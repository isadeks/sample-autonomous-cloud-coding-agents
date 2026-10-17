"""Convergence rounds after the agent's turn (``convergence.py``).

Pins, against a small fake "world" (the PR head on GitHub, CI per commit, what
the agent pushes per round) rather than call counts:
- local build rounds resume the session with the failing output and stop on
  green / round cap / budget / turns / push failure;
- CI rounds re-wait on the PR's new head, carry cost/turns/session, and leave
  the task's agent status alone;
- a round where the agent pushes nothing checks its "unrelated" claim against
  the base commit (refuted → another round with the evidence);
- the baseline probe reads existing base CI first and only pushes (and always
  deletes) ``abca-baseline/<task_id>`` when the repo opts in;
- the task verdict: red CI, and required checks without a verdict, block success;
- the pre-push check resumes the session on a genuine failure, commits without
  pushing, draws on one task-wide round budget, and runs again before each CI
  fix-up push.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

import convergence
from ci_wait import BaselineProbe, CiConvergence, CiResult
from convergence import (
    PREPUSH_MAX_ROUNDS,
    PrepushResult,
    RoundContext,
    ci_failure_message,
    probe_baseline,
    render_prepush_summary,
    run_ci_rounds,
    run_fixup_rounds,
    run_prepush_rounds,
)
from models import AgentResult, RepoSetup, TaskConfig
from pipeline import _resolve_overall_task_status
from post_hooks import VerifyOutcome

PR_URL = "https://github.com/o/r/pull/9"


def _config(**over) -> TaskConfig:
    base: dict[str, Any] = {
        "repo_url": "o/r",
        "task_id": "01TASKTASKTASKTASKTASKTASK",
        "github_token": "x",
        "aws_region": "us-east-1",
        "max_turns": 100,
        "build_command": "npm test",
        "ci_wait_timeout_s": 1800,
        "ci_required_checks": ["ci/build"],
    }
    base.update(over)
    return TaskConfig(**base)


def _agent(**over) -> AgentResult:
    base: dict[str, Any] = {
        "status": "success",
        "turns": 10,
        "num_turns": 10,
        "cost_usd": 1.0,
        "session_id": "s-1",
    }
    base.update(over)
    return AgentResult(**base)


def _ctx(
    config: TaskConfig | None = None, repo_dir: str = "/w/repo", max_rounds: int = 2
) -> RoundContext:
    return RoundContext(
        config=config or _config(),
        setup=RepoSetup(repo_dir=repo_dir, branch="bgagent/t/x", default_branch="main"),
        system_prompt="sys",
        trajectory=None,
        progress=MagicMock(),
        max_rounds=max_rounds,
    )


@dataclass
class World:
    """The PR on GitHub as the loop sees it."""

    head: str = "c1"
    ci: dict[str, str] = field(default_factory=lambda: {"c1": "fail"})  # sha -> pass|fail|none
    # what the agent pushes in each resumed round (None = pushes nothing)
    pushes: list[str | None] = field(default_factory=list)
    push_ok: bool = True
    prompts: list[str] = field(default_factory=list)
    resumed_with: list[dict] = field(default_factory=list)

    async def run_agent(self, prompt, *_a, **kw):
        self.prompts.append(prompt)
        self.resumed_with.append(kw)
        new = self.pushes.pop(0) if self.pushes else None
        if new:
            self.head = new
        return AgentResult(
            status="error_max_turns",
            turns=2,
            num_turns=2,
            cost_usd=0.25,
            session_id=f"s-{len(self.prompts) + 1}",
        )

    def wait_for_ci(self, _repo, sha, *_a, **_kw):
        state = self.ci.get(sha, "none")
        check = {
            "name": "ci/build",
            "state": "failure" if state == "fail" else "success",
            "url": "",
            "detail": f"on {sha}",
        }
        return CiResult(state, sha, [check] if state != "none" else [])


def _ci_rounds(world: World, ctx: RoundContext | None = None, probe: BaselineProbe | None = None):
    agent = _agent()
    ctx = ctx or _ctx()
    with (
        patch("runner.run_agent", side_effect=world.run_agent),
        patch("convergence.wait_for_ci", side_effect=world.wait_for_ci),
        patch("convergence.pr_head_sha", side_effect=lambda *_a: world.head),
        patch("convergence.head_sha", return_value=""),
        patch("convergence.ensure_pushed", side_effect=lambda *_a: world.push_ok),
        patch("convergence.reconcile_agent_branch"),
        patch("convergence.ensure_committed"),
        patch("convergence.ci_comments_for", return_value=[]),
        patch("convergence._task_cancelled", return_value=False),
        patch(
            "convergence.probe_baseline",
            return_value=probe or BaselineProbe("unverified", "main", reason="no base CI"),
        ),
    ):
        ci = run_ci_rounds(agent, ctx, PR_URL)
    return agent, ci


class TestCiRounds:
    @pytest.fixture(autouse=True)
    def _no_handoff(self, monkeypatch):
        # the handoff turn is covered by TestHandoff; keep these tests about the rounds
        self.handoffs: list[tuple] = []
        monkeypatch.setattr(convergence, "_post_handoff", lambda *a: self.handoffs.append(a))

    def test_off_without_a_wait_timeout(self):
        world = World()
        _agent_result, ci = _ci_rounds(world, _ctx(_config(ci_wait_timeout_s=0)))
        assert ci is None and world.prompts == []

    def test_green_ci_needs_no_round(self):
        world = World(ci={"c1": "pass"})
        _a, ci = _ci_rounds(world)
        assert (
            ci is not None and ci.rounds == 0 and ci.final.state == "pass" and world.prompts == []
        )

    def test_red_then_green_on_the_new_pr_head_in_the_same_session(self):
        world = World(ci={"c1": "fail", "c2": "pass"}, pushes=["c2"])
        agent, ci = _ci_rounds(world)
        assert ci is not None and ci.rounds == 1 and [r.sha for r in ci.results] == ["c1", "c2"]
        assert world.resumed_with[0]["resume_session_id"] == "s-1"
        assert "on c1" in world.prompts[0]
        assert agent.cost_usd == pytest.approx(1.25) and agent.session_id == "s-2"
        # a resumed turn's own status does not decide the task: the sensors do
        assert agent.status == "success"

    def test_resumed_calls_get_what_is_left_of_turns_and_budget(self):
        world = World(ci={"c1": "fail", "c2": "pass"}, pushes=["c2"])
        _ci_rounds(world, _ctx(_config(max_budget_usd=3.0)))
        assert world.resumed_with[0]["max_turns"] == 90
        assert world.resumed_with[0]["max_budget_usd"] == pytest.approx(2.0)
        # live progress events continue the task's totals instead of restarting at 0
        assert world.resumed_with[0]["prior_turns"] == 10
        assert world.resumed_with[0]["prior_cost_usd"] == pytest.approx(1.0)

    def test_stays_red_until_the_round_cap(self):
        world = World(ci={"c1": "fail", "c2": "fail", "c3": "fail"}, pushes=["c2", "c3"])
        _a, ci = _ci_rounds(world)
        assert (
            ci is not None and ci.rounds == 2 and ci.stopped_reason == "max fix-up rounds reached"
        )

    def test_no_round_when_the_turns_are_spent(self):
        world = World()
        agent = _agent(num_turns=98)
        with (
            patch("convergence.wait_for_ci", side_effect=world.wait_for_ci),
            patch("convergence.pr_head_sha", side_effect=lambda *_a: world.head),
            patch("convergence.head_sha", return_value=""),
            patch("convergence.ensure_pushed", return_value=True),
            patch("convergence._task_cancelled", return_value=False),
        ):
            ci = run_ci_rounds(agent, _ctx(), PR_URL)
        assert ci is not None and ci.rounds == 0 and ci.stopped_reason == "turn limit reached"

    def test_a_failed_push_ends_the_round(self):
        world = World(pushes=["c2"])
        world.ci["c2"] = "pass"
        calls = iter([True, False])  # initial push ok, push after the fix fails
        with patch("convergence.ensure_pushed", side_effect=lambda *_a: next(calls)):
            agent = _agent()
            with (
                patch("runner.run_agent", side_effect=world.run_agent),
                patch("convergence.wait_for_ci", side_effect=world.wait_for_ci),
                patch("convergence.pr_head_sha", side_effect=lambda *_a: world.head),
                patch("convergence.head_sha", return_value=""),
                patch("convergence.reconcile_agent_branch"),
                patch("convergence.ensure_committed"),
                patch("convergence.ci_comments_for", return_value=[]),
                patch("convergence._task_cancelled", return_value=False),
            ):
                ci = run_ci_rounds(agent, _ctx(), PR_URL)
        assert ci is not None and ci.stopped_reason == "push failed" and len(ci.results) == 1

    def test_unverified_claim_stops(self):
        world = World(pushes=[None])
        _a, ci = _ci_rounds(world)
        assert (
            ci is not None
            and ci.rounds == 1
            and "claim unverified (no base CI)" in ci.stopped_reason
        )

    def test_refuted_claim_goes_back_with_the_evidence_then_converges(self):
        world = World(ci={"c1": "fail", "c2": "pass"}, pushes=[None, "c2"])
        refuted = BaselineProbe(
            "refuted", "main", "base123456789", CiResult("pass", "base123456789")
        )
        _a, ci = _ci_rounds(world, probe=refuted)
        assert ci is not None and ci.rounds == 2 and ci.final.state == "pass"
        assert "PASS there and FAIL on your branch" in world.prompts[1]
        # the refuted round reuses the red result instead of re-waiting on the same head
        assert [r.sha for r in ci.results] == ["c1", "c2"]

    def test_confirmed_preexisting_failure_stops(self):
        world = World(pushes=[None])
        _a, ci = _ci_rounds(world, probe=BaselineProbe("confirmed", "main", "b1"))
        assert (
            ci is not None and ci.stopped_reason == "failure also on the base branch (pre-existing)"
        )
        assert len(world.prompts) == 1


class TestFixupRounds:
    def _run(
        self,
        outcomes: list[VerifyOutcome],
        *,
        ctx: RoundContext | None = None,
        agent=None,
        push_ok=True,
    ):
        world = World(pushes=["c2", "c3", "c4"])
        agent = agent or _agent()
        first, *rest = outcomes
        with (
            patch("runner.run_agent", side_effect=world.run_agent),
            patch("convergence.verify_build", side_effect=rest),
            patch("convergence.reconcile_agent_branch"),
            patch("convergence.ensure_committed"),
            patch("convergence.ensure_pushed", return_value=push_ok),
        ):
            outcome, fixup = run_fixup_rounds(first, agent, ctx or _ctx(), read_only=False)
        return outcome, fixup, world, agent

    FAIL = VerifyOutcome(passed=False, output_tail="FAIL src/a.test.ts\nexpected 2 got 1")
    PASS = VerifyOutcome(passed=True)

    def test_green_first_try_is_a_noop(self):
        outcome, fixup, world, _a = self._run([self.PASS])
        assert outcome.passed and fixup.rounds == 0 and world.prompts == []

    def test_report_only_without_rounds(self):
        outcome, fixup, world, _a = self._run([self.FAIL], ctx=_ctx(max_rounds=0))
        assert not outcome.passed and fixup.rounds == 0 and world.prompts == []

    def test_fixes_in_one_round_resuming_the_session(self):
        outcome, fixup, world, agent = self._run([self.FAIL, self.PASS])
        assert outcome.passed and fixup.history == [True] and fixup.stopped_reason == "build passed"
        assert world.resumed_with[0]["resume_session_id"] == "s-1"
        assert "expected 2 got 1" in world.prompts[0]
        assert agent.turns == 12 and agent.session_id == "s-2" and agent.status == "success"

    def test_stops_at_the_round_cap(self):
        outcome, fixup, _w, _a = self._run([self.FAIL, self.FAIL, self.FAIL])
        assert not outcome.passed and fixup.history == [False, False]
        assert fixup.stopped_reason == "max fix-up rounds reached"

    def test_pre_existing_red_build_is_not_chased(self):
        ctx = _ctx()
        ctx.setup = RepoSetup(repo_dir="/w/repo", branch="b", build_before=False)
        _o, fixup, world, _a = self._run([self.FAIL], ctx=ctx)
        assert (
            fixup.rounds == 0 and "already failing" in fixup.stopped_reason and world.prompts == []
        )

    def test_budget_exhausted(self):
        _o, fixup, world, _a = self._run([self.FAIL], ctx=_ctx(_config(max_budget_usd=1.0)))
        assert fixup.stopped_reason == "budget exhausted" and world.prompts == []

    def test_a_failed_push_stops(self):
        _o, fixup, _w, _a = self._run([self.FAIL, self.PASS], push_ok=False)
        assert fixup.rounds == 1 and fixup.stopped_reason == "push failed" and fixup.history == []


def _git(repo, *args) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@x", *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout


@pytest.fixture
def clone(tmp_path):
    """A bare origin with `main` and a working clone on a PR branch."""
    origin, work = tmp_path / "origin.git", tmp_path / "work"
    subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(origin)], check=True)
    subprocess.run(["git", "clone", "-q", str(origin), str(work)], check=True, capture_output=True)
    (work / "a.txt").write_text("a\n")
    _git(work, "add", "-A")
    _git(work, "commit", "-qm", "base")
    _git(work, "push", "-q", "origin", "HEAD:main")
    _git(work, "checkout", "-qb", "bgagent/t/x")
    return origin, work


HEAD_RED = CiResult("fail", "h1", [{"name": "ci/e2e", "state": "failure", "url": "", "detail": ""}])


class TestProbeBaseline:
    def _probe(self, work, *, opt_in: bool, base_checks: list[dict], on_wait=None):
        ctx = _ctx(_config(ci_baseline_probe=opt_in), repo_dir=str(work))
        green = CiResult(
            "pass", "", [{"name": "ci/e2e", "state": "success", "url": "", "detail": ""}]
        )

        def _wait(_repo, sha, *_a, **_kw):
            if on_wait:
                on_wait()
            return CiResult("pass", sha, green.checks)

        with (
            patch("convergence.collect_checks", return_value=base_checks),
            patch("convergence.wait_for_ci", side_effect=_wait) as waited,
        ):
            probe = probe_baseline(ctx, HEAD_RED, deadline=10**12, cancelled=lambda: False)
        return probe, waited

    def test_uses_ci_already_on_the_base_commit_without_pushing(self, clone):
        origin, work = clone
        probe, waited = self._probe(
            work,
            opt_in=True,
            base_checks=[{"name": "ci/e2e", "state": "pending", "url": "", "detail": ""}],
        )
        assert probe.verdict == "refuted" and waited.call_count == 1
        assert "abca-baseline" not in _git(origin, "branch", "-a")

    def test_pushes_the_probe_branch_only_when_opted_in_and_always_deletes_it(self, clone):
        origin, work = clone
        seen: list[str] = []
        probe, _w = self._probe(
            work,
            opt_in=True,
            base_checks=[],
            on_wait=lambda: seen.append(_git(origin, "branch", "-a")),
        )
        assert (
            probe.verdict == "refuted"
            and probe.base_sha == _git(origin, "rev-parse", "main").strip()
        )
        assert "abca-baseline/01TASKTASKTASKTASKTASKTASK" in seen[0]
        assert "abca-baseline" not in _git(origin, "branch", "-a")

    def test_without_opt_in_and_without_base_ci_the_claim_is_unverified(self, clone):
        _origin, work = clone
        probe, waited = self._probe(work, opt_in=False, base_checks=[])
        assert probe.verdict == "unverified" and "no CI results" in probe.reason
        assert waited.call_count == 0

    def test_a_failed_probe_push_is_unverified(self, clone):
        _origin, work = clone
        _git(work, "remote", "set-url", "--push", "origin", str(work.parent / "missing.git"))
        probe, waited = self._probe(work, opt_in=True, base_checks=[])
        assert probe.verdict == "unverified" and probe.reason == "probe push failed"
        assert waited.call_count == 0


def _conv(
    state: str, *, probe: BaselineProbe | None = None, rounds: int = 1, checks=None
) -> CiConvergence:
    checks = (
        checks
        if checks is not None
        else [
            {
                "name": "ci/build",
                "state": "failure" if state == "fail" else "success",
                "url": "",
                "detail": "",
            }
        ]
    )
    return CiConvergence(rounds=rounds, results=[CiResult(state, "c1", checks)], probe=probe)


class TestCiFailureMessage:
    def test_green_or_no_wait_does_not_block(self):
        assert ci_failure_message(None, ["ci/build"]) is None
        assert ci_failure_message(_conv("pass"), ["ci/build"]) is None

    def test_red_blocks(self):
        msg = ci_failure_message(_conv("fail"), [])
        assert msg is not None and msg.startswith("ci_ok=False: CI checks failing")

    def test_red_with_a_confirmed_preexisting_failure(self):
        msg = ci_failure_message(_conv("fail", probe=BaselineProbe("confirmed", "main")), [])
        assert msg is not None and msg.startswith("ci_ok=preexisting")

    def test_red_with_a_refuted_claim(self):
        msg = ci_failure_message(_conv("fail", probe=BaselineProbe("refuted", "main")), [])
        assert msg is not None and "refuted" in msg

    @pytest.mark.parametrize(
        ("state", "marker"), [("none", "unknown"), ("error", "unknown"), ("timeout", "timeout")]
    )
    def test_no_verdict_blocks_only_when_checks_are_required(self, state, marker):
        conv = _conv(state, checks=[])
        assert ci_failure_message(conv, []) is None
        msg = ci_failure_message(conv, ["ci/build"])
        assert msg is not None and msg.startswith(f"ci_ok={marker}") and "ci/build" in msg

    def test_wait_never_started_blocks_when_required(self):
        conv = CiConvergence(stopped_reason="push failed")
        assert (
            ci_failure_message(conv, ["ci/build"])
            == "ci_ok=unknown: CI was not waited on (push failed)"
        )


def test_task_status_ci_error_turns_success_into_error():
    status, err = _resolve_overall_task_status(
        _agent(), build_ok=True, pr_url=PR_URL, ci_error="ci_ok=False: x"
    )
    assert (status, err) == ("error", "ci_ok=False: x")
    assert _resolve_overall_task_status(_agent(), build_ok=True, pr_url=PR_URL)[0] == "success"


def test_progress_is_reported_during_a_long_wait():
    ctx = _ctx()
    convergence._progress_reporter(ctx, "abcdef123456")(
        300, [{"name": "ci/build", "state": "pending"}]
    )
    ctx.progress.write_agent_milestone.assert_called_once_with(
        "ci_wait_progress", "sha=abcdef123 waited=300s pending=ci/build"
    )


class TestHandoff:
    """A PR still red after the rounds gets ONE tagged comment saying what ABCA needs."""

    def _ctx(self, tmp_path):
        config = TaskConfig(
            repo_url="o/r", task_id="t1", max_turns=100, github_token="x", aws_region="us-east-1"
        )
        setup = RepoSetup(repo_dir=str(tmp_path), branch="bgagent/t1/x")
        return convergence.RoundContext(config, setup, "sys", None, MagicMock(), 2)

    def _red(self):
        return CiResult(
            "fail",
            "abc1234567",
            [{"name": "ci/integrity", "state": "failure", "url": "u", "detail": "1 finding"}],
        )

    def test_agent_writes_the_handoff_and_it_is_posted_tagged(self, tmp_path):
        ci = CiConvergence(rounds=2, results=[self._red()])
        agent = AgentResult(status="success", session_id="s", turns=10, num_turns=10, cost_usd=1.0)

        async def _turn(*_a, **kw):
            assert kw["resume_session_id"] == "s" and kw["max_turns"] <= 3
            return AgentResult(
                status="success", result_text="**Needs your decision:** approve X?", cost_usd=0.02
            )

        posted = []
        with (
            patch("runner.run_agent", side_effect=_turn),
            patch("convergence.ci_comments_for", return_value=[]),
            patch("convergence.try_cmd"),
            patch("convergence.post_pr_handoff", side_effect=lambda *a: posted.append(a) or True),
        ):
            convergence._post_handoff(self._ctx(tmp_path), agent, ci, "7")
        assert posted[0][:2] == ("o/r", "7") and "approve X?" in posted[0][2]
        assert agent.cost_usd == pytest.approx(1.02)

    def test_falls_back_to_the_failing_checks_when_the_agent_cannot_resume(self, tmp_path):
        ci = CiConvergence(rounds=2, results=[self._red()])
        agent = AgentResult(status="success", session_id="")  # nothing to resume
        posted = []
        with patch("convergence.post_pr_handoff", side_effect=lambda *a: posted.append(a) or True):
            convergence._post_handoff(self._ctx(tmp_path), agent, ci, "7")
        assert "`ci/integrity`: 1 finding" in posted[0][2] and "abc123456" in posted[0][2]


def test_post_pr_handoff_tags_the_comment():
    from handoff import ABCA_COMMENT_TAG, post_pr_handoff

    with patch("handoff.try_cmd", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
        assert post_pr_handoff("o/r", "7", "body", "/w")
    body = run.call_args.args[0][run.call_args.args[0].index("--body") + 1]
    assert body.startswith(ABCA_COMMENT_TAG) and "body" in body


def test_approval_question_for_editing_an_existing_test():
    from handoff import approval_question

    q = approval_question(
        "Edit",
        {"file_path": "/w/e2e/a.e2e-spec.ts", "old_string": "a\nb", "new_string": "a\nb\nc"},
        ["modify_existing_test"],
        "/w",
    )
    assert q == "Allow changing the existing test `e2e/a.e2e-spec.ts`? (replaces 2 line(s) with 3)"
    assert approval_question("Bash", {}, ["force_push_any"], "/w") == ""


class TestPrepushRounds:
    FAIL = VerifyOutcome(passed=False, output_tail="UI check library-info: expected 'Lib' got ''")
    PASS = VerifyOutcome(passed=True)

    def _ctx(self, **config_over) -> RoundContext:
        ctx = _ctx(_config(prepush_command=".abca/preview.sh test", **config_over))
        ctx.prepush = PrepushResult()
        return ctx

    def _run(self, outcomes: list[VerifyOutcome], ctx: RoundContext | None = None, agent=None):
        world = World()
        ctx = ctx or self._ctx()
        agent = agent or _agent()
        with (
            patch("runner.run_agent", side_effect=world.run_agent),
            patch("convergence.verify_prepush", side_effect=outcomes) as check,
            patch("convergence.reconcile_agent_branch"),
            patch("convergence.ensure_committed") as commit,
            patch("convergence.ensure_pushed") as push,
        ):
            run_prepush_rounds(ctx, agent)
        return ctx.prepush, world, check, commit, push

    def test_noop_without_a_check(self):
        ctx = _ctx()
        with patch("convergence.verify_prepush") as check:
            run_prepush_rounds(ctx, _agent())
        check.assert_not_called()

    def test_green_needs_no_round(self):
        state, world, _check, _commit, push = self._run([self.PASS])
        assert state.runs == ["pass"] and state.rounds == 0 and world.prompts == []
        push.assert_not_called()

    def test_failure_goes_back_to_the_session_and_is_committed_not_pushed(self):
        state, world, check, commit, push = self._run([self.FAIL, self.PASS])
        assert state.runs == ["fail", "pass"] and state.rounds == 1
        assert state.stopped_reason == "check passed"
        assert world.resumed_with[0]["resume_session_id"] == "s-1"
        assert "expected 'Lib' got ''" in world.prompts[0]
        assert "Do not push" in world.prompts[0]
        assert check.call_args.args == ("/w/repo", ".abca/preview.sh test")
        commit.assert_called_once()
        push.assert_not_called()

    def test_only_genuine_failures_go_back(self):
        for outcome, verdict in (
            (VerifyOutcome(passed=False, timed_out=True), "timeout"),
            (VerifyOutcome(passed=False, inert=True), "inert"),
            (VerifyOutcome(passed=False, infra_failed=True), "infra"),
        ):
            state, world, *_ = self._run([outcome])
            assert state.runs == [verdict] and state.stopped_reason == f"check {verdict}"
            assert world.prompts == []

    def test_rounds_come_from_one_budget_for_the_task(self):
        ctx = self._ctx()
        fails = [self.FAIL] * (PREPUSH_MAX_ROUNDS + 1)
        state, world, *_ = self._run(fails, ctx)
        assert state.rounds == PREPUSH_MAX_ROUNDS and len(world.prompts) == PREPUSH_MAX_ROUNDS
        assert state.stopped_reason == "max pre-push rounds reached"
        # spent: a later push point does not run the check again
        state, world, check, *_ = self._run([self.PASS], ctx)
        check.assert_not_called()

    def test_no_round_without_turns_left(self):
        state, world, *_ = self._run([self.FAIL], agent=_agent(num_turns=98))
        assert state.runs == ["fail"] and state.stopped_reason == "turn limit reached"
        assert world.prompts == []

    def test_runs_before_each_ci_fixup_push(self):
        world = World(ci={"c1": "fail", "c2": "pass"}, pushes=["c2"])
        ctx = self._ctx()
        order: list[str] = []

        def check(*_a):
            order.append("check")
            return self.PASS

        def push(*_a):
            order.append("push")
            return True

        with (
            patch("runner.run_agent", side_effect=world.run_agent),
            patch("convergence.verify_prepush", side_effect=check),
            patch("convergence.ensure_pushed", side_effect=push),
            patch("convergence.wait_for_ci", side_effect=world.wait_for_ci),
            patch("convergence.pr_head_sha", side_effect=lambda *_a: world.head),
            patch("convergence.head_sha", return_value=""),
            patch("convergence.reconcile_agent_branch"),
            patch("convergence.ensure_committed"),
            patch("convergence.ci_comments_for", return_value=[]),
            patch("convergence._task_cancelled", return_value=False),
            patch("convergence._post_handoff"),
        ):
            ci = run_ci_rounds(_agent(), ctx, PR_URL)
        assert ci is not None and ci.final is not None and ci.final.state == "pass"
        # the push of the open PR, then: CI fix-up -> check -> push
        assert order == ["push", "check", "push"]
        # the agent commits the CI fix and leaves the push to the platform
        assert "do NOT push" in world.prompts[0]
        assert ctx.prepush is not None and ctx.prepush.runs == ["pass"]

    def test_pr_summary(self):
        assert render_prepush_summary(None, "x") == ("", [])
        assert render_prepush_summary(PrepushResult(), "x") == ("", [])
        summary, details = render_prepush_summary(
            PrepushResult(runs=["fail", "pass"], rounds=1), ".abca/preview.sh test"
        )
        assert summary == "pre-push ✅"
        assert details == [
            "- Pre-push check: `.abca/preview.sh test` → PASS (runs: fail, pass; "
            "1 fix-up round(s); feedback for the agent, CI is the gate)"
        ]
        assert render_prepush_summary(PrepushResult(runs=["timeout"]), "x")[0] == "pre-push ⚠️"


class TestCiHead:
    """The PR head GitHub reports lags a push by a few seconds."""

    def test_waits_for_github_to_show_the_pushed_commit(self):
        heads = iter(["old", "old", "new"])
        sleeps: list[float] = []
        with (
            patch("convergence.head_sha", return_value="new"),
            patch("convergence.pr_head_sha", side_effect=lambda *_a: next(heads)),
        ):
            from convergence import _ci_head

            assert _ci_head(_ctx(), "7", sleep=sleeps.append) == "new"
        assert len(sleeps) == 2

    def test_uses_githubs_head_when_it_never_matches(self):
        sleeps: list[float] = []
        with (
            patch("convergence.head_sha", return_value="local"),
            patch("convergence.pr_head_sha", return_value="remote"),
        ):
            from convergence import PR_HEAD_SYNC_POLLS, _ci_head

            assert _ci_head(_ctx(), "7", sleep=sleeps.append) == "remote"
        assert len(sleeps) == PR_HEAD_SYNC_POLLS - 1
