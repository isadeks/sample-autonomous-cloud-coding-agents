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
 * ABCA-1016 — understand a natural Slack thread reply to a PROPOSED plan.
 *
 * When a suitably large ``@Shoof`` request produces a breakdown, the bot posts
 * the plan in the thread and WAITS: the person replies to approve it, discard
 * it, or ask for a change — the same safety checkpoint Linear has (Mode B), which
 * Slack lacked. This module is the pure classifier that turns the human's reply
 * ("looks good", "no, make it two tasks", "👍", "cancel", "drop #3") into one of
 * a small set of {@link SlackPlanReply} actions the flow acts on.
 *
 * REUSE, not re-implementation, is the whole point (and the sub-issue's explicit
 * ask): the natural-language verdict vocabulary — approve/reject/soft-negation/
 * change-instruction, the emoji handling, the "short comment vs. long edit
 * request" discipline — is exactly what {@link parsePlanVerdict} already encodes
 * for Linear, and the structural direct-manipulation grammar ("drop 3", "merge 1
 * and 2", "make #2 small") is what {@link parsePlanCommand}/{@link applyPlanCommand}
 * already encode. Slack replies are the same human utterances arriving over a
 * different surface, so this module DELEGATES to those shared helpers and only
 * decides how their verdicts map onto a Slack thread's editable panel. Nothing
 * about the parsing lives here.
 *
 * Kept pure (no I/O, no AWS/Slack types) so the routing is unit-testable in
 * isolation; the flow ({@link runSlackPlanReply}) does the persistence + panel
 * edit + seeding.
 */

import { parsePlanVerdict } from './orchestration-comment-trigger';
import type { PlannedSubIssue } from './orchestration-decomposition-types';
import { applyPlanCommand, parsePlanCommand } from './orchestration-plan-commands';

/**
 * The classified intent of a reply to a pending Slack plan. Mirrors the Linear
 * Mode-B outcomes ({@link parsePlanVerdict}) but resolved all the way to a Slack
 * ACTION, because Slack has no revise-agent loop yet — a semantic change request
 * that isn't a structural command is surfaced as a nudge rather than silently
 * dropped (the destructive-safe default the Linear path also honours).
 */
export type SlackPlanReply =
  /** A clear go-ahead: seed the multi-step orchestration from the current plan. */
  | { readonly kind: 'approve' }
  /** An explicit, unambiguous discard: throw the plan away, run nothing. */
  | { readonly kind: 'reject' }
  /**
   * A STRUCTURAL edit the reviewer typed ("drop #3", "merge 1 and 2", "make #2
   * small") that applied cleanly. ``nodes`` is the new plan; the caller re-renders
   * the SAME panel in place and keeps waiting for approval. ``summary`` is a short
   * human note of what changed, for the panel's "what changed" line.
   */
  | { readonly kind: 'revised'; readonly nodes: readonly PlannedSubIssue[]; readonly summary: string }
  /**
   * The reply asked for a change we can't safely make deterministically: a
   * semantic re-plan ("make it simpler", "split the API work"), a structural
   * command that was out of range / collapsed the plan, or an ambiguous soft
   * negation ("no", "don't"). We never guess-and-destroy — the caller nudges the
   * reviewer to approve / discard / describe an exact change. ``detail`` carries a
   * specific reason when one is known (e.g. the out-of-range message).
   */
  | { readonly kind: 'nudge'; readonly detail?: string };

/**
 * Classify a thread reply (mention token already stripped) against the pending
 * plan's nodes. PURE. Delegates every judgement of the human's words to the
 * shared helpers:
 *
 *  1. {@link parsePlanVerdict} first — an unqualified approve/reject verdict wins,
 *     because a person who typed "looks good" or "cancel" means exactly that and a
 *     structural parse of the same words would be a misread. A ``none`` verdict
 *     (an edit request) or ``ambiguous`` (a bare soft negation) falls through.
 *  2. On a ``none`` verdict, try {@link parsePlanCommand} — the reviewer may have
 *     typed a concrete structural edit. If it parses AND {@link applyPlanCommand}
 *     succeeds, that's a ``revised`` plan (re-rendered in place). A parsed-but-
 *     invalid command (out of range, collapses to one) becomes a ``nudge`` with
 *     the specific reason, exactly as Linear surfaces it — never a silent no-op.
 *  3. Anything else (a semantic re-plan we can't apply deterministically, or an
 *     ``ambiguous`` verdict) → ``nudge``.
 *
 * An empty reply (a bare re-mention with no text) is a ``nudge`` — unlike the
 * ABCA-1015 iterate path where a bare mention means "address the review", a bare
 * re-mention while a plan is pending is not a decision, so we prompt rather than
 * guess.
 */
export function classifySlackPlanReply(
  instruction: string,
  nodes: readonly PlannedSubIssue[],
): SlackPlanReply {
  const text = (instruction ?? '').trim();
  if (!text) return { kind: 'nudge' };

  const verdict = parsePlanVerdict(text);
  if (verdict === 'approve') return { kind: 'approve' };
  if (verdict === 'reject') return { kind: 'reject' };
  if (verdict === 'ambiguous') return { kind: 'nudge' };

  // verdict === 'none' → an edit request. Try the deterministic structural grammar
  // before falling back to a nudge (Slack has no repo-cloning revise loop yet).
  const command = parsePlanCommand(text);
  if (!command) return { kind: 'nudge' };

  const applied = applyPlanCommand(nodes, command);
  if (applied.kind === 'ok') {
    return { kind: 'revised', nodes: applied.nodes, summary: describeCommand(command, nodes.length, applied.nodes.length) };
  }
  if (applied.kind === 'collapses') {
    return {
      kind: 'nudge',
      detail: 'That change would leave just one piece — there\'d be nothing to run in parallel.',
    };
  }
  // applied.kind === 'error' — the reviewer named a real structural intent but it
  // was invalid (an out-of-range number). Surface the specific reason.
  return { kind: 'nudge', detail: applied.message };
}

/** A short, human-readable note of what a structural command did, for the panel. */
function describeCommand(
  command: ReturnType<typeof parsePlanCommand>,
  before: number,
  after: number,
): string {
  if (!command) return 'Updated the plan.';
  switch (command.kind) {
    case 'drop': {
      const refs = command.indices.map((i) => `#${i + 1}`).join(', ');
      return `Dropped ${refs} — now ${after} piece${after === 1 ? '' : 's'}.`;
    }
    case 'merge': {
      const refs = command.indices.map((i) => `#${i + 1}`).join(', ');
      return `Merged ${refs} into one — now ${after} piece${after === 1 ? '' : 's'} (was ${before}).`;
    }
    case 'size':
      return `Resized #${command.index + 1} to ${command.size}.`;
  }
}
