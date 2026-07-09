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
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { buildClarifyResumeDescription, isClarifyHold } from './shared/clarify-resume';
import { createTaskCore } from './shared/create-task-core';
import { logger } from './shared/logger';
import { slackFetch } from './shared/slack-api';
import { repoPickerMessage } from './shared/slack-blocks';
import {
  addChannelRepo,
  getChannelRepos,
  putPendingRepoPick,
  type PendingRepoPickFile,
} from './shared/slack-channel-config';
import { prNumberFromSlackTask, type SlackThreadTask } from './shared/slack-task-by-thread';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';
import type { Attachment } from './shared/types';
import type { SlackCommandPayload } from './slack-commands';

/**
 * Payload fields every inbound event carries, whether it came from a slash
 * command or an @mention.
 */
interface BasePayload {
  readonly text: string;
  readonly user_id: string;
  readonly team_id: string;
  readonly channel_id: string;
}

/** Slash-command invocation — has a usable response_url, no mention context. */
export interface SlashCommandEvent extends BasePayload, SlackCommandPayload {
  readonly source: 'slash';
}

/** Metadata for a file attached to a Slack message. */
export interface SlackFileRef {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url_private_download: string;
}

/** @mention invocation — no response_url; reply via chat.postMessage in-thread. */
export interface MentionEvent extends BasePayload {
  readonly source: 'mention';
  readonly mention_thread_ts?: string;
  readonly files?: readonly SlackFileRef[];
  /**
   * Workflow ref pre-parsed by the events handler from a keyword prefix
   * (e.g. "decompose: …" → "coding/decompose-v1"). When set, the submit
   * handler passes it through to createTaskCore instead of relying on the
   * platform's default resolution ladder.
   */
  readonly workflow_ref?: string;
}

/**
 * A thread-reply in an existing ABCA task thread — triggers PR-iteration or
 * clarify-resume, depending on the originating task's state. Routed here by
 * the events handler (``slack-events.ts``) when it detects a non-bot,
 * non-mention message in a thread whose ``thread_ts`` belongs to a task.
 */
export interface ThreadReplyEvent extends BasePayload {
  readonly source: 'thread_reply';
  /** The ``thread_ts`` of the Slack thread (= the root message ts). */
  readonly thread_ts: string;
  /** The reply text (bot-mention stripped, trimmed). */
  readonly reply_text: string;
  /** The task found in the SlackThreadIndex for this thread. */
  readonly thread_task: SlackThreadTask;
  readonly files?: readonly SlackFileRef[];
}

/** Discriminated union of the inbound events the processor accepts. */
export type CommandProcessorEvent = SlashCommandEvent | MentionEvent | ThreadReplyEvent;

/**
 * Legacy shape — the slash-command acknowledger (`slack-commands.ts`) forwards
 * payloads without a `source` field. Normalize those into SlashCommandEvent so
 * the handler body only has to reason about the discriminated union.
 */
type RawEvent = CommandProcessorEvent | SlackCommandPayload;

