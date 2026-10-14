"""Convergence fix-up loop (``convergence.max_fixup_rounds``, test_gated workflows).

Pins: which failures go back to the agent and which do not, that the fix-up
turn RESUMES the agent's session with the failing output, that cost/turns
accumulate, that the loop stops on green / on the round cap / on budget, and
that workflows without the knob keep the v1 report-only gate.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from fixup import (
    build_fixup_prompt,
    fixup_skip_reason,
    max_fixup_rounds,
    remaining_budget,
)
from models import AgentResult, RepoSetup
from pipeline import _run_fixup_rounds
from post_hooks import (
    VERIFICATION_END,
    VERIFICATION_START,
    VerifyOutcome,
    _output_tail,
    render_verification_section,
)
from workflow import Workflow, load_workflow


def _wf(convergence: dict | None) -> Workflow:
    body = {
        "id": "coding/new-task-v1",
        "version": "1.0.0",
        "domain": "coding",
        "requires_repo": True,
        "prompt": {"template": "do the thing"},
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
        "status": "production",
    }
    if convergence is not None:
        body["convergence"] = convergence
    return Workflow.model_validate(body)


_GATED = {
    "mode": "test_gated",
    "required_sensors": ["verify_build"],
    "terminal_outcomes": ["pr_opened"],
}


def _config(**over):
    base = {
        "build_command": "npm test",
        "lint_command": "",
        "max_budget_usd": None,
        "task_id": "t1",
    }
    base.update(over)
    return SimpleNamespace(**base)


def _setup(build_before: bool = True) -> RepoSetup:
    return RepoSetup(repo_dir="/w/repo", branch="bgagent/t1/x", build_before=build_before)


def _agent(
    *,
    status: str = "success",
    turns: int = 10,
    num_turns: int = 10,
    cost_usd: float = 1.0,
    session_id: str = "s-1",
) -> AgentResult:
    return AgentResult(
        status=status, turns=turns, num_turns=num_turns, cost_usd=cost_usd, session_id=session_id
    )


FAIL = VerifyOutcome(passed=False, output_tail="FAIL src/a.test.ts\nexpected 2 got 1")
PASS = VerifyOutcome(passed=True)


class TestMaxFixupRounds:
    def test_default_is_zero(self):
        assert max_fixup_rounds(_wf(_GATED)) == 0
        assert max_fixup_rounds(_wf(None)) == 0
        assert max_fixup_rounds(None) == 0

    def test_test_gated_with_rounds(self):
        assert max_fixup_rounds(_wf({**_GATED, "max_fixup_rounds": 2})) == 2

    def test_non_test_gated_mode_never_loops(self):
        conv = {
            "mode": "artifact_delivered",
            "terminal_outcomes": ["artifact_delivered"],
            "max_fixup_rounds": 3,
        }
        assert max_fixup_rounds(_wf(conv)) == 0

    def test_out_of_range_rejected(self):
        with pytest.raises(ValueError):
            _wf({**_GATED, "max_fixup_rounds": 9})

    @pytest.mark.parametrize("wf_id", ["coding/new-task-v1", "coding/pr-iteration-v1"])
    def test_shipped_coding_workflows_opt_in(self, wf_id):
        assert max_fixup_rounds(load_workflow(wf_id)) == 2

    def test_review_workflow_does_not_loop(self):
        assert max_fixup_rounds(load_workflow("coding/pr-review-v1")) == 0


class TestSkipReason:
    def _r(self, outcome, **over):
        kw = {
            "build_before": True,
            "read_only": False,
            "session_id": "s",
            "agent_status": "success",
        }
        kw.update(over)
        return fixup_skip_reason(outcome, **kw)

    def test_genuine_regression_goes_back(self):
        assert self._r(FAIL) == ""

    @pytest.mark.parametrize(
        ("outcome", "over", "needle"),
        [
            (PASS, {}, "passed"),
            (VerifyOutcome(passed=False, inert=True), {}, "inert"),
            (VerifyOutcome(passed=False, timed_out=True), {}, "timed out"),
            (VerifyOutcome(passed=False, infra_failed=True), {}, "infrastructure"),
            (FAIL, {"build_before": False}, "already failing"),
            (FAIL, {"read_only": True}, "read-only"),
            (FAIL, {"session_id": ""}, "session"),
            (FAIL, {"agent_status": "error_max_turns"}, "error_max_turns"),
        ],
    )
    def test_not_the_agents_code(self, outcome, over, needle):
        assert needle in self._r(outcome, **over)


def test_prompt_carries_command_and_output_as_data():
    p = build_fixup_prompt("npm test", "boom\nline2", 1, 2)
    assert "`npm test`" in p and "boom\nline2" in p and "round 1 of 2" in p
    assert "untrusted" in p and "Do not weaken, skip or delete" in p


def test_remaining_budget():
    assert remaining_budget(None, 3.0) is None
    assert remaining_budget(5.0, 3.0) == 2.0
    assert remaining_budget(5.0, 7.0) == 0.0


def test_output_tail_keeps_last_lines():
    result = subprocess.CompletedProcess(
        [], 1, stdout="\n".join(f"l{i}" for i in range(300)), stderr="err"
    )
    tail = _output_tail(result, max_lines=5)
    assert tail.splitlines() == [
        "l295",
        "l296",
        "l297",
        "l298",
        "l299err",
    ]  # stderr joins the last line
    assert len(_output_tail(result).splitlines()) <= 150


def _run(outcomes, agent=None, wf=None, config=None, setup=None, fix_results=None):
    """Drive _run_fixup_rounds with verify_build/run_agent mocked."""
    first, *rest = outcomes
    fixes = fix_results or [_agent(cost_usd=0.5, turns=3, num_turns=3, session_id="s-2")] * 5

    async def _fake_run_agent(*_a, **_kw):
        return fixes[run_agent.call_count - 1]

    run_agent = MagicMock(side_effect=_fake_run_agent)
    with (
        patch("runner.run_agent", run_agent),
        patch("pipeline.verify_build", side_effect=rest),
        patch("pipeline.reconcile_agent_branch"),
        patch("pipeline.ensure_committed"),
        patch("pipeline.ensure_pushed") as pushed,
    ):
        out = _run_fixup_rounds(
            first,
            agent or _agent(),
            workflow=wf or _wf({**_GATED, "max_fixup_rounds": 2}),
            config=config or _config(),
            setup=setup or _setup(),
            system_prompt="sys",
            trajectory=None,
            progress=MagicMock(),
            read_only=False,
        )
    return out, run_agent, pushed


class TestLoop:
    def test_green_first_try_is_noop(self):
        (outcome, _agent_res, fixup), run_agent, _ = _run([PASS])
        assert outcome.passed and fixup.rounds == 0
        run_agent.assert_not_called()

    def test_report_only_when_not_opted_in(self):
        (outcome, _a, fixup), run_agent, _ = _run([FAIL], wf=_wf(_GATED))
        assert not outcome.passed and fixup.rounds == 0
        run_agent.assert_not_called()

    def test_fixes_in_one_round_resuming_the_session(self):
        (outcome, agent_res, fixup), run_agent, pushed = _run([FAIL, PASS])
        assert outcome.passed
        assert (
            fixup.rounds == 1 and fixup.history == [True] and fixup.stopped_reason == "build passed"
        )
        kwargs = run_agent.call_args.kwargs
        assert kwargs["resume_session_id"] == "s-1" and kwargs["cwd"] == "/w/repo"
        assert "expected 2 got 1" in run_agent.call_args.args[0]
        assert agent_res.cost_usd == pytest.approx(1.5) and agent_res.turns == 13
        assert agent_res.session_id == "s-2"
        pushed.assert_called_once_with("/w/repo", "bgagent/t1/x")

    def test_stops_at_round_cap(self):
        (outcome, _a, fixup), run_agent, _ = _run([FAIL, FAIL, FAIL])
        assert not outcome.passed and fixup.rounds == 2 and fixup.history == [False, False]
        assert fixup.stopped_reason == "max fix-up rounds reached"
        assert run_agent.call_count == 2
        # the second round resumes the session the first fix-up returned
        assert run_agent.call_args_list[1].kwargs["resume_session_id"] == "s-2"

    def test_pre_existing_red_build_is_not_chased(self):
        (_o, _a, fixup), run_agent, _ = _run([FAIL], setup=_setup(build_before=False))
        assert fixup.rounds == 0 and "already failing" in fixup.stopped_reason
        run_agent.assert_not_called()

    def test_budget_passed_down_and_exhaustion_stops(self):
        (_o, _a, fixup), run_agent, _ = _run([FAIL, PASS], config=_config(max_budget_usd=3.0))
        assert run_agent.call_args.kwargs["max_budget_usd"] == pytest.approx(2.0)
        (_o, _a, fixup), run_agent, _ = _run([FAIL], config=_config(max_budget_usd=1.0))
        assert fixup.rounds == 0 and fixup.stopped_reason == "budget exhausted"
        run_agent.assert_not_called()

    def test_fixup_agent_error_stops_without_raising(self):
        async def _boom(*_a, **_kw):
            raise RuntimeError("sdk died")

        with (
            patch("runner.run_agent", side_effect=_boom),
            patch("pipeline.verify_build"),
            patch("pipeline.log_error_cw"),
        ):
            outcome, _a, fixup = _run_fixup_rounds(
                FAIL,
                _agent(),
                workflow=_wf({**_GATED, "max_fixup_rounds": 2}),
                config=_config(),
                setup=_setup(),
                system_prompt="sys",
                trajectory=None,
                progress=MagicMock(),
                read_only=False,
            )
        assert not outcome.passed and fixup.rounds == 1 and "RuntimeError" in fixup.stopped_reason


class TestVerificationSection:
    def test_marked_and_reports_rounds(self):
        s = render_verification_section(
            _config(),
            True,
            True,
            fixup_rounds=2,
            fixup_history=[False, True],
            agent_result=_agent(),
        )
        assert s.startswith(VERIFICATION_START) and s.endswith(VERIFICATION_END)
        assert "`npm test` (post-agent): **PASS**" in s
        assert "**2** fix-up round(s)" in s and "FAIL, PASS" in s

    def test_inert_is_not_pass(self):
        s = render_verification_section(_config(), True, True, build_inert=True)
        build_line = s.splitlines()[3]
        assert "NOT VERIFIED" in build_line and "PASS" not in build_line
