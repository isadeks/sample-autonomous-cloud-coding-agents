---
title: Linear issue intake checklist
---

# Linear issue-intake checklist

A pre-flight checklist for the person writing a Linear issue **before** they hand it to ABCA with the `bgagent` trigger label. ABCA agents run unattended — once the label is applied, the agent works from the issue title, description, and comments alone. It cannot ask a clarifying question or pause for feedback, so everything it needs must be in the issue before you label it.

Use this page as a quick review pass. If every box is checked, the agent has what it needs to open a mergeable PR on the first try.

> **How ABCA reads the issue:** the issue **title + description** become the task description; comments add context (oldest are trimmed first if the combined content is large). For writing effective descriptions in depth, see the [Prompt guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering). For label mechanics (`bgagent`, `:decompose`, `:auto`, `:help`) and the trigger flow, see the [Linear setup guide](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide).

## The checklist

### 1. Objective — what should be true when this is done?

- [ ] The title summarizes the outcome, not the symptom: "Reject expired tokens with a 401" beats "Auth bug".
- [ ] The description states the **end state**, not step-by-step instructions. Describe the result; let the agent choose the implementation.
- [ ] Scope is **one logical change**. Split "fix login, add dark mode, update README" into separate issues.
- [ ] If the work has several parts you want reviewed before spending, plan to use `bgagent:decompose` instead of a single-task label.

### 2. Acceptance criteria — how does the agent (and reviewer) know it's done?

- [ ] Concrete exit conditions are in the **issue body**, not buried in comments. State what "done" looks like: a behavior change, a new file, a passing check.
- [ ] Tests are specified where relevant: "add tests for missing fields, invalid types, and empty input."
- [ ] Verification commands are named: "`npm run build` and `npm test` pass with no new warnings."
- [ ] For bugs: reproduction steps, expected behavior, and actual behavior are all present.

### 3. Constraints — what must the agent respect or avoid?

- [ ] Version / framework limits are stated: "React 18 only — no React 19 APIs."
- [ ] Off-limits areas are called out: "Don't modify existing DB migrations; add a new one."
- [ ] Style, dependency, or architectural rules the repo enforces are noted (or captured in the repo's `CLAUDE.md`).
- [ ] A turn or budget expectation is set if the work is unusually large or small (`--max-turns` / `--max-budget` at submit time; see the [Prompt guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering#calibrating---max-turns)).

### 4. Dependencies — what must exist or happen first?

- [ ] The target repository is **onboarded** (registered via a Blueprint). An un-onboarded repo fails at pre-flight with `REPO_NOT_ONBOARDED`.
- [ ] Prerequisite work is merged, or this issue is modeled as a **sub-issue** with the correct `blocked by` relation so orchestration runs it in order (see [parent/sub-issue orchestration](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide#parentsub-issue-orchestration)).
- [ ] The GitHub PAT for the repo has the permissions this task type needs (avoids `preflight_failed`).
- [ ] Any external service, secret, or account the change relies on already exists — the agent can't create AWS resources or third-party accounts for you.

### 5. Links & context — is everything the agent needs inline?

- [ ] Relevant files or areas are pointed to (no line numbers needed): "the discount logic in `src/payments/calculateTotal`."
- [ ] External context is **pasted or summarized inline** — the agent sees only the repo, the issue, and its comments. Links to Slack threads, private docs, or "the thing we discussed yesterday" are invisible to it.
- [ ] Examples of desired input → output are included when behavior is specific (e.g. `"Hello World"` → `"hello-world"`).
- [ ] Attachments (images, logs) are added to the issue itself, not referenced from elsewhere.

## Quick reference

| Section | The one question to answer | Common miss |
|---------|---------------------------|-------------|
| Objective | What should be true when this is done? | Describing steps instead of the end state |
| Acceptance criteria | How do we know it's done? | Criteria live in comments, not the body |
| Constraints | What must it respect or avoid? | Framework/version limits left unsaid |
| Dependencies | What must exist or happen first? | Repo not onboarded; PAT under-scoped |
| Links & context | Is everything inline? | Pointing to context the agent can't see |

## Related

- [Prompt guide](/sample-autonomous-cloud-coding-agents/customizing/prompt-engineering) — writing effective task descriptions in depth.
- [Linear setup guide](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide) — trigger labels, the approval flow, and orchestration.
- [User guide](/sample-autonomous-cloud-coding-agents/using/tips-for-being-a-good-citizen) — being a good citizen on a shared platform.
