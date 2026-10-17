"""Convergence after the agent's turn: local build fix-up rounds and PR CI/CD rounds.

Both loops resume the agent's OWN session (``run_agent(resume_session_id=...)``)
with the failing evidence, within what is left of the task's budget and turns,
then commit and push and re-check:

- ``run_fixup_rounds``: the post-agent ``verify_build`` gate (``fixup.py``).
- ``run_prepush_rounds``: the repo's ``prepush_command`` (e.g. its app started
  against the task's service containers, with UI checks and e2e tests), before
  the first push and before each CI fix-up push. Feedback only: it never
  decides the task's verdict, and its rounds come from one task-wide budget.
- ``run_ci_rounds``: the PR's statuses / check runs / deployments
  (``ci_wait.py``), when the repo sets ``ci_wait_timeout_s``. When the agent
  pushes nothing — its way of saying a failure is not caused by its change — the
  claim is checked against the same CI on the base commit (``probe_baseline``).

The task's ``agent_result`` accumulates cost/turns/session across rounds; its
``status`` stays the first run's, so the verdict comes from the final sensor
state, not from how a fix-up turn ended.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import runner
import task_state
from ci_wait import (
    BASELINE_BRANCH_PREFIX,
    CI_APPEAR_TIMEOUT_S,
    BaselineProbe,
    CiConvergence,
    CiResult,
    build_ci_fixup_prompt,
    ci_comments_for,
    collect_checks,
    failure_report,
    judge_claim,
    refutation_evidence,
    wait_for_ci,
)
from fixup import (
    MIN_FIXUP_BUDGET_USD,
    MIN_FIXUP_TURNS,
    FixupResult,
    build_fixup_prompt,
    build_prepush_prompt,
    fixup_skip_reason,
    log_round,
    remaining_budget,
    remaining_turns,
)
from handoff import (
    HANDOFF_MAX_TURNS,
    HANDOFF_MAX_WORDS,
    fallback_handoff,
    handoff_prompt,
    post_pr_handoff,
)
from post_hooks import (
    DEFAULT_BUILD_COMMAND,
    ensure_committed,
    ensure_pushed,
    reconcile_agent_branch,
    verify_build,
    verify_prepush,
)
from shell import log, log_error_cw, try_cmd

if TYPE_CHECKING:
    from collections.abc import Callable

    from models import AgentResult, RepoSetup, TaskConfig
    from post_hooks import VerifyOutcome

# The baseline probe never waits longer than this, whatever is left of the CI wait.
PROBE_MAX_S = 900

# Pre-push fix-up rounds over the whole task (before the PR and every CI round).
PREPUSH_MAX_ROUNDS = int(os.environ.get("PREPUSH_MAX_ROUNDS") or 3)
# How long to wait for GitHub to show a just-pushed commit as the PR head.
PR_HEAD_SYNC_POLLS = 12
PR_HEAD_SYNC_INTERVAL_S = 5


@dataclass
class PrepushResult:
    """What the pre-push check did over the task, for the PR's verification block."""

    # outcome of each run in order: pass, fail, timeout, inert or infra
    runs: list[str] = field(default_factory=list)
    # failures handed back to the agent
    rounds: int = 0
    stopped_reason: str = ""


@dataclass
class RoundContext:
    """What every convergence round needs about the task and its session."""

    config: TaskConfig
    setup: RepoSetup
    system_prompt: str
    trajectory: Any
    progress: Any
    max_rounds: int
    # set when the repo declares a pre-push check (and the workflow writes code)
    prepush: PrepushResult | None = None


def _resume_blocker(ctx: RoundContext, agent_result: AgentResult) -> str:
    """Why the agent cannot be resumed for another round ("" = it can)."""
    if not agent_result.session_id:
        return "no agent session to resume"
    budget = remaining_budget(ctx.config.max_budget_usd, agent_result.cost_usd)
    if budget is not None and budget < MIN_FIXUP_BUDGET_USD:
        return "budget exhausted"
    if remaining_turns(ctx.config.max_turns, _used_turns(agent_result)) < MIN_FIXUP_TURNS:
        return "turn limit reached"
    return ""


