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
 * ABCA-1016 — the Slack plan-approval FLOW: given a thread reply while a plan is
 * pending, decide + act (approve → seed, reject → discard, revise → re-render,
 * else nudge), maturing the ONE panel message in place.
 *
 * This is the Slack analogue of the Linear Mode-B verdict path
 * ({@link runPlanVerdict} in orchestration-decomposition-flow.ts): it consumes the
 * SAME pending-plan store, and — crucially for the sub-issue's ask — it understands
 * the reply via the SHARED verdict helpers (through {@link classifySlackPlanReply},
 * which delegates to ``parsePlanVerdict`` / ``parsePlanCommand``) rather than
 * re-implementing them.
 *
 * Every side effect is INJECTED ({@link SlackPlanEffects}) so the control flow is
 * unit-testable with spies, and so the mechanism (which DDB table, which Slack
 * token) stays in the processor. The flow itself is deterministic and never throws
 * — a failed effect is reported as a terminal ``error`` result the caller surfaces.
 */

import { logger } from './logger';
import type { PlannedSubIssue } from './orchestration-decomposition-types';
import {
  renderSlackPlanApproved,
  renderSlackPlanDiscarded,
  renderSlackPlanNudge,
  renderSlackPlanProposal,
} from './slack-plan-panel';
import { classifySlackPlanReply } from './slack-plan-reply';

/** The pending plan the flow acts on, resolved by the caller from the store. */
export interface SlackPendingPlan {
  /** The proposed pieces (index-based ``depends_on``). */
  readonly nodes: readonly PlannedSubIssue[];
  /** The ts of the editable panel message, so a revise/approve edits it in place. */
  readonly panelMessageTs?: string;
}

/**
 * Injected effects. Each is a thin async thunk the processor wires to its real
 * Slack/DDB helpers; tests pass spies. Granular (vs. passing the processor) so the
 * flow is testable in isolation.
 */
export interface SlackPlanEffects {
  /**
   * Edit the plan panel message in place to ``body`` (``chat.update`` via the
   * Slack channel adapter's ``upsertComment`` with the known ts). Returns the ts
   * of the edited/posted message, or null on failure. This is what makes the ONE
   * panel mature rather than stacking messages.
   */
  readonly editPanel: (body: string, panelMessageTs?: string) => Promise<string | null>;
  /** Post a fresh threaded reply (used for the non-destructive nudge, which must
   *  NOT overwrite the still-live panel). */
  readonly postReply: (body: string) => Promise<void>;
  /** Persist the revised plan (replace), remembering the panel ts. Idempotent
   *  overwrite — a revise always supersedes the prior pending plan. */
  readonly replacePendingPlan: (nodes: readonly PlannedSubIssue[], panelMessageTs?: string) => Promise<void>;
  /**
   * Atomically TAKE the pending plan (approve/reject), so a racing second reply
   * can't double-seed or double-discard. Returns the taken plan's nodes, or null
   * when it was already consumed (the loser no-ops).
   */
  readonly consumePendingPlan: () => Promise<{ nodes: readonly PlannedSubIssue[] } | null>;
  /**
   * Seed the multi-step orchestration from the approved nodes (the declarative
   * graph → discover → release → panel). Returns true when it seeded, false when
   * discovery declined (e.g. degenerate graph) so the caller can restore/telling.
   */
  readonly seedApprovedPlan: (nodes: readonly PlannedSubIssue[]) => Promise<boolean>;
}

/** What the flow did — the processor maps this to reactions/logging. */
export type SlackPlanFlowResult =
  /** Plan approved + orchestration seeded; the panel is now the approved reference. */
  | { readonly kind: 'seeded' }
  /** Plan discarded; the panel is now the discarded reference. */
  | { readonly kind: 'discarded' }
  /** Plan revised + re-rendered in place; still awaiting a decision. */
  | { readonly kind: 'revised' }
  /** Reply wasn't an actionable decision; a nudge was posted, plan left intact. */
  | { readonly kind: 'nudged' }
  /**
   * There was no pending plan to act on (already consumed, expired, or this thread
   * never had one). The caller falls through to its normal thread handling — this
   * is NOT an error.
   */
  | { readonly kind: 'no_pending_plan' }
  /** An effect failed; the caller surfaces a "try again". Plan state unchanged where possible. */
  | { readonly kind: 'error'; readonly message: string };

