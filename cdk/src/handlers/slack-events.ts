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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { buildClarifyResumeDescription, isClarifyHold } from './shared/clarify-resume';
import { logger } from './shared/logger';
import { slackFetch } from './shared/slack-api';
import { getSlackSecret, SLACK_SECRET_PREFIX, verifySlackRequest } from './shared/slack-verify';
import type { TaskRecord } from './shared/types';
import type { MentionEvent, SlackFileRef } from './slack-command-processor';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sm = new SecretsManagerClient({});
const lambdaClient = new LambdaClient({});

const TABLE_NAME = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const PROCESSOR_FUNCTION_NAME = process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME;
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME;

/** Secret recovery window for revoked installations. */
const SECRET_RECOVERY_DAYS = 7;

interface SlackEventPayload {
  readonly type: string;
  readonly challenge?: string;
  readonly token?: string;
  readonly team_id?: string;
  readonly event?: {
    readonly type: string;
    readonly user?: string;
    readonly text?: string;
    readonly channel?: string;
    readonly ts?: string;
    readonly thread_ts?: string;
    readonly [key: string]: unknown;
  };
}

/**
 * POST /v1/slack/events — Handle Slack Events API requests.
 *
 * Handles:
 * - `url_verification` challenge (Slack sends this when the event URL is configured)
 * - `app_uninstalled` event (mark installation revoked, delete bot token)
 * - `tokens_revoked` event (same cleanup)
 */
/** Event types where retries are idempotent and must be re-processed. */
const RETRY_ALLOWED_EVENT_TYPES = new Set(['app_uninstalled', 'tokens_revoked']);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    // Verify Slack signing secret for every request — including url_verification.
    // Slack signs all requests; skipping verification exposes the endpoint.
    // The only reason to bypass is initial setup before the signing secret is populated.
    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);

    if (!signingSecret) {
      // Secret hasn't been populated yet — allow url_verification so the Slack App can be
      // wired up during initial setup, but reject anything else.
      logger.warn('Slack signing secret not populated — bypassing verification for url_verification only');
      const payload: SlackEventPayload = JSON.parse(event.body);
      if (payload.type === 'url_verification' && payload.challenge) {
        return jsonResponse(200, { challenge: payload.challenge });
      }
      return jsonResponse(500, { error: 'Internal configuration error' });
    }

    if (!await verifySlackRequest(SIGNING_SECRET_ARN, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack event signature');
      return jsonResponse(401, { error: 'Invalid signature' });
    }

    const payload: SlackEventPayload = JSON.parse(event.body);

    // URL verification challenge — Slack sends this when configuring the event URL.
    if (payload.type === 'url_verification' && payload.challenge) {
      return jsonResponse(200, { challenge: payload.challenge });
    }

    // Slack retries events if we don't respond within 3 seconds. Ack retries
    // immediately for user-facing events (mentions, DMs) to prevent duplicate task
    // creation — the idempotency cost of processing the same app_mention twice is
    // a double-submit. For security-critical revocation events, we MUST process
    // retries so a transient failure on first delivery doesn't leave the workspace
    // with a live bot token after uninstall.
    const retryNum = event.headers['X-Slack-Retry-Num'] ?? event.headers['x-slack-retry-num'];
    const eventType = payload.type === 'event_callback' ? payload.event?.type : undefined;
    if (retryNum && !(eventType && RETRY_ALLOWED_EVENT_TYPES.has(eventType))) {
      logger.info('Acknowledging Slack retry without reprocessing', { retry_num: retryNum, event_type: eventType });
      return jsonResponse(200, { ok: true });
    }

    // Dispatch by event type.
    if (payload.type === 'event_callback' && payload.event) {
      const teamId = payload.team_id;

      if ((eventType === 'app_uninstalled' || eventType === 'tokens_revoked') && teamId) {
        await revokeInstallation(teamId);
      } else if (eventType === 'app_mention' && teamId) {
        await handleAppMention(payload.event, teamId);
      } else if (eventType === 'message' && teamId && payload.event.channel_type === 'im') {
        // DMs to the bot — skip bot's own messages to avoid loops.
        if (!payload.event.bot_id) {
          await handleAppMention(payload.event, teamId);
        }
      } else if (eventType === 'message' && teamId && !payload.event.bot_id) {
        // Thread replies in public/private channels. When the reply is in a
        // thread that belongs to a known ABCA task, route based on task state:
        //   - Task has a PR → coding/pr-iteration-v1
        //   - Task is a clarify-hold → coding/new-task-v1 with the resume description
        //   - Otherwise → no-op (task is complete/cancelled or unrecognised thread)
        const threadTs = payload.event.thread_ts;
        const messageTs = payload.event.ts;
        if (threadTs && threadTs !== messageTs) {
          // This is a reply in a thread — not a root message.
          await handleThreadReply(payload.event, teamId);
        }
      } else {
        logger.info('Unhandled Slack event type', { event_type: eventType, team_id: teamId });
      }
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    logger.error('Slack event handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal server error' });
  }
}