function normalizeEvent(event: RawEvent): CommandProcessorEvent {
  if ('source' in event && event.source) {
    return event;
  }
  return { ...event, source: 'slash' };
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const USER_MAPPING_TABLE = process.env.SLACK_USER_MAPPING_TABLE_NAME!;
const INSTALLATION_TABLE = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const CHANNEL_MAPPING_TABLE = process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME;

/** Link code TTL. */
const LINK_CODE_TTL_S = 10 * 60; // 10 minutes

/** Random bytes for slash-command account-link codes (→ 6 hex chars). */
const LINK_CODE_ENTROPY_BYTES = 3;

/** Prefix length when logging Slack response_url values (avoid leaking tokens). */
const RESPONSE_URL_LOG_PREFIX_LEN = 80;

/**
 * Async processor for Slack slash commands and @mention triggers.
 *
 * Invoked asynchronously by the slash command acknowledger or the events handler.
 * Posts results back to Slack via `response_url` (slash commands) or
 * `chat.postMessage` (@mentions).
 */
export async function handler(raw: RawEvent): Promise<void> {
  const event = normalizeEvent(raw);

  // Thread-reply path — entirely separate from subcommand routing.
  if (event.source === 'thread_reply') {
    await handleThreadReply(event);
    return;
  }

  const text = (event.text ?? '').trim();
  const parts = text.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? '';

  // Build a reply function that handles both response_url and mention modes.
  const reply = event.source === 'mention'
    ? buildMentionReply(event)
    : (msg: string) => postToSlack(event.response_url, msg);

  try {
    switch (subcommand) {
      case 'submit':
        // Submit is only used via @mentions — slash commands show usage guidance.
        if (event.source === 'mention') {
          await handleSubmit(event, parts.slice(1), reply);
        } else {
          await reply('Use `@Shoof` to submit tasks — e.g. `@Shoof fix the bug in org/repo#42`\nFor private submissions, DM Shoof directly.');
        }
        break;
      case 'link':
        await handleLink(event, reply);
        break;
      case 'set-repo':
      case 'setup':
        await handleSetRepo(event, parts.slice(1), reply);
        break;
      case 'repos':
      case 'list-repos':
        await handleListRepos(event, reply);
        break;
      case 'help':
        await reply(
          '*Using Shoof*\n\n'
          + '*Submit a task:* Mention `@Shoof` in any channel:\n'
          + '> `@Shoof fix the login bug in org/repo#42`\n'
          + '> `@Shoof update the README in org/repo`\n\n'
          + '*Workflow keywords:* Prefix your message to select a workflow:\n'
          + '> `@Shoof decompose: fix the auth bug in org/repo` — plan and decompose\n'
          + '> `@Shoof review: check the PR in org/repo#42` — PR review only\n\n'
          + '*Thread replies:* Reply in an existing task\'s thread to continue work:\n'
          + '> Reply to trigger PR-iteration on the task\'s open PR.\n'
          + '> Reply to resume a task that asked a clarifying question.\n\n'
          + '*Set a default repo for this channel:* `/bgagent set-repo org/repo`\n'
          + 'Once set, you can drop the repo name — `@Shoof fix the login bug` runs against the channel default. Add several repos and Shoof will ask which one to use.\n\n'
          + '*See configured repos:* `/bgagent repos`\n\n'
          + '*Private submissions:* DM Shoof directly.\n\n'
          + '*Cancel a task:* Use the Cancel button in the thread.\n\n'
          + '*Link your account:* `/bgagent link` — one-time setup.\n\n'
          + 'Reactions on your message show progress: :eyes: → :hourglass_flowing_sand: → :white_check_mark:',
        );
        break;
      default:
        await reply('Use `@Shoof` to submit tasks, `/bgagent set-repo org/repo` to set a channel default, or `/bgagent link` to link your account.\nTry `/bgagent help` for more info.');
    }
  } catch (err) {
    logger.error('Slack command processing failed', {
      subcommand,
      error: err instanceof Error ? err.message : String(err),
      team_id: event.team_id,
      user_id: event.user_id,
    });
    await reply(':warning: Something went wrong. Please try again.');
  }
}

type ReplyFn = (text: string) => Promise<void>;

/** Build a reply function that posts in-thread via chat.postMessage for @mentions. */
function buildMentionReply(event: MentionEvent): ReplyFn {
  return async (text: string) => {
    const botToken = await getBotToken(event.team_id);
    if (!botToken) {
      logger.warn('Cannot reply to mention: bot token not found', { team_id: event.team_id });
      return;
    }
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: event.channel_id,
        text,
        thread_ts: event.mention_thread_ts,
      }),
    });
    const result = await response.json() as { ok: boolean; error?: string };
    if (!result.ok) {
      logger.warn('Failed to post mention reply', { error: result.error, channel: event.channel_id });
    }
  };
}

// ─── Submit ───────────────────────────────────────────────────────────────────

