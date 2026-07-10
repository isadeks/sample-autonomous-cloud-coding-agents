"""Unit tests for dep_cache.py — the warm dependency cache (ABCA-691).

Covers the four correctness pillars from the issue:
  * hash-key: entries are keyed on the LOCKFILE hash (never the commit SHA), so
    a changed lockfile produces a different key.
  * hit: a populated entry matching the lockfile hash is restored and the
    install is skipped.
  * miss: a changed/absent lockfile hash MISSES → the install runs and the entry
    is populated for the next task.
  * atomic-populate: a concurrent populate never corrupts the cache; a
    missing/corrupt/unmounted cache degrades to a cold install and never raises.

The install seam (``run_cmd``) is faked so no real yarn/uv runs; the fake writes
a marker file into the artifact dir so we can assert restore vs. install.
"""

import os
from types import SimpleNamespace

import dep_cache


def _write(path: str, content: str = "x") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(content)


class _FakeInstall:
    """Fake run_cmd that simulates an install by writing the artifact dir.

    Records each call's label + cwd. On success (default) it creates the
    artifact dir with a marker file whose content proves it came from a cold
    install (not a restore). Set ``rc`` to simulate an install failure.
    """

    def __init__(self, rc: int = 0, marker: str = "INSTALLED"):
        self.calls: list[dict] = []
        self._rc = rc
        self._marker = marker

    def __call__(self, cmd, label, cwd: str = "", check=True, timeout=None):
        self.calls.append({"cmd": cmd, "label": label, "cwd": cwd})
        if self._rc == 0:
            art = "node_modules" if "yarn" in cmd[0] else ".venv"
            _write(os.path.join(cwd, art, "MARKER"), self._marker)
        return SimpleNamespace(returncode=self._rc, stdout="", stderr="")

    def labels(self) -> list[str]:
        return [c["label"] for c in self.calls]