export interface RunSlackPlanReplyParams {
  /** The reply text with the ``@Shoof`` mention already stripped. */
  readonly instruction: string;
  /** The pending plan, or null when the thread has none (→ ``no_pending_plan``). */
  readonly pending: SlackPendingPlan | null;
  readonly effects: SlackPlanEffects;
}

/**
 * Run one plan reply. Never throws.
 *
 * Ordering mirrors {@link classifySlackPlanReply}: an unqualified approve/reject
 * verdict wins; a structural revise re-renders the panel; anything else nudges.
 * Approve/reject go through the atomic {@link SlackPlanEffects.consumePendingPlan}
 * so a duplicate Slack delivery (Slack retries un-acked events) can't double-act.
 */
export async function runSlackPlanReply(params: RunSlackPlanReplyParams): Promise<SlackPlanFlowResult> {
  const { instruction, pending, effects } = params;
  if (!pending) return { kind: 'no_pending_plan' };

  const reply = classifySlackPlanReply(instruction, pending.nodes);

  try {
    switch (reply.kind) {
      case 'approve':
        return await handleApprove(pending, effects);
      case 'reject':
        return await handleReject(pending, effects);
      case 'revised':
        return await handleRevise(reply.nodes, reply.summary, pending, effects);
      case 'nudge':
        await effects.postReply(renderSlackPlanNudge(reply.detail));
        return { kind: 'nudged' };
    }
  } catch (err) {
    logger.error('Slack plan reply flow failed', {
      reply_kind: reply.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

async function handleApprove(
  pending: SlackPendingPlan,
  effects: SlackPlanEffects,
): Promise<SlackPlanFlowResult> {
  // Atomically take the plan so a racing second approve can't double-seed.
  const taken = await effects.consumePendingPlan();
  if (!taken) return { kind: 'no_pending_plan' };

  const seeded = await effects.seedApprovedPlan(taken.nodes);
  if (!seeded) {
    // Discovery declined (a degenerate/empty graph) — nothing to orchestrate. The
    // plan is already consumed; tell the reviewer plainly rather than silently.
    await effects.postReply(
      ':information_source: I couldn\'t start a multi-step run from that plan — try mentioning `@Shoof` again with a fresh request.',
    );
    return { kind: 'error', message: 'seed_declined' };
  }
  // Freeze the panel into the approved reference; live progress arrives below it.
  await effects.editPanel(renderSlackPlanApproved(taken.nodes), pending.panelMessageTs);
  return { kind: 'seeded' };
}

async function handleReject(
  pending: SlackPendingPlan,
  effects: SlackPlanEffects,
): Promise<SlackPlanFlowResult> {
  const taken = await effects.consumePendingPlan();
  if (!taken) return { kind: 'no_pending_plan' };
  await effects.editPanel(renderSlackPlanDiscarded(), pending.panelMessageTs);
  return { kind: 'discarded' };
}

async function handleRevise(
  nodes: readonly PlannedSubIssue[],
  summary: string,
  pending: SlackPendingPlan,
  effects: SlackPlanEffects,
): Promise<SlackPlanFlowResult> {
  // Persist the revised plan first (source of truth), THEN mature the panel — so a
  // crash between the two leaves the store holding the plan the reviewer sees.
  await effects.replacePendingPlan(nodes, pending.panelMessageTs);
  await effects.editPanel(
    renderSlackPlanProposal(nodes, { changeSummary: summary }),
    pending.panelMessageTs,
  );
  return { kind: 'revised' };
}
