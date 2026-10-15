"""``runner._files_at_base``: the PR base's tree, for existing-file policy rules."""

from __future__ import annotations

import subprocess

from runner import _files_at_base


def _git(repo, *args) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@x", *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


def _clone(tmp_path):
    origin, work = tmp_path / "origin.git", tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True, capture_output=True)
    (work / "base.spec.ts").write_text("x\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-qm", "base")
    _git(work, "push", "-q", "origin", "HEAD:main", "HEAD:release")
    _git(work, "remote", "set-head", "origin", "main")
    return work


def test_the_pr_base_tree_excludes_files_added_on_the_branch(tmp_path):
    work = _clone(tmp_path)
    _git(work, "checkout", "-qb", "bgagent/t/x")
    (work / "new.spec.ts").write_text("y\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-qm", "pr")
    assert _files_at_base(str(work)) == frozenset({"base.spec.ts"})
    assert _files_at_base(str(work), "release") == frozenset({"base.spec.ts"})


def test_an_unresolvable_base_is_empty_not_head(tmp_path):
    work = _clone(tmp_path)
    (work / "new.spec.ts").write_text("y\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-qm", "pr")
    # no origin/missing: falling back to HEAD would wrongly count new.spec.ts as existing
    assert _files_at_base(str(work), "missing") == frozenset()


def test_not_a_git_checkout(tmp_path):
    assert _files_at_base(str(tmp_path)) == frozenset()
