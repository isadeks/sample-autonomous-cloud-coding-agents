"""Warm dependency cache across ECS tasks (ABCA-691).

Each ECS agent task otherwise pays a full COLD dependency install (``yarn
install`` + ``uv sync``, ~3-5 min) even when the target repo's dependencies
have not changed since the last task. This module persists the *derived*
dependency artifacts — ``node_modules`` and the target-repo ``.venv`` — on a
shared filesystem (an EFS volume mounted at ``/cache`` on the build task def)
so a subsequent task on the SAME lockfiles restores them from local disk
instead of re-downloading from the network.

Correctness invariant (non-negotiable)
---------------------------------------
Every cache entry is keyed on the **lockfile hash**, NEVER the commit SHA:

* ``node_modules`` → ``sha256(yarn.lock)``
* ``.venv``        → ``sha256(uv.lock)``

If the target repo's trunk bumped a dependency, the lockfile bytes differ, the
hash differs, and the lookup MISSES → a full reinstall. It is therefore
impossible to build against stale deps: a hit can only occur when the exact
lockfile that produced the cached artifact is present again. If trunk changed
only source (lockfile unchanged), reuse is safe. The git clone itself is never
cached — it stays fresh per task (source of truth); only these two derived
artifacts are reused.

Concurrency + resilience
------------------------
Many tasks run at once against the same shared volume. Cache entries are
published with a write-to-temp-then-atomic-rename so a reader never observes a
half-written entry, and two tasks publishing the same key race harmlessly (the
first ``rename`` wins; the loser discards its temp). Every operation here is
**best-effort**: a missing, corrupt, or unreadable entry — or an absent/unwritable
cache root (e.g. the AgentCore substrate, local dev, or tests) — falls back to a
cold install and NEVER fails the task. A restored artifact is always followed by
the repo's normal validating install, so a cache hit produces the identical
``node_modules`` a cold install would.
"""

import hashlib
import os
import shutil
import uuid

from shell import log

# Where the shared cache volume is mounted in the build task def (CDK EFS access
# point → ``/cache``). Overridable via env for local dev / tests.
DEFAULT_CACHE_ROOT = "/cache"

# Cache namespaces (subdirectories under the cache root). Each artifact kind
# gets its own tree so ``node_modules`` and ``.venv`` digests can never collide.
CACHE_KIND_NODE_MODULES = "node_modules"
CACHE_KIND_VENV = "venv"

# Read the lockfile in bounded chunks so a large lockfile never balloons memory.
_HASH_CHUNK_BYTES = 1 << 20  # 1 MiB

# Directories never worth scanning for nested ``uv.lock`` files — vendored trees
# and build outputs are huge and any lockfile inside them is not a project root.
_UV_LOCK_SKIP_DIRS = frozenset(
    {".git", "node_modules", ".venv", "cdk.out", "dist", "build", ".tox", "__pycache__"}
)


def cache_root() -> str | None:
    """Return the writable cache root, or ``None`` when caching is unavailable.

    The cache is available only when the mount point exists AND is writable —
    i.e. the EFS access point is mounted (build task def). On any substrate
    without it (AgentCore runtime, local dev, unit tests) this returns ``None``
    and every caller degrades to a plain cold install.
    """
    root = os.environ.get("DEPENDENCY_CACHE_DIR", DEFAULT_CACHE_ROOT)
    if not root:
        return None
    if not os.path.isdir(root) or not os.access(root, os.W_OK):
        return None
    return root


