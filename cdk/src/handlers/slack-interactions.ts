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

import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { logger } from './shared/logger';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const TASK_APPROVALS_TABLE = process.env.TASK_APPROVALS_TABLE_NAME;
const TASK_EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME;
const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;

/** Audit event retention (days). Falls back to 90 if not set. */
const AUDIT_EVENT_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

interface SlackInteractionPayload {
  readonly type: string;
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  readonly actions?: ReadonlyArray<{
    readonly action_id: string;
    readonly block_id: string;
    readonly value?: string;
  }>;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly channel?: { readonly id: string };
}

/**
 * POST /v1/slack/interactions — Handle Slack Block Kit interactive actions.
 *
 * Slack sends interaction payloads as a URL-encoded `payload` field in the body.
 * Currently handles:
 * - `cancel_task:{task_id}` — Cancel a running task via the "Cancel Task" button.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // Verify Slack signing secret (re-fetches if the cached value was rotated out).
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);
    if (!signingSecret) {
      logger.error('Slack signing secret not found');
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';

    if (!await verifySlackRequest(SIGNING_SECRET_ARN, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack interaction signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    // Parse the payload — Slack sends it as URL-encoded `payload=<json>`.
    const params = new URLSearchParams(event.body);
    const payloadStr = params.get('payload');
    if (!payloadStr) {
      return jsonResponse(400, { error: 'Missing payload' });
    }

    const payload: SlackInteractionPayload = JSON.parse(payloadStr);

    if (payload.type === 'block_actions' && payload.actions) {
      for (const action of payload.actions) {
        if (action.action_id.startsWith('cancel_task:')) {
          await handleCancelAction(payload, action.action_id);
        } else if (action.action_id.startsWith('approve_task:')) {
          await handleApproveAction(payload, action.action_id);
        } else if (action.action_id.startsWith('deny_task:')) {
          await handleDenyAction(payload, action.action_id);
        }
      }
    }

    // Slack expects a 200 response within 3 seconds.
    return jsonResponse(200, {});
  } catch (err) {
    logger.error('Slack interaction handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(200, {}); // Still return 200 to avoid Slack retries.
  }
}

async function handleCancelAction(payload: SlackInteractionPayload, actionId: string): Promise<void> {
  const taskId = actionId.replace('cancel_task:', '');
  const teamId = payload.user.team_id;
  const userId = payload.user.id;

  // Look up platform user.
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${userId}` },
  }));

  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url, ':link: Your Slack account is not linked.');
    return;
  }

  const platformUserId = mappingResult.Item.platform_user_id as string;

  // Load the task.
  const taskResult = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  if (!taskResult.Item) {
    await postToResponseUrl(payload.response_url, `:mag: Task \`${taskId}\` not found.`);
    return;
  }

  if (taskResult.Item.user_id !== platformUserId) {
    await postToResponseUrl(payload.response_url, ':no_entry: You can only cancel your own tasks.');
    return;
  }

  // Attempt to cancel.
  const CANCELLABLE_STATUSES = ['PENDING_UPLOADS', 'SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING'];
  try {
    await ddb.send(new UpdateCommand({
      TableName: TASK_TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #s = :cancelled, updated_at = :now',
      ConditionExpression: '#s IN (:s1, :s2, :s3, :s4, :s5, :s6)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'CANCELLED',
        ':now': new Date().toISOString(),
        ':s1': CANCELLABLE_STATUSES[0],
        ':s2': CANCELLABLE_STATUSES[1],
        ':s3': CANCELLABLE_STATUSES[2],
        ':s4': CANCELLABLE_STATUSES[3],
        ':s5': CANCELLABLE_STATUSES[4],
        ':s6': CANCELLABLE_STATUSES[5],
      },
    }));

    // Instant feedback: replace the Cancel button message with "Cancelling..."
    // then clean up all intermediate messages.
    const channelMeta = taskResult.Item.channel_metadata as Record<string, string> | undefined;
    const channelId = payload.channel?.id ?? channelMeta?.slack_channel_id;
    if (channelMeta && channelId) {
      const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
      if (botToken) {
        if (channelMeta.slack_session_msg_ts) {
          await updateSlackMessage(botToken, channelId, channelMeta.slack_session_msg_ts,
            ':hourglass_flowing_sand: Cancelling...', channelMeta.slack_thread_ts);
        }
        const toDelete = [channelMeta.slack_created_msg_ts].filter(Boolean);
        for (const ts of toDelete) {
          await deleteSlackMessage(botToken, channelId, ts!);
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'ConditionalCheckFailedException') {
      await postToResponseUrl(payload.response_url, ':warning: Task is already in a terminal state.');
    } else {
      throw err;
    }
  }
}

/**
 * Parse a ``<action>_task:<task_id>:<request_id>`` action id into its
 * components. Returns null if the shape doesn't match.
 */
