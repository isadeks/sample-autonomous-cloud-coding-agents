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

import * as crypto from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import type { PendingTaskContext } from './shared/slack-blocks';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const TASK_TABLE = process.env.TASK_TABLE_NAME!;
const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;

interface SlackInteractionAction {
  readonly action_id: string;
  readonly block_id: string;
  readonly value?: string;
  /** Selected option value (for static_select elements). */
  readonly selected_option?: { readonly value: string };
}

interface SlackInteractionPayload {
  readonly type: string;
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  readonly actions?: ReadonlyArray<SlackInteractionAction>;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly channel?: { readonly id: string };
  readonly container?: { readonly message_ts: string; readonly channel_id: string };
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
        } else if (action.action_id.startsWith('pick_repo:')) {
          await handlePickRepoAction(payload, action);
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

// ─── Repo-picker callback ─────────────────────────────────────────────────────

/**
 * Handle the `pick_repo:<repo>` interactive button from the repo picker message.
 *
 * The button `value` field carries the serialised {@link PendingTaskContext}
 * (description, thread_ts, user_id, team_id, channel_id) so we can reconstruct
 * the task submission without a DynamoDB round-trip.
 */
async function handlePickRepoAction(
  payload: SlackInteractionPayload,
  action: SlackInteractionAction,
): Promise<void> {
  const repo = action.action_id.replace('pick_repo:', '');
  const teamId = payload.user.team_id;
  const userId = payload.user.id;

  // Validate repo name to prevent injection via a crafted action_id.
  // Use the same REPO_PATTERN as validation.ts: rejects dot-only path segments
  // (e.g. `../injection` or `owner/..`) to prevent URL/key path traversal.
  const REPO_PATTERN = /^(?!\.+\/)[a-zA-Z0-9._-]+\/(?!\.+$)[a-zA-Z0-9._-]+$/;
  if (!REPO_PATTERN.test(repo)) {
    await postToResponseUrl(payload.response_url, ':warning: Invalid repo name in picker action.');
    return;
  }

  // Deserialise the pending task context from the button value.
  let ctx: PendingTaskContext;
  try {
    ctx = JSON.parse(action.value ?? '{}') as PendingTaskContext;
  } catch {
    await postToResponseUrl(payload.response_url, ':warning: Could not parse task context. Please try again.');
    return;
  }

  // Verify the picker was triggered by the same user who sent the @mention.
  // Prevents other users from hijacking pending submissions.
  if (ctx.user_id && ctx.user_id !== userId) {
    await postToResponseUrl(payload.response_url, ':no_entry: Only the person who sent the original message can pick a repo.');
    return;
  }

  // Look up the platform user.
  const mappingResult = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: `${teamId}#${userId}` },
  }));

  if (!mappingResult.Item || mappingResult.Item.status === 'pending') {
    await postToResponseUrl(payload.response_url, ':link: Your Slack account is not linked. Run `/bgagent link` first.');
    return;
  }

  const platformUserId = mappingResult.Item.platform_user_id as string;

  const channelId = ctx.channel_id || payload.channel?.id || payload.container?.channel_id || '';
  const channelMetadata: Record<string, string> = {
    slack_team_id: teamId,
    slack_channel_id: channelId,
    slack_user_id: userId,
  };
  if (ctx.thread_ts) {
    channelMetadata.slack_thread_ts = ctx.thread_ts;
  }

  // Acknowledge immediately with an ephemeral message so the picker is dismissed.
  await postToResponseUrl(payload.response_url, `:hourglass_flowing_sand: Submitting task against \`${repo}\`...`);

  // Create the task.
  const result = await createTaskCore(
    {
      repo,
      task_description: ctx.description || undefined,
    },
    {
      userId: platformUserId,
      channelSource: 'slack',
      channelMetadata,
    },
    crypto.randomUUID(),
  );

  const body = JSON.parse(result.body);
  if (result.statusCode !== 201 || !body.data) {
    const errMsg = body.error?.message ?? 'Unknown error';
    await postToResponseUrl(payload.response_url, `:x: Failed to create task: ${errMsg}`);
  }
  // On success the notify handler posts the task_created message in-thread.
}

// ─── Cancel-task callback ─────────────────────────────────────────────────────

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