async function handleSubmit(event: MentionEvent, args: string[], reply: ReplyFn): Promise<void> {
  if (args.length === 0) {
    await reply('Usage: `/bgagent submit org/repo#42 description`');
    return;
  }

  // Resolve platform user.
  const platformUserId = await lookupPlatformUser(event.team_id, event.user_id);
  if (!platformUserId) {
    await reply(':link: Your Slack account is not linked. Run `/bgagent link` first.');
    if (event.mention_thread_ts) {
      await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
    }
    return;
  }

  // Resolve the target repo. Three ways, in priority order:
  //   1. The user typed it: "org/repo#42 <description>" — first arg is the repo,
  //      the rest is the description. This explicit override always wins so
  //      one-off cross-repo tasks still work in a channel with defaults.
  //   2. The user omitted it and the channel has exactly ONE configured default
  //      repo (`/bgagent set-repo` or the legacy `bgagent slack onboard-channel`)
  //      — resolve it automatically; the WHOLE message is the description.
  //   3. The channel has SEVERAL configured repos — post an interactive picker
  //      and defer submission until the user chooses one.
  const repoArg = args[0];
  const { repo, issueNumber } = parseRepoArg(repoArg);
  let description: string | undefined;
  if (repo) {
    description = args.slice(1).join(' ') || undefined;
  } else {
    const channelRepos = await getChannelRepos(CHANNEL_MAPPING_TABLE, event.team_id, event.channel_id);
    if (channelRepos.length === 0) {
      // No default set — guide the user rather than silently failing.
      await reply('This channel has no default repo set. Include one — e.g. `@Shoof fix the bug in org/repo#42` — or run `/bgagent set-repo org/repo` to set a channel default.');
      if (event.mention_thread_ts) {
        await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
      }
      return;
    }
    if (channelRepos.length === 1) {
      // Exactly one default — resolve automatically. The whole message is the description.
      await submitTaskForRepo(event, platformUserId, channelRepos[0], undefined, args.join(' ') || undefined, reply);
      return;
    }
    // Multiple defaults — present a Block Kit picker and defer submission.
    await presentRepoPicker(event, channelRepos, args.join(' ') || undefined, reply);
    return;
  }

  await submitTaskForRepo(event, platformUserId, repo, issueNumber, description, reply);
}

/**
 * Post the interactive repo-picker for a channel that has several configured
 * default repos. Stashes the pending submission context keyed by a random
 * token so the interaction callback (`pick_repo:{token}`) can complete the
 * submission against whichever repo the user chooses.
 */
async function presentRepoPicker(
  event: MentionEvent,
  repos: string[],
  description: string | undefined,
  reply: ReplyFn,
): Promise<void> {
  if (!CHANNEL_MAPPING_TABLE) {
    // Should not happen (we only get here after a successful lookup), but stay safe.
    await reply('This channel has no default repo set. Include one — e.g. `@Shoof fix the bug in org/repo#42`.');
    return;
  }

  const token = crypto.randomUUID();
  const files: PendingRepoPickFile[] | undefined = event.files?.map((f) => ({
    id: f.id,
    name: f.name,
    mimetype: f.mimetype,
    size: f.size,
    url_private_download: f.url_private_download,
  }));

  try {
    await putPendingRepoPick(CHANNEL_MAPPING_TABLE, token, {
      description: description ?? '',
      team_id: event.team_id,
      channel_id: event.channel_id,
      user_id: event.user_id,
      thread_ts: event.mention_thread_ts,
      files,
    });
  } catch (err) {
    logger.error('Failed to store pending repo pick', {
      error: err instanceof Error ? err.message : String(err),
    });
    await reply(':warning: Could not build the repo picker. Please include the repo explicitly — e.g. `@Shoof fix the bug in org/repo`.');
    return;
  }

  const botToken = await getBotToken(event.team_id);
  if (!botToken) {
    await reply(':warning: The Slack integration is not fully configured (missing bot token). Ask your workspace admin to reinstall the app.');
    return;
  }

  const message = repoPickerMessage(token, repos, event.mention_thread_ts);
  const ok = await slackFetch(botToken, 'chat.postMessage', {
    channel: event.channel_id,
    text: message.text,
    blocks: message.blocks,
    ...(message.thread_ts && { thread_ts: message.thread_ts }),
  });
  if (!ok) {
    await reply(':warning: Could not post the repo picker. Please include the repo explicitly — e.g. `@Shoof fix the bug in org/repo`.');
  }
}

