"""modify_existing_test soft-deny rule (an agent editing tests instead of fixing code).

Changing a test that already existed on the PR's base pauses for a human;
tests the agent creates in this PR stay editable.
"""

from __future__ import annotations

import subprocess

import pytest

from policy import Outcome, PolicyEngine
from runner import _files_at_base

ROOT = "/workspace/t1"
BASE = frozenset({"e2e/specs/login.e2e-spec.ts", "src/auth/session.ts"})


@pytest.fixture
def engine() -> PolicyEngine:
    return PolicyEngine(task_type="new_task", repo="o/r", repo_root=ROOT, files_at_base=BASE)


def test_editing_an_existing_test_requires_approval(engine):
    d = engine.evaluate_tool_use("Edit", {"file_path": f"{ROOT}/e2e/specs/login.e2e-spec.ts"})
    assert d.outcome == Outcome.REQUIRE_APPROVAL
    assert "modify_existing_test" in d.reason


def test_a_test_the_agent_created_is_not_gated(engine):
    d = engine.evaluate_tool_use("Write", {"file_path": f"{ROOT}/src/auth/token.spec.ts"})
    assert d.outcome == Outcome.ALLOW


def test_existing_source_files_are_not_gated(engine):
    d = engine.evaluate_tool_use("Edit", {"file_path": f"{ROOT}/src/auth/session.ts"})
    assert d.outcome == Outcome.ALLOW


def test_relative_paths_resolve_against_the_repo_root(engine):
    d = engine.evaluate_tool_use("Edit", {"file_path": "e2e/specs/login.e2e-spec.ts"})
    assert d.outcome == Outcome.REQUIRE_APPROVAL


def test_without_a_base_snapshot_nothing_is_gated():
    eng = PolicyEngine(task_type="new_task", repo="o/r")
    d = eng.evaluate_tool_use("Edit", {"file_path": f"{ROOT}/e2e/specs/login.e2e-spec.ts"})
    assert d.outcome == Outcome.ALLOW


def test_shell_commands_are_not_gated(engine):
    # the rule sees Write/Edit only; running tests (even with redirects) never pauses the task
    for command in (
        "pnpm exec vitest run a.spec.ts > /tmp/out 2>&1",
        "npx jest a.test.ts | tee log",
    ):
        assert engine.evaluate_tool_use("Bash", {"command": command}).outcome == Outcome.ALLOW


def _git(repo, *args):
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@x", *args],
        check=True,
        capture_output=True,
    )


def test_files_at_base_lists_the_merge_base_tree_not_pr_files(tmp_path):
    origin, work = tmp_path / "origin", tmp_path / "work"
    subprocess.run(["git", "init", "-q", "-b", "main", str(origin)], check=True)
    (origin / "a.spec.ts").write_text("x\n")
    _git(origin, "add", "-A")
    _git(origin, "commit", "-qm", "base")
    subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True)
    _git(work, "checkout", "-qb", "bgagent/t/x")
    (work / "new.spec.ts").write_text("y\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-qm", "pr")
    assert _files_at_base(str(work)) == frozenset({"a.spec.ts"})
    assert _files_at_base(str(tmp_path / "not-a-repo")) == frozenset()