def _used_turns(agent_result: AgentResult) -> int:
    return agent_result.num_turns or agent_result.turns


def _accumulate(agent_result: AgentResult, fix: AgentResult) -> None:
    agent_result.cost_usd = (agent_result.cost_usd or 0.0) + (fix.cost_usd or 0.0)
    agent_result.turns += fix.turns
    agent_result.num_turns = (agent_result.num_turns or 0) + (fix.num_turns or 0)
    if fix.session_id:
        agent_result.session_id = fix.session_id


def _resume(ctx: RoundContext, agent_result: AgentResult, prompt: str) -> str:
    """Resume the agent with ``prompt``, then commit its work.

    Returns "" when the round ran, else why the loop must stop. Call
    ``_resume_blocker`` first.
    """
    config = ctx.config
    try:
        fix = asyncio.run(
            runner.run_agent(
                prompt,
                ctx.system_prompt,
                config,
                cwd=ctx.setup.repo_dir,
                trajectory=ctx.trajectory,
                resume_session_id=agent_result.session_id,
                max_budget_usd=remaining_budget(config.max_budget_usd, agent_result.cost_usd),
                max_turns=remaining_turns(config.max_turns, _used_turns(agent_result)),
                prior_turns=_used_turns(agent_result),
                prior_cost_usd=agent_result.cost_usd or 0.0,
            )
        )
    except Exception as e:
        log_error_cw(f"Convergence fix-up round failed: {e}", task_id=config.task_id or None)
        return f"fix-up agent error: {type(e).__name__}"
    _accumulate(agent_result, fix)
    if fix.status != "success":
        log("POST", f"Convergence: resumed turn ended with status={fix.status}")
    reconcile_agent_branch(ctx.setup.repo_dir, ctx.setup.branch)
    ensure_committed(ctx.setup.repo_dir)
    return ""


def _resume_and_push(
    ctx: RoundContext, agent_result: AgentResult, prompt: str, *, prepush: bool = False
) -> str:
    """Resume the agent with ``prompt``, commit, optionally run the pre-push check, push.

    Returns "" when the round ran and was pushed, else why the loop must stop.
    Call ``_resume_blocker`` first.
    """
    stop = _resume(ctx, agent_result, prompt)
    if stop:
        return stop
    if prepush:
        run_prepush_rounds(ctx, agent_result)
    if not ensure_pushed(ctx.setup.repo_dir, ctx.setup.branch):
        return "push failed"
    return ""


def _prepush_verdict(outcome: VerifyOutcome) -> str:
    if outcome.passed:
        return "pass"
    if outcome.timed_out:
        return "timeout"
    if outcome.inert:
        return "inert"
    if outcome.infra_failed:
        return "infra"
    return "fail"


def run_prepush_rounds(ctx: RoundContext, agent_result: AgentResult) -> None:
    """Run the repo's pre-push check; hand a genuine failure back to the agent and re-run.

    Commits the agent's fixes but never pushes: the caller pushes afterwards,
    whatever the check says (CI stays the gate). Only a genuine failure goes back
    to the agent; a timeout, an infrastructure kill or a command that cannot run
    stops the loop. Rounds come from one budget for the whole task
    (``PREPUSH_MAX_ROUNDS``); once it is spent the check is not run again.
    No-op when the repo declares no check.
    """
    state = ctx.prepush
    if state is None:
        return
    command = ctx.config.prepush_command
    if state.runs and state.rounds >= PREPUSH_MAX_ROUNDS:
        state.stopped_reason = "max pre-push rounds reached"
        return
    while True:
        outcome = verify_prepush(ctx.setup.repo_dir, command)
        verdict = _prepush_verdict(outcome)
        state.runs.append(verdict)
        ctx.progress.write_agent_milestone(
            "prepush_check_result", f"run={len(state.runs)} result={verdict}"
        )
        if verdict != "fail":
            state.stopped_reason = "check passed" if verdict == "pass" else f"check {verdict}"
            break
        reason = (
            "max pre-push rounds reached" if state.rounds >= PREPUSH_MAX_ROUNDS else ""
        ) or _resume_blocker(ctx, agent_result)
        if reason:
            state.stopped_reason = reason
            break
        state.rounds += 1
        ctx.progress.write_agent_milestone(
            "prepush_round_started", f"round={state.rounds}/{PREPUSH_MAX_ROUNDS}"
        )
        prompt = build_prepush_prompt(
            command, outcome.output_tail, state.rounds, PREPUSH_MAX_ROUNDS
        )
        stop = _resume(ctx, agent_result, prompt)
        if stop:
            state.stopped_reason = stop
            break
    log("POST", f"Convergence: pre-push check stopped ({state.stopped_reason})")


