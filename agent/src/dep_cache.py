"""Warm dependency cache across ECS agent tasks (ABCA-691).

Persist the two expensive *derived* dependency artifacts — Node ``node_modules``
and the target repo's uv ``.venv`` — on a shared volume mounted at ``/cache`` so
a fresh clone can restore them instead of paying the full cold ``yarn install``
+ ``uv sync`` (~3-5 min) on every task.

Correctness (non-negotiable): each cache entry is keyed on the **lockfile hash**,
NEVER the commit SHA:

* ``node_modules`` → ``sha256(yarn.lock)``
* ``.venv``        → ``sha256(uv.lock)``

If the target repo's trunk bumped a dependency the lockfile bytes differ, the
hash differs, and the lookup MISSES → a full reinstall runs. It is therefore
impossible to build against stale deps. If trunk changed only source (lockfile
unchanged) the entry HITS and reuse is safe: a lockfile fully determines the
resolved dependency tree, so a restored entry is byte-identical to what a cold
install would have produced. The git clone itself is never cached — it stays
fresh per task (the source of truth); only these derived artifacts are reused.

Concurrency: many ECS tasks share ``/cache`` at once. A cache entry is populated
by copying into a per-task temp dir and then ``os.rename``-ing it into place —
an atomic same-filesystem move, so a half-written tree is never visible under
its final key and two tasks racing the same key can't corrupt each other (the
loser simply discards its temp; the winner's immutable entry stands).

Best-effort by construction: a missing, empty, corrupt, or unwritable cache
NEVER fails the task — every failure path degrades to a normal cold install.
When ``/cache`` is not mounted at all (AgentCore runtime, local runs) this module
is a complete no-op and dependency handling is left exactly as it was before.
"""

import hashlib
import os
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from shell import log
from shell import run_cmd as _default_run_cmd

# Where the shared cache volume is mounted inside the BUILD task container. The
# CDK ``EcsAgentCluster`` construct mounts an EFS access point here (ABCA-691).
# Overridable via env for tests / alternate substrates.
DEFAULT_CACHE_DIR = "/cache"

# Directories we never descend into when locating a lockfile — vendored / build
# trees whose own ``yarn.lock``/``uv.lock`` are not the repo's top-level lock.
_LOCK_SKIP_DIRS = frozenset({".git", "node_modules", ".venv", "cdk.out", "dist", "build"})

# A cold install can legitimately run several minutes; give it the same generous
# ceiling the build verify uses rather than run_cmd's 600s default.
_INSTALL_TIMEOUT_S = 1800


@dataclass(frozen=True)
class Artifact:
    """One cacheable dependency artifact and how to (re)build it.

    ``key`` is the ``/cache`` sub-namespace; entries live at
    ``<cache>/<key>/<lockfile-hash>``. ``artifact_dir`` and ``lockfile`` are
    both resolved relative to the directory that contains the lockfile (so a
    monorepo's ``agent/uv.lock`` → ``agent/.venv`` works, not just the root)."""

    key: str
    lockfile: str
    artifact_dir: str
    install_argv: list[str]
    install_label: str


# The MINIMAL scope (ABCA-691): node_modules + the target repo's uv .venv only.
# (jest/tsc build caches are an explicit out-of-scope follow-up.)
ARTIFACTS: list[Artifact] = [
    Artifact(
        key="node_modules",
        lockfile="yarn.lock",
        artifact_dir="node_modules",
        # --frozen-lockfile: install exactly what the lock pins and fail rather
        # than silently mutate it, so the populated entry matches the key.
        install_argv=["yarn", "install", "--frozen-lockfile"],
        install_label="warm-cache-yarn-install",
    ),
    Artifact(
        key="venv",
        lockfile="uv.lock",
        artifact_dir=".venv",
        install_argv=["uv", "sync", "--frozen"],
        install_label="warm-cache-uv-sync",
    ),
]


