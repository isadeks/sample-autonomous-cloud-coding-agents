"""Unit tests for repo.py — hermetic git/gh setup (no network, no real git).

``setup_repo`` and ``detect_default_branch`` shell out heavily. We fake the two
seams they use — ``shell.run_cmd`` (logged commands) and ``subprocess.run``
(detect_default_branch) — recording argv and returning scripted results.
"""

import os
import subprocess
from types import SimpleNamespace

import dependency_cache
import repo
from tests.conftest import FakeRunCmd, make_task_config


def _fake_run_cmd(
    returncodes: dict[str, int] | None = None,
    stdouts: dict[str, str] | None = None,
) -> FakeRunCmd:
    """repo.py keys scripted results off a recognizable label fragment (substring match)."""
    return FakeRunCmd(returncodes=returncodes, stdouts=stdouts, match_substring=True)


_config = make_task_config


def _patch_common(monkeypatch, fake: FakeRunCmd):
    """Patch run_cmd everywhere repo.py reaches it, plus the commit-hook install."""
    monkeypatch.setattr(repo, "run_cmd", fake)
    # #251 Phase 2: clone/fetch now go through run_cmd_with_backoff. Route it to
    # the same fake so scripted returncodes drive both — the fake ignores the
    # extra retry kwargs (max_attempts/base_delay_s/on_retry/sleep) via **kwargs.
    monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
    # _install_commit_hook touches the filesystem; stub it out (it's its own
    # best-effort path and not under test here).
    monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)


class TestSetupRepoHappyPath:
    def test_new_task_argv_sequence_and_remote_url_has_no_token(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        # detect_default_branch is exercised separately; stub for this test.
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        labels = fake.labels()
        # Core sequence present and ordered: clone before remote pin before branch.
        assert "clone" in labels
        assert "set-remote-url" in labels
        assert "configure-git-credential-helper" in labels
        assert labels.index("clone") < labels.index("set-remote-url")
        assert labels.index("set-remote-url") < labels.index("create-branch")

        # Security fix: remote URL is the plain https URL WITHOUT an embedded token.
        set_url_cmd = fake.cmd_for("set-remote-url")
        assert set_url_cmd is not None
        remote = set_url_cmd[-1]
        assert remote == "https://github.com/owner/repo.git"
        assert "@" not in remote
        assert "x-access-token" not in remote
        assert "ghp_" not in " ".join(set_url_cmd)

        # And the credential.helper config call is present (token resolved at call time).
        helper_cmd = fake.cmd_for("configure-git-credential-helper")
        assert helper_cmd is not None
        assert "credential.helper" in helper_cmd

        # Derived branch slug for a new task.
        assert setup.branch.startswith("bgagent/task-abc/")
        assert setup.default_branch == "main"

    def test_pr_branch_checkout_path(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)

        setup = repo.setup_repo(
            _config(
                is_pr_workflow=True,
                branch_name="feature/existing",
                base_branch="develop",
            )
        )

        labels = fake.labels()
        assert "fetch-pr-branch" in labels
        assert "checkout-pr-branch" in labels
        assert "create-branch" not in labels
        assert setup.branch == "feature/existing"
        # base_branch from orchestrator wins for PR workflows — no detection call.
        assert setup.default_branch == "develop"

    def test_non_pr_task_captures_head_sha_for_digest(self, monkeypatch):
        # #299 plan-mode T2: a NON-PR workflow (e.g. coding/decompose-v1) must also
        # capture the cloned HEAD sha (via the post-setup rev-parse) so the planner
        # can echo it into repo_digest_sha. The PR path captures its own sha; this
        # covers the else/default clone path that decompose uses.
        fake = _fake_run_cmd(stdouts={"head-sha-after-setup": "deadbeefcafe1234\n"})
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config())

        assert "head-sha-after-setup" in fake.labels()
        assert setup.head_sha_before == "deadbeefcafe1234"

    def test_pr_workflow_does_not_double_capture_head_sha(self, monkeypatch):
        # The PR path already set head_sha_before, so the post-setup fallback must
        # NOT run (guarded on `if not head_sha_before`).
        fake = _fake_run_cmd(stdouts={"head-sha-before": "aaaa1111bbbb2222\n"})
        _patch_common(monkeypatch, fake)

        setup = repo.setup_repo(
            _config(is_pr_workflow=True, branch_name="feature/x", base_branch="develop")
        )

        assert setup.head_sha_before == "aaaa1111bbbb2222"
        assert "head-sha-after-setup" not in fake.labels()