function parseApprovalActionId(actionId: string): { taskId: string; requestId: string } | null {
  // Format: approve_task:<task_id>:<request_id>
  //       deny_task:<task_id>:<request_id>
  const colonIdx = actionId.indexOf(':');
  if (colonIdx < 0) return null;
  const rest = actionId.slice(colonIdx + 1);
  const midIdx = rest.indexOf(':');
  if (midIdx < 0) return null;
  const taskId = rest.slice(0, midIdx);
  const requestId = rest.slice(midIdx + 1);
  if (!taskId || !requestId) return null;
  return { taskId, requestId };
}

/**
 * Handle the Cedar HITL "Approve" button click.
 *
 * Mirrors the ``approve-task.ts`` handler logic: atomically transitions the
 * approval row from ``PENDING`` → ``APPROVED`` while verifying the task is
 * still in ``AWAITING_APPROVAL`` and the request_id matches. Writes an
 * ``approval_decision_recorded`` audit event to ``TaskEventsTable``.
 *
 * The Slack-specific layer resolves the Slack user → platform user mapping
 * (same as cancel) to enforce ownership — only the user who submitted the
 * task may approve/deny it. This keeps the Slack HITL surface aligned with
 * the REST API's ownership guard.
 *
 * Action id shape: ``approve_task:<task_id>:<request_id>``
 */
async function handleApproveAction(payload: SlackInteractionPayload, actionId: string): Promise<void> {
  const parsed = parseApprovalActionId(actionId);
  if (!parsed) {
    logger.warn('approve_task: malformed action id', { action_id: actionId });
    return;
  }
  const { taskId, requestId } = parsed;

  if (!TASK_APPROVALS_TABLE || !TASK_EVENTS_TABLE) {
    logger.warn('approve_task: TASK_APPROVALS_TABLE_NAME or TASK_EVENTS_TABLE_NAME not configured', { task_id: taskId });
    await postToResponseUrl(payload.response_url, ':warning: Approval actions are not configured on this deployment. Ask your admin to re-deploy.');
    return;
  }

  await handleApprovalDecision({
    payload,
    taskId,
    requestId,
    decision: 'approve',
    successText: ':white_check_mark: *Approved.* The agent will continue.',
  });
}

/**
 * Handle the Cedar HITL "Deny" button click.
 *
 * Mirrors ``approve-task.ts`` but transitions to ``DENIED``. No deny_reason
 * is collected from Slack (the button confirm dialog already gives the user
 * a chance to reconsider). The agent receives the denial on its next poll
 * and applies the configured soft-deny behaviour.
 *
 * Action id shape: ``deny_task:<task_id>:<request_id>``
 */
async function handleDenyAction(payload: SlackInteractionPayload, actionId: string): Promise<void> {
  const parsed = parseApprovalActionId(actionId);
  if (!parsed) {
    logger.warn('deny_task: malformed action id', { action_id: actionId });
    return;
  }
  const { taskId, requestId } = parsed;

  if (!TASK_APPROVALS_TABLE || !TASK_EVENTS_TABLE) {
    logger.warn('deny_task: TASK_APPROVALS_TABLE_NAME or TASK_EVENTS_TABLE_NAME not configured', { task_id: taskId });
    await postToResponseUrl(payload.response_url, ':warning: Approval actions are not configured on this deployment. Ask your admin to re-deploy.');
    return;
  }

  await handleApprovalDecision({
    payload,
    taskId,
    requestId,
    decision: 'deny',
    successText: ':no_entry_sign: *Denied.* The agent will stop this action.',
  });
}

/**
 * Shared atomic approve/deny DynamoDB transition.
 *
 * Performs a ``TransactWriteItems`` matching the approve-task / deny-task
 * handlers: (1) transitions the approval row from PENDING, (2) no-op update
 * on the task row to confirm it is still AWAITING_APPROVAL with the matching
 * request_id. Writes an audit event on success.
 *
 * Failure cases:
 *  - Task not found / user not mapped     → 404-equivalent ephemeral message.
 *  - Ownership mismatch                   → deny via 404 collapse (no oracle).
 *  - Request not found / already decided  → 409-equivalent ephemeral message.
 *  - Task no longer AWAITING_APPROVAL     → 409-equivalent ephemeral message.
 */