def _node_repo(tmp_path, lock_content="lock-v1"):
    """A minimal clone dir with a yarn.lock."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "yarn.lock").write_text(lock_content)
    return str(repo)


class TestHashKey:
    def test_hash_is_sha256_of_lockfile_bytes(self, tmp_path):
        p = tmp_path / "yarn.lock"
        p.write_text("resolved-tree-A")
        import hashlib

        expected = hashlib.sha256(b"resolved-tree-A").hexdigest()
        assert dep_cache.hash_lockfile(str(p)) == expected

    def test_different_lockfile_content_yields_different_key(self, tmp_path):
        a = tmp_path / "a.lock"
        b = tmp_path / "b.lock"
        a.write_text("dep@1.0.0")
        b.write_text("dep@2.0.0")  # trunk bumped a dependency
        assert dep_cache.hash_lockfile(str(a)) != dep_cache.hash_lockfile(str(b))

    def test_identical_content_yields_identical_key(self, tmp_path):
        a = tmp_path / "a.lock"
        b = tmp_path / "b.lock"
        a.write_text("same")
        b.write_text("same")
        assert dep_cache.hash_lockfile(str(a)) == dep_cache.hash_lockfile(str(b))


class TestMissThenPopulate:
    def test_cold_miss_runs_install_and_populates_cache(self, tmp_path):
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        cache.mkdir()
        fake = _FakeInstall()

        notes = dep_cache.warm_dependency_cache(
            repo,
            run_cmd=fake,
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],  # node_modules only
        )

        # Install ran (cold miss).
        assert "warm-cache-yarn-install" in fake.labels()
        # node_modules exists in the clone.
        assert os.path.isfile(os.path.join(repo, "node_modules", "MARKER"))
        # The cache was populated under the lockfile hash.
        key = dep_cache.hash_lockfile(os.path.join(repo, "yarn.lock"))
        assert os.path.isfile(os.path.join(cache, "node_modules", key, "MARKER"))
        assert any("cache MISS" in n and "cached" in n for n in notes)


class TestHitSkipsInstall:
    def test_matching_lockfile_hash_restores_and_skips_install(self, tmp_path):
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        # Pre-populate a cache entry keyed on the CURRENT lockfile hash, with a
        # marker proving it came from the cache (not a fresh install).
        key = dep_cache.hash_lockfile(os.path.join(repo, "yarn.lock"))
        _write(os.path.join(cache, "node_modules", key, "MARKER"), "FROM_CACHE")
        fake = _FakeInstall()

        notes = dep_cache.warm_dependency_cache(
            repo,
            run_cmd=fake,
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )

        # Install did NOT run — the entry was restored.
        assert fake.labels() == []
        # The restored node_modules carries the cache marker (byte-identical).
        with open(os.path.join(repo, "node_modules", "MARKER")) as fh:
            assert fh.read() == "FROM_CACHE"
        assert any("cache HIT" in n for n in notes)


class TestChangedLockfileMisses:
    def test_changed_yarn_lock_misses_and_reinstalls(self, tmp_path):
        """AC: a task whose clone has a CHANGED yarn.lock does a full reinstall.

        A cache entry exists for the OLD lockfile hash; the clone's lockfile
        changed (trunk bumped a dep), so its hash differs → MISS → reinstall,
        and the OLD entry is never restored (no stale deps)."""
        repo = _node_repo(tmp_path, lock_content="dep@2.0.0")  # new lock
        cache = tmp_path / "cache"
        # An entry exists — but keyed on the OLD lockfile's hash.
        import hashlib

        old_key = hashlib.sha256(b"dep@1.0.0").hexdigest()
        _write(os.path.join(cache, "node_modules", old_key, "MARKER"), "STALE")
        fake = _FakeInstall()

        dep_cache.warm_dependency_cache(
            repo,
            run_cmd=fake,
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )

        # Reinstalled (cache miss on the new hash).
        assert "warm-cache-yarn-install" in fake.labels()
        # The clone's node_modules is the FRESH install, never the stale entry.
        with open(os.path.join(repo, "node_modules", "MARKER")) as fh:
            assert fh.read() == "INSTALLED"
        # And a new entry was populated under the NEW hash (old entry untouched).
        new_key = dep_cache.hash_lockfile(os.path.join(repo, "yarn.lock"))
        assert new_key != old_key
        assert os.path.isfile(os.path.join(cache, "node_modules", new_key, "MARKER"))
        assert os.path.isfile(os.path.join(cache, "node_modules", old_key, "MARKER"))


class TestAtomicPopulate:
    def test_populate_is_atomic_no_partial_entry_visible(self, tmp_path):
        # A successful populate leaves ONLY the final key dir — no leftover
        # .tmp-* staging dir (which would be a partially-written tree).
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        cache.mkdir()
        dep_cache.warm_dependency_cache(
            repo,
            run_cmd=_FakeInstall(),
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )
        subdir = cache / "node_modules"
        leftovers = [d for d in os.listdir(subdir) if d.startswith(".tmp-")]
        assert leftovers == []

    def test_concurrent_populate_does_not_overwrite_or_corrupt(self, tmp_path):
        # If the final key already exists (a concurrent task won the race), a
        # second populate must NOT overwrite it and must leave no temp behind.
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        key = dep_cache.hash_lockfile(os.path.join(repo, "yarn.lock"))
        # Winner's entry already in place.
        _write(os.path.join(cache, "node_modules", key, "MARKER"), "WINNER")

        installed = dep_cache._atomic_populate(
            str(cache / "node_modules"),
            key,
            str(_seed_src(tmp_path)),
        )

        assert installed is False  # lost the race, did not populate
        # Winner's entry is intact and unchanged.
        with open(os.path.join(cache, "node_modules", key, "MARKER")) as fh:
            assert fh.read() == "WINNER"
        leftovers = [d for d in os.listdir(cache / "node_modules") if d.startswith(".tmp-")]
        assert leftovers == []

    def test_corrupt_empty_entry_falls_back_to_install(self, tmp_path):
        # An EMPTY cache dir (a half-populated / stale marker) must be treated as
        # a MISS, not restored as an empty node_modules.
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        key = dep_cache.hash_lockfile(os.path.join(repo, "yarn.lock"))
        os.makedirs(os.path.join(cache, "node_modules", key))  # empty → corrupt
        fake = _FakeInstall()

        dep_cache.warm_dependency_cache(
            repo,
            run_cmd=fake,
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )
        # Fell back to a cold install rather than restoring an empty tree.
        assert "warm-cache-yarn-install" in fake.labels()
        assert os.path.isfile(os.path.join(repo, "node_modules", "MARKER"))


class TestBestEffortNeverFails:
    def test_unmounted_cache_is_a_noop_cold_install(self, tmp_path, monkeypatch):
        # No /cache mounted and no DEP_CACHE_DIR → module no-ops, no install
        # driven by the cache (the normal setup path still installs deps itself).
        monkeypatch.delenv("DEP_CACHE_DIR", raising=False)
        repo = _node_repo(tmp_path)
        fake = _FakeInstall()
        notes = dep_cache.warm_dependency_cache(
            repo,
            run_cmd=fake,
            cache_dir=str(tmp_path / "does-not-exist"),
        )
        assert fake.labels() == []
        assert any("not mounted" in n for n in notes)

    def test_install_failure_does_not_populate_and_does_not_raise(self, tmp_path):
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        cache.mkdir()
        fake = _FakeInstall(rc=1)  # install fails
        notes = dep_cache.warm_dependency_cache(
            repo,
            run_cmd=fake,
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )
        # Install ran but failed → nothing cached, no crash.
        assert "warm-cache-yarn-install" in fake.labels()
        key = dep_cache.hash_lockfile(os.path.join(repo, "yarn.lock"))
        assert not os.path.isdir(os.path.join(cache, "node_modules", key))
        assert any("install failed" in n for n in notes)

    def test_repo_without_lockfile_skips_artifact_entirely(self, tmp_path):
        # A repo with no yarn.lock → the node_modules artifact is skipped (no
        # install, no note) — nothing to cache.
        repo = tmp_path / "repo"
        repo.mkdir()
        fake = _FakeInstall()
        cache = tmp_path / "cache"
        cache.mkdir()
        notes = dep_cache.warm_dependency_cache(
            repo_dir=str(repo),
            run_cmd=fake,
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )
        assert fake.labels() == []
        assert notes == []

    def test_unexpected_error_degrades_and_never_raises(self, tmp_path, monkeypatch):
        # An unexpected error inside artifact processing must be swallowed
        # (best-effort) and recorded, not propagated to fail the task.
        repo = _node_repo(tmp_path)
        cache = tmp_path / "cache"
        cache.mkdir()

        def boom(*a, **k):
            raise RuntimeError("disk on fire")

        monkeypatch.setattr(dep_cache, "_process_artifact", boom)
        notes = dep_cache.warm_dependency_cache(
            repo,
            run_cmd=_FakeInstall(),
            cache_dir=str(cache),
            artifacts=[dep_cache.ARTIFACTS[0]],
        )
        assert any("error" in n.lower() for n in notes)  # did not raise


class TestLockfileDiscovery:
    def test_shallowest_lockfile_wins_and_vendored_pruned(self, tmp_path):
        repo = tmp_path / "repo"
        (repo / "pkg").mkdir(parents=True)
        (repo / "node_modules" / "dep").mkdir(parents=True)
        # Root lock, a nested pkg lock, and a vendored lock.
        (repo / "yarn.lock").write_text("root")
        (repo / "pkg" / "yarn.lock").write_text("nested")
        (repo / "node_modules" / "dep" / "yarn.lock").write_text("vendored")
        found = dep_cache._find_lockfile(str(repo), "yarn.lock")
        assert found == str(repo / "yarn.lock")  # shallowest, vendored ignored


def _seed_src(tmp_path):
    """A small source dir to populate FROM (for the atomic-populate unit test)."""
    src = tmp_path / "src-artifact"
    _write(str(src / "MARKER"), "LOSER")
    return src
