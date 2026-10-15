"""The platform's marked verification block in the PR body.

Pins: one summary line with details collapsed; ``upsert_verification_section``
appends the block to an agent-written body and REPLACES it in a body that
already has one — including the body ``ensure_pr`` wrote on create — so a later
round's verdict (CI/CD, fix-up rounds) always reaches the PR.
"""

from __future__ import annotations

import subprocess
from typing import Any

from models import AgentResult, TaskConfig
from post_hooks import (
    VERIFICATION_END,
    VERIFICATION_START,
    render_verification_section,
    upsert_verification_section,
)


def _config(**over) -> TaskConfig:
    base: dict[str, Any] = {
        "repo_url": "o/r",
        "task_id": "t1",
        "github_token": "x",
        "aws_region": "us-east-1",
        "build_command": "npm test",
        "lint_command": "true",
    }
    base.update(over)
    return TaskConfig(**base)


class TestRender:
    def test_one_summary_line_details_collapsed(self):
        s = render_verification_section(
            _config(),
            True,
            True,
            fixup_rounds=2,
            fixup_history=[False, True],
            agent_result=AgentResult(cost_usd=1.0),
            ci_summary="CI/CD ✅ (build ✅)",
            extra_lines=["- CI/CD on `abc`: **PASS**"],
        )
        lines = s.splitlines()
        assert lines[0] == VERIFICATION_START and lines[-1] == VERIFICATION_END
        assert lines[1] == (
            "**ABCA verification** · build gate ✅ · CI/CD ✅ (build ✅)"
            " · 2 fix-up round(s) · $1.00"
        )
        assert "<details><summary>Details</summary>" in s
        assert (
            "- Local build fix-up rounds: 2 (FAIL, PASS)" in s and "- CI/CD on `abc`: **PASS**" in s
        )
        assert "Lint" not in s  # a no-op lint command is not shown

    def test_inert_build_is_not_a_pass(self):
        s = render_verification_section(_config(), True, True, build_inert=True)
        assert "build gate ⚠️ not verified" in s.splitlines()[1]
        assert "not verified (command could not run)" in s

    def test_long_commands_are_shortened(self):
        cmd = "pnpm install --frozen-lockfile --filter x && pnpm --filter y run build && pnpm build"
        s = render_verification_section(_config(build_command=cmd), True, True)
        line = next(x for x in s.splitlines() if x.startswith("- Build gate:"))
        assert "…" in line and len(line) < 100


class _Gh:
    """Fake `gh pr view/edit` holding one PR body."""

    def __init__(self, body: str) -> None:
        self.body = body
        self.edits = 0

    def __call__(self, argv, **_kw):
        if argv[:3] == ["gh", "pr", "view"]:
            return subprocess.CompletedProcess(argv, 0, stdout=self.body + "\n", stderr="")
        if argv[:3] == ["gh", "pr", "edit"]:
            self.body = argv[argv.index("--body") + 1]
            self.edits += 1
            return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")
        raise AssertionError(argv)


def _upsert(monkeypatch, gh: _Gh, section: str) -> bool:
    import post_hooks

    monkeypatch.setattr(post_hooks.subprocess, "run", gh)
    return upsert_verification_section("/w", "https://github.com/o/r/pull/1", _config(), section)


NEW = render_verification_section(_config(), True, True, ci_summary="CI/CD ✅")


class TestUpsert:
    def test_appends_to_an_agent_written_body(self, monkeypatch):
        gh = _Gh("## Summary\n\nAgent text")
        assert _upsert(monkeypatch, gh, NEW)
        assert gh.body.startswith("## Summary\n\nAgent text\n\n" + VERIFICATION_START)
        assert gh.body.count(VERIFICATION_START) == 1

    def test_replaces_an_existing_block(self, monkeypatch):
        old = render_verification_section(_config(), False, True)
        gh = _Gh(f"intro\n\n{old}\n\nfooter")
        assert _upsert(monkeypatch, gh, NEW)
        assert gh.body == f"intro\n\n{NEW}\n\nfooter"

    def test_replaces_the_block_ensure_pr_wrote_on_create(self, monkeypatch):
        # ensure_pr's body: summary, the marked block for the pre-CI state, a footer
        created = (
            "## Summary\n\n## Verification\n\n"
            f"{render_verification_section(_config(), True, True)}\n\n---\n\nlicense"
        )
        gh = _Gh(created)
        assert _upsert(monkeypatch, gh, NEW)
        assert gh.edits == 1 and "CI/CD ✅" in gh.body and gh.body.count(VERIFICATION_START) == 1

    def test_no_edit_when_unchanged(self, monkeypatch):
        gh = _Gh(f"intro\n\n{NEW}")
        assert _upsert(monkeypatch, gh, NEW)
        assert gh.edits == 0