def hash_lockfile(path: str) -> str:
    """Return the SHA-256 hex digest of the lockfile at *path* — the cache key.

    Streams the file so a large lock is not read wholesale into memory. Raises
    ``OSError`` if the file cannot be read; callers treat that as "no key".
    """
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_cache_dir(explicit: str | None = None) -> str | None:
    """Resolve the mounted cache directory, or ``None`` when caching is off.

    Order: an explicit argument (tests), then ``$DEP_CACHE_DIR``, then
    ``/cache``. Returns the path only if it exists and is a directory — when the
    volume is not mounted (AgentCore, local runs) this is ``None`` and the whole
    module no-ops, leaving pre-ABCA-691 dependency handling untouched.
    """
    candidate = explicit or os.environ.get("DEP_CACHE_DIR") or DEFAULT_CACHE_DIR
    return candidate if os.path.isdir(candidate) else None


def _find_lockfile(repo_dir: str, name: str) -> str | None:
    """Return the shallowest ``name`` lockfile under *repo_dir*, or ``None``.

    Shallowest wins so a repo's top-level lock beats any nested one, and
    vendored/build trees are pruned so we never key off a dependency's own lock.
    """
    best: str | None = None
    best_depth = None
    for dirpath, dirnames, filenames in os.walk(repo_dir):
        dirnames[:] = [d for d in dirnames if d not in _LOCK_SKIP_DIRS]
        if name in filenames:
            depth = os.path.relpath(dirpath, repo_dir).count(os.sep)
            if best_depth is None or depth < best_depth:
                best, best_depth = os.path.join(dirpath, name), depth
    return best


def _dir_has_content(path: str) -> bool:
    """True if *path* is a directory with at least one entry.

    An empty directory is treated as a MISS (a half-populated / stale marker),
    so a caller falls back to a cold install rather than restoring nothing.
    """
    try:
        return os.path.isdir(path) and any(os.scandir(path))
    except OSError:
        return False


def _restore(entry_dir: str, dest_dir: str) -> bool:
    """Copy a cache *entry_dir* into the clone at *dest_dir*. Best-effort.

    Copies (not symlinks) so each task gets an independent, writable tree: a
    build that writes into ``node_modules`` (e.g. ``.cache``) can never mutate
    the shared entry and corrupt a concurrent task. ``symlinks=True`` preserves
    the internal symlinks (``.bin`` shims, workspace links) so the restored tree
    is byte-identical to a cold install. A failure leaves *dest_dir* removed and
    returns ``False`` so the caller cold-installs.
    """
    try:
        if os.path.lexists(dest_dir):
            shutil.rmtree(dest_dir, ignore_errors=True)
        shutil.copytree(entry_dir, dest_dir, symlinks=True)
        return True
    except OSError as exc:
        log("WARN", f"warm-cache: restore of {entry_dir} → {dest_dir} failed: {exc}")
        shutil.rmtree(dest_dir, ignore_errors=True)
        return False


def _atomic_populate(cache_subdir: str, key: str, src_dir: str) -> bool:
    """Populate ``<cache_subdir>/<key>`` from *src_dir* atomically. Best-effort.

    Copies *src_dir* into a per-task temp dir on the SAME filesystem, then
    ``os.rename``-s it into place — an atomic move, so no partial tree is ever
    visible under the final key. If another task won the race (the final key
    already exists) or the move fails, the temp is discarded and the existing
    entry is left intact — a populate never corrupts the cache. Returns whether
    this task installed the entry.
    """
    final = os.path.join(cache_subdir, key)
    if os.path.isdir(final):
        return False  # already populated by a prior/concurrent task
    tmp = os.path.join(cache_subdir, f".tmp-{uuid.uuid4().hex}")
    try:
        os.makedirs(cache_subdir, exist_ok=True)
        shutil.copytree(src_dir, tmp, symlinks=True)
        try:
            os.rename(tmp, final)
            return True
        except OSError:
            # Target sprang into existence (lost the race) or cross-device — the
            # existing entry stands; drop our temp so no partial leaks.
            shutil.rmtree(tmp, ignore_errors=True)
            return False
    except OSError as exc:
        log("WARN", f"warm-cache: populate of {final} failed: {exc}")
        shutil.rmtree(tmp, ignore_errors=True)
        return False