def hash_lockfile(path: str) -> str | None:
    """Return the hex ``sha256`` of the lockfile at *path*, or ``None``.

    ``None`` means the lockfile is absent or unreadable — there is nothing to
    key a cache entry on, so the caller skips caching for that artifact (a repo
    with no ``yarn.lock`` simply has no node_modules cache). Never raises.
    """
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            while True:
                chunk = handle.read(_HASH_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _entry_path(root: str, kind: str, digest: str) -> str:
    """Absolute path of the cache entry directory for ``(kind, digest)``."""
    return os.path.join(root, kind, digest)


def _safe_rmtree(path: str | None) -> None:
    """Best-effort recursive delete used to clean up temp dirs. Never raises."""
    if not path:
        return
    shutil.rmtree(path, ignore_errors=True)


def restore_artifact(root: str, kind: str, digest: str, dest: str) -> bool:
    """Restore a cached artifact directory into *dest*. Return ``True`` on HIT.

    Copies the cache entry ``<root>/<kind>/<digest>`` into *dest* so the task
    gets its OWN copy — the shared entry is treated read-only, so a subsequent
    install that mutates *dest* can never corrupt the cache for concurrent
    tasks. The copy lands via a per-task temp dir then an atomic rename so a
    crash mid-copy leaves no partial *dest*.

    Returns ``False`` (cold install) when the entry is absent, *dest* already
    exists (nothing to restore over), or anything goes wrong (corrupt/partial
    entry, permission error) — best-effort read, never fatal.
    """
    entry = _entry_path(root, kind, digest)
    tmp: str | None = None
    try:
        if not os.path.isdir(entry):
            return False
        # Never clobber an existing dest: a present artifact means the caller
        # already has it (e.g. a venv baked into the image). Cold-path it.
        if os.path.exists(dest):
            return False
        parent = os.path.dirname(os.path.abspath(dest)) or "."
        os.makedirs(parent, exist_ok=True)
        # Temp sits next to dest (same filesystem as the clone) so the final
        # rename into place is atomic.
        tmp = os.path.join(parent, f".{os.path.basename(dest)}.cache-restore-{uuid.uuid4().hex}")
        shutil.copytree(entry, tmp, symlinks=True)
        os.rename(tmp, dest)
        tmp = None
        return True
    except OSError as exc:
        # Corrupt/partial entry or a race that created dest first. Clean up and
        # fall back to a cold install — a bad cache entry must never fail a task.
        log("WARN", f"dependency-cache restore miss ({kind}): {type(exc).__name__}: {exc}")
        _safe_rmtree(tmp)
        return False


def populate_artifact(root: str, kind: str, digest: str, source: str) -> bool:
    """Publish *source* into the cache under ``(kind, digest)``. Atomic.

    Copies *source* into a unique temp directory ON THE CACHE FILESYSTEM, then
    ``rename``s it to the final entry path. The rename is atomic, so a reader
    observes either no entry or a fully-formed one — never a half-written tree.
    When two tasks publish the same key concurrently the first rename wins and
    the loser (rename onto a non-empty dir fails) discards its temp; the winning
    entry is equally valid because an identical lockfile hash means identical
    dependencies.

    Returns ``True`` when this call published a new entry; ``False`` when an
    entry already existed (hit or concurrent winner), *source* is absent, or
    anything went wrong. Best-effort — never raises.
    """
    entry = _entry_path(root, kind, digest)
    tmp: str | None = None
    try:
        # Already cached (a hit, or a concurrent task already won). Nothing to do.
        if os.path.isdir(entry):
            return False
        if not os.path.isdir(source):
            return False
        kind_dir = os.path.join(root, kind)
        os.makedirs(kind_dir, exist_ok=True)
        # Temp MUST live on the same filesystem as the final entry (the cache
        # volume) for the rename to be atomic — so build it under kind_dir.
        tmp = os.path.join(kind_dir, f".tmp-populate-{uuid.uuid4().hex}")
        shutil.copytree(source, tmp, symlinks=True)
        try:
            os.rename(tmp, entry)
            tmp = None
            return True
        except OSError:
            # Lost the publish race: another task's rename created the (non-empty)
            # entry first, so ours fails. Its entry is valid — discard our temp.
            _safe_rmtree(tmp)
            tmp = None
            return False
    except OSError as exc:
        log("WARN", f"dependency-cache populate skipped ({kind}): {type(exc).__name__}: {exc}")
        _safe_rmtree(tmp)
        return False


def _find_uv_locks(repo_dir: str) -> list[str]:
    """Return every ``uv.lock`` under *repo_dir*, skipping vendored/build trees.

    A monorepo may have several Python project roots (ABCA keeps one at
    ``agent/uv.lock``); each drives its own sibling ``.venv``.
    """
    locks: list[str] = []
    for dirpath, dirnames, filenames in os.walk(repo_dir):
        dirnames[:] = [d for d in dirnames if d not in _UV_LOCK_SKIP_DIRS]
        if "uv.lock" in filenames:
            locks.append(os.path.join(dirpath, "uv.lock"))
    return locks


def discover_artifacts(repo_dir: str) -> list[tuple[str, str, str]]:
    """Discover cacheable derived artifacts in the clone.

    Returns a list of ``(kind, lockfile_path, artifact_path)`` tuples:

    * the root ``yarn.lock`` → ``node_modules`` (Yarn workspaces install every
      workspace's deps into the single root ``node_modules``), and
    * each ``uv.lock`` → its sibling ``.venv``.

    Only pairs whose lockfile exists are returned; the artifact dir need not
    exist yet (it won't on the restore pass, before install runs).
    """
    plan: list[tuple[str, str, str]] = []
    yarn_lock = os.path.join(repo_dir, "yarn.lock")
    if os.path.isfile(yarn_lock):
        plan.append((CACHE_KIND_NODE_MODULES, yarn_lock, os.path.join(repo_dir, "node_modules")))
    for uv_lock in _find_uv_locks(repo_dir):
        venv = os.path.join(os.path.dirname(uv_lock), ".venv")
        plan.append((CACHE_KIND_VENV, uv_lock, venv))
    return plan


def restore_dependency_cache(repo_dir: str, notes: list[str]) -> None:
    """Restore warm dependency artifacts into the clone before install runs.

    Best-effort and idempotent: for each cacheable ``(lockfile, artifact)`` pair
    whose lockfile hashes to a present cache entry, copy the artifact into the
    clone (a HIT) so the repo's subsequent ``yarn install`` / ``uv sync`` finds
    the packages already present and validates instead of cold-downloading. A
    miss (or no cache volume) leaves the clone untouched → a normal cold install.
    Records a human-readable note per artifact for the PR / setup log.
    """
    root = cache_root()
    if root is None:
        log("SETUP", "Dependency cache unavailable (no writable /cache) — cold install")
        notes.append("Dependency cache: unavailable (cold install)")
        return
    for kind, lockfile, artifact in discover_artifacts(repo_dir):
        digest = hash_lockfile(lockfile)
        if digest is None:
            continue
        if restore_artifact(root, kind, digest, artifact):
            msg = f"cache HIT for {kind} (key {digest[:12]}) — restored, install will validate"
            log("SETUP", f"Dependency {msg}")
            notes.append(f"Dependency {msg}")
        else:
            msg = f"cache MISS for {kind} (key {digest[:12]}) — cold install"
            log("SETUP", f"Dependency {msg}")
            notes.append(f"Dependency {msg}")


def populate_dependency_cache(repo_dir: str, notes: list[str]) -> None:
    """Publish freshly-installed dependency artifacts into the shared cache.

    Best-effort: called AFTER the repo's install/build has produced the
    artifacts. For each cacheable pair whose lockfile hash has no entry yet, the
    artifact is atomically published so the NEXT task on the same lockfile hits.
    An already-present entry (this task hit, or a concurrent task won the race)
    is left untouched. Never fails the task.
    """
    root = cache_root()
    if root is None:
        return
    for kind, lockfile, artifact in discover_artifacts(repo_dir):
        if not os.path.isdir(artifact):
            continue
        digest = hash_lockfile(lockfile)
        if digest is None:
            continue
        if populate_artifact(root, kind, digest, artifact):
            log("SETUP", f"Dependency cache populated for {kind} (key {digest[:12]})")
            notes.append(f"Dependency cache: populated {kind} (key {digest[:12]})")
