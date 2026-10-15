"""In-session CI/CD convergence (``ci_wait_timeout_s`` / ``ci_required_checks``).

Pins: statuses, check runs and deployments are read for the head SHA; a red
check fails at once; a required stage that has not reported yet keeps waiting
(CD reports only after CI); no CI → "none" after the appear window; the CI
fix-up round resumes the agent's session with the failure report and re-waits
on the new head; and a red PR after the rounds fails the task.
"""

from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, patch

import pytest

from ci_wait import (
    CiConvergence,
    CiResult,
    build_ci_fixup_prompt,
    classify,
    collect_checks,
    failure_report,
    render_ci_summary,
    wait_for_ci,
)
from models import AgentResult, RepoSetup
from pipeline import _run_ci_rounds
from workflow import Workflow

if TYPE_CHECKING:
    from collections.abc import Mapping


def _chk(name: str, state: str, detail: str = "") -> dict:
    return {"name": name, "state": state, "url": "", "detail": detail}


class TestClassify:
    def test_all_green(self):
        assert classify([_chk("ci", "success"), _chk("deployment:Preview", "success")]) == "pass"

    def test_pending_waits(self):
        assert classify([_chk("ci", "success"), _chk("deployment:Preview", "pending")]) == "pending"

    def test_red_fails_without_waiting_for_later_stages(self):
        assert classify([_chk("ci", "failure"), _chk("deployment:Preview", "pending")]) == "fail"

    def test_required_stage_not_reported_yet_keeps_waiting(self):
        checks = [_chk("ci", "success")]
        assert classify(checks, ["ci", "deployment:Preview"]) == "pending"
        assert classify([*checks, _chk("deployment:Preview", "success")], ["ci"]) == "pass"

    @pytest.mark.parametrize("state", ["error", "timed_out", "cancelled", "action_required"])
    def test_other_red_states(self, state):
        assert classify([_chk("x", state)]) == "fail"


def _gh_router(responses: Mapping[str, object]):
    """Fake `gh api <path> ...` → JSON by path prefix."""

    def _run(argv, **_kw):
        path = argv[2]
        for prefix, body in responses.items():
            if path.startswith(prefix):
                return subprocess.CompletedProcess(argv, 0, stdout=json.dumps(body), stderr="")
        return subprocess.CompletedProcess(argv, 1, stdout="", stderr="not found")

    return _run


class TestCollectChecks:
    def test_reads_statuses_check_runs_and_latest_deployment(self):
        responses = {
            "repos/o/r/commits/abc/status": {
                "statuses": [
                    {
                        "context": "AWS CodeBuild us-east-1 (ci)",
                        "state": "failure",
                        "description": "Build failed",
                        "target_url": "https://cb/1",
                    }
                ]
            },
            "repos/o/r/commits/abc/check-runs": {
                "check_runs": [
                    {"name": "lint", "status": "completed", "conclusion": "success", "output": {}},
                    {"name": "slow", "status": "in_progress", "conclusion": None, "output": {}},
                ]
            },
            "repos/o/r/deployments/7/statuses": [
                {"state": "error", "description": "skipped: CI failed", "log_url": "https://c"},
                {"state": "queued"},
            ],
            "repos/o/r/deployments": [
                {"id": 7, "environment": "Preview"},
                {"id": 3, "environment": "Preview"},  # older: ignored
            ],
        }
        with patch("ci_wait.subprocess.run", side_effect=_gh_router(responses)):
            checks = collect_checks("o/r", "abc", "/w")
        by_name = {c["name"]: c for c in checks or []}
        assert by_name["AWS CodeBuild us-east-1 (ci)"]["state"] == "failure"
        assert by_name["lint"]["state"] == "success" and by_name["slow"]["state"] == "pending"
        assert by_name["deployment:Preview"]["state"] == "error"
        assert by_name["deployment:Preview"]["url"] == "https://c"

    def test_all_api_errors_is_none(self):
        with patch("ci_wait.subprocess.run", side_effect=_gh_router({})):
            assert collect_checks("o/r", "abc", "/w") is None


class _Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


def _wait(sequence, timeout_s=600, required=None, appear=120, cancelled=lambda: False):
    clock = _Clock()
    with patch("ci_wait.collect_checks", side_effect=[*sequence] + [sequence[-1]] * 100):
        return wait_for_ci(
            "o/r",
            "abc",
            "/w",
            timeout_s,
            required=required,
            is_cancelled=cancelled,
            appear_timeout_s=appear,
            poll_s=30,
            sleep=clock.sleep,
            clock=clock,
        )


