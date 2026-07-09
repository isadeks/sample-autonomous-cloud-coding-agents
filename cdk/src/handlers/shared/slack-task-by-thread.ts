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
 * Resolve a Slack thread timestamp → the ABCA task that originated it.
 *
 * Queries the sparse ``SlackThreadIndex`` GSI (ABCA-661), which is keyed
 * ``(slack_thread_ts, created_at)`` and projects the fields the Slack
 * thread-reply handler needs to decide whether to trigger PR-iteration or
 * clarify-resume. Returns null when no task exists for the thread (the
 * thread is ordinary Slack conversation, not an ABCA task thread) or on
 * any error — the caller treats null as "not an ABCA task thread, ignore".
 *
 * Best-effort: never throws.
 */

import { type DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { TaskTable } from '../../constructs/task-table';

/**
 * The fields the Slack thread-reply handler needs from the task that
 * originated a thread. Projected by the ``SlackThreadIndex`` GSI.
 */
export interface SlackThreadTask {
  readonly task_id: string;
  readonly user_id?: string;
  readonly repo?: string;
  readonly pr_url?: string;
  readonly pr_number?: number;
  readonly status?: string;
  /** Resolved workflow id (e.g. ``coding/new-task-v1``). */
  readonly resolved_workflow_id?: string;
  /** Raw workflow_ref supplied at submit time (fallback when resolved_workflow absent). */
  readonly workflow_ref?: string;
  /** Whether the task made a code change (false = clarify-hold candidate). */
  readonly code_changed?: boolean;
  /** The question the agent posed on a clarify-hold. */
  readonly answer_text?: string;
  /** The original task description, used to reconstruct the resume description. */
  readonly task_description?: string;
}

/**
 * Resolve a Slack ``thread_ts`` → its NEWEST ABCA task via the sparse
 * ``SlackThreadIndex`` GSI (ABCA-661). The GSI is keyed
 * ``(slack_thread_ts, created_at)``; we query descending and take the first
 * row, so a thread that has been re-used gets its latest task.
 *
 * Returns null when no task exists for the thread or on any error.
 */
export async function resolveTaskBySlackThread(
  ddb: DynamoDBDocumentClient,
  taskTableName: string,
  slackThreadTs: string,
): Promise<SlackThreadTask | null> {
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: taskTableName,
      IndexName: TaskTable.SLACK_THREAD_INDEX,
      KeyConditionExpression: 'slack_thread_ts = :tts',
      ExpressionAttributeValues: { ':tts': slackThreadTs },
      ScanIndexForward: false, // newest created_at first
      Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item) return null;

    // resolved_workflow is a nested map { id, version } on the task record.
    // The GSI projects the whole map; extract the id field.
    const resolvedWorkflow = item.resolved_workflow as { id?: string } | undefined;

    return {
      task_id: item.task_id as string,
      ...(item.user_id !== undefined && { user_id: item.user_id as string }),
      ...(item.repo !== undefined && { repo: item.repo as string }),
      ...(item.pr_url !== undefined && { pr_url: item.pr_url as string }),
      ...(item.pr_number !== undefined && { pr_number: item.pr_number as number }),
      ...(item.status !== undefined && { status: item.status as string }),
      ...(resolvedWorkflow?.id !== undefined && { resolved_workflow_id: resolvedWorkflow.id }),
      ...(item.workflow_ref !== undefined && { workflow_ref: item.workflow_ref as string }),
      ...(item.code_changed !== undefined && { code_changed: item.code_changed as boolean }),
      ...(item.answer_text !== undefined && { answer_text: item.answer_text as string }),
      ...(item.task_description !== undefined && { task_description: item.task_description as string }),
    };
  } catch (err) {
    logger.warn('Slack thread-reply: SlackThreadIndex query failed — treating thread as non-ABCA', {
      slack_thread_ts: slackThreadTs,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Extract a PR number from a task's ``pr_number`` (preferred) or by parsing
 * ``/pull/<n>`` out of ``pr_url``. Returns null when neither yields a number —
 * the task ran but never opened a PR.
 */
export function prNumberFromSlackTask(task: SlackThreadTask): number | null {
  if (typeof task.pr_number === 'number') return task.pr_number;
  if (typeof task.pr_url === 'string') {
    const m = task.pr_url.match(/\/pull\/(\d+)\b/);
    if (m) return Number(m[1]);
  }
  return null;
}