class TestReadOnlyBaselineSkip:
    """#299 ECS_RIGHTSIZED_PLANNING: a read_only workflow (coding/decompose-v1)
    never edits code, runs the post-agent gate, or opens a PR, so the pre-agent
    build + lint baseline is pure waste — and on a big repo the full CI-parity
    `mise run build` won't fit the 8 GB read-only planning task def (it would
    stall/OOM before the planner reads a file). setup_repo must skip both
    baselines for read_only and still return neutral OK values."""

    def test_read_only_skips_build_and_lint_baseline(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=True))

        labels = fake.labels()
        # The heavy build + lint baselines must NOT run.
        assert "verify-build-pre" not in labels
        assert "verify-lint-pre" not in labels
        # But the clone/branch/mise-install setup still happens.
        assert "clone" in labels
        assert "mise-install" in labels
        # Neutral OK baselines (nothing gets committed, so nothing to gate).
        assert setup.build_before is True
        assert setup.lint_before is True
        assert setup.build_gate_inert is False
        assert setup.lint_gate_inert is False
        assert any("Read-only workflow" in n for n in setup.notes)

    def test_non_read_only_still_runs_build_and_lint_baseline(self, monkeypatch):
        # Regression guard: the default (write) workflow must still run both
        # baselines — the skip is gated strictly on read_only.
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        labels = fake.labels()
        assert "verify-build-pre" in labels
        assert "verify-lint-pre" in labels
        assert setup.build_before is True  # fake run_cmd returns rc 0
        assert setup.lint_before is True


class TestBaselineBuildTimeout:
    """ABCA-659 Bug B: the pre-agent baseline build/lint must run with the SAME
    generous wall-clock ceiling as the post-agent gate (BUILD_VERIFY_TIMEOUT_S,
    30min) — NOT run_cmd's 600s default — and a TIMEOUT must be GUARDED so a
    slow-but-valid CI-parity build no longer raises out of setup_repo and crashes
    the whole task before the agent ever runs (the 661/662 symptom: no PR, issue
    stuck in Backlog, indistinguishable from a real failure)."""

    class _RecordingFake:
        """run_cmd fake that records the ``timeout`` kwarg and can raise
        TimeoutExpired for a label substring."""

        def __init__(
            self,
            timeout_on: str | None = None,
            rc_on: tuple[str, int, str] | None = None,
        ):
            self.calls: list[dict] = []
            self._timeout_on = timeout_on
            # (label_substring, returncode, stderr) to force a non-zero exit on a
            # specific labelled command (e.g. an OOM-killed baseline build).
            self._rc_on = rc_on

        def __call__(self, cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            self.calls.append({"label": label, "timeout": timeout})
            if self._timeout_on and self._timeout_on in label:
                raise subprocess.TimeoutExpired(cmd=cmd, timeout=timeout)
            if self._rc_on and self._rc_on[0] in label:
                return SimpleNamespace(returncode=self._rc_on[1], stdout="", stderr=self._rc_on[2])
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        def timeout_for(self, label: str) -> int | None:
            for c in self.calls:
                if label in c["label"]:
                    return c["timeout"]
            return None

    def test_baseline_build_uses_the_generous_verify_ceiling_not_600s(self, monkeypatch):
        from post_hooks import BUILD_VERIFY_TIMEOUT_S

        fake = self._RecordingFake()
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        repo.setup_repo(_config(read_only=False))

        assert fake.timeout_for("verify-build-pre") == BUILD_VERIFY_TIMEOUT_S
        assert fake.timeout_for("verify-lint-pre") == BUILD_VERIFY_TIMEOUT_S
        assert BUILD_VERIFY_TIMEOUT_S > 600  # the whole point: not the old default

    def test_baseline_build_timeout_is_guarded_not_a_task_crash(self, monkeypatch):
        # The heavy build times out. setup_repo must NOT propagate TimeoutExpired
        # (which crashed the task pre-agent); it degrades to "no baseline" and the
        # run proceeds with build_before=True (a timeout is not a regression).
        fake = self._RecordingFake(timeout_on="verify-build-pre")
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))  # must not raise

        assert setup.build_before is True  # timeout → not treated as a regression
        assert setup.build_gate_inert is False
        assert any("did not finish within" in n for n in setup.notes)

    def test_baseline_lint_timeout_is_guarded(self, monkeypatch):
        fake = self._RecordingFake(timeout_on="verify-lint-pre")
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))  # must not raise

        assert setup.lint_before is True
        assert setup.lint_gate_inert is False
        assert any("Initial lint" in n and "did not finish within" in n for n in setup.notes)

    def test_baseline_build_OOM_kill_is_not_a_regression(self, monkeypatch):
        # ABCA-662 root cause: the pre-agent baseline build was OOM-KILLED (exit
        # 137) because several heavy CI-parity builds shared one ECS box. Exit 137
        # is an ENVIRONMENT fault, NOT broken code — so build_before must be True
        # (no usable baseline, no known regression), NOT False ("already broken").
        # A False here poisons the whole verdict: the regression gate reads
        # "red-before → red-after isn't the agent's fault → ✅" while the absolute
        # orchestration gate fails the node — a task GitHub built green.
        fake = self._RecordingFake(rc_on=("verify-build-pre", 137, "Killed"))
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is True  # OOM → no baseline, NOT "already broken"
        assert setup.build_gate_inert is False  # an OOM kill is not an inert gate
        assert any("environment fault" in n for n in setup.notes)
        # And it must NOT be recorded as a pre-existing build failure.
        assert not any("FAILED before agent changes" in n for n in setup.notes)

    def test_baseline_build_genuine_failure_still_marks_regression_baseline(self, monkeypatch):
        # Guard the other side: a REAL red build (exit 1, not an infra signal) must
        # still record build_before=False so genuine regressions are gated.
        fake = self._RecordingFake(rc_on=("verify-build-pre", 1, "TS2345: type error"))
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        setup = repo.setup_repo(_config(read_only=False))

        assert setup.build_before is False  # a real red build IS the baseline
        assert any("FAILED before agent changes" in n for n in setup.notes)