/**
 * Complete a task submission against a resolved repo. Shared by the
 * explicit-repo path, the single-default auto-resolve path, and (via the
 * interactions handler) the repo-picker path.
 */
async function submitTaskForRepo(
  event: MentionEvent,
  platformUserId: string,
  repo: string,
  issueNumber: number | undefined,
  description: string | undefined,
  reply: ReplyFn,
): Promise<void> {
  // Check if the bot can post to this channel (private channels need an invite).
  const channelCheck = await checkChannelAccess(event.team_id, event.channel_id);
  if (!channelCheck.ok) {
    await reply(channelCheck.error!);
    return;
  }

  // handleSubmit is only invoked for the mention path, so there's no response_url.
  // Notifications thread under the user's @mention message using mention_thread_ts.
  const channelMetadata: Record<string, string> = {
    slack_team_id: event.team_id,
    slack_channel_id: event.channel_id,
    slack_user_id: event.user_id,
  };
  if (event.mention_thread_ts) {
    channelMetadata.slack_thread_ts = event.mention_thread_ts;
  }

  // Extract file attachments from the Slack event (if present).
  // Files are downloaded from Slack CDN and passed as inline base64 attachments.
  const attachments = await extractSlackFileAttachments(event, reply);
  if (attachments === null) {
    // extractSlackFileAttachments already replied with the error
    if (event.mention_thread_ts) {
      await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
    }
    return;
  }

  // Create the task through the shared core.
  const result = await createTaskCore(
    {
      repo,
      issue_number: issueNumber,
      task_description: description,
      ...(attachments.length > 0 && { attachments }),
      // Pass through the workflow_ref if the mention included a keyword prefix
      // (e.g. "decompose: …" → workflow_ref='coding/decompose-v1').
      ...(event.workflow_ref && { workflow_ref: event.workflow_ref }),
    },
    {
      userId: platformUserId,
      channelSource: 'slack',
      channelMetadata,
    },
    crypto.randomUUID(),
  );

  // Extract task info from the response.
  const body = JSON.parse(result.body);
  if (result.statusCode === 201 && body.data) {
    // The notify handler posts the task_created message in-thread — don't
    // duplicate it here on the mention path.
    return;
  }

  const errMsg = body.error?.message ?? 'Unknown error';
  await reply(`:x: Failed to create task: ${errMsg}`);
  // Swap reaction to :x: on the mention message.
  if (event.mention_thread_ts) {
    await swapReaction(event.team_id, event.channel_id, event.mention_thread_ts, 'eyes', 'x');
  }
}