async function handleAppMention(
  event: NonNullable<SlackEventPayload['event']>,
  teamId: string,
): Promise<void> {
  if (!PROCESSOR_FUNCTION_NAME) {
    logger.warn('SLACK_COMMAND_PROCESSOR_FUNCTION_NAME not set, ignoring app_mention');
    return;
  }

  const userId = event.user;
  const channelId = event.channel;
  const rawText = event.text ?? '';
  const messageTs = event.ts;
  const threadTs = event.thread_ts;

  if (!userId || !channelId) {
    logger.warn('app_mention missing user or channel', { event });
    return;
  }

  // Strip the @mention prefix (e.g. "<@U12345> fix the bug" → "fix the bug").
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) {
    logger.info('app_mention with empty text after stripping mention, ignoring');
    return;
  }

  // Build a payload compatible with the command processor.
  // Use source: 'mention' so the processor knows there's no response_url —
  // it should use chat.postMessage with the bot token instead.
  //
  // Keyword-prefix messages (``decompose: …``, ``review pr #N …``, etc.) are
  // forwarded as-is prefixed with ``submit`` so the command processor's
  // ``parseWorkflowPrefix`` can extract the workflow hint. The repo-extraction
  // reorder would corrupt these messages, so we detect them first.
  //
  // For natural language mentions like "@Shoof fix the bug in org/repo#42",
  // extract the repo pattern and reorder so submit gets "org/repo#42 fix the bug".
  // The submit handler expects: submit <repo> <description...>
  //
  // When no repo is present we still forward the mention (rather than erroring
  // here): the processor falls back to the channel's onboarded default repo
  // (`bgagent slack onboard-channel`), and only replies with guidance if no
  // default exists. Keeping that decision in one place (the processor) avoids
  // duplicating the channel-mapping lookup in the events handler.
  const WORKFLOW_PREFIX_RE = /^(decompose|review|iterate)\s*:/i;
  const WORKFLOW_PR_RE = /^(review|iterate)\s+pr\s+#?\d+/i;
  let commandText: string;
  if (WORKFLOW_PREFIX_RE.test(text) || WORKFLOW_PR_RE.test(text)) {
    // Keyword-prefix path: forward the text verbatim — the processor's
    // ``parseWorkflowPrefix`` will strip the keyword and extract the description.
    commandText = `submit ${text}`;
  } else {
    const repoPattern = /\b([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:#\d+)?)\b/;
    const repoMatch = text.match(repoPattern);
    if (repoMatch) {
      const repo = repoMatch[0];
      const description = text.replace(repo, '').replace(/\s+/g, ' ').trim();
      commandText = `submit ${repo} ${description}`.trim();
    } else {
      // No repo token — forward the whole text; the processor treats it as the
      // task description against the channel default repo (or replies with help).
      commandText = `submit ${text}`;
    }
  }

  // Extract file references from the Slack event (if any attached)
  const rawFiles = Array.isArray(event.files) ? event.files as Array<Record<string, unknown>> : [];
  const files: SlackFileRef[] = rawFiles
    .filter(f => typeof f.url_private_download === 'string' && typeof f.name === 'string')
    .map(f => ({
      id: String(f.id ?? ''),
      name: String(f.name),
      mimetype: String(f.mimetype ?? 'application/octet-stream'),
      size: typeof f.size === 'number' ? f.size : 0,
      url_private_download: String(f.url_private_download),
    }));

  const mentionPayload: MentionEvent = {
    text: commandText,
    user_id: userId,
    team_id: teamId,
    channel_id: channelId,
    source: 'mention',
    mention_thread_ts: threadTs ?? messageTs,
    ...(files.length > 0 && { files }),
  };

  // React with :eyes: immediately so the user knows the bot saw their message.
  const mentionTs = threadTs ?? messageTs;
  if (mentionTs) {
    const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
    if (botToken) {
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: mentionTs, name: 'eyes' });
    }
  }

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: PROCESSOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(mentionPayload)),
    }));
    logger.info('app_mention forwarded to command processor', {
      team_id: teamId,
      user_id: userId,
      channel_id: channelId,
      text_length: text.length,
    });
  } catch (err) {
    logger.error('Failed to invoke command processor for app_mention', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Mirror the no-repo-found failure UX: swap :eyes: to :x: and reply in thread
    // so the user isn't left staring at a stuck :eyes: reaction forever.
    const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
    if (botToken && mentionTs) {
      await slackFetch(botToken, 'reactions.remove', { channel: channelId, timestamp: mentionTs, name: 'eyes' });
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: mentionTs, name: 'x' });
      await slackFetch(botToken, 'chat.postMessage', {
        channel: channelId,
        thread_ts: mentionTs,
        text: ':x: Something went wrong forwarding your request. Please try again.',
      });
    }
  }
}