def render_prepush_summary(state: PrepushResult | None, command: str) -> tuple[str, list[str]]:
    """The pre-push check's token for the PR's summary line and its details line."""
    if state is None or not state.runs:
        return "", []
    last = state.runs[-1]
    icon = {"pass": "✅", "fail": "❌"}.get(last, "⚠️")
    rounds = f"; {state.rounds} fix-up round(s)" if state.rounds else ""
    detail = (
        f"- Pre-push check: `{command}` → {last.upper()} (runs: {', '.join(state.runs)}"
        f"{rounds}; feedback for the agent, CI is the gate)"
    )
    return f"pre-push {icon}", [detail]


def run_fixup_rounds(
    build_outcome: VerifyOutcome,
    agent_result: AgentResult,
    ctx: RoundContext,
    *,
    read_only: bool,
) -> tuple[VerifyOutcome, FixupResult]:
    """Feed a genuinely failing post-agent build back to the agent and re-verify.

    Returns the LAST build outcome and what the loop did. With
    ``max_rounds == 0`` this is a no-op (report-only gate).
    """
    fixup = FixupResult()
    if ctx.max_rounds <= 0 or build_outcome.passed:
        return build_outcome, fixup
    command = (ctx.config.build_command or DEFAULT_BUILD_COMMAND).strip()
    while fixup.rounds < ctx.max_rounds:
        reason = fixup_skip_reason(
            build_outcome,
            build_before=ctx.setup.build_before,
            read_only=read_only,
            session_id=agent_result.session_id,
            agent_status=agent_result.status,
        ) or _resume_blocker(ctx, agent_result)
        if reason:
            fixup.stopped_reason = reason
            break
        fixup.rounds += 1
        ctx.progress.write_agent_milestone(
            "fixup_round_started", f"round={fixup.rounds}/{ctx.max_rounds}"
        )
        prompt = build_fixup_prompt(
            command, build_outcome.output_tail, fixup.rounds, ctx.max_rounds
        )
        stop = _resume_and_push(ctx, agent_result, prompt)
        if stop:
            fixup.stopped_reason = stop
            break
        build_outcome = verify_build(ctx.setup.repo_dir, ctx.config.build_command)
        fixup.history.append(build_outcome.passed)
        log_round(fixup.rounds, ctx.max_rounds, build_outcome.passed)
        ctx.progress.write_agent_milestone(
            "fixup_round_result",
            f"round={fixup.rounds}/{ctx.max_rounds} "
            f"build={'pass' if build_outcome.passed else 'fail'}",
        )
        if build_outcome.passed:
            fixup.stopped_reason = "build passed"
            break
    else:
        fixup.stopped_reason = "max fix-up rounds reached"
    log("POST", f"Convergence: local build loop stopped ({fixup.stopped_reason})")
    return build_outcome, fixup


def head_sha(repo_dir: str) -> str:
    r = try_cmd(["git", "rev-parse", "HEAD"], label="head-sha", cwd=repo_dir)
    return r.stdout.strip() if r.returncode == 0 else ""


def pr_head_sha(repo: str, pr_number: str, repo_dir: str) -> str:
    """The PR's head commit as GitHub sees it ("" if it can't be read)."""
    if not pr_number:
        return ""
    r = try_cmd(
        [
            "gh",
            "pr",
            "view",
            pr_number,
            "--repo",
            repo,
            "--json",
            "headRefOid",
            "-q",
            ".headRefOid",
        ],
        label="pr-head-sha",
        cwd=repo_dir,
    )
    return r.stdout.strip() if r.returncode == 0 else ""


