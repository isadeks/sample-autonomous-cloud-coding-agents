"""Proof tests for the structural git isolation (#855).

These are the tests that make the three-layer fix *provable* rather than
assumed. Two of them are unusual on purpose:

* :class:`TestDetectorIsLive` spawns a **nested pytest session** whose test
  deliberately leaks, and asserts the nested run turns RED with the pollution
  report. A detector whose failure mode is a false pass cannot be trusted
  unless you have watched it fail, and you cannot watch it fail from inside the
  session it is guarding (failing the outer run is the very thing under test).
* :class:`TestReproductionIsContained` replays the issue's reproduction verbatim
  — a real repo with a real identity, a real linked worktree, and the
  ``GIT_DIR``/``GIT_COMMON_DIR`` pair git exports to a hook in that worktree —
  and asserts the shared config is **byte-identical** afterwards.

Every ``git`` invocation below is itself isolated (``isolated_git_env``) so these
tests cannot become the fifth recurrence.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

from tests.git_isolation import (
    GIT_LOCATION_VARS,
    RESERVED_IDENTITY,
    isolated_git_env,
    shared_git_config_path,
)

_TESTS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _TESTS_DIR.parent.parent


def _git(cwd: Path, *args: str, home: Path | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env=isolated_git_env(home or cwd),
    )


class TestLayer1StripsAmbientLocationVars:
    """The autouse fixture in conftest must have cleared the whole family before
    any test body runs — including for test modules that declare no git fixture
    of their own (which is the entire point of hoisting it into conftest)."""

    def test_every_location_var_is_absent(self):
        leaked = {var: os.environ[var] for var in GIT_LOCATION_VARS if var in os.environ}
        assert leaked == {}, f"conftest's _isolate_git_env did not strip {sorted(leaked)} (#855)"

    def test_config_resolution_is_pinned_away_from_the_developers_files(self):
        assert os.environ["GIT_CONFIG_SYSTEM"] == os.devnull
        assert os.environ["GIT_CONFIG_NOSYSTEM"] == "1"
        # A tmp path, never ~/.gitconfig.
        assert Path(os.environ["GIT_CONFIG_GLOBAL"]).parent != Path.home()

    def test_identity_is_an_rfc_2606_reserved_domain(self):
        for key, value in RESERVED_IDENTITY.items():
            assert os.environ[key] == value
        assert os.environ["GIT_AUTHOR_EMAIL"].endswith(".invalid")

    def test_a_bare_git_config_write_cannot_reach_the_shared_config(self, tmp_path):
        """With layer 1 in force, even the *unguarded* call shape from #665
        (``git -C <tmp> config ...``, no ``env=``) stays contained."""
        shared_before = shared_git_config_path()
        blob_before = shared_before.read_bytes() if shared_before else None

        _git(tmp_path, "init", "-q")
        subprocess.run(
            ["git", "-C", str(tmp_path), "config", "user.name", "unguarded"],
            check=True,
            capture_output=True,
        )

        assert (tmp_path / ".git" / "config").read_text().find("unguarded") != -1
        if shared_before is not None:
            assert shared_before.read_bytes() == blob_before


class TestIsolatedGitEnv:
    def test_drops_location_vars_and_overlays_the_pins(self, tmp_path):
        base = {var: "/leaked" for var in GIT_LOCATION_VARS} | {"PATH": "/usr/bin"}
        env = isolated_git_env(tmp_path, base=base)
        assert not any(var in env for var in GIT_LOCATION_VARS)
        assert env["PATH"] == "/usr/bin"  # unrelated vars survive
        assert env["HOME"] == str(tmp_path)
        assert env["GIT_CONFIG_GLOBAL"] == str(tmp_path / ".gitconfig-test")

    def test_contains_a_git_init_even_with_git_dir_and_work_tree_set(self, tmp_path, monkeypatch):
        """``core.worktree`` needs BOTH GIT_DIR and GIT_WORK_TREE set during
        ``git init`` — the nastiest fallout, because it redirects the primary
        checkout and makes ``git revert`` appear to succeed while changing
        nothing. Set both, then prove the helper still contains the init."""
        outer = tmp_path / "outer"
        outer.mkdir()
        _git(outer.parent, "init", "-q", str(outer))
        outer_config = outer / ".git" / "config"
        before = outer_config.read_bytes()

        monkeypatch.setenv("GIT_DIR", str(outer / ".git"))
        monkeypatch.setenv("GIT_WORK_TREE", str(outer))

        sandbox = tmp_path / "sandbox"
        sandbox.mkdir()
        _git(sandbox, "init", "-q")

        assert (sandbox / ".git").is_dir(), "init was redirected by the ambient GIT_DIR"
        assert outer_config.read_bytes() == before
        assert b"worktree" not in before


class TestSharedConfigResolution:
    """``--git-common-dir``, never ``--show-toplevel``: ``core.worktree`` changes
    what the latter returns, so an already-polluted repo would make the detector
    compute a nonexistent path and report "clean" — the pollution would disable
    its own detector."""

    def test_resolves_the_shared_config_even_when_core_worktree_is_set(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q")
        elsewhere = tmp_path / "elsewhere"
        elsewhere.mkdir()
        # Exactly the pollution the issue describes, applied to a throwaway repo.
        _git(repo, "config", "core.worktree", str(elsewhere))

        resolved = shared_git_config_path(cwd=repo)
        assert resolved == repo / ".git" / "config"
        assert resolved is not None and resolved.exists()

    def test_never_resolves_to_this_repository_from_an_unrelated_cwd(self, tmp_path):
        """Outside a repo the resolver must answer ``None`` (or at worst the repo
        actually containing TMPDIR) — never this checkout. Otherwise the detector
        would fingerprint a file no test in that session can reach, and a real
        leak elsewhere would read as "clean"."""
        resolved = shared_git_config_path(cwd=tmp_path)
        assert resolved != _REPO_ROOT / ".git" / "config"
        if resolved is not None:  # TMPDIR itself lives inside some other repo
            assert tmp_path.is_relative_to(resolved.parent.parent)


class TestSingleDefinition:
    """#855 acceptance criterion: exactly one ``_GIT_LOCATION_VARS`` definition.

    The four previous fixes each re-declared the list in the file where the leak
    was observed, and the copies drifted. This fails the build if a new copy
    appears anywhere in the tree."""

    # An assignment of the name, with or without a leading underscore (the four
    # prior copies used `_GIT_LOCATION_VARS`) and with or without an annotation.
    # Walks the filesystem rather than using `git grep`, which only sees TRACKED
    # files — a fresh copy in a not-yet-committed file is exactly the moment this
    # guard needs to fire.
    _DEFINITION = re.compile(r"^\s*_?GIT_LOCATION_VARS\s*(?::[^=\n]+)?=")

    def test_git_location_vars_is_defined_once(self):
        skip_dirs = {".git", ".venv", "node_modules", "cdk.out", "__pycache__", ".worktrees"}
        definitions = []
        for path in _REPO_ROOT.rglob("*.py"):
            if skip_dirs & set(path.parts):
                continue
            for lineno, line in enumerate(
                path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
            ):
                if self._DEFINITION.match(line):
                    definitions.append(f"{path.relative_to(_REPO_ROOT)}:{lineno}: {line.strip()}")

        assert definitions == [
            f"agent/tests/git_isolation.py:{self._expected_lineno()}: GIT_LOCATION_VARS = ("
        ], (
            "GIT_LOCATION_VARS must have exactly ONE definition in the tree, in "
            "agent/tests/git_isolation.py — a second copy is how the four previous "
            "fixes drifted apart (#855). Found:\n" + "\n".join(definitions or ["<none>"])
        )

    @staticmethod
    def _expected_lineno() -> int:
        source = (_TESTS_DIR / "git_isolation.py").read_text(encoding="utf-8").splitlines()
        return next(
            i for i, line in enumerate(source, start=1) if line.startswith("GIT_LOCATION_VARS")
        )


class TestDetectorIsLive:
    """Layer 2, proven by making it fail.

    Spawns a nested pytest session over a throwaway repo. The nested test
    deliberately re-sets ``GIT_DIR`` in its own body (i.e. *after* layer 1's
    autouse strip has run) and then writes config unguarded — a route layer 1
    cannot anticipate, which is precisely the class of mistake layer 2 exists
    for. The nested run must exit non-zero with the pollution report."""

    def _nested_project(self, tmp_path: Path, test_body: str) -> Path:
        repo = tmp_path / "real"
        repo.mkdir()
        _git(repo, "init", "-q")
        _git(repo, "config", "user.name", "RealDev")
        _git(repo, "config", "user.email", "real@dev.example")
        (repo / "test_leak.py").write_text(test_body)
        return repo

    def _run_nested(self, repo: Path) -> subprocess.CompletedProcess:
        env = isolated_git_env(repo.parent / "nested-home")
        (repo.parent / "nested-home").mkdir(exist_ok=True)
        # `-p tests.git_isolation` loads layers 1+2 as a plugin, so the nested
        # session is guarded exactly like the real suite without dragging in the
        # agent conftest (which would collect the whole suite recursively).
        env["PYTHONPATH"] = str(_REPO_ROOT / "agent")
        env.pop("PYTEST_ADDOPTS", None)
        env.pop("PYTEST_CURRENT_TEST", None)
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-p",
                "tests.git_isolation",
                "-p",
                "no:cacheprovider",
                "--no-header",
                "-q",
                "test_leak.py",
            ],
            cwd=repo,
            capture_output=True,
            text=True,
            check=False,
            env=env,
            timeout=90,
        )

    def test_an_unguarded_fixture_fails_the_run_instead_of_mutating_silently(self, tmp_path):
        repo = self._nested_project(
            tmp_path,
            # The leak, verbatim in shape from test_registry_loader.py before
            # #855: `git -C <tmp> config user.name x` with GIT_DIR set.
            "import os, subprocess\n"
            "def test_unguarded_fixture(tmp_path):\n"
            "    os.environ['GIT_DIR'] = os.path.join(os.getcwd(), '.git')\n"
            "    subprocess.run(['git', '-C', str(tmp_path), 'config', 'user.name', 'x'],\n"
            "                   check=True, capture_output=True)\n",
        )
        shared = repo / ".git" / "config"
        before = shared.read_text()

        result = self._run_nested(repo)
        blob = result.stdout + result.stderr

        # The leak really happened (otherwise this test proves nothing)...
        assert shared.read_text() != before, (
            f"the nested leak did not reproduce, so the detector was never exercised.\n{blob}"
        )
        # ...and the detector caught it and reddened the run.
        assert result.returncode != 0, f"detector did not fail the session:\n{blob}"
        assert "GIT CONFIG POLLUTION DETECTED" in blob
        assert "isolated_git_env" in blob  # points at the fix
        # Copy-pasteable remedy for both shapes of damage.
        assert f"git config --file {shared} --unset-all core.worktree" in blob
        assert f"git config --file {shared} --remove-section user" in blob
        # A real diff, not just a hash.
        assert re.search(r"^\+.*\bx\b", blob, re.MULTILINE)

    def test_a_guarded_fixture_passes_and_the_shared_config_is_untouched(self, tmp_path):
        repo = self._nested_project(
            tmp_path,
            "import subprocess\n"
            "from tests.git_isolation import isolated_git_env\n"
            "def test_guarded_fixture(tmp_path):\n"
            "    subprocess.run(['git', 'init', '-q'], cwd=tmp_path, check=True,\n"
            "                   capture_output=True, env=isolated_git_env(tmp_path))\n"
            "    subprocess.run(['git', 'config', 'user.name', 'x'], cwd=tmp_path,\n"
            "                   check=True, capture_output=True, env=isolated_git_env(tmp_path))\n"
            "    assert (tmp_path / '.git' / 'config').read_text().count('x') == 1\n",
        )
        shared = repo / ".git" / "config"
        before = shared.read_bytes()

        result = self._run_nested(repo)
        blob = result.stdout + result.stderr

        assert result.returncode == 0, f"guarded fixture should pass:\n{blob}"
        assert "GIT CONFIG POLLUTION DETECTED" not in blob
        assert shared.read_bytes() == before


class TestReproductionIsContained:
    """#855 acceptance criterion 1 — the issue's reproduction, replayed.

    A real repo with a real identity, a real linked worktree, and the
    GIT_DIR/GIT_COMMON_DIR pair git exports to a hook running in that worktree.
    Before the fix this stamped ``[user] name = t / email = t@t`` into the shared
    config and created NO repo in the sandbox. After it, the shared config is
    byte-identical.
    """

    def test_shared_config_is_byte_identical_after_the_reproduction(self, tmp_path, monkeypatch):
        real = tmp_path / "real"
        real.mkdir()
        _git(real, "init", "-q")
        _git(real, "config", "user.name", "RealDev")
        _git(real, "config", "user.email", "real@dev.example")
        _git(real, "commit", "-q", "--allow-empty", "-m", "init")
        _git(real, "worktree", "add", "-q", str(tmp_path / "wt"), "-b", "probe")

        shared_config = real / ".git" / "config"
        before = shared_config.read_bytes()

        # Exactly what git exports to a hook in a LINKED worktree.
        monkeypatch.setenv("GIT_DIR", str(real / ".git" / "worktrees" / "wt"))
        monkeypatch.setenv("GIT_COMMON_DIR", str(real / ".git"))

        # Replay the fixture body through the guarded helper.
        sandbox = tmp_path / "sandbox"
        sandbox.mkdir()
        _git(sandbox, "init", "-q")
        _git(sandbox, "config", "user.email", "t@t")
        _git(sandbox, "config", "user.name", "t")

        assert shared_config.read_bytes() == before, (
            "the reproduction still leaks into the shared config (#855)"
        )
        assert (sandbox / ".git").is_dir(), "the sandbox got no repo — init hit the shared one"
        # And the real identity is intact / unshadowed.
        text = before.decode()
        assert "RealDev" in text and "t@t" not in text
