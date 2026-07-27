/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * ABCA-1016 — the Slack plan panel: ONE message that MATURES IN PLACE.
 *
 * The sub-issue asks that the plan and its progress "surface as an editable Slack
 * message so one panel matures in place". The Slack channel adapter already edits
 * a message via ``chat.update`` (``upsertComment`` with a known ts — see
 * orchestration-channel-slack.ts), which is exactly the mechanism this relies on:
 * the flow posts this panel once, remembers its ts, and re-renders + edits the
 * SAME message as the plan is revised, approved, or discarded — instead of
 * stacking a new message per step.
 *
 * These renderers are pure Slack ``mrkdwn`` (no I/O). They deliberately parallel
 * the Linear Mode-B proposal copy (orchestration-decomposition-render.ts) — same
 * numbered breakdown, same sizing/sequencing/cost-ceiling framing — so a reviewer
 * who has seen ABCA on Linear reads the Slack panel the same way. The action
 * footer is Slack-flavoured (reply in-thread, no ``@bgagent`` label grammar): the
 * verbs are the natural replies {@link classifySlackPlanReply} understands.
 *
 * The panel has FOUR states, all rendered here so the one message can move through
 * them without ever being deleted:
 *  - PROPOSED / REVISED — awaiting a decision (approve / reject / change).
 *  - APPROVED — frozen reference; the live orchestration progress takes over below.
 *  - DISCARDED — frozen one-liner; nothing ran.
 */

import { validateDag, type DagNode } from './orchestration-dag';
import type { PlannedSubIssue, SubIssueSize } from './orchestration-decomposition-types';

/** Leading glyph so the panel is instantly recognisable as the plan (and, like
 *  the Linear 🗂️ prefix, marks it as bot-authored for any self-trigger guard). */
export const SLACK_PLAN_PANEL_PREFIX = ':clipboard:';

/** A short glyph per size for compact rendering (matches the Linear proposal). */
const SIZE_GLYPH: Readonly<Record<SubIssueSize, string>> = { S: 'S', M: 'M', L: 'L' };

/** The longest dependency chain = number of topological layers (the serial floor
 *  of the orchestration). Mirrors ``criticalPathLength`` on the Linear side. */
function criticalPathLength(nodes: readonly PlannedSubIssue[]): number {
  if (nodes.length === 0) return 0;
  const dagNodes: DagNode[] = nodes.map((n, i) => ({
    id: `n${i}`,
    depends_on: n.depends_on.map((d) => `n${d}`),
  }));
  const v = validateDag(dagNodes);
  return v.ok ? v.layers.length : nodes.length;
}

/** Σ of per-child budgets — the plan's worst-case cost ceiling. */
function totalBudget(nodes: readonly PlannedSubIssue[]): number {
  return nodes.reduce((s, n) => s + (Number.isFinite(n.max_budget_usd) ? n.max_budget_usd : 0), 0);
}

/** Money with at most 2 decimals, trailing zeros trimmed. */
function formatUsd(n: number): string {
  return Number(n.toFixed(2)).toString();
}

/** Render one child's dependency note (e.g. " _(after #1, #3)_"; "" for a root). */
function dependsNote(node: PlannedSubIssue): string {
  if (node.depends_on.length === 0) return '';
  const refs = [...node.depends_on].sort((a, b) => a - b).map((d) => `#${d + 1}`).join(', ');
  return ` _(after ${refs})_`;
}

/** Render the numbered breakdown shared by the proposed/approved states. */
function renderNodes(nodes: readonly PlannedSubIssue[]): string[] {
  const lines: string[] = [];
  nodes.forEach((node, i) => {
    lines.push(`${i + 1}. *${node.title}* \`${SIZE_GLYPH[node.size]}\`${dependsNote(node)}`);
    if (node.description && node.description !== node.title) {
      lines.push(`   ${node.description}`);
    }
  });
  return lines;
}