def _ci_head(ctx: RoundContext, pr_number: str, *, sleep=time.sleep) -> str:
    """The commit CI builds: the PR head on GitHub, else (logged) the pushed local HEAD.

    GitHub updates a PR's head a few seconds after a push. Reading it at once returned
    the previous commit, and the loop took a pushed fix for "the agent pushed nothing"
    (it then probed the base instead of waiting for CI on the fix). So while GitHub's
    head differs from what was just pushed, poll briefly before trusting it.
    """
    repo_dir = ctx.setup.repo_dir
    local = head_sha(repo_dir)
    sha = ""
    for attempt in range(PR_HEAD_SYNC_POLLS):
        sha = pr_head_sha(ctx.config.repo_url, pr_number, repo_dir)
        if not sha or not local or sha == local:
            break
        if attempt < PR_HEAD_SYNC_POLLS - 1:
            sleep(PR_HEAD_SYNC_INTERVAL_S)
    if not sha:
        log("WARN", "CI: could not read the PR head from GitHub; using the pushed local HEAD")
        return local
    if sha != local:
        log("WARN", f"CI: PR head on GitHub is {sha[:9]}, local HEAD {local[:9]}; using GitHub's")
    return sha


def _remaining(deadline: float) -> int:
    return max(0, int(deadline - time.monotonic()))


def _task_cancelled(task_id: str) -> bool:
    try:
        rec = task_state.get_task(task_id)
    except task_state.TaskFetchError:
        return False
    return bool(rec and rec.get("status") == "CANCELLED")


def _progress_reporter(ctx: RoundContext, sha: str):
    def report(waited: int, checks: list[dict]) -> None:
        pending = ",".join(c["name"] for c in checks if c["state"] == "pending") or "none yet"
        ctx.progress.write_agent_milestone(
            "ci_wait_progress", f"sha={sha[:9]} waited={waited}s pending={pending}"[:900]
        )

    return report


def probe_baseline(ctx: RoundContext, head: CiResult, deadline: float, cancelled) -> BaselineProbe:
    """The base commit's CI for the checks that failed on the PR head, judged against the claim.

    Reads the results CI already reported on the base commit. Only when they are
    absent and the repo opts in (``ci_baseline_probe``) does it push
    ``abca-baseline/<task_id>`` at the base commit (no new commit) so CI builds
    it, then deletes the branch. Bounded by ``PROBE_MAX_S``.
    """
    config, setup = ctx.config, ctx.setup
    base = setup.default_branch
    fetch = try_cmd(["git", "fetch", "origin", base], label="probe-fetch-base", cwd=setup.repo_dir)
    rev = try_cmd(
        ["git", "rev-parse", f"origin/{base}"], label="probe-base-sha", cwd=setup.repo_dir
    )
    base_sha = rev.stdout.strip() if fetch.returncode == 0 and rev.returncode == 0 else ""
    if not base_sha:
        return BaselineProbe("unverified", base, reason="could not resolve the base commit")
    failing = [c["name"] for c in head.failed]

    def wait() -> CiResult:
        return wait_for_ci(
            config.repo_url,
            base_sha,
            setup.repo_dir,
            min(PROBE_MAX_S, _remaining(deadline)),
            required=failing,
            only=failing,
            is_cancelled=cancelled,
            required_appear_timeout_s=CI_APPEAR_TIMEOUT_S,
        )

    on_base = {c["name"] for c in collect_checks(config.repo_url, base_sha, setup.repo_dir) or []}
    if set(failing) <= on_base:
        result = wait()
    elif config.ci_baseline_probe:
        result = _probe_by_push(ctx, base_sha, wait)
        if result is None:
            return BaselineProbe("unverified", base, base_sha, reason="probe push failed")
    else:
        return BaselineProbe(
            "unverified",
            base,
            base_sha,
            reason="the base commit has no CI results for the failing checks",
        )
    probe = BaselineProbe(judge_claim(head, result), base, base_sha, result)
    states = ", ".join(f"{c['name']}={c['state']}" for c in result.checks) or result.state
    log("POST", f"CI: base {base}@{base_sha[:9]}: {states} -> claim {probe.verdict}")
    ctx.progress.write_agent_milestone(
        "ci_baseline_probe_result", f"claim={probe.verdict} base={states}"[:900]
    )
    return probe