function parseRepoArg(arg: string): { repo: string | null; issueNumber?: number } {
  // Match "org/repo#42" or "org/repo"
  const match = arg.match(/^([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)(?:#(\d+))?$/);
  if (!match) return { repo: null };
  return {
    repo: match[1],
    issueNumber: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

// ─── Thread Reply ─────────────────────────────────────────────────────────────

/**
 * Handle a reply in an existing ABCA task thread.
 *
 * Three sub-cases, checked in order:
 *
 *   1. **Clarify-resume** — the originating task is a ``coding/new-task-v1``
 *      that paused to ask a clarifying question (``code_changed===false``,
 *      non-empty ``answer_text``, no PR). The user's reply is the answer;
 *      dispatch a fresh ``new-task-v1`` with the resume description.
 *
 *   2. **PR-iteration** — the originating task has an open PR (``pr_number``
 *      or parseable ``pr_url``). The user's reply is the iteration instruction;
 *      dispatch a ``coding/pr-iteration-v1`` on that PR.
 *
 *   3. **Neither** — the task thread exists but the task has no actionable
 *      state (e.g. it's still running, or it failed without a PR). Ignore
 *      silently — reacting to every reply in a task thread would be noisy.
 */
async function handleThreadReply(event: ThreadReplyEvent): Promise<void> {
  const { thread_task: task, reply_text, thread_ts } = event;

  // Build a reply fn that posts in-thread under the root message.
  const reply = async (text: string): Promise<void> => {
    const botToken = await getBotToken(event.team_id);
    if (!botToken) return;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${botToken}`,
      },
      body: JSON.stringify({
        channel: event.channel_id,
        text,
        thread_ts,
      }),
    });
  };

  // Resolve the platform user.
  const platformUserId = await lookupPlatformUser(event.team_id, event.user_id);
  if (!platformUserId) {
    await reply(':link: Your Slack account is not linked. Run `/bgagent link` first.');
    return;
  }

  const channelMetadata: Record<string, string> = {
    slack_team_id: event.team_id,
    slack_channel_id: event.channel_id,
    slack_user_id: event.user_id,
    slack_thread_ts: thread_ts,
  };

  // 1. Clarify-resume — re-run new-task-v1 with the user's answer baked into
  //    the description. Mirror the exact same predicate used by the Linear path.
  const clarifyHoldRow = {
    resolved_workflow: task.resolved_workflow_id
      ? { id: task.resolved_workflow_id }
      : undefined,
    workflow_ref: task.workflow_ref,
    code_changed: task.code_changed,
    answer_text: task.answer_text,
    task_description: task.task_description,
    pr_url: task.pr_url,
    pr_number: task.pr_number,
  };
  if (isClarifyHold(clarifyHoldRow)) {
    const resumeDescription = buildClarifyResumeDescription(
      task.task_description,
      task.answer_text,
      reply_text,
    );
    const result = await createTaskCore(
      {
        repo: task.repo,
        task_description: resumeDescription,
        workflow_ref: 'coding/new-task-v1',
      },
      {
        userId: platformUserId,
        channelSource: 'slack',
        channelMetadata,
      },
      crypto.randomUUID(),
    );
    if (result.statusCode !== 201) {
      const body = JSON.parse(result.body);
      const errMsg = body.error?.message ?? 'Unknown error';
      await reply(`:x: Failed to resume task: ${errMsg}`);
      logger.warn('Slack clarify-resume task creation failed', {
        status: result.statusCode,
        task_id: task.task_id,
        error: errMsg,
      });
    }
    // On success the notify handler posts in-thread — don't duplicate.
    return;
  }

  // 2. PR-iteration — the task opened a PR; the user's reply is the instruction.
  const prNumber = prNumberFromSlackTask(task);
  if (prNumber !== null && task.repo) {
    // Extract file attachments if any.
    const attachments = await extractSlackFileAttachments(
      { ...event, files: event.files, source: 'mention', text: '', mention_thread_ts: thread_ts } as MentionEvent,
      reply,
    );
    if (attachments === null) return; // validation error already replied

    const result = await createTaskCore(
      {
        repo: task.repo,
        pr_number: prNumber,
        task_description: reply_text || undefined,
        workflow_ref: 'coding/pr-iteration-v1',
        ...(attachments.length > 0 && { attachments }),
      },
      {
        userId: platformUserId,
        channelSource: 'slack',
        channelMetadata,
      },
      crypto.randomUUID(),
    );
    if (result.statusCode !== 201) {
      const body = JSON.parse(result.body);
      const errMsg = body.error?.message ?? 'Unknown error';
      await reply(`:x: Failed to create PR iteration task: ${errMsg}`);
      logger.warn('Slack PR-iteration task creation failed', {
        status: result.statusCode,
        task_id: task.task_id,
        error: errMsg,
      });
    }
    // On success the notify handler posts in-thread — don't duplicate.
    return;
  }

  // 3. Neither — task thread but no actionable state. Log and silently ignore.
  logger.info('Slack thread reply in non-actionable task thread — ignoring', {
    task_id: task.task_id,
    task_status: task.status,
    has_pr: prNumber !== null,
    is_clarify_hold: false,
  });
}

// ─── Set / list channel repos ──────────────────────────────────────────────────

/**
 * `/bgagent set-repo org/repo` (or `/bgagent setup org/repo`) — add a default
 * repo to the current channel so members can @mention the bot without typing
 * the repo. Repeated calls with different repos build up the channel's list;
 * once several are configured, a bare @mention shows an interactive picker.
 *
 * Runs on both the slash-command and mention paths — the channel id and team
 * id are present in either case.
 */
async function handleSetRepo(event: CommandProcessorEvent, args: string[], reply: ReplyFn): Promise<void> {
  if (!CHANNEL_MAPPING_TABLE) {
    await reply(':warning: Channel repo configuration is not available in this deployment.');
    return;
  }

  const repoArg = args[0];
  if (!repoArg) {
    await reply('Usage: `/bgagent set-repo org/repo` — sets the default repo for this channel.\nRun it again with another repo to add more; Shoof will then ask which one to use.');
    return;
  }

  const { repo } = parseRepoArg(repoArg);
  if (!repo) {
    await reply(`:x: \`${repoArg}\` doesn't look like a repo. Use the \`owner/repo\` format — e.g. \`/bgagent set-repo acme/website\`.`);
    return;
  }

  try {
    const repos = await addChannelRepo(CHANNEL_MAPPING_TABLE, event.team_id, event.channel_id, repo);
    if (repos.length === 1) {
      await reply(`:white_check_mark: This channel now defaults to \`${repo}\`.\nMembers can @mention Shoof without naming the repo — e.g. \`@Shoof fix the login bug\`.`);
    } else {
      await reply(
        `:white_check_mark: Added \`${repo}\`. This channel now has ${repos.length} repos configured:\n`
        + repos.map((r) => `• \`${r}\``).join('\n')
        + '\n\nWhen you @mention Shoof without a repo, it will ask which one to use.',
      );
    }
  } catch (err) {
    logger.error('Failed to set channel repo', {
      error: err instanceof Error ? err.message : String(err),
      team_id: event.team_id,
      channel_id: event.channel_id,
    });
    await reply(':warning: Could not save the channel repo. Please try again.');
  }
}

/** `/bgagent repos` — list the repos configured for the current channel. */
async function handleListRepos(event: CommandProcessorEvent, reply: ReplyFn): Promise<void> {
  const repos = await getChannelRepos(CHANNEL_MAPPING_TABLE, event.team_id, event.channel_id);
  if (repos.length === 0) {
    await reply('This channel has no default repo set. Run `/bgagent set-repo org/repo` to add one.');
    return;
  }
  await reply(
    `*Repos configured for this channel:*\n${repos.map((r) => `• \`${r}\``).join('\n')}`,
  );
}

// ─── Link ─────────────────────────────────────────────────────────────────────

async function handleLink(event: CommandProcessorEvent, reply: ReplyFn): Promise<void> {
  // Generate a 6-character alphanumeric code.
  const code = crypto.randomBytes(LINK_CODE_ENTROPY_BYTES).toString('hex').toUpperCase();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + LINK_CODE_TTL_S;

  // Store the pending link record.
  await ddb.send(new PutCommand({
    TableName: USER_MAPPING_TABLE,
    Item: {
      slack_identity: `pending#${code}`,
      slack_team_id: event.team_id,
      slack_user_id: event.user_id,
      link_method: 'slash_command',
      linked_at: now,
      status: 'pending',
      ttl,
    },
  }));

  await reply(
    `:link: *Link your account*\n\nRun this command in your terminal:\n\`\`\`bgagent slack link ${code}\`\`\`\n_This code expires in 10 minutes._`,
  );
}