class TestFindMiseConfigs:
    """ABCA-662 follow-up: `mise trust <repo_dir>` trusts only the ROOT config;
    a monorepo's per-package `mise.toml` roots must ALSO be trusted or
    `mise run build` fanning into `//cdk:*` etc. dies at the trust gate."""

    def _mk(self, root, rels):
        import os

        for r in rels:
            d = os.path.dirname(r)
            if d:
                os.makedirs(os.path.join(root, d), exist_ok=True)
            open(os.path.join(root, r), "w").close()

    def _rel(self, root, configs):
        import os

        return sorted(os.path.relpath(c, root) for c in configs)

    def test_returns_nested_configs_excluding_root(self, tmp_path):
        root = str(tmp_path)
        self._mk(root, ["mise.toml", "cdk/mise.toml", "cli/mise.toml", "agent/mise.toml"])
        got = self._rel(root, repo._find_mise_configs(root))
        # root already trusted by `mise trust <repo_dir>`, so it's excluded
        assert "mise.toml" not in got
        assert got == ["agent/mise.toml", "cdk/mise.toml", "cli/mise.toml"]

    def test_skips_vendored_and_build_dirs(self, tmp_path):
        root = str(tmp_path)
        self._mk(
            root,
            ["mise.toml", "cdk/mise.toml", "node_modules/pkg/mise.toml", "cdk/cdk.out/a/mise.toml"],
        )
        got = self._rel(root, repo._find_mise_configs(root))
        assert got == ["cdk/mise.toml"]  # node_modules + cdk.out pruned

    def test_no_nested_configs_returns_empty(self, tmp_path):
        root = str(tmp_path)
        self._mk(root, ["mise.toml"])  # only the root
        assert repo._find_mise_configs(root) == []


class TestDetectDefaultBranch:
    def test_returns_detected_branch(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="trunk\n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "trunk"

    def test_timeout_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="gh", timeout=30)

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_gh_missing_falls_back_to_main(self, monkeypatch):
        # FileNotFoundError (gh not on PATH) is an OSError — must not escape.
        def fake_run(*args, **kwargs):
            raise FileNotFoundError("gh")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_oserror_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise OSError("permission denied")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_subprocess_error_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            raise subprocess.SubprocessError("boom")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_nonzero_exit_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="auth error")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"

    def test_empty_stdout_falls_back_to_main(self, monkeypatch):
        def fake_run(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="   \n", stderr="")

        monkeypatch.setattr(subprocess, "run", fake_run)
        assert repo.detect_default_branch("owner/repo", "/tmp/x") == "main"