def _probe_by_push(
    ctx: RoundContext, base_sha: str, wait: Callable[[], CiResult]
) -> CiResult | None:
    """Push the probe branch at ``base_sha``, ``wait()`` for its CI, always delete the branch."""
    setup = ctx.setup
    branch = f"{BASELINE_BRANCH_PREFIX}{ctx.config.task_id}"
    push = try_cmd(
        ["git", "push", "--force", "origin", f"{base_sha}:refs/heads/{branch}"],
        label="probe-push",
        cwd=setup.repo_dir,
    )
    if push.returncode != 0:
        return None
    ctx.progress.write_agent_milestone("ci_baseline_probe_started", f"sha={base_sha[:9]}")
    try:
        return wait()
    finally:
        try_cmd(
            ["git", "push", "origin", "--delete", branch], label="probe-delete", cwd=setup.repo_dir
        )


def run_ci_rounds(
    agent_result: AgentResult, ctx: RoundContext, pr_url: str
) -> CiConvergence | None:
    """Wait for the PR's CI in-session; on red, resume the agent with the report.

    None unless the repo sets ``ci_wait_timeout_s``. Each round re-waits on the
    PR's new head; a round where the agent pushes nothing triggers the baseline
    check of its "unrelated" claim, and a refuted claim goes back to the agent.
    """
    config = ctx.config
    if config.ci_wait_timeout_s <= 0:
        return None
    match = re.search(r"/pull/(\d+)", pr_url)
    pr_number = match.group(1) if match else ""
    ci = CiConvergence()
    deadline = time.monotonic() + config.ci_wait_timeout_s

    def cancelled() -> bool:
        return _task_cancelled(config.task_id)

    if not ensure_pushed(ctx.setup.repo_dir, ctx.setup.branch):
        ci.stopped_reason = "push failed"
        return ci
    sha = _ci_head(ctx, pr_number)
    evidence = ""
    result: CiResult | None = None
    while True:
        if result is None:
            result = _wait_and_record(ctx, ci, sha, deadline, cancelled)
        if result.state != "fail":
            ci.stopped_reason = f"ci {result.state}"
            break
        reason = (
            "max fix-up rounds reached" if ci.rounds >= ctx.max_rounds else ""
        ) or _resume_blocker(ctx, agent_result)
        if reason:
            ci.stopped_reason = reason
            break
        ci.rounds += 1
        report = failure_report(
            result, ci_comments_for(config.repo_url, pr_number, sha, ctx.setup.repo_dir)
        )
        ctx.progress.write_agent_milestone(
            "ci_fixup_round_started", f"round={ci.rounds}/{ctx.max_rounds}"
        )
        prompt = build_ci_fixup_prompt(
            f"{evidence}\n\n{report}" if evidence else report,
            ci.rounds,
            ctx.max_rounds,
            platform_pushes=ctx.prepush is not None,
        )
        stop = _resume_and_push(ctx, agent_result, prompt, prepush=True)
        if stop:
            ci.stopped_reason = stop
            break
        new_sha = _ci_head(ctx, pr_number)
        if new_sha != sha:
            sha, evidence, result = new_sha, "", None
            continue
        # The agent judged the failure unrelated to its change and pushed nothing.
        ci.probe = probe_baseline(ctx, result, deadline, cancelled)
        if ci.probe.verdict == "refuted":
            evidence = refutation_evidence(result, ci.probe)
            continue  # same head, same red result: another round with the evidence
        ci.stopped_reason = (
            "failure also on the base branch (pre-existing)"
            if ci.probe.verdict == "confirmed"
            else f"agent pushed no change; claim unverified ({ci.probe.reason or 'no verdict'})"
        )
        break
    if ci.final is not None and ci.final.state == "fail" and not cancelled():
        _post_handoff(ctx, agent_result, ci, pr_number)
    return ci


