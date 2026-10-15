"""ExistingTestGuard: shell commands cannot change tests that existed on the PR's base."""

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

import pytest

from hooks import _apply_test_guard
from test_guard import ExistingTestGuard, is_test_path

if TYPE_CHECKING:
    from pathlib import Path

SPEC = "e2e/src/specs/library.e2e-spec.ts"
UNIT = "server/src/a.service.spec.ts"
SRC = "server/src/a.service.ts"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        check=True,
        capture_output=True,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    for rel, text in (
        (SPEC, "expect(a).toBe(1)\n"),
        (UNIT, "it('x')\n"),
        (SRC, "export const a = 1\n"),
    ):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text)
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "base")
    return tmp_path


@pytest.fixture
def guard(repo: Path) -> ExistingTestGuard:
    return ExistingTestGuard(str(repo), frozenset({SPEC, UNIT, SRC}))


def test_globs_match_the_cedar_rule():
    import re
    from pathlib import Path

    from test_guard import TEST_PATH_GLOBS

    cedar = (Path(__file__).parents[1] / "policies" / "soft_deny.cedar").read_text()
    rule = cedar[cedar.index('@rule_id("modify_existing_test")') :]
    rule = rule[: rule.index("};")]
    assert set(re.findall(r'context\.file_path like "([^"]+)"', rule)) == set(TEST_PATH_GLOBS)


def test_only_test_paths_are_protected():
    assert is_test_path(SPEC) and is_test_path(UNIT) and is_test_path("web/vitest.config.ts")
    assert not is_test_path(SRC)


def test_shell_edit_of_an_existing_test_is_restored(repo, guard):
    (repo / SPEC).write_text("await poll(); expect(a).toBe(1)\n")
    assert guard.after_shell() == [SPEC]
    assert (repo / SPEC).read_text() == "expect(a).toBe(1)\n"


def test_source_files_and_new_tests_are_left_alone(repo, guard):
    (repo / SRC).write_text("export const a = 2\n")
    (repo / "server/src/b.service.spec.ts").write_text("it('new')\n")
    assert guard.after_shell() == []
    assert (repo / SRC).read_text() == "export const a = 2\n"


def test_deleted_existing_test_is_restored(repo, guard):
    (repo / UNIT).unlink()
    assert guard.after_shell() == [UNIT]
    assert (repo / UNIT).read_text() == "it('x')\n"


def test_a_change_committed_from_the_shell_is_undone_in_the_tree(repo, guard):
    (repo / SPEC).write_text("expect(a).toBeTruthy()\n")
    _git(repo, "commit", "-qam", "loosen")
    assert guard.after_shell() == [SPEC]
    assert (repo / SPEC).read_text() == "expect(a).toBe(1)\n"


def test_an_approved_edit_becomes_the_accepted_content(repo, guard):
    (repo / SPEC).write_text("expect(a).toBe(2)\n")  # the approved Edit tool wrote this
    guard.record_tool_write(str(repo / SPEC))
    assert guard.after_shell() == []
    (repo / SPEC).write_text("expect(a).toBeDefined()\n")  # later shell edit
    assert guard.after_shell() == [SPEC]
    assert (repo / SPEC).read_text() == "expect(a).toBe(2)\n"


def test_inactive_without_protected_tests(repo):
    g = ExistingTestGuard(str(repo), frozenset({SRC}))
    (repo / SPEC).write_text("changed\n")
    assert not g.active and g.after_shell() == []


def test_hook_tells_the_agent_what_was_restored(repo, guard):
    (repo / SPEC).write_text("changed\n")
    result: dict = {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}
    _apply_test_guard(
        guard, {"tool_name": "Bash", "tool_input": {"command": "python3 x.py"}}, result, None
    )
    context = result["hookSpecificOutput"]["additionalContext"]
    assert f"`{SPEC}`" in context and "Edit tool" in context


def test_hook_accepts_edit_tool_writes(repo, guard):
    (repo / SPEC).write_text("approved\n")
    result: dict = {"hookSpecificOutput": {"hookEventName": "PostToolUse"}}
    _apply_test_guard(
        guard, {"tool_name": "Edit", "tool_input": {"file_path": str(repo / SPEC)}}, result, None
    )
    assert "additionalContext" not in result["hookSpecificOutput"]
    assert guard.after_shell() == []
