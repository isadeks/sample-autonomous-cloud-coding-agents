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
 * ABCA-1016 — pending-plan persistence for a Slack thread's approval checkpoint.
 *
 * A Slack plan lives between two events just like a Linear Mode-B plan does: the
 * bot posts the breakdown (event 1) and waits for the person's reply (event 2, a
 * later Slack delivery). So the plan is persisted as ONE row in the same
 * ``OrchestrationTable``, keyed on the parent-thread ref via ``deriveOrchestrationId``
 * + a fixed ``#slack-pending-plan`` sort key, with a TTL so an un-acted plan
 * self-expires — exactly mirroring orchestration-decomposition-store.ts.
 *
 * It is a SEPARATE sort key from the Linear ``#pending-plan`` row so the two
 * surfaces never collide on a shared derived id (they can't today — a Slack thread
 * ref and a Linear issue id are different strings — but keeping the SKs distinct is
 * defence in depth). The row records the panel message ts so a revise/approve
 * matures that SAME editable message in place.
 *
 * Idempotency mirrors the Linear store: {@link consumeSlackPendingPlan} is a
 * conditional delete-and-return, so two racing ``approve``/``reject`` deliveries
 * (Slack retries un-acked events) can't both seed/discard — only the delete winner
 * proceeds. {@link putSlackPendingPlan} is an unconditional upsert (replace), which
 * is what a revise needs; a first-post redelivery is guarded upstream by the
 * planning task's own claim, and re-writing the same nodes is harmless.
 */

import {
  type DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import type { PlannedSubIssue } from './orchestration-decomposition-types';
import { deriveOrchestrationId } from './orchestration-store';

/** Sort key of the single Slack pending-plan row for a thread's orchestration. */
export const SLACK_PENDING_PLAN_SK = '#slack-pending-plan';

/** The persisted Slack pending plan awaiting a thread reply. */
export interface SlackPendingPlanRow {
  readonly orchestration_id: string;
  /** The Slack thread ref (``<channel>:<thread_ts>``) this plan belongs to. */
  readonly slack_thread_ref: string;
  readonly slack_team_id: string;
  readonly slack_channel_id: string;
  readonly slack_thread_ts: string;
  readonly repo: string;
  /** The proposed pieces (index-based ``depends_on``). */
  readonly nodes: readonly PlannedSubIssue[];
  /** Platform user the eventual child tasks attribute to (the submitter). */
  readonly platform_user_id: string;
  /** ts of the editable plan panel message, so revise/approve edit it in place. */
  readonly panel_message_ts?: string;
  readonly created_at: string;
}

export interface PutSlackPendingPlanParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly threadRef: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly repo: string;
  readonly nodes: readonly PlannedSubIssue[];
  readonly platformUserId: string;
  readonly panelMessageTs?: string;
  readonly now: string;
  /** Absolute epoch-seconds expiry (un-acted plans self-clean). */
  readonly ttlEpochSeconds: number;
}

/**
 * Upsert the Slack pending plan (unconditional). A first post and a revise both
 * write here; the revise MUST overwrite the prior nodes (a create-once would keep
 * the stale plan and approve would seed it). Redelivery of a first post re-writes
 * identical content — harmless.
 */
export async function putSlackPendingPlan(params: PutSlackPendingPlanParams): Promise<void> {
  await params.ddb.send(new PutCommand({
    TableName: params.tableName,
    Item: {
      orchestration_id: deriveOrchestrationId(params.threadRef),
      sub_issue_id: SLACK_PENDING_PLAN_SK,
      slack_thread_ref: params.threadRef,
      slack_team_id: params.teamId,
      slack_channel_id: params.channelId,
      slack_thread_ts: params.threadTs,
      repo: params.repo,
      nodes: params.nodes,
      platform_user_id: params.platformUserId,
      ...(params.panelMessageTs !== undefined && { panel_message_ts: params.panelMessageTs }),
      created_at: params.now,
      ttl: params.ttlEpochSeconds,
    },
  }));
}

/** Read a Slack pending plan without consuming it (to route a thread reply). */
export async function getSlackPendingPlan(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  threadRef: string,
): Promise<SlackPendingPlanRow | undefined> {
  const orchestrationId = deriveOrchestrationId(threadRef);
  const res = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { orchestration_id: orchestrationId, sub_issue_id: SLACK_PENDING_PLAN_SK },
  }));
  // A genuine row always carries slack_thread_ref (written by putSlackPendingPlan).
  // Guard on it so a malformed/foreign item at this key isn't read as a live plan.
  if (!res.Item || res.Item.slack_thread_ref === undefined) return undefined;
  return parseRow(res.Item);
}

/**
 * Atomically take the Slack pending plan (approve/reject): delete the row and
 * return what it held. The conditional delete means only the FIRST of two racing
 * deliveries wins — the loser gets ``undefined`` and must not seed/discard.
 */
export async function consumeSlackPendingPlan(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  threadRef: string,
): Promise<SlackPendingPlanRow | undefined> {
  const orchestrationId = deriveOrchestrationId(threadRef);
  try {
    const res = await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { orchestration_id: orchestrationId, sub_issue_id: SLACK_PENDING_PLAN_SK },
      ConditionExpression: 'attribute_exists(orchestration_id)',
      ReturnValues: 'ALL_OLD',
    }));
    if (!res.Attributes) return undefined;
    return parseRow(res.Attributes);
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      logger.info('Slack pending plan already consumed/expired (race or replay) — no-op', {
        orchestration_id: orchestrationId,
      });
      return undefined;
    }
    throw err;
  }
}

/** Coerce a raw DDB item into a typed row (best-effort, total). */
function parseRow(item: Record<string, unknown>): SlackPendingPlanRow {
  return {
    orchestration_id: String(item.orchestration_id ?? ''),
    slack_thread_ref: String(item.slack_thread_ref ?? ''),
    slack_team_id: String(item.slack_team_id ?? ''),
    slack_channel_id: String(item.slack_channel_id ?? ''),
    slack_thread_ts: String(item.slack_thread_ts ?? ''),
    repo: String(item.repo ?? ''),
    nodes: Array.isArray(item.nodes) ? (item.nodes as PlannedSubIssue[]) : [],
    platform_user_id: String(item.platform_user_id ?? ''),
    ...(item.panel_message_ts !== undefined && { panel_message_ts: String(item.panel_message_ts) }),
    created_at: String(item.created_at ?? ''),
  };
}