class TestWaitForCi:
    def test_waits_through_pending_then_passes(self):
        r = _wait([[_chk("ci", "pending")], [_chk("ci", "pending")], [_chk("ci", "success")]])
        assert r.state == "pass" and r.waited_s == 60

    def test_ci_then_cd(self):
        seq = [
            [_chk("ci", "pending")],
            [_chk("ci", "success")],  # CD not reported yet: required keeps it waiting
            [_chk("ci", "success"), _chk("deployment:Preview", "pending")],
            [_chk("ci", "success"), _chk("deployment:Preview", "success")],
        ]
        r = _wait(seq, required=["ci", "deployment:Preview"])
        assert r.state == "pass" and r.waited_s == 90

    def test_no_ci_reported(self):
        r = _wait([[]], appear=120)
        assert r.state == "none" and r.waited_s == 120

    def test_timeout_while_pending(self):
        r = _wait([[_chk("ci", "pending")]], timeout_s=90)
        assert r.state == "timeout"

    def test_cancelled(self):
        r = _wait([[_chk("ci", "pending")]], cancelled=lambda: True)
        assert r.state == "cancelled"


def test_failure_report_includes_failed_checks_and_ci_comment_and_is_capped():
    res = CiResult("fail", "abc123", [_chk("ci", "failure", "e2e 4/7"), _chk("lint", "success")])
    report = failure_report(res, ["<!-- feval-ci sha=abc123 result=fail -->\nFAIL fix: 2-asset"])
    assert "ci: FAILURE" in report and "e2e 4/7" in report and "FAIL fix: 2-asset" in report
    assert "lint" not in report
    huge = failure_report(res, ["x" * 50_000])
    assert len(huge) <= 12_000 and huge.endswith("(report truncated)")


def test_ci_prompt():
    p = build_ci_fixup_prompt("REPORT", 1, 2)
    assert "REPORT" in p and "round 1 of 2" in p and "untrusted" in p and "push" in p


def test_render_ci_summary():
    ci = CiConvergence(
        rounds=1,
        results=[
            CiResult("fail", "abcdef1234", [_chk("ci", "failure")]),
            CiResult(
                "pass",
                "1234567890",
                [
                    _chk("AWS CodeBuild us-east-1 (feval-immich-ci-x)", "success"),
                    _chk("deployment:Preview", "success"),
                    _chk("feval/ui-check", "success"),
                ],
            ),
        ],
    )
    summary, details = render_ci_summary(ci)
    assert summary == "CI/CD ✅ (CI ✅ Preview ✅ ui-check ✅)"
    assert details[0] == "- CI/CD on `123456789`: **PASS**"
    assert "  - deployment:Preview: success" in details
    assert details[-1] == "- CI fix-up rounds: 1 (FAIL, PASS)"
    assert render_ci_summary(None) == ("", [])


def _wf() -> Workflow:
    return Workflow.model_validate(
        {
            "id": "coding/new-task-v1",
            "version": "1.0.0",
            "domain": "coding",
            "requires_repo": True,
            "prompt": {"template": "x"},
            "hydration": {"sources": ["task_description"]},
            "agent_config": {
                "tier": "standard",
                "allowed_tools": ["Bash"],
                "cedar_policy_modules": ["builtin/hard_deny"],
            },
            "steps": [
                {"kind": "run_agent", "name": "implement"},
                {"kind": "verify_build", "name": "build"},
                {"kind": "ensure_pr", "strategy": "create"},
            ],
            "terminal_outcomes": {"primary": "pr_url"},
            "convergence": {
                "mode": "test_gated",
                "required_sensors": ["verify_build"],
                "terminal_outcomes": ["pr_opened"],
                "max_fixup_rounds": 2,
            },
            "status": "production",
        }
    )


