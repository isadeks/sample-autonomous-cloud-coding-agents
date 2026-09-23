"""Structural git isolation for the agent test suite (#855).

THE BUG THIS EXISTS TO MAKE IMPOSSIBLE
--------------------------------------
Test fixtures that shell out to ``git`` write into the repository's **shared
``.git/config``** whenever the test process inherits a ``GIT_DIR`` from its
environment. Git exports ``GIT_DIR``/``GIT_COMMON_DIR`` to hooks **only in a
linked worktree**, which is exactly how this suite runs as a ``prek`` pre-push
gate from ``.worktrees/<branch>/``. That is why the leak looks unreproducible:
``uv run pytest`` by hand from the primary checkout is harmless.

An explicit ``GIT_DIR`` overrides repository *discovery* outright, so it beats
``-C <path>``, ``--local``, ``cwd=``, ``HOME=`` and the
``GIT_CONFIG_GLOBAL``/``GIT_CONFIG_SYSTEM`` pins **simultaneously**. A fixture
doing ``git -C <tmp_path> config user.email t@t`` looks contained and is not:
the write lands in the real repo, and ``git -C <tmp> init`` does not create a
repo in ``<tmp>`` at all — it **re-inits the shared repository**. The fallout,
in order of nastiness: ``core.worktree`` in a non-bare repo redirects the
primary checkout (``git checkout --`` / ``git revert`` silently operate on
another tree and still exit 0); a repo-local ``[user]`` section **always**
shadows ``~/.gitconfig``, so commits land mis-attributed.

This recurred four times (#622/#623, #695, #720/#731, #665) because every fix
was placed in the file where the leak was observed — so it could not protect the
next file to shell out to git. #731's ``_isolated_env`` was the right *content*
in the wrong *place*. Hence this module: the isolation lives in ONE place that
covers test files which do not exist yet.

THREE LAYERS
------------
1. **Prevent** — :func:`_isolate_git_env`, an autouse fixture imported by
   ``tests/conftest.py``, strips the ambient repo-location vars from every
   test's environment and pins config resolution + identity. Fixtures that build
   their own env dict for ``subprocess.run`` use :func:`isolated_git_env`.
2. **Detect** — :func:`snapshot_shared_git_config` /
   :func:`check_shared_git_config`, wired to pytest's session start/finish in
   ``tests/conftest.py``, fingerprint the shared config and **fail the run**
   with a diff if anything changed. Mechanism-INDEPENDENT: it catches routes to
   the file that layer 1 does not anticipate.
3. **Refuse** — ``mise run check:git-config-clean`` (pre-commit + pre-push)
   rejects a config containing ``core.worktree`` or a ``[user]`` section.

AUDIT OF EVERY TEST FILE THAT MENTIONS git (#855 acceptance criteria)
---------------------------------------------------------------------
* ``test_post_hooks.py`` — real git in ``tmp_path``; uses
  :func:`isolated_git_env` (was the local ``_isolated_env`` of #731).
* ``test_registry_loader.py`` — real git in ``tmp_path``; was the unguarded
  ``_git()`` helper introduced by #665, now uses :func:`isolated_git_env`.
* ``test_shell.py`` — ``["git", "clone"]`` is only an argv *fixture* handed to a
  patched ``shell.subprocess.run``; the one test that spawns a real process uses
  ``sh -c``. No git process is created. Covered by layer 1 regardless.
* ``test_server.py`` — ``git`` appears as a warm-up argv matched by a fake
  ``server.subprocess.run``. No git process is created. Covered by layer 1.

This module is also a valid pytest plugin (``-p tests.git_isolation``), which is
how ``test_git_isolation.py`` proves the detector fires in a real nested session
instead of asserting it in the abstract.
"""

import difflib
import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

#: Repo-LOCATION vars. An explicit ``GIT_DIR`` overrides repository discovery
#: outright, so it beats ``cwd``, ``HOME``, the ``GIT_CONFIG_*`` pins and
#: ``--local`` alike — dropping these FIRST is load-bearing, not tidiness. Git
#: exports them to hooks in a LINKED WORKTREE (they are unset in a normal
#: checkout), which is precisely how this suite runs as a pre-push gate.
#:
#: THIS IS THE ONLY DEFINITION IN THE TREE (#855 acceptance criterion). Import
#: it; do not re-declare it in a test file — that is how the previous four fixes
#: drifted apart.
GIT_LOCATION_VARS = (
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_PREFIX",
    "GIT_CEILING_DIRECTORIES",
)

#: RFC-2606 reserved identity. A commit produced by a fixture must never be
#: attributable to a real person, and ``GIT_AUTHOR_*``/``GIT_COMMITTER_*`` beat
#: every config file — so no fixture needs ``git config user.*`` at all (#623).
RESERVED_IDENTITY = {
    "GIT_AUTHOR_NAME": "ABCA Test",
    "GIT_AUTHOR_EMAIL": "abca-test@example.invalid",
    "GIT_COMMITTER_NAME": "ABCA Test",
    "GIT_COMMITTER_EMAIL": "abca-test@example.invalid",
}


def config_pins(home: str | os.PathLike[str]) -> dict[str, str]:
    """Env pins that keep git config resolution inside *home*.

    Only meaningful once :data:`GIT_LOCATION_VARS` are gone — ``GIT_DIR``
    defeats all of these at once.
    """
    home = str(home)
    return {
        "HOME": home,
        "XDG_CONFIG_HOME": home,
        "GIT_CONFIG_GLOBAL": os.path.join(home, ".gitconfig-test"),
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        **RESERVED_IDENTITY,
    }


