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

import { formatDuration, truncate } from './slack-format';

/** Max length for task-failure reason text in Slack blocks. */
const TASK_FAILED_REASON_MAX_LEN = 300;
import type { TaskRecord } from './types';

/** A Slack Block Kit mrkdwn text object. */
interface MrkdwnText {
  readonly type: 'mrkdwn';
  readonly text: string;
}

/** A Slack Block Kit plain_text text object. */
interface PlainText {
  readonly type: 'plain_text';
  readonly text: string;
  readonly emoji?: boolean;
}

/** Section block: a single line/paragraph of mrkdwn content. */
export interface SectionBlock {
  readonly type: 'section';
  readonly text: MrkdwnText;
  readonly block_id?: string;
}

/** Link-out button: opens a URL in a new tab. No action_id needed. */
export interface LinkButtonElement {
  readonly type: 'button';
  readonly text: PlainText;
  readonly url: string;
  readonly style?: 'primary' | 'danger';
}

/** Actionable button: triggers a Block Kit interaction callback via action_id. */
export interface ActionButtonElement {
  readonly type: 'button';
  readonly text: PlainText;
  readonly action_id: string;
  /** Opaque value delivered back in the interaction payload's `actions[].value`. */
  readonly value?: string;
  readonly style?: 'primary' | 'danger';
  readonly confirm?: {
    readonly title: PlainText;
    readonly text: MrkdwnText;
    readonly confirm: PlainText;
    readonly deny: PlainText;
  };
}

export type ButtonElement = LinkButtonElement | ActionButtonElement;

/** An option in a static_select menu. */
export interface StaticSelectOption {
  readonly text: PlainText;
  readonly value: string;
}

/** Static select menu element: a dropdown of predefined options. */
export interface StaticSelectElement {
  readonly type: 'static_select';
  readonly action_id: string;
  readonly placeholder: PlainText;
  readonly options: ReadonlyArray<StaticSelectOption>;
}

/** Any interactive element an actions block can hold. */
export type ActionElement = ButtonElement | StaticSelectElement;

/** Actions block: a row of interactive elements (buttons, menus, etc.). */
export interface ActionsBlock {
  readonly type: 'actions';
  readonly block_id: string;
  readonly elements: ReadonlyArray<ActionElement>;
}

/** Any Block Kit block this module renders. */
export type SlackBlock = SectionBlock | ActionsBlock;

/** A Slack message payload suitable for chat.postMessage. */
export interface SlackMessage {
  /** Fallback plain-text for notifications. */
  readonly text: string;
  /** Block Kit blocks for rich rendering. */
  readonly blocks: SlackBlock[];
  /** If set, post as a threaded reply. */
  readonly thread_ts?: string;
}

/**
 * Render a task event as a Slack Block Kit message.
 *
 * @param eventType - the task event type (e.g. 'task_created', 'task_completed').
 * @param task - the task record with current state.
 * @param eventMetadata - optional metadata from the event record.
 * @returns a SlackMessage payload.
 */
export function renderSlackBlocks(
  eventType: string,
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'task_description' | 'pr_url' | 'error_message' | 'cost_usd' | 'duration_s' | 'status'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  switch (eventType) {
    case 'task_created':
      return taskCreatedMessage(task);
    case 'session_started':
      return sessionStartedMessage(task);
    case 'task_completed':
      return taskCompletedMessage(task);
    case 'task_failed':
      return taskFailedMessage(task, eventMetadata);
    case 'task_cancelled':
      return simpleStatusMessage(task, ':no_entry_sign: Task cancelled');
    case 'task_timed_out':
      return taskTimedOutMessage(task);
    case 'task_stranded':
      // Emitted by reconcile-stranded-tasks when a task's heartbeat
      // stops. Operators see this on stranded Slack-origin tasks; the
      // generic "Event: ..." fallback would be a UX regression
      // (issue #64 review Cat 7).
      return taskStrandedMessage(task, eventMetadata);
    case 'agent_error':
      return agentErrorMessage(task, eventMetadata);
    default:
      return simpleStatusMessage(task, `Event: ${eventType}`);
  }
}

function taskCreatedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'task_description'>,
): SlackMessage {
  const desc = task.task_description
    ? `\n${truncate(task.task_description, 200)}`
    : '';
  const text = `:rocket: *Task submitted* for \`${task.repo}\`${desc}\n_ID:_ \`${task.task_id}\``;
  return {
    text: `Task submitted for ${task.repo}`,
    blocks: [section(text)],
  };
}

function taskCompletedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'pr_url' | 'cost_usd' | 'duration_s'>,
): SlackMessage {
  const parts = [`:white_check_mark: *Task completed* for \`${task.repo}\``];
  const stats: string[] = [];
  if (task.duration_s != null) stats.push(formatDuration(task.duration_s));
  if (task.cost_usd != null) stats.push(`$${Number(task.cost_usd).toFixed(2)}`);
  if (stats.length > 0) parts.push(stats.join(' · '));
  const text = parts.join('\n');

  const blocks: SlackBlock[] = [section(text)];

  // "View PR" button — no inline link text, so Slack won't unfurl a big preview card.
  if (task.pr_url) {
    blocks.push(actions(task.task_id, [
      linkButton(`View PR ${prLabel(task.pr_url)}`, task.pr_url),
    ]));
  }

  return {
    text: `Task completed for ${task.repo}`,
    blocks,
  };
}

function taskFailedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'error_message'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  const reason = task.error_message
    ?? (eventMetadata?.error as string | undefined)
    ?? 'Unknown error';
  const text = `:x: *Task failed* for \`${task.repo}\`\n_Reason:_ ${truncate(reason, TASK_FAILED_REASON_MAX_LEN)}`;
  return {
    text: `Task failed for ${task.repo}`,
    blocks: [section(text)],
  };
}

function taskTimedOutMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo' | 'duration_s'>,
): SlackMessage {
  const duration = task.duration_s != null ? ` after ${formatDuration(task.duration_s)}` : '';
  const text = `:hourglass: *Task timed out* for \`${task.repo}\`${duration}`;
  return {
    text: `Task timed out for ${task.repo}`,
    blocks: [section(text)],
  };
}

function sessionStartedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
): SlackMessage {
  const text = `:hourglass_flowing_sand: Agent started working on \`${task.repo}\``;
  return {
    text: `Agent started working on ${task.repo}`,
    blocks: [
      section(text),
      actions(task.task_id, [
        dangerButton('Cancel Task', `cancel_task:${task.task_id}`),
      ]),
    ],
  };
}

function taskStrandedMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  // The reconciler stamps ``code: STRANDED_NO_HEARTBEAT`` and
  // ``prior_status`` on the event metadata (see
  // handlers/reconcile-stranded-tasks.ts). Surface the prior status so
  // operators can tell at a glance whether the task hung in HYDRATING
  // vs RUNNING.
  const priorStatus = typeof eventMetadata?.prior_status === 'string'
    ? eventMetadata.prior_status
    : undefined;
  const detail = priorStatus ? ` (last status: ${priorStatus})` : '';
  const text = `:warning: *Task stranded* for \`${task.repo}\`${detail}`;
  return {
    text: `Task stranded for ${task.repo}`,
    blocks: [section(text)],
  };
}

function agentErrorMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  eventMetadata?: Record<string, unknown>,
): SlackMessage {
  // ``agent/src/progress_writer.py::write_agent_error`` carries
  // ``error_type`` and ``message_preview``. Render whichever is
  // present without leaking the full preview if it's noisy.
  const errorType = typeof eventMetadata?.error_type === 'string'
    ? eventMetadata.error_type
    : undefined;
  const preview = typeof eventMetadata?.message_preview === 'string'
    ? eventMetadata.message_preview
    : undefined;
  const detail = errorType
    ? `\n_Type:_ \`${errorType}\``
    : '';
  const previewLine = preview ? `\n${truncate(preview, 200)}` : '';
  const text = `:rotating_light: *Agent error* during \`${task.repo}\`${detail}${previewLine}`;
  return {
    text: `Agent error during ${task.repo}`,
    blocks: [section(text)],
  };
}