/**
 * Look up the most-recent active/terminal Slack task whose ``slack_thread_ts``
 * matches ``threadTs`` in the given team + channel. Returns ``null`` when no
 * matching task exists or when the task table is not configured.
 *
 * Performs a DynamoDB Scan with a filter expression. This is intentionally a
 * Scan rather than a query: ``slack_thread_ts`` lives inside the ``channel_metadata``
 * map attribute, which cannot be a GSI key. Thread replies are infrequent
 * (one per user interaction after a task completes/holds) so the Scan cost is
 * acceptable. The filter is tight (channel_source = 'slack' AND the nested
 * thread-ts attribute) to minimise the scanned-row count.
 */
async function lookupTaskByThreadTs(
  teamId: string,
  channelId: string,
  threadTs: string,
): Promise<TaskRecord | null> {
  if (!TASK_TABLE_NAME) return null;
  try {
    const result = await ddb.send(new ScanCommand({
      TableName: TASK_TABLE_NAME,
      FilterExpression:
        'channel_source = :slack'
        + ' AND channel_metadata.slack_team_id = :teamId'
        + ' AND channel_metadata.slack_channel_id = :channelId'
        + ' AND channel_metadata.slack_thread_ts = :threadTs',
      ExpressionAttributeValues: {
        ':slack': 'slack',
        ':teamId': teamId,
        ':channelId': channelId,
        ':threadTs': threadTs,
      },
      // We only need the first match; cap the scan to keep it cheap.
      Limit: 10,
    }));
    if (!result.Items || result.Items.length === 0) return null;
    // Return the most-recently created task (largest created_at ISO string).
    const sorted = [...result.Items].sort((a, b) =>
      String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
    );
    return sorted[0] as TaskRecord;
  } catch (err) {
    logger.warn('Thread-reply task lookup failed', {
      error: err instanceof Error ? err.message : String(err),
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });
    return null; // nosemgrep: ts-silent-success-masking -- fail-open: an unknown thread is not a task-trigger
  }
}