// ─── Channel Access ──────────────────────────────────────────────────────────

async function getBotToken(teamId: string): Promise<string | null> {
  const installation = await ddb.send(new GetCommand({
    TableName: INSTALLATION_TABLE,
    Key: { team_id: teamId },
  }));
  if (!installation.Item || installation.Item.status !== 'active') return null;
  return getSlackSecret(`${SLACK_SECRET_PREFIX}${teamId}`);
}

/** Slack error codes that definitively mean the bot cannot post in this channel. */
const CHANNEL_ACCESS_HARD_FAILURES = new Set([
  'channel_not_found', // private channel the bot hasn't been invited to
  'not_in_channel', // public channel the bot isn't in (some workspaces require join)
  'missing_scope', // bot lacks the scope it needs — admin must reinstall
]);

async function checkChannelAccess(teamId: string, channelId: string): Promise<{ ok: boolean; error?: string }> {
  // DM channels always work — notifications fall back to user ID.
  if (channelId.startsWith('D')) return { ok: true };

  const botToken = await getBotToken(teamId);
  if (!botToken) {
    logger.warn('Channel access check skipped: bot token missing', { team_id: teamId });
    return {
      ok: false,
      error: ':warning: The Slack integration is not fully configured (missing bot token). Ask your workspace admin to reinstall the app.',
    };
  }

  try {
    const response = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    const result = await response.json() as { ok: boolean; channel?: { is_private: boolean; is_member: boolean }; error?: string };

    if (!result.ok) {
      // Hard failures: the bot definitively cannot post here. Fail closed so the
      // task isn't created silently into a dead-letter channel.
      if (result.error && CHANNEL_ACCESS_HARD_FAILURES.has(result.error)) {
        return { ok: false, error: ':lock: This is a private channel and the bot is not a member. Invite the bot first with `/invite @bgagent`, or submit from a public channel or DM.' };
      }
      // Anything else (ratelimited, internal_error, fatal_error, network blip) is
      // likely transient — fail open and let slack-notify surface any real delivery
      // failure downstream. Blocking task submission on a 30-second Slack blip is
      // a worse UX than creating a task that notifies late.
      logger.warn('Channel access check: transient/unknown Slack error, failing open', {
        error: result.error,
        channel_id: channelId,
      });
      return { ok: true };
    }

    if (result.channel?.is_private && !result.channel?.is_member) {
      return { ok: false, error: ':lock: This is a private channel and the bot is not a member. Invite the bot first with `/invite @bgagent`, or submit from a public channel or DM.' };
    }

    return { ok: true };
  } catch (err) {
    // Network-level failure — treat the same as a transient Slack error.
    logger.warn('Channel access check network failure, failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: true };
  }
}

// ─── Slack File Extraction ───────────────────────────────────────────────────

/** Max size for a Slack file attachment (10 MB per the design doc). */
const SLACK_FILE_MAX_SIZE_BYTES = 10 * 1024 * 1024;
/** Max number of file attachments per Slack message. */
const SLACK_FILE_MAX_COUNT = 10;

/** MIME types supported for attachments (must match validation.ts — PNG/JPEG only). */
const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
const SUPPORTED_FILE_MIMES = new Set([
  'text/plain', 'text/csv', 'text/markdown', 'application/json',
  'application/pdf', 'text/x-log',
]);

/**
 * Download Slack file attachments and convert them to inline Attachment objects.
 * Returns null if validation fails (reply already sent). Returns an empty array
 * if no files are attached.
 *
 * Implements atomic failure semantics: if ANY file fails validation or download,
 * the entire submission is rejected with a descriptive error listing all failures.
 */
async function extractSlackFileAttachments(
  event: MentionEvent,
  reply: ReplyFn,
): Promise<Attachment[] | null> {
  const files = event.files;
  if (!files || files.length === 0) return [];

  if (files.length > SLACK_FILE_MAX_COUNT) {
    await reply(`:x: Task not created. Too many attachments (${files.length}, max ${SLACK_FILE_MAX_COUNT}).`);
    return null;
  }

  const errors: string[] = [];
  const attachments: Attachment[] = [];

  const botToken = await getBotToken(event.team_id);
  if (!botToken) {
    await reply(':x: Task not created. Cannot download attachments (bot token not found).');
    return null;
  }

  for (const file of files) {
    // Validate size
    if (file.size > SLACK_FILE_MAX_SIZE_BYTES) {
      const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
      errors.push(`\`${file.name}\` (too large, ${sizeMb} MB > 10 MB limit)`);
      continue;
    }

    // Validate MIME type
    const mime = file.mimetype.toLowerCase();
    const isImage = SUPPORTED_IMAGE_MIMES.has(mime);
    const isFile = SUPPORTED_FILE_MIMES.has(mime);
    if (!isImage && !isFile) {
      errors.push(`\`${file.name}\` has unsupported type \`${mime}\``);
      continue;
    }

    // Validate the download URL points to a legitimate Slack domain before
    // sending the bot token — prevents SSRF and token exfiltration via crafted events.
    if (!isSlackFileUrl(file.url_private_download)) {
      errors.push(`\`${file.name}\` (invalid download URL — not a Slack domain)`);
      continue;
    }

    // Download the file from Slack CDN using the bot token
    try {
      const response = await fetch(file.url_private_download, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        errors.push(`\`${file.name}\` (download failed: HTTP ${response.status})`);
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // Post-download size validation: Slack's declared file.size may differ
      // from the actual download (e.g., server-side processing, bug, or manipulation).
      if (buffer.length > SLACK_FILE_MAX_SIZE_BYTES) {
        const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);
        errors.push(`\`${file.name}\` (downloaded size ${sizeMb} MB exceeds 10 MB limit)`);
        continue;
      }

      attachments.push({
        type: isImage ? 'image' : 'file',
        content_type: mime,
        filename: file.name,
        data: buffer.toString('base64'),
      });
    } catch (err) {
      logger.error('Failed to download Slack file', {
        filename: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      errors.push(`\`${file.name}\` (download failed)`);
    }
  }

  // Atomic failure: if any file failed, reject the entire submission
  if (errors.length > 0) {
    const errorList = errors.length === 1
      ? errors[0]
      : `${errors.length} attachment errors: ${errors.join(', ')}`;
    await reply(`:x: Task not created. ${errorList}. Fix or remove these files and try again.`);
    return null;
  }

  return attachments;
}

/** Validate that a URL points to a legitimate Slack file domain. */
function isSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'files.slack.com' || parsed.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function lookupPlatformUser(teamId: string, userId: string): Promise<string | null> {
  const key = `${teamId}#${userId}`;
  logger.info('Looking up platform user', { slack_identity: key, table: USER_MAPPING_TABLE });
  const result = await ddb.send(new GetCommand({
    TableName: USER_MAPPING_TABLE,
    Key: { slack_identity: key },
  }));

  if (!result.Item) {
    logger.warn('No user mapping found', { slack_identity: key });
    return null;
  }
  if (result.Item.status === 'pending') {
    logger.warn('User mapping is pending', { slack_identity: key });
    return null;
  }
  logger.info('Found platform user', { slack_identity: key, platform_user_id: result.Item.platform_user_id });
  return (result.Item.platform_user_id as string) ?? null;
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
  logger.info('Posting to Slack response_url', {
    response_url: responseUrl.substring(0, RESPONSE_URL_LOG_PREFIX_LEN),
    text_length: text.length,
  });
  try {
    const response = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn('Failed to post to Slack response_url', {
        status: response.status,
        response_url: responseUrl.substring(0, RESPONSE_URL_LOG_PREFIX_LEN),
        body,
      });
    } else {
      logger.info('Slack response_url post succeeded', { status: response.status });
    }
  } catch (err) {
    logger.warn('Error posting to Slack response_url', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function swapReaction(teamId: string, channelId: string, messageTs: string, remove: string, add: string): Promise<void> {
  const botToken = await getBotToken(teamId);
  if (!botToken) return;
  await slackFetch(botToken, 'reactions.remove', { channel: channelId, timestamp: messageTs, name: remove });
  await slackFetch(botToken, 'reactions.add', { channel: channelId, timestamp: messageTs, name: add });
}
