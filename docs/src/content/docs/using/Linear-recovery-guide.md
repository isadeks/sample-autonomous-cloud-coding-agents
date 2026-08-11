---
title: Linear recovery guide
---

# Recovering when ABCA needs input (Linear)

When you hand a Linear issue to ABCA, the agent talks back to you **entirely through the issue you triggered** — an emoji reaction on your comment (or the issue) plus a threaded reply. You never leave Linear to see what happened or to steer it.

This page explains how to read those status reactions and how to reply to revise, answer, or retry work — especially when ABCA stops and **needs input from you**.

> **New to the Linear integration?** Start with the [Linear integration setup guide](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide) for how triggering, labels, and the `@bgagent` reply flow work. This page picks up once a task is running and something needs your attention.

## Reading the status reactions

ABCA reacts on the comment (or issue) that triggered the work and swaps that reaction as the task moves through its lifecycle. At any moment there is **one** ABCA reaction, and it tells you exactly where things stand:

| Reaction | Emoji | What it means | What you do |
|----------|-------|---------------|-------------|
| **Started / running** | 👀 `eyes` | ABCA has picked up the work and is running. The 👀 stays on for the whole run — from the moment it starts through to the terminal state. On a plain issue task the issue also moves to **In Progress**. | Nothing yet — wait. A typical task takes a few minutes. |
| **Success** | ✅ `white_check_mark` | The task finished and produced a change. ABCA has opened (or updated) a pull request and posted the link in the thread. On a plain issue task the issue moves to **In Review**. | Review the linked PR. Reply if you want changes (see below). |
| **Needs input** | ❓ `question` | ABCA **stopped without making a change** because it needs something from you: a clarifying answer, a decision it can't make on its own, or an acknowledgement that your comment was a question rather than a change. **No PR was opened and you were not charged for a guess.** The threaded reply says what it needs. | Reply with the answer or decision (see [When ABCA needs input](#when-abca-needs-input)). |
| **Failure** | ❌ `x` | The task failed — a pre-flight problem (repo not onboarded, missing permissions), a build/test failure it couldn't resolve, a cancellation, or an internal error. The threaded reply explains what went wrong. | Fix the cause if it's on your side, then reply to retry (see [When a task fails](#when-a-task-fails)). |

> **Why the reactions swap instead of stacking.** ABCA keeps a single live marker so the reaction always matches the current state — it deletes the previous one before adding the next (👀 → ✅ / ❓ / ❌). Reactions a **human** added are never touched. If a task is re-run, stale ABCA markers from the previous run are swept so you only ever see the current status.

> **Reactions are advisory, the reply is authoritative.** Reactions are best-effort UX. If a transient Linear API hiccup drops a reaction, the threaded reply and the PR link are the source of truth — read the reply text, not just the emoji.

## When ABCA needs input

A ❓ reaction means ABCA deliberately paused rather than guessing. This is the "clarify before spend" behaviour: when a request is too ambiguous to implement without guessing, the agent asks a question, opens **no** PR, and surfaces the question to you instead of burning budget on a wrong guess. It happens in a few situations:

- **The request is ambiguous.** ABCA read the issue but couldn't tell what you actually want built, so it asks a clarifying question instead of guessing.
- **Your comment was a question, not a change.** If you `@bgagent`'d something like "where is the login page handled?", ABCA answers in the thread and marks it ❓ (it answered you; it didn't change code).
- **A reply couldn't be routed.** On an epic (parent issue with sub-issues), a comment ABCA can't map to a single sub-issue gets a ❓ and a reply asking you to pick one.

**To respond, reply in the same thread with `@bgagent <your answer>`.** Give it the missing detail in plain language — for example:

```
@bgagent yes, use the existing validation helper in utils/validate.ts and return a 400 on failure
```

ABCA re-reads the thread with your answer as new context and continues. You can go back and forth as many times as you need until it has enough to proceed.

## Revising work that succeeded

A ✅ with a PR link doesn't mean you're stuck with what it produced. To ask for changes, **reply to the agent's comment with `@bgagent <what you want changed>`**:

```
@bgagent rename the flag to --dry-run and add a unit test for the empty-input case
```

ABCA checks out the existing PR branch, makes the change, and pushes to the **same** PR (it does not open a new one). The trigger comment's reaction swaps back to 👀 while it works, then to ✅ when done. Repeat until the PR is right, then merge it yourself — **ABCA never merges for you.**

## When a task fails

A ❌ means the task ended without success. Read the threaded reply first — it names the cause. Common ones and how to recover:

- **Repo or project not onboarded / label mismatch** — the trigger never mapped to a repo. Fix the onboarding (see the [Linear setup guide](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide#troubleshooting)) and re-apply the trigger label.
- **Missing GitHub permissions** — the personal access token lacks the rights the workflow needs. Fix the PAT, then retry.
- **Build or test failure it couldn't resolve** — the reply summarises what broke. Reply with a hint (`@bgagent the failing test needs the DB fixture seeded first`) and ABCA retries with that context.
- **Concurrency limit** — you already have the maximum number of tasks running. Wait for one to finish (or cancel it), then re-trigger.

**To retry, reply `@bgagent <optional guidance>` in the thread**, or re-apply the trigger label to the issue. A plain retry re-runs the work; adding guidance steers the next attempt. When you retry, ABCA clears the ❌ and puts 👀 back while it works.

> Removing the Linear label does **not** cancel a running task, and re-adding it while a task is in flight won't start a second one. Use `bgagent cancel <task-id>` from the CLI to stop a run.

## Approving or changing a proposed plan

If you triggered a plan-first flow (`bgagent:decompose`), ABCA posts a breakdown and **waits for your approval** before running anything. Reply in the thread:

- `@bgagent approve` — run the plan as posted.
- `@bgagent reject` — discard the plan; nothing runs.
- Plain language — e.g. `@bgagent make it 2 tasks instead of 3` — ABCA re-plans and posts an updated breakdown. Repeat until you're happy, then approve.

See [Trigger labels](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide#trigger-labels) for the full label reference.

## Quick reference

| You see… | It means | Reply with |
|----------|----------|------------|
| 👀 | Running | (wait) |
| ✅ + PR link | Done, PR ready | `@bgagent <change>` to revise, or merge it |
| ❓ + a question | Needs your input | `@bgagent <answer / decision>` |
| ❌ + a reason | Failed | `@bgagent <retry guidance>`, or re-apply the label |
| A posted plan | Awaiting approval | `@bgagent approve` / `reject` / a change |

## Related

- [Linear integration setup guide](/sample-autonomous-cloud-coding-agents/using/linear-setup-guide) — triggering, labels, `@bgagent` replies, and setup troubleshooting.
- [User guide](/sample-autonomous-cloud-coding-agents/using/overview) — task lifecycle, workflows, and limits across all channels.
- [Quick start](./QUICK_START.mdx) — deploy ABCA and run your first task.
