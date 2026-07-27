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

import { type DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { TaskTable } from '../../constructs/task-table';

// prNumberFromTask is shared from linear-task-by-issue (same pr_number / pr_url
// extraction) rather than duplicated here.
export { prNumberFromTask } from './linear-task-by-issue';

/**
 * The fields the ABCA-1015 Slack follow-up trigger needs from the newest ABCA
 * task that ran in a given Slack thread. Projected by the ``SlackThreadIndex``
 * GSI (INCLUDE: pr_url, pr_number, status, repo, user_id, channel_metadata).
 */
export interface SlackThreadTask {
  readonly task_id: string;
  readonly user_id?: string;
  readonly repo?: string;
  readonly pr_url?: string;
  readonly pr_number?: number;
  readonly status?: string;
  readonly channel_metadata?: Record<string, string>;
}

/**
 * Build the sparse-index key for a Slack task thread. A thread is uniquely
 * identified by the workspace + channel + the root message ts the task's
 * notifications hang under (``channel_metadata.slack_thread_ts``).
 */
export function slackThreadIdentity(teamId: string, channelId: string, threadTs: string): string {
  return `${teamId}#${channelId}#${threadTs}`;
}

/**
 * Resolve a Slack thread → its NEWEST ABCA task via the sparse
 * ``SlackThreadIndex`` GSI (ABCA-1015). The GSI is keyed
 * ``(slack_thread_identity, created_at)``; we query descending and take the
 * first row, so a thread that has already been iterated resolves to its latest
 * task (the one holding the live PR). Returns null when no task exists for the
 * thread (the reply is in some other thread, or a thread ABCA never posted in)
 * or on any error — the caller treats null as "not a task thread, ignore".
 *
 * Best-effort: never throws.
 */
export async function resolveTaskBySlackThread(
  ddb: DynamoDBDocumentClient,
  taskTableName: string,
  teamId: string,
  channelId: string,
  threadTs: string,
): Promise<SlackThreadTask | null> {
  const identity = slackThreadIdentity(teamId, channelId, threadTs);
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: taskTableName,
      IndexName: TaskTable.SLACK_THREAD_INDEX,
      KeyConditionExpression: 'slack_thread_identity = :sid',
      ExpressionAttributeValues: { ':sid': identity },
      ScanIndexForward: false, // newest created_at first
      Limit: 1,
    }));
    const item = res.Items?.[0];
    if (!item || typeof item.task_id !== 'string') return null;
    return {
      task_id: item.task_id,
      ...(typeof item.user_id === 'string' && { user_id: item.user_id }),
      ...(typeof item.repo === 'string' && { repo: item.repo }),
      ...(typeof item.pr_url === 'string' && { pr_url: item.pr_url }),
      ...(typeof item.pr_number === 'number' && { pr_number: item.pr_number }),
      ...(typeof item.status === 'string' && { status: item.status }),
      ...(isStringRecord(item.channel_metadata) && { channel_metadata: item.channel_metadata }),
    };
  } catch (err) {
    logger.warn('ABCA-1015 follow-up: SlackThreadIndex query failed — treating thread as non-ABCA', {
      slack_thread_identity: identity,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object'
    && value !== null
    && Object.values(value).every((entry) => typeof entry === 'string');
}