/**
 * Handle a thread reply in a public/private channel.
 *
 * Three routing outcomes:
 *   1. The thread belongs to an ABCA task with a PR (``pr_number`` set) →
 *      forward to the command processor as a ``coding/pr-iteration-v1`` task.
 *   2. The task is a clarify-hold (``coding/new-task-v1`` that paused to ask a
 *      question, no PR) → forward as a ``coding/new-task-v1`` clarify-resume
 *      with the assembled description.
 *   3. Thread is not a known ABCA task thread (or task is terminal/cancelled) →
 *      no-op. We don't reply in random threads just because someone used a
 *      thread.
 *
 * The user must have their account linked — the command processor enforces this
 * check, so we don't duplicate it here.
 */
async function handleThreadReply(
  event: NonNullable<SlackEventPayload['event']>,
  teamId: string,
): Promise<void> {
  if (!PROCESSOR_FUNCTION_NAME) return;

  const userId = event.user;
  const channelId = event.channel;
  const threadTs = event.thread_ts;
  const messageTs = event.ts;
  const rawText = (event.text ?? '') as string;

  if (!userId || !channelId || !threadTs) return;

  // Strip any @mention in the reply (e.g. "@Shoof follow up on this") —
  // the user may @mention the bot but doesn't have to; both should work.
  const replyText = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!replyText) {
    logger.info('Thread reply with empty text after mention strip, ignoring');
    return;
  }

  // Look up whether this thread belongs to an ABCA task.
  const task = await lookupTaskByThreadTs(teamId, channelId, threadTs);
  if (!task) {
    // Not an ABCA task thread — ignore silently.
    logger.info('Thread reply in non-ABCA thread, ignoring', {
      team_id: teamId,
      channel_id: channelId,
      thread_ts: threadTs,
    });
    return;
  }

  // Terminal tasks (COMPLETED, FAILED, CANCELLED, TIMED_OUT) that have a PR
  // can still accept iteration requests — that's the "review comments after
  // merge" use case. Active tasks (RUNNING, HYDRATING) should NOT spawn a
  // concurrent iteration — ignore those.
  const activeStatuses = new Set(['SUBMITTED', 'HYDRATING', 'RUNNING', 'AWAITING_APPROVAL', 'FINALIZING']);
  if (activeStatuses.has(task.status)) {
    logger.info('Thread reply on an active task, ignoring to avoid concurrent execution', {
      task_id: task.task_id,
      status: task.status,
    });
    return;
  }

  let workflowRef: string | undefined;
  let prNumber: number | undefined;
  let preBuiltDescription: string | undefined;

  const taskPrNumber = task.pr_number;
  const taskPrUrl = task.pr_url;

  // Routing decision. Use a boolean variable for the clarify-hold check rather
  // than `isClarifyHold` as an `if` condition directly — TypeScript's type-guard
  // narrowing on `row is ClarifyHoldRow` evaluates `Exclude<TaskRecord, ClarifyHoldRow>`
  // as `never` in the else branch (all ClarifyHoldRow fields are optional subsets of
  // TaskRecord, so TS concludes TaskRecord ⊆ ClarifyHoldRow). Capturing the boolean
  // result first avoids the narrowing and keeps `task` usable throughout.
  const isClarifyHoldTask: boolean = isClarifyHold(task);
  if (taskPrNumber !== undefined) {
    // Task has a PR — trigger a PR-iteration.
    workflowRef = 'coding/pr-iteration-v1';
    prNumber = taskPrNumber;
    logger.info('Thread reply routes to pr-iteration-v1', {
      task_id: task.task_id,
      pr_number: prNumber,
      team_id: teamId,
      channel_id: channelId,
    });
  } else if (isClarifyHoldTask) {
    // Task is a clarify-hold — resume with the user's answer.
    workflowRef = 'coding/new-task-v1';
    preBuiltDescription = buildClarifyResumeDescription(
      task.task_description,
      task.answer_text,
      replyText,
    );
    logger.info('Thread reply routes to clarify-resume (new-task-v1)', {
      task_id: task.task_id,
      team_id: teamId,
      channel_id: channelId,
    });
  } else {
    // Thread belongs to a task that is neither in-flight PR nor a clarify-hold
    // (e.g. a plain completed/failed task with no PR). For now, ignore; a future
    // enhancement could open a new task with context.
    logger.info('Thread reply on task with no PR and no clarify-hold, ignoring', {
      task_id: task.task_id,
      status: task.status,
      has_pr: taskPrUrl !== undefined,
    });
    return;
  }

  // Build the processor payload.
  const repoArg = task.repo;
  if (!repoArg) {
    logger.warn('Thread reply: task has no repo — cannot route workflow', { task_id: task.task_id });
    return;
  }

  // Reuse the repo pattern from handleAppMention to normalise the commandText.
  // For PR workflows we don't need to embed the repo in the text; the processor
  // reads repo from the task's repo field via the payload.
  const commandText = `submit ${repoArg}${prNumber !== undefined ? ` ${replyText}` : ''}`;

  // React with :eyes: on the reply message to show the bot saw it.
  if (messageTs) {
    const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
    if (botToken) {
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: messageTs, name: 'eyes' });
    }
  }

  const mentionPayload: MentionEvent = {
    text: commandText,
    user_id: userId,
    team_id: teamId,
    channel_id: channelId,
    source: 'mention',
    mention_thread_ts: threadTs,
    workflow_ref: workflowRef,
    ...(prNumber !== undefined && { pr_number: prNumber }),
    ...(preBuiltDescription !== undefined && { pre_built_description: preBuiltDescription }),
  };

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: PROCESSOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(mentionPayload)),
    }));
    logger.info('Thread reply forwarded to command processor', {
      team_id: teamId,
      user_id: userId,
      channel_id: channelId,
      workflow_ref: workflowRef,
    });
  } catch (err) {
    logger.error('Failed to invoke command processor for thread reply', {
      error: err instanceof Error ? err.message : String(err),
    });
    // On failure swap :eyes: to :x: so the user knows something went wrong.
    const botToken = await getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
    if (botToken && messageTs) {
      await slackFetch(botToken, 'reactions.remove', { channel: channelId, timestamp: messageTs, name: 'eyes' });
      await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: messageTs, name: 'x' });
      await slackFetch(botToken, 'chat.postMessage', {
        channel: channelId,
        thread_ts: threadTs,
        text: ':x: Something went wrong processing your reply. Please try again.',
      });
    }
  }
}

async function revokeInstallation(teamId: string): Promise<void> {
  const now = new Date().toISOString();

  // Mark the installation record as revoked FIRST. If this fails we must not
  // delete the bot token, or the DB will still show status=active while the
  // token is gone — every subsequent Slack call would then fail with "secret
  // not found." Let Slack retry the revocation event in that case.
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { team_id: teamId },
      UpdateExpression: 'SET #s = :revoked, updated_at = :now, revoked_at = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':now': now },
    }));
  } catch (err) {
    logger.error('Failed to mark Slack installation revoked — bot token left in place for retry', {
      team_id: teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // Schedule the bot token secret for deletion. Failure here is recoverable
  // on retry (the DDB row is already revoked, so the next delivery just re-tries
  // this step).
  try {
    await sm.send(new DeleteSecretCommand({
      SecretId: `${SLACK_SECRET_PREFIX}${teamId}`,
      RecoveryWindowInDays: SECRET_RECOVERY_DAYS,
    }));
    logger.info('Slack installation revoked', { team_id: teamId });
  } catch (err) {
    logger.warn('Failed to delete Slack bot token secret', {
      team_id: teamId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function jsonResponse(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
