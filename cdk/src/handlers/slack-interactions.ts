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
const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;
const TASK_APPROVALS_TABLE = process.env.TASK_APPROVALS_TABLE_NAME;
const TASK_EVENTS_TABLE = process.env.TASK_EVENTS_TABLE_NAME;

/** Approval decision written by the Slack interactions handler. */
type ApprovalDecision = 'approve' | 'deny';

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
          await handleApprovalAction(payload, action.action_id, 'approve');
        } else if (action.action_id.startsWith('deny_task:')) {
          await handleApprovalAction(payload, action.action_id, 'deny');
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
 * Handle an Approve or Deny button click on a Cedar HITL approval gate.
 *
 * Action ID format: ``approve_task:<task_id>:<request_id>`` or
 * ``deny_task:<task_id>:<request_id>``.
 *
 * Flow:
 *   1. Parse task_id and request_id from the action_id.
 *   2. Verify the Slack user has a linked platform account.
 *   3. Load the task and verify ownership (platform user matches task.user_id).
 *   4. Apply the decision via a cross-table atomic TransactWriteItems:
 *        - Update approval row: PENDING → APPROVED/DENIED (guarded by ownership + status).
 *        - No-op update on TaskTable guarded by status = AWAITING_APPROVAL + request_id.
 *   5. Write an ``approval_decision_recorded`` audit event to TaskEventsTable.
 *   6. Reply to the response_url with the outcome (ephemeral message replaces the block).
 */
async function handleApprovalAction(
  payload: SlackInteractionPayload,
  actionId: string,
  decision: ApprovalDecision,
): Promise<void> {
  // Parse action_id: "approve_task:<task_id>:<request_id>"
  const prefix = decision === 'approve' ? 'approve_task:' : 'deny_task:';
  const rest = actionId.slice(prefix.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) {
    await postToResponseUrl(payload.response_url, ':warning: Malformed action — cannot process approval.');
    return;
  }
  const taskId = rest.slice(0, colonIdx);
  const requestId = rest.slice(colonIdx + 1);

  if (!taskId || !requestId) {
    await postToResponseUrl(payload.response_url, ':warning: Malformed action — missing task or request ID.');
    return;
  }

  const teamId = payload.user.team_id;
  const userId = payload.user.id;

  // Verify the Slack user has a linked platform account.
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${userId}` },
  }));

  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url, ':link: Your Slack account is not linked. Run `/bgagent link` first.');
    return;
  }

  const platformUserId = mappingResult.Item.platform_user_id as string;

  // Load the task and verify ownership.
  const taskResult = await ddb.send(new GetCommand({
    TableName: TASK_TABLE,
    Key: { task_id: taskId },
  }));

  if (!taskResult.Item) {
    await postToResponseUrl(payload.response_url, `:mag: Task \`${taskId}\` not found.`);
    return;
  }

  if (taskResult.Item.user_id !== platformUserId) {
    await postToResponseUrl(payload.response_url, ':no_entry: You can only approve or deny your own tasks.');
    return;
  }

  if (!TASK_APPROVALS_TABLE) {
    logger.warn('[slack/approval] TASK_APPROVALS_TABLE_NAME not set — cannot record decision', {
      task_id: taskId, request_id: requestId,
    });
    await postToResponseUrl(payload.response_url, ':warning: Approval tables are not configured. Use the CLI to respond.');
    return;
  }

  const nowIso = new Date().toISOString();
  const decisionLabel = decision === 'approve' ? 'APPROVED' : 'DENIED';

  // Cross-table atomic decision. Mirrors the approve-task / deny-task Lambda
  // handlers (cdk/src/handlers/approve-task.ts and deny-task.ts).
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: TASK_APPROVALS_TABLE,
            Key: { task_id: taskId, request_id: requestId },
            UpdateExpression: 'SET #status = :decided, decided_at = :now, #scope = :scope',
            ConditionExpression:
              'attribute_exists(request_id) AND #status = :pending AND user_id = :caller',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#scope': 'scope',
            },
            ExpressionAttributeValues: {
              ':decided': decisionLabel,
              ':pending': 'PENDING',
              ':now': nowIso,
              ':scope': 'this_call',
              ':caller': platformUserId,
            },
          },
        },
        {
          Update: {
            TableName: TASK_TABLE,
            Key: { task_id: taskId },
            // No-op update — the condition is the real guard.
            UpdateExpression: 'SET last_decision_at = :now',
            ConditionExpression:
              '#status = :awaiting AND awaiting_approval_request_id = :rid',
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
        await postToResponseUrl(
          payload.response_url,
          ':mag: Approval request not found, already decided, or not owned by you.',
        );
      } else if (taskCode === 'ConditionalCheckFailed') {
        await postToResponseUrl(
          payload.response_url,
          ':warning: Task is no longer awaiting approval for this request.',
        );
      } else {
        logger.warn('[slack/approval] TransactWriteCommand cancelled for unknown reason', {
          task_id: taskId,
          request_id: requestId,
          reasons: JSON.stringify(err.CancellationReasons ?? []),
        });
        await postToResponseUrl(payload.response_url, ':warning: Could not record decision. Please try again.');
      }
      return;
    }
    throw err;
  }

  // Write audit event (best-effort — decision already committed above).
  if (TASK_EVENTS_TABLE) {
    try {
      await ddb.send(new PutCommand({
        TableName: TASK_EVENTS_TABLE,
        Item: {
          task_id: taskId,
          event_id: ulid(),
          event_type: 'approval_decision_recorded',
          timestamp: nowIso,
          metadata: {
            request_id: requestId,
            status: decisionLabel,
            scope: 'this_call',
            decided_at: nowIso,
            caller_user_id: platformUserId,
            channel: 'slack',
          },
        },
      }));
    } catch (auditErr) {
      logger.warn('[slack/approval] audit event write failed (decision already committed)', {
        task_id: taskId,
        request_id: requestId,
        error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }

  const emoji = decision === 'approve' ? ':white_check_mark:' : ':no_entry_sign:';
  const verb = decision === 'approve' ? 'approved' : 'denied';
  logger.info('[slack/approval] decision recorded via Slack', {
    task_id: taskId,
    request_id: requestId,
    decision,
    team_id: teamId,
    user_id: userId,
  });
  await postToResponseUrl(
    payload.response_url,
    `${emoji} *${decisionLabel}* — approval request ${verb} for task \`${taskId}\`.`,
  );
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