def _run_rounds(results, *, ci_wait_timeout_s=1800, shas=("s1", "s2", "s3", "s4")):
    config = SimpleNamespace(
        ci_wait_timeout_s=ci_wait_timeout_s,
        ci_required_checks=["ci", "deployment:Preview"],
        repo_url="o/r",
        task_id="t1",
        max_budget_usd=None,
    )
    setup = RepoSetup(repo_dir="/w/repo", branch="bgagent/t1/x")
    agent = AgentResult(status="success", turns=5, num_turns=5, cost_usd=1.0, session_id="sess-1")

    async def _fake_run_agent(*_a, **_kw):
        return AgentResult(
            status="success", turns=2, num_turns=2, cost_usd=0.25, session_id="sess-2"
        )

    run_agent = MagicMock(side_effect=_fake_run_agent)
    with (
        patch("ci_wait.wait_for_ci", side_effect=results) as waited,
        patch("ci_wait.ci_comments_for", return_value=["<!-- feval-ci sha=s1 result=fail -->"]),
        patch("runner.run_agent", run_agent),
        patch("pipeline._head_sha", side_effect=list(shas)),
        patch("pipeline._pr_head_sha", return_value=""),
        patch("pipeline.reconcile_agent_branch"),
        patch("pipeline.ensure_committed"),
        patch("pipeline.ensure_pushed") as pushed,
        patch("pipeline.task_state.get_task", return_value={"status": "RUNNING"}),
    ):
        out_agent, ci = _run_ci_rounds(
            agent,
            workflow=_wf(),
            config=config,
            setup=setup,
            pr_url="https://github.com/o/r/pull/9",
            system_prompt="sys",
            trajectory=None,
            progress=MagicMock(),
        )
    if ci_wait_timeout_s:
        pushed.assert_called()  # always push before waiting
    return out_agent, ci, run_agent, waited


class TestCiRounds:
    def test_waits_on_the_prs_head_from_github_not_local_head(self):
        config = SimpleNamespace(
            ci_wait_timeout_s=600,
            ci_required_checks=[],
            repo_url="o/r",
            task_id="t",
            max_budget_usd=None,
        )
        setup = RepoSetup(repo_dir="/w/repo", branch="b")
        agent = AgentResult(status="success", session_id="s")
        green = CiResult("pass", "remote1", [_chk("ci", "success")])
        with (
            patch("ci_wait.wait_for_ci", return_value=green) as waited,
            patch("pipeline._pr_head_sha", return_value="remote1") as pr_head,
            patch("pipeline._head_sha", return_value="local-unpushed"),
            patch("pipeline.ensure_pushed") as pushed,
        ):
            _run_ci_rounds(
                agent,
                workflow=_wf(),
                config=config,
                setup=setup,
                pr_url="https://github.com/o/r/pull/9",
                system_prompt="s",
                trajectory=None,
                progress=MagicMock(),
            )
        pushed.assert_called_once_with("/w/repo", "b")
        pr_head.assert_called_once_with("o/r", "9", "/w/repo")
        assert waited.call_args.args[1] == "remote1"

    def test_off_by_default(self):
        _a, ci, run_agent, _w = _run_rounds([], ci_wait_timeout_s=0)
        assert ci is None
        run_agent.assert_not_called()

    def test_green_ci_needs_no_round(self):
        _a, ci, run_agent, waited = _run_rounds([CiResult("pass", "s1", [_chk("ci", "success")])])
        assert ci is not None and ci.rounds == 0 and ci.final.state == "pass"
        assert waited.call_args.kwargs["required"] == ["ci", "deployment:Preview"]
        run_agent.assert_not_called()

    def test_red_then_green_in_one_session(self):
        red = CiResult("fail", "s1", [_chk("ci", "failure", "e2e 4/7")])
        green = CiResult("pass", "s2", [_chk("ci", "success")])
        agent, ci, run_agent, waited = _run_rounds([red, green], shas=("s1", "s2", "s2"))
        assert (
            ci is not None and ci.rounds == 1 and [r.state for r in ci.results] == ["fail", "pass"]
        )
        assert run_agent.call_args.kwargs["resume_session_id"] == "sess-1"
        prompt = run_agent.call_args.args[0]
        assert "e2e 4/7" in prompt and "feval-ci sha=s1" in prompt
        assert waited.call_args_list[1].args[1] == "s2"  # re-waits on the NEW head
        assert agent.cost_usd == pytest.approx(1.25) and agent.session_id == "sess-2"

    def test_stays_red_after_max_rounds(self):
        reds = [CiResult("fail", f"s{i}", [_chk("ci", "failure")]) for i in range(1, 4)]
        _a, ci, run_agent, _w = _run_rounds(reds, shas=("s1", "s2", "s2", "s3", "s3"))
        assert ci is not None and ci.rounds == 2 and ci.final.state == "fail"
        assert ci.stopped_reason == "max fix-up rounds reached" and run_agent.call_count == 2

    def test_agent_pushes_nothing_stops(self):
        red = CiResult("fail", "s1", [_chk("ci", "failure")])
        _a, ci, _r, _w = _run_rounds([red], shas=("s1", "s1"))
        assert ci is not None and ci.rounds == 1 and "pushed no change" in ci.stopped_reason