def isolated_git_env(
    home: str | os.PathLike[str], base: dict[str, str] | None = None
) -> dict[str, str]:
    """Return an environment for ``subprocess.run(["git", ...])`` that cannot escape *home*.

    Drops :data:`GIT_LOCATION_VARS` from *base* (default ``os.environ``) and then
    overlays :func:`config_pins`. Fixtures pass their ``tmp_path`` repo as
    *home*.
    """
    env = {
        k: v
        for k, v in (base if base is not None else os.environ).items()
        if k not in GIT_LOCATION_VARS
    }
    env.update(config_pins(home))
    return env


@pytest.fixture(scope="session")
def _git_isolation_home(tmp_path_factory) -> Path:
    """One throwaway HOME for the whole session's git config resolution."""
    return tmp_path_factory.mktemp("git-isolation-home")


@pytest.fixture(autouse=True)
def _isolate_git_env(monkeypatch, _git_isolation_home):
    """LAYER 1 (#855): strip ambient git location vars and pin config for EVERY test.

    ``conftest.py`` imports this so it applies to test modules that do not exist
    yet — the placement the four previous fixes lacked. Note it deliberately
    does NOT pin ``HOME`` process-wide (other suites read it); ``GIT_CONFIG_*``
    already supersedes ``~/.gitconfig`` for git.

    A test may still re-set ``GIT_DIR`` itself to *simulate* the hook
    environment (``test_post_hooks``, ``test_git_isolation``); layer 2 is what
    backstops that.
    """
    for var in GIT_LOCATION_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(_git_isolation_home / ".gitconfig-test"))
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for key, value in RESERVED_IDENTITY.items():
        monkeypatch.setenv(key, value)


# --------------------------------------------------------------------------- #
# LAYER 2 — detect
# --------------------------------------------------------------------------- #

#: ``(path, bytes)`` captured at session start; ``(None, None)`` outside a repo.
_SNAPSHOT: tuple[Path | None, bytes | None] = (None, None)


def shared_git_config_path(cwd: str | os.PathLike[str] | None = None) -> Path | None:
    """Absolute path of the SHARED ``.git/config``, or ``None`` outside a repo.

    Resolved via ``--git-common-dir`` on purpose. ``--show-toplevel`` is wrong
    here: ``core.worktree`` changes what it returns, so an already-polluted repo
    would make this compute a path that does not exist and report "clean" — the
    pollution would disable its own detector. ``--git-common-dir`` answers from
    the gitdir alone.
    """
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if out.returncode != 0 or not out.stdout.strip():
        return None
    return Path(out.stdout.strip()) / "config"


def _read(path: Path | None) -> bytes | None:
    if path is None:
        return None
    try:
        return path.read_bytes()
    except OSError:
        return None


def snapshot_shared_git_config(
    cwd: str | os.PathLike[str] | None = None,
) -> tuple[Path | None, bytes | None]:
    """Fingerprint the shared config at session start. Returns the snapshot."""
    global _SNAPSHOT
    path = shared_git_config_path(cwd)
    _SNAPSHOT = (path, _read(path))
    return _SNAPSHOT


def _digest(blob: bytes | None) -> str:
    return "<missing>" if blob is None else hashlib.sha256(blob).hexdigest()[:16]


def format_pollution_report(path: Path, before: bytes | None, after: bytes | None) -> str:
    diff = "\n".join(
        difflib.unified_diff(
            (before or b"").decode("utf-8", "replace").splitlines(),
            (after or b"").decode("utf-8", "replace").splitlines(),
            fromfile=f"{path} (session start, sha {_digest(before)})",
            tofile=f"{path} (session end, sha {_digest(after)})",
            lineterm="",
        )
    )
    return (
        "\nGIT CONFIG POLLUTION DETECTED (#855): the test session mutated the "
        f"SHARED git config at {path}.\n\n"
        f"{diff}\n\n"
        "A test shelled out to git while a repo-LOCATION var (GIT_DIR, "
        "GIT_WORK_TREE, ...) was set, so `-C <tmp>` / `--local` / cwd / HOME were "
        "all overridden and the write landed in the real repository. Fix the "
        "fixture to build its environment with "
        "`tests.git_isolation.isolated_git_env(<tmp repo>)`.\n\n"
        "Undo the damage (a repo-local [user] shadows ~/.gitconfig, and "
        "core.worktree redirects the primary checkout):\n"
        f"  git config --file {path} --unset-all core.worktree\n"
        f"  git config --file {path} --remove-section user\n"
    )


def check_shared_git_config(session=None) -> str | None:
    """Fail the session if the shared config changed since :func:`snapshot_shared_git_config`.

    Returns the printed report, or ``None`` when clean / not applicable.
    Mechanism-independent by construction: it compares bytes on disk, so it
    catches any future route to the file, including ones layer 1 misses.
    """
    path, before = _SNAPSHOT
    if path is None:
        return None
    after = _read(path)
    if after == before:
        return None
    report = format_pollution_report(path, before, after)
    print(report, file=sys.stderr, flush=True)
    if session is not None:
        session.exitstatus = int(pytest.ExitCode.TESTS_FAILED)
    return report


# Plugin hooks, so the detector can be loaded standalone with
# `-p tests.git_isolation` (how test_git_isolation.py proves it fires live).
# tests/conftest.py calls the same two functions from its own hooks — it cannot
# import these, because it already defines pytest_sessionfinish for the hang
# watchdog.


def pytest_sessionstart(session):
    snapshot_shared_git_config()


def pytest_sessionfinish(session, exitstatus):
    check_shared_git_config(session)