class TestPlatformBranchNameVerbatim:
    """The agent MUST use the platform-provided ``config.branch_name`` verbatim
    when present, for EVERY workflow — never re-deriving its own slug. A
    re-derived slug diverges from the platform's (shell.py slugify strips
    dots / truncates at 40; gateway.ts uses dashes / truncates at 50), which
    silently breaks #247 A4 stacking: a stacked child fetches the
    predecessor's platform-named branch, the agent pushed a differently-named
    one, the fetch 404s, and the child falls back to main (#14)."""

    def test_uses_platform_branch_name_verbatim_for_new_task(self, monkeypatch):
        # new_task (is_pr_workflow=False) with a platform branch_name carrying a
        # dotted/dashed slug. The agent must NOT re-slugify it.
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=False,
                branch_name="bgagent/01TESTTASKID/abca-166-add-seville-guide-html",
                task_description="ABCA-166: Add seville-guide.html",
            )
        )
        assert setup.branch == "bgagent/01TESTTASKID/abca-166-add-seville-guide-html"

    def test_uses_platform_branch_name_verbatim_for_pr_workflow(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=True,
                branch_name="bgagent/01TESTTASKID/abca-167-stacked-child",
                base_branch="bgagent/01PREDTASK/abca-166-predecessor",
            )
        )
        assert setup.branch == "bgagent/01TESTTASKID/abca-167-stacked-child"

    def test_falls_back_to_derived_slug_only_when_no_branch_name(self, monkeypatch):
        # No platform branch_name → the agent derives its own slug (legacy path).
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        setup = repo.setup_repo(
            _config(
                is_pr_workflow=False,
                task_description="ABCA-168: derive me",
            )
        )
        assert setup.branch.startswith("bgagent/")


class _RecordingProgress:
    """Progress double recording write_agent_blocked calls (mirrors test_hooks)."""

    def __init__(self):
        self.calls = []
        self._disabled = False

    def __getattr__(self, name):
        if name.startswith("write_"):
            return lambda **kw: self.calls.append((name, kw))
        raise AttributeError(name)