function simpleStatusMessage(
  task: Pick<TaskRecord, 'task_id' | 'repo'>,
  label: string,
): SlackMessage {
  const text = `${label} for \`${task.repo}\`\n_ID:_ \`${task.task_id}\``;
  return {
    text: `${label} for ${task.repo}`,
    blocks: [section(text)],
  };
}

function section(text: string): SectionBlock {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function actions(blockId: string, elements: ReadonlyArray<ActionElement>): ActionsBlock {
  return { type: 'actions', block_id: blockId, elements };
}

function linkButton(label: string, url: string): LinkButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    url,
    style: 'primary',
  };
}

function dangerButton(label: string, actionId: string): ActionButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: label },
    action_id: actionId,
    style: 'danger',
    confirm: {
      title: { type: 'plain_text', text: 'Cancel task?' },
      text: { type: 'mrkdwn', text: 'This will stop the running agent.' },
      confirm: { type: 'plain_text', text: 'Cancel' },
      deny: { type: 'plain_text', text: 'Keep running' },
    },
  };
}

function prLabel(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)$/);
  return match ? `#${match[1]}` : 'Pull Request';
}

// ─── Repo picker ────────────────────────────────────────────────────────────

/** action_id prefix for the repo-picker callback (wired in slack-interactions.ts). */
export const REPO_PICK_ACTION_ID = 'pick_repo';

/**
 * Above this many configured repos, a row of buttons would overflow the
 * Slack actions-block element cap and wrap awkwardly, so the picker switches
 * to a single static_select dropdown.
 */
const REPO_PICKER_BUTTON_THRESHOLD = 5;

/** Slack caps button/option label text at 75 characters. */
const REPO_LABEL_MAX_LEN = 75;

/**
 * Render an interactive repo-picker message shown when a channel has multiple
 * default repos configured and the user submitted a bare @mention. The user
 * picks a repo and the interaction callback (`pick_repo:{token}`) submits the
 * task against it.
 *
 * Uses supported Block Kit interactive components: a row of buttons for a small
 * number of repos, or a static_select dropdown once the list grows past
 * {@link REPO_PICKER_BUTTON_THRESHOLD}.
 *
 * @param token - opaque pending-pick token round-tripped through the action.
 * @param repos - the channel's configured `owner/repo` defaults.
 * @param threadTs - optional thread to post the picker into.
 */
export function repoPickerMessage(token: string, repos: string[], threadTs?: string): SlackMessage {
  const actionId = `${REPO_PICK_ACTION_ID}:${token}`;
  const prompt = ':point_down: This channel has multiple repos configured. Which one is this task for?';

  const elements: ActionElement[] = repos.length > REPO_PICKER_BUTTON_THRESHOLD
    ? [repoSelect(actionId, repos)]
    : repos.map((repo) => repoButton(actionId, repo));

  const blocks: SlackBlock[] = [section(prompt), actions(token, elements)];

  return {
    text: 'Which repo is this task for?',
    blocks,
    ...(threadTs && { thread_ts: threadTs }),
  };
}

/**
 * A button that submits the pending task against `repo` when clicked.
 *
 * The repo is carried in `value`; the `action_id` embeds the repo too so that
 * a Block Kit actions block with several repo buttons keeps each action_id
 * unique (Slack rejects duplicate action_ids within a block).
 */
function repoButton(actionId: string, repo: string): ActionButtonElement {
  return {
    type: 'button',
    text: { type: 'plain_text', text: truncate(repo, REPO_LABEL_MAX_LEN) },
    action_id: `${actionId}#${repo}`,
    value: repo,
  };
}

/** A static_select dropdown listing every configured repo. */
function repoSelect(actionId: string, repos: string[]): StaticSelectElement {
  return {
    type: 'static_select',
    action_id: actionId,
    placeholder: { type: 'plain_text', text: 'Choose a repo' },
    options: repos.map((repo) => ({
      text: { type: 'plain_text', text: truncate(repo, REPO_LABEL_MAX_LEN) },
      value: repo,
    })),
  };
}
