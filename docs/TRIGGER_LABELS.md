# Trigger labels

ABCA watches Linear issues for these labels and matches them by name, so you create them yourself (Linear → Settings → Labels, or inline on any issue). Add a short description to each — Linear shows it on hover in the label picker, the only discoverability a first-time teammate gets.

There are exactly two labels:

| Label | What it does | Use it when |
|-------|--------------|-------------|
| `bgagent` | **Do it.** Hands the issue to the agent — it reads the issue, makes the change, and opens a PR. If the issue already has sub-issues, those run in dependency order instead. | The issue is a single, well-defined piece of work (or a parent whose sub-issues are ready). |
| `bgagent:help` | **Explain the labels.** Posts a one-time comment describing what the labels do, then creates no task. Remove it afterward. | You're new to ABCA on this issue and want a reminder of the options. |

Notes:

- The base trigger label defaults to `bgagent`; if you passed `--label <name>` at onboarding, substitute your workspace's label (the `:help` variant follows the same prefix, e.g. `<name>:help`).
- Suggested descriptions to set in Linear: **`bgagent`** — "Hand this issue to ABCA — makes the change and opens a PR"; **`bgagent:help`** — "ABCA explains what its labels do".
- Grouping both under a shared label prefix/group keeps them together and away from unrelated labels in the picker.
- Removing a label does not cancel a running task; use `bgagent cancel <task-id>`.