def _post_handoff(
    ctx: RoundContext, agent_result: AgentResult, ci: CiConvergence, pr_number: str
) -> None:
    """Checks are still red: tell the owner exactly what ABCA needs (one question).

    The agent writes it in one constrained turn when it can still be resumed;
    otherwise a deterministic summary of the failing checks is posted.
    """
    final = ci.final
    if final is None or not pr_number:
        return
    config, repo_dir = ctx.config, ctx.setup.repo_dir
    body = ""
    if not _resume_blocker(ctx, agent_result):
        report = failure_report(
            final, ci_comments_for(config.repo_url, pr_number, final.sha, repo_dir)
        )
        try:
            turn = asyncio.run(
                runner.run_agent(
                    handoff_prompt(report, ci.rounds),
                    ctx.system_prompt,
                    config,
                    cwd=repo_dir,
                    trajectory=ctx.trajectory,
                    resume_session_id=agent_result.session_id,
                    max_budget_usd=remaining_budget(config.max_budget_usd, agent_result.cost_usd),
                    max_turns=min(
                        HANDOFF_MAX_TURNS,
                        remaining_turns(config.max_turns, _used_turns(agent_result)),
                    ),
                    prior_turns=_used_turns(agent_result),
                    prior_cost_usd=agent_result.cost_usd or 0.0,
                )
            )
            _accumulate(agent_result, turn)
            body = (turn.result_text or "").strip()
        except Exception as e:
            log("WARN", f"handoff turn failed ({type(e).__name__}); posting the fallback")
        # the handoff turn must not leave edits behind
        try_cmd(["git", "checkout", "--", "."], label="handoff-discard-edits", cwd=repo_dir)
    if not body or len(body.split()) > 2 * HANDOFF_MAX_WORDS:
        body = fallback_handoff(final, ci.rounds)
    if post_pr_handoff(config.repo_url, pr_number, body, repo_dir):
        ctx.progress.write_agent_milestone("handoff_posted", f"sha={final.sha[:9]}")


def _wait_and_record(
    ctx: RoundContext, ci: CiConvergence, sha: str, deadline: float, cancelled
) -> CiResult:
    config = ctx.config
    ctx.progress.write_agent_milestone("ci_wait_started", f"sha={sha[:9]} round={ci.rounds}")
    log("POST", f"CI: waiting for checks on {sha[:9]} (up to {_remaining(deadline)}s)")
    result = wait_for_ci(
        config.repo_url,
        sha,
        ctx.setup.repo_dir,
        _remaining(deadline),
        required=config.ci_required_checks,
        is_cancelled=cancelled,
        on_progress=_progress_reporter(ctx, sha),
    )
    ci.results.append(result)
    names = ", ".join(f"{c['name']}={c['state']}" for c in result.checks) or "none"
    log("POST", f"CI: {result.state} on {sha[:9]} after {result.waited_s}s ({names})")
    ctx.progress.write_agent_milestone(
        "ci_result", f"state={result.state} sha={sha[:9]} checks={names}"[:900]
    )
    return result


def ci_failure_message(ci: CiConvergence | None, required: list[str]) -> str | None:
    """The task error for a PR whose CI did not converge (None = CI does not block success).

    Red checks always block. When the repo names required checks, a wait that
    ended without a verdict (nothing reported, timed out, unreadable) blocks too:
    an unverified PR is not a green one.
    """
    if ci is None:
        return None
    final = ci.final
    if final is None:
        return f"ci_ok=unknown: CI was not waited on ({ci.stopped_reason})" if required else None
    if final.state == "fail":
        failing = ", ".join(c["name"] for c in final.failed) or "CI"
        if ci.probe and ci.probe.verdict == "confirmed":
            return (
                f"ci_ok=preexisting: {failing} also fail on the base branch "
                "(not caused by this change); the PR needs the base fixed first"
            )
        message = (
            f"ci_ok=False: CI checks failing on the PR after {ci.rounds} fix-up round(s): {failing}"
        )
        if ci.probe and ci.probe.verdict == "refuted":
            message += " (the agent's 'unrelated' claim was refuted on the base branch)"
        return message
    if required and final.state in ("none", "timeout", "error"):
        reported = {c["name"] for c in final.checks}
        missing = ", ".join(r for r in required if r not in reported) or "none missing"
        marker = "timeout" if final.state == "timeout" else "unknown"
        return (
            f"ci_ok={marker}: required checks reached no verdict ({final.state}; "
            f"not reported: {missing})"
        )
    return None