async function handleApprovalDecision(opts: {
  payload: SlackInteractionPayload;
  taskId: string;
  requestId: string;
  decision: 'approve' | 'deny';
  successText: string;
}): Promise<void> {
  const { payload, taskId, requestId, decision, successText } = opts;
  const teamId = payload.user.team_id;
  const userId = payload.user.id;

  // Resolve the Slack user to a platform user (ownership check).
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${userId}` },
  }));
  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url, ':link: Your Slack account is not linked. Run `/bgagent link` first.');
    return;
  }
  const platformUserId = mappingResult.Item.platform_user_id as string;

  // Load the task to verify it exists and the user owns it.
  const taskResult = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));
  if (!taskResult.Item) {
    await postToResponseUrl(payload.response_url, `:mag: Task \`${taskId}\` not found.`);
    return;
  }
  if (taskResult.Item.user_id !== platformUserId) {
    // Same 404 collapse as the REST API — don't expose existence oracle.
    await postToResponseUrl(payload.response_url, ':mag: Approval request not found or not owned by you.');
    return;
  }

  const nowIso = new Date().toISOString();
  const nowEpoch = Math.floor(Date.now() / 1000);
  const newStatus = decision === 'approve' ? 'APPROVED' : 'DENIED';

  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TASK_APPROVALS_TABLE!,
            Key: { task_id: taskId, request_id: requestId },
            UpdateExpression: 'SET #status = :decided, decided_at = :now',
            ConditionExpression: 'attribute_exists(request_id) AND #status = :pending AND user_id = :caller',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':decided': newStatus,
              ':pending': 'PENDING',
              ':now': nowIso,
              ':caller': platformUserId,
            },
          },
        },
        {
          Update: {
            TableName: TASK_TABLE,
            Key: { task_id: taskId },
            UpdateExpression: 'SET last_decision_at = :now',
            ConditionExpression: '#status = :awaiting AND awaiting_approval_request_id = :rid',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':awaiting': 'AWAITING_APPROVAL',
              ':rid': requestId,
              ':now': nowIso,
            },
          },
        },
      ],
    }));
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      const reasons = err.CancellationReasons ?? [];
      const approvalsCode = reasons[0]?.Code;
      const taskCode = reasons[1]?.Code;
      if (approvalsCode === 'ConditionalCheckFailed') {
        await postToResponseUrl(payload.response_url, ':mag: Approval request not found, not owned by you, or already decided.');
        return;
      }
      if (taskCode === 'ConditionalCheckFailed') {
        await postToResponseUrl(payload.response_url, ':warning: Task is no longer waiting for this approval.');
        return;
      }
    }
    logger.error('Approval decision transaction failed', {
      task_id: taskId,
      request_id: requestId,
      decision,
      error: err instanceof Error ? err.message : String(err),
    });
    await postToResponseUrl(payload.response_url, ':x: Something went wrong recording your decision. Please try again.');
    return;
  }

  // Write audit event (best-effort — the decision is already committed).
  try {
    await ddb.send(new PutCommand({
      TableName: TASK_EVENTS_TABLE!,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'approval_decision_recorded',
        timestamp: nowIso,
        ttl: nowEpoch + AUDIT_EVENT_RETENTION_DAYS * 86_400,
        metadata: {
          request_id: requestId,
          status: newStatus,
          decided_at: nowIso,
          caller_user_id: platformUserId,
          channel: 'slack',
        },
      },
    }));
  } catch (auditErr) {
    logger.warn('approval_decision_recorded audit write failed (decision already committed)', {
      task_id: taskId,
      request_id: requestId,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }

  logger.info('Approval decision recorded via Slack', {
    task_id: taskId,
    request_id: requestId,
    decision,
    platform_user_id: platformUserId,
  });

  await postToResponseUrl(payload.response_url, successText);
}

async function updateSlackMessage(botToken: string, channel: string, ts: string, text: string, threadTs?: string): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      channel,
      ts,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    };
    if (threadTs) payload.thread_ts = threadTs;
    const response = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to update Slack message', { error: result.error, ts });
    }
  } catch (err) {
    logger.warn('Error updating Slack message', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function deleteSlackMessage(botToken: string, channel: string, ts: string): Promise<void> {
  try {
    const response = await fetch('https://slack.com/api/chat.delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({ channel, ts }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to delete Slack message', { error: result.error, ts });
    }
  } catch (err) {
    logger.warn('Error deleting Slack message', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function postToResponseUrl(responseUrl: string, text: string): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text, replace_original: false }),
    });
  } catch (err) {
    logger.warn('Failed to post to interaction response_url', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