class TestSetupRepoDependencyUnreachable:
    """#251 Phase 2: bounded remediation on transient clone failure + the
    security invariant that remediation never widens creds/egress."""

    def _patch_backoff_to_fail(self, monkeypatch, fake, *, transient_stderr):
        """Wire run_cmd_with_backoff to a real bounded loop over the fake so the
        report/raise path fires, while run_cmd (non-clone commands) stays faked."""
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)

        def fake_backoff(cmd, label, *, on_retry=None, **kwargs):
            # Mirror the real helper: on_retry only fires for transient failures.
            from shell import is_transient_cmd_failure

            if is_transient_cmd_failure(transient_stderr):
                for attempt in range(1, 3):
                    if on_retry is not None:
                        on_retry(attempt, 3, transient_stderr)
            return SimpleNamespace(returncode=1, stdout="", stderr=transient_stderr)

        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake_backoff)

    def test_named_host_clone_bails_through_real_backoff_no_retry_events(self, monkeypatch):
        """#251 review (end-to-end): drive the REAL run_cmd_with_backoff (not the
        fake) so the shell.py DNS-bail + repo.py egress reclassification are proven
        together. A named-host DNS failure must produce ZERO dependency_unreachable
        retry events and exactly one non-retryable egress_denied — and the clone
        command must run only once (no burned retries)."""
        clone_calls = []

        def fake_run_cmd(cmd, label, cwd=None, timeout=600, check=True, **kwargs):
            if "clone" in label:
                clone_calls.append(cmd)
                return SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr="fatal: unable to access: Could not resolve host: github.com",
                )
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        # Patch shell.run_cmd (what the REAL run_cmd_with_backoff calls) AND
        # repo.run_cmd (the non-clone setup commands). run_cmd_with_backoff itself
        # is NOT patched — the real DNS-bail logic runs.
        monkeypatch.setattr("shell.run_cmd", fake_run_cmd)
        monkeypatch.setattr(repo, "run_cmd", fake_run_cmd)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        # Bailed on the first clone attempt — no retries burned.
        assert len(clone_calls) == 1
        # Terminal reason is egress_denied naming the host, not dependency_unreachable.
        assert str(excinfo.value).startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in str(excinfo.value)
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        # No misleading dependency_unreachable retry events; exactly one egress_denied.
        assert not [c for c in blocked if c[1]["kind"] == "dependency_unreachable"]
        egress = [c for c in blocked if c[1]["kind"] == "egress_denied"]
        assert len(egress) == 1
        assert egress[0][1]["retryable"] is False

    def test_exhausted_clone_reports_and_raises_canonical_reason(self, monkeypatch):
        fake = _fake_run_cmd()
        # A hostless transient blip (connection reset, no nameable host) → the
        # retryable dependency_unreachable branch. A name-resolution failure that
        # names a host is egress_denied instead — see the egress test below.
        self._patch_backoff_to_fail(
            monkeypatch, fake, transient_stderr="error: RPC failed; connection reset"
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        # Canonical reason carried on the exception → terminal error → classifier.
        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:")
        assert "(resource: owner/repo)" in str(excinfo.value)

        # Each transient retry + the final exhaustion emitted an auditable event:
        # _patch_backoff_to_fail fires on_retry twice (attempts 1,2) and
        # _fail_setup_command emits the terminal blocker → exactly 3.
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert len(blocked) == 3
        assert all(c[1]["kind"] == "dependency_unreachable" for c in blocked)
        assert all(c[1]["retryable"] is True for c in blocked)

    def test_exhausted_clone_naming_host_is_egress_denied_not_retryable(self, monkeypatch):
        """#251 review fix: a name-resolution failure naming a host is a
        firewalled endpoint, NOT a transient blip. It must classify as
        non-retryable egress_denied (allowlist remedy) — the same verdict the
        PostToolUse egress detector reaches for identical stderr — rather than
        retryable dependency_unreachable ("retry the task", which never helps)."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="fatal: unable to access: Could not resolve host: github.com",
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(_config(), progress=progress)

        # Reclassified to egress_denied naming the exact host to allowlist.
        assert str(excinfo.value).startswith("BLOCKED[egress_denied]:")
        assert "(resource: github.com)" in str(excinfo.value)

        # The terminal blocker is egress_denied and non-retryable.
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        terminal = [c for c in blocked if c[1]["kind"] == "egress_denied"]
        assert terminal, "expected an egress_denied blocker event"
        assert all(c[1]["retryable"] is False for c in terminal)
        assert all(c[1]["resource"] == "github.com" for c in terminal)

    def test_permanent_clone_failure_is_not_reported_as_dependency_unreachable(self, monkeypatch):
        """A permanent failure (repo not found / auth denied) must raise a plain
        RuntimeError — NOT the retryable dependency_unreachable blocker — so the
        classifier routes it to the auth/not-found remedy (#251 review fix)."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="Could not resolve to a Repository with the name 'owner/repo'",
        )
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(RuntimeError) as excinfo:
            repo.setup_repo(_config(), progress=progress)
        assert not isinstance(excinfo.value, repo.DependencyUnreachableError)
        assert "BLOCKED[" not in str(excinfo.value)
        # No dependency_unreachable blocker emitted for a permanent failure.
        assert not [c for c in progress.calls if c[0] == "write_agent_blocked"]

    def test_permanent_failure_stderr_is_redacted_in_raised_error(self, monkeypatch):
        """The raised RuntimeError message is persisted to TaskResult.error, so a
        credential leaked in git stderr must be redacted (pre-#251 check=True
        behavior — regression guard)."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(
            monkeypatch,
            fake,
            transient_stderr="fatal: Authentication failed for 'https://ghp_SECRETTOKEN123@github.com/o/r'",
        )
        import pytest

        with pytest.raises(RuntimeError) as excinfo:
            repo.setup_repo(_config(), progress=_RecordingProgress())
        assert "ghp_SECRETTOKEN123" not in str(excinfo.value)

    def test_exhausted_pr_branch_fetch_reports_branch_as_resource(self, monkeypatch):
        """The PR-workflow fetch path (repo.py) mirrors the clone path but its
        blocker resource is the branch name, not the repo. Clone succeeds; the
        transient fetch failure exhausts retries → dependency_unreachable naming
        the branch."""
        fake = _fake_run_cmd()
        monkeypatch.setattr(repo, "run_cmd", fake)
        monkeypatch.setattr(repo, "_install_commit_hook", lambda repo_dir: None)

        def fake_backoff(cmd, label, *, on_retry=None, **kwargs):
            # Clone succeeds; only the PR-branch fetch fails transiently.
            if label == "fetch-pr-branch":
                return SimpleNamespace(returncode=1, stdout="", stderr="connection timed out")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        monkeypatch.setattr(repo, "run_cmd_with_backoff", fake_backoff)
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError) as excinfo:
            repo.setup_repo(
                _config(is_pr_workflow=True, branch_name="feature/x", base_branch="main"),
                progress=progress,
            )

        # Resource is the branch, not the repo — this is the fetch path.
        assert str(excinfo.value).startswith("BLOCKED[dependency_unreachable]:")
        assert "(resource: feature/x)" in str(excinfo.value)
        blocked = [c for c in progress.calls if c[0] == "write_agent_blocked"]
        assert any(c[1].get("resource") == "feature/x" for c in blocked)

    def test_remediation_does_not_widen_creds_or_egress(self, monkeypatch):
        """Invariant (AC): remediation only re-runs the same command. It must
        NOT run any credential- or remote-mutating command before failing —
        no scope/allowlist widening, purely a bounded retry of the clone."""
        fake = _fake_run_cmd()
        self._patch_backoff_to_fail(monkeypatch, fake, transient_stderr="connection timed out")
        progress = _RecordingProgress()

        import pytest

        with pytest.raises(repo.DependencyUnreachableError):
            repo.setup_repo(_config(), progress=progress)

        # setup aborts at clone: none of the credential/remote-config commands
        # (which run AFTER clone) executed. Remediation widened nothing.
        labels = fake.labels()
        assert "set-remote-url" not in labels
        assert "configure-git-credential-helper" not in labels
        assert "safe-directory" in labels  # only the pre-clone step ran


# ---------------------------------------------------------------------------
# ABCA-691: warm dependency cache (lockfile-keyed node_modules / .venv reuse)
# ---------------------------------------------------------------------------


def _write(path: str, content: str = "x") -> None:
    """Create a file (and its parent dirs) with *content*."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as handle:
        handle.write(content)


def _make_dir_with_file(path: str, filename: str = "marker", content: str = "data") -> None:
    """Create directory *path* containing one file (an artifact stand-in)."""
    os.makedirs(path, exist_ok=True)
    _write(os.path.join(path, filename), content)


class TestHashLockfile:
    """The cache key is the lockfile hash, NEVER the commit SHA — the crux of the
    correctness invariant (a changed lockfile must miss)."""

    def test_hash_is_stable_for_identical_bytes(self, tmp_path):
        a = str(tmp_path / "yarn.a.lock")
        b = str(tmp_path / "yarn.b.lock")
        _write(a, "same bytes")
        _write(b, "same bytes")
        assert dependency_cache.hash_lockfile(a) == dependency_cache.hash_lockfile(b)

    def test_changed_lockfile_changes_the_hash(self, tmp_path):
        lock = str(tmp_path / "yarn.lock")
        _write(lock, "dep@1.0.0")
        before = dependency_cache.hash_lockfile(lock)
        _write(lock, "dep@2.0.0")  # trunk bumped a dependency
        after = dependency_cache.hash_lockfile(lock)
        assert before != after

    def test_missing_lockfile_returns_none(self, tmp_path):
        assert dependency_cache.hash_lockfile(str(tmp_path / "nope.lock")) is None


class TestCacheRoot:
    def test_none_when_mount_absent(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DEPENDENCY_CACHE_DIR", str(tmp_path / "does-not-exist"))
        assert dependency_cache.cache_root() is None

    def test_returns_writable_root(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DEPENDENCY_CACHE_DIR", str(tmp_path))
        assert dependency_cache.cache_root() == str(tmp_path)


class TestRestoreAndPopulate:
    """Hit/miss + atomic populate on the low-level artifact primitives."""

    def test_populate_then_restore_roundtrips_identical_bytes(self, tmp_path):
        root = str(tmp_path / "cache")
        os.makedirs(root)
        source = str(tmp_path / "node_modules")
        _make_dir_with_file(source, "pkg.js", "installed-payload")

        assert dependency_cache.populate_artifact(root, "node_modules", "abc123", source) is True

        dest = str(tmp_path / "clone" / "node_modules")
        assert dependency_cache.restore_artifact(root, "node_modules", "abc123", dest) is True
        # A hit produces the identical tree a cold install would have.
        with open(os.path.join(dest, "pkg.js")) as handle:
            assert handle.read() == "installed-payload"

    def test_restore_miss_when_key_absent(self, tmp_path):
        root = str(tmp_path / "cache")
        os.makedirs(root)
        dest = str(tmp_path / "clone" / "node_modules")
        assert dependency_cache.restore_artifact(root, "node_modules", "missing", dest) is False
        assert not os.path.exists(dest)  # nothing restored → cold install

    def test_populate_is_atomic_no_partial_entry_on_the_final_path(self, tmp_path, monkeypatch):
        # The published entry only ever appears via an atomic rename: there is no
        # window where <root>/<kind>/<digest> exists but is half-copied.
        root = str(tmp_path / "cache")
        os.makedirs(root)
        source = str(tmp_path / "venv")
        _make_dir_with_file(source, "python", "bin")

        renames: list[tuple[str, str]] = []
        real_rename = os.rename

        def spy_rename(src, dst):
            renames.append((src, dst))
            return real_rename(src, dst)

        monkeypatch.setattr(os, "rename", spy_rename)
        assert dependency_cache.populate_artifact(root, "venv", "deadbeef", source) is True

        entry = os.path.join(root, "venv", "deadbeef")
        # Exactly one rename, and its destination is the final entry path — the
        # temp was built elsewhere and moved into place in one atomic step.
        assert any(dst == entry for _src, dst in renames)
        assert os.path.isdir(entry)

    def test_second_populate_same_key_is_noop(self, tmp_path):
        root = str(tmp_path / "cache")
        os.makedirs(root)
        source = str(tmp_path / "node_modules")
        _make_dir_with_file(source)
        assert dependency_cache.populate_artifact(root, "node_modules", "k", source) is True
        # A concurrent/second publish of the same key finds the entry present.
        assert dependency_cache.populate_artifact(root, "node_modules", "k", source) is False

    def test_concurrent_populate_race_leaves_one_valid_entry(self, tmp_path, monkeypatch):
        # Simulate two tasks publishing the SAME key: the second's rename lands on
        # a now-non-empty dir and fails; it must discard its temp and report False,
        # leaving exactly one valid entry (no corruption, no leftover temp).
        root = str(tmp_path / "cache")
        os.makedirs(root)
        source = str(tmp_path / "node_modules")
        _make_dir_with_file(source, "pkg.js", "payload")

        real_rename = os.rename

        def racing_rename(src, dst):
            # Before our rename runs, a concurrent task has already published the
            # entry, so ``dst`` now exists and is non-empty → rename raises.
            os.makedirs(dst, exist_ok=True)
            _write(os.path.join(dst, "pkg.js"), "payload")
            return real_rename(src, dst)  # onto non-empty → OSError

        monkeypatch.setattr(os, "rename", racing_rename)
        result = dependency_cache.populate_artifact(root, "node_modules", "shared", source)

        assert result is False  # lost the race
        entry = os.path.join(root, "node_modules", "shared")
        assert os.path.isdir(entry)  # the winner's entry is intact
        # No leftover temp dirs polluting the kind dir.
        kind_dir = os.path.join(root, "node_modules")
        leftovers = [d for d in os.listdir(kind_dir) if d.startswith(".tmp")]
        assert leftovers == []

    def test_restore_does_not_clobber_existing_dest(self, tmp_path):
        root = str(tmp_path / "cache")
        os.makedirs(root)
        source = str(tmp_path / "src_nm")
        _make_dir_with_file(source, "pkg.js", "cached")
        dependency_cache.populate_artifact(root, "node_modules", "k", source)

        dest = str(tmp_path / "clone" / "node_modules")
        _make_dir_with_file(dest, "pkg.js", "already-present")
        # dest exists → not a restore target; leave it untouched.
        assert dependency_cache.restore_artifact(root, "node_modules", "k", dest) is False
        with open(os.path.join(dest, "pkg.js")) as handle:
            assert handle.read() == "already-present"


class TestDiscoverArtifacts:
    def test_discovers_root_yarn_lock_and_nested_uv_locks(self, tmp_path):
        repo_dir = str(tmp_path / "clone")
        _write(os.path.join(repo_dir, "yarn.lock"))
        _write(os.path.join(repo_dir, "agent", "uv.lock"))
        plan = dependency_cache.discover_artifacts(repo_dir)
        kinds = {k for k, _lock, _art in plan}
        assert dependency_cache.CACHE_KIND_NODE_MODULES in kinds
        assert dependency_cache.CACHE_KIND_VENV in kinds
        # node_modules maps to the ROOT (yarn workspaces install centrally).
        nm = next(a for k, _l, a in plan if k == dependency_cache.CACHE_KIND_NODE_MODULES)
        assert nm == os.path.join(repo_dir, "node_modules")
        # .venv is the SIBLING of the uv.lock that keys it.
        venv = next(a for k, _l, a in plan if k == dependency_cache.CACHE_KIND_VENV)
        assert venv == os.path.join(repo_dir, "agent", ".venv")

    def test_skips_vendored_and_build_dirs_for_uv_locks(self, tmp_path):
        repo_dir = str(tmp_path / "clone")
        _write(os.path.join(repo_dir, "agent", "uv.lock"))
        _write(os.path.join(repo_dir, "node_modules", "pkg", "uv.lock"))
        _write(os.path.join(repo_dir, "cdk.out", "asset", "uv.lock"))
        plan = dependency_cache.discover_artifacts(repo_dir)
        venvs = [a for k, _l, a in plan if k == dependency_cache.CACHE_KIND_VENV]
        assert venvs == [os.path.join(repo_dir, "agent", ".venv")]

    def test_no_lockfiles_returns_empty(self, tmp_path):
        assert dependency_cache.discover_artifacts(str(tmp_path)) == []


class TestRestoreAndPopulateHighLevel:
    """The setup-facing helpers: end-to-end hit/miss keyed on lockfile hash."""

    def test_changed_yarn_lock_is_a_miss_then_repopulates(self, tmp_path, monkeypatch):
        # Two consecutive "tasks" with a CHANGED yarn.lock: the second must MISS
        # (different lockfile hash) and cold-install — never reuse stale deps.
        root = str(tmp_path / "cache")
        os.makedirs(root)
        monkeypatch.setenv("DEPENDENCY_CACHE_DIR", root)

        # Task 1: lockfile v1, installs node_modules, populates cache.
        repo1 = str(tmp_path / "task1")
        _write(os.path.join(repo1, "yarn.lock"), "dep@1.0.0")
        notes1: list[str] = []
        dependency_cache.restore_dependency_cache(repo1, notes1)
        assert any("cache MISS for node_modules" in n for n in notes1)
        _make_dir_with_file(os.path.join(repo1, "node_modules"), "pkg.js", "v1")
        dependency_cache.populate_dependency_cache(repo1, notes1)

        # Task 2: SAME lockfile → HIT (restores identical tree).
        repo2 = str(tmp_path / "task2")
        _write(os.path.join(repo2, "yarn.lock"), "dep@1.0.0")
        notes2: list[str] = []
        dependency_cache.restore_dependency_cache(repo2, notes2)
        assert any("cache HIT for node_modules" in n for n in notes2)
        with open(os.path.join(repo2, "node_modules", "pkg.js")) as handle:
            assert handle.read() == "v1"

        # Task 3: trunk BUMPED the dependency → different hash → MISS (no stale reuse).
        repo3 = str(tmp_path / "task3")
        _write(os.path.join(repo3, "yarn.lock"), "dep@2.0.0")
        notes3: list[str] = []
        dependency_cache.restore_dependency_cache(repo3, notes3)
        assert any("cache MISS for node_modules" in n for n in notes3)
        assert not os.path.exists(os.path.join(repo3, "node_modules"))

    def test_no_cache_volume_is_a_clean_cold_install(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DEPENDENCY_CACHE_DIR", str(tmp_path / "absent"))
        repo_dir = str(tmp_path / "clone")
        _write(os.path.join(repo_dir, "yarn.lock"), "dep@1.0.0")
        notes: list[str] = []
        dependency_cache.restore_dependency_cache(repo_dir, notes)  # must not raise
        assert any("unavailable" in n for n in notes)
        # populate is likewise a safe no-op with no volume.
        _make_dir_with_file(os.path.join(repo_dir, "node_modules"))
        dependency_cache.populate_dependency_cache(repo_dir, notes)  # must not raise


class TestSetupRepoWiresDependencyCache:
    """setup_repo must restore before install and populate after — best-effort."""

    def test_setup_calls_restore_then_populate(self, monkeypatch):
        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")

        calls: list[str] = []
        monkeypatch.setattr(
            "dependency_cache.restore_dependency_cache",
            lambda repo_dir, notes: calls.append("restore"),
        )
        monkeypatch.setattr(
            "dependency_cache.populate_dependency_cache",
            lambda repo_dir, notes: calls.append("populate"),
        )

        repo.setup_repo(_config())

        assert calls == ["restore", "populate"]

    def test_setup_end_to_end_hit_across_two_runs(self, tmp_path, monkeypatch):
        # End-to-end through the REAL cache helpers (only run_cmd + workspace
        # faked): a first setup_repo populates the cache from an installed
        # node_modules, and a second run on the same lockfile restores it (a HIT).
        root = str(tmp_path / "cache")
        os.makedirs(root)
        monkeypatch.setenv("DEPENDENCY_CACHE_DIR", root)

        fake = _fake_run_cmd()
        _patch_common(monkeypatch, fake)
        monkeypatch.setattr(repo, "detect_default_branch", lambda url, d: "main")
        # Point the clone dir into tmp_path (not the real /workspace).
        workspace = str(tmp_path / "ws")
        monkeypatch.setattr(repo, "AGENT_WORKSPACE", workspace)

        # Task 1: seed a yarn.lock + an "installed" node_modules so the post-setup
        # populate publishes it.
        repo_dir1 = os.path.join(workspace, "task-one")
        _write(os.path.join(repo_dir1, "yarn.lock"), "dep@1.0.0")
        _make_dir_with_file(os.path.join(repo_dir1, "node_modules"), "pkg.js", "payload")
        setup1 = repo.setup_repo(_config(task_id="task-one"))
        assert any("populated node_modules" in n for n in setup1.notes)

        # Task 2: same lockfile, fresh clone dir → restore HIT.
        repo_dir2 = os.path.join(workspace, "task-two")
        _write(os.path.join(repo_dir2, "yarn.lock"), "dep@1.0.0")
        setup2 = repo.setup_repo(_config(task_id="task-two"))
        assert any("cache HIT for node_modules" in n for n in setup2.notes)
        assert os.path.exists(os.path.join(repo_dir2, "node_modules", "pkg.js"))