def _process_artifact(
    art: Artifact,
    repo_dir: str,
    cache_dir: str,
    run_cmd: Callable[..., Any],
    notes: list[str],
) -> None:
    """Restore-or-install a single artifact. Never raises.

    HIT  → copy the entry into the clone and skip the install.
    MISS → run the install, then populate the cache for the next task.
    Any read/restore failure degrades to a cold install; any install/populate
    failure leaves the task to proceed with whatever the install produced.
    """
    lock_path = _find_lockfile(repo_dir, art.lockfile)
    if lock_path is None:
        return  # repo doesn't use this toolchain — nothing to cache

    proj_dir = os.path.dirname(lock_path)
    dest_dir = os.path.join(proj_dir, art.artifact_dir)
    cache_subdir = os.path.join(cache_dir, art.key)

    try:
        key = hash_lockfile(lock_path)
    except OSError as exc:
        log("WARN", f"warm-cache: cannot hash {lock_path}: {exc}; cold install")
        key = None

    # --- Restore path (cache HIT) ---
    if key is not None:
        entry_dir = os.path.join(cache_subdir, key)
        if _dir_has_content(entry_dir):
            if _restore(entry_dir, dest_dir):
                log("SETUP", f"warm-cache HIT: {art.artifact_dir} restored from {entry_dir}")
                notes.append(
                    f"dependency cache HIT: {art.artifact_dir} (key {key[:12]}) — skipped install"
                )
                return
            # Restore failed → treat as a miss and fall through to install.
            log("WARN", f"warm-cache: HIT but restore failed for {art.artifact_dir}; cold install")

    # --- Miss path: install, then populate for the next task ---
    log("SETUP", f"warm-cache MISS: {art.artifact_dir} — running {' '.join(art.install_argv)}")
    result = run_cmd(
        art.install_argv,
        label=art.install_label,
        cwd=proj_dir,
        check=False,
        timeout=_INSTALL_TIMEOUT_S,
    )
    if getattr(result, "returncode", 1) != 0:
        notes.append(f"dependency cache MISS: {art.artifact_dir} — install failed, not cached")
        return
    if not key or not os.path.isdir(dest_dir):
        notes.append(f"dependency cache MISS: {art.artifact_dir} — installed (not cached)")
        return
    populated = _atomic_populate(cache_subdir, key, dest_dir)
    if populated:
        notes.append(
            f"dependency cache MISS: {art.artifact_dir} — installed and cached (key {key[:12]})"
        )
    else:
        notes.append(
            f"dependency cache MISS: {art.artifact_dir} — installed "
            "(cache populated by another task)"
        )


def warm_dependency_cache(
    repo_dir: str,
    *,
    run_cmd: Callable[..., Any] | None = None,
    cache_dir: str | None = None,
    artifacts: list[Artifact] | None = None,
) -> list[str]:
    """Restore or install each dependency artifact, keyed on its lockfile hash.

    Returns human-readable notes (one per artifact acted on) for the
    ``RepoSetup`` notes; never raises. When no cache volume is mounted this is a
    no-op and returns a single explanatory note, leaving dependency handling
    exactly as it was before ABCA-691.
    """
    resolved = resolve_cache_dir(cache_dir)
    if resolved is None:
        log("SETUP", "warm-cache: no /cache volume mounted — skipping (cold install as before)")
        return ["dependency cache not mounted; skipped warm cache"]

    run = run_cmd or _default_run_cmd
    notes: list[str] = []
    for art in artifacts if artifacts is not None else ARTIFACTS:
        try:
            _process_artifact(art, repo_dir, resolved, run, notes)
        except Exception as exc:
            # A bug in the cache path must degrade to a cold install, not crash
            # setup. Log loudly (this is unexpected) and move on.
            log("ERROR", f"warm-cache: unexpected error for {art.key}: {type(exc).__name__}: {exc}")
            notes.append(f"dependency cache error for {art.artifact_dir}; proceeded without cache")
    return notes