/** Plain-English sequencing summary (matches the Linear proposal's three shapes). */
function renderSummaryLine(nodes: readonly PlannedSubIssue[]): string {
  const cp = criticalPathLength(nodes);
  const n = nodes.length;
  let sequencing: string;
  if (cp <= 1) {
    sequencing = 'they can all run at the same time';
  } else if (cp >= n) {
    sequencing = 'they run one after another';
  } else {
    sequencing = `up to ${cp} run one after another (the rest run at the same time)`;
  }
  return (
    `*In short:* ${n} pieces — ${sequencing}. `
    + `I'll cap spending at *$${formatUsd(totalBudget(nodes))}* — that's a safety limit, `
    + 'not an estimate; actual cost is usually a small fraction of it.'
  );
}

export interface RenderSlackPlanProposalOptions {
  /** A short "what changed" note, shown after a structural revise so the reviewer
   *  can catch the edit at a glance (mirrors the Linear "What changed" line). */
  readonly changeSummary?: string;
}

/**
 * Render the PROPOSED (or REVISED) plan panel — the state awaiting a decision.
 * ``changeSummary`` present ⇒ the header reads "Updated plan" and the note is
 * shown, exactly as the Linear proposal flips "Proposed" → "Updated" after an edit.
 */
export function renderSlackPlanProposal(
  nodes: readonly PlannedSubIssue[],
  opts: RenderSlackPlanProposalOptions = {},
): string {
  const edited = Boolean(opts.changeSummary);
  const lines: string[] = [];
  lines.push(
    `${SLACK_PLAN_PANEL_PREFIX} *${edited ? 'Updated plan' : 'Proposed plan'}* — ${nodes.length} pieces`,
  );
  if (edited && opts.changeSummary) {
    lines.push('');
    lines.push(`*What changed:* ${opts.changeSummary}`);
  }
  lines.push('');
  lines.push(...renderNodes(nodes));
  lines.push('');
  lines.push(renderSummaryLine(nodes));
  lines.push('');
  // Slack-flavoured action footer: the natural replies classifySlackPlanReply
  // understands. No @bgagent label grammar — this is a chat surface.
  lines.push('Reply in this thread to decide:');
  lines.push('• *approve* (or "looks good", 👍) — I\'ll create the pieces and start.');
  lines.push('• *cancel* — discard the plan; nothing runs.');
  lines.push('• or tell me what to change — e.g. "drop #3", "merge 1 and 2", "make #2 small".');
  return lines.join('\n');
}

/**
 * Freeze the panel into an APPROVED reference once the orchestration is seeded.
 * The action footer + cost preamble are now stale; what stays useful is a compact
 * record of WHAT was agreed, with live status arriving as threaded progress below.
 * Mirrors the Linear ``renderApprovedPlanReference``.
 */
export function renderSlackPlanApproved(nodes: readonly PlannedSubIssue[]): string {
  const lines: string[] = [];
  lines.push(`${SLACK_PLAN_PANEL_PREFIX} *Approved plan* — ${nodes.length} pieces`);
  lines.push('');
  lines.push(...renderNodes(nodes));
  lines.push('');
  lines.push('_Started — I\'ll post progress on each piece in this thread._');
  return lines.join('\n');
}

/** Freeze the panel when the plan is DISCARDED — a one-line record; nothing ran. */
export function renderSlackPlanDiscarded(): string {
  return `${SLACK_PLAN_PANEL_PREFIX} *Plan discarded* — no pieces were created, nothing ran.`;
}

/**
 * The nudge posted (as a THREADED reply, not an edit to the panel) when a reply is
 * not an actionable decision: a bare re-mention, an ambiguous "no", or a change we
 * can't apply deterministically. Keeps the panel intact + approvable and tells the
 * reviewer the three concrete things they can say. ``detail`` carries a specific
 * reason when one is known (e.g. an out-of-range "#5"). Mirrors the Linear nudge.
 */
export function renderSlackPlanNudge(detail?: string): string {
  const reason = detail?.trim();
  const lead = reason
    ? `${SLACK_PLAN_PANEL_PREFIX} ${/[.!?]$/.test(reason) ? reason : `${reason}.`} `
    : `${SLACK_PLAN_PANEL_PREFIX} There's a plan above waiting on you. `;
  return (
    lead
    + 'Reply *approve* to create the pieces and start, *cancel* to discard it, '
    + 'or tell me what to change (e.g. "drop #3", "merge 1 and 2").'
  );
}
