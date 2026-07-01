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

import { BedrockAgentCoreClient, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { resolveTaskByLinearIssue } from './linear-task-by-issue';
import { logger } from './logger';
import type { TaskRecord } from './types';
import { computeTtlEpoch } from './validation';
import { TERMINAL_STATUSES, TaskStatus } from '../../constructs/task-status';

const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');

/**
 * Outcome of a {@link cancelTaskForLinearIssue} call.
 *
 * - ``cancelled``: the task was successfully cancelled.
 * - ``already_terminal``: the task is already in a terminal state — nothing to do.
 * - ``no_task``: no active ABCA task was found for this Linear issue.
 * - ``not_owner``: the requesting user does not own the task.
 * - ``error``: unexpected error during cancellation.
 */
export type CancelTaskResult =
  | { readonly kind: 'cancelled'; readonly taskId: string }
  | { readonly kind: 'already_terminal'; readonly taskId: string }
  | { readonly kind: 'no_task' }
  | { readonly kind: 'not_owner'; readonly taskId: string }
  | { readonly kind: 'error'; readonly message: string };

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentCoreClient = new BedrockAgentCoreClient({});
const ecsClient = new ECSClient({});

const RUNTIME_ARN = process.env.RUNTIME_ARN;
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;

/**
 * Cancel the active ABCA task linked to a Linear issue.
 *
 * Resolution path:
 *  1. Look up the newest ABCA task for ``linearIssueId`` via the
 *     ``LinearIssueIndex`` GSI (same query used by the standalone
 *     ``@bgagent`` comment trigger).
 *  2. Verify the task is non-terminal (skip silently if already done).
 *  3. Optionally verify ownership (``ownerPlatformUserId`` guard — the
 *     orchestration release user, not necessarily the Linear commenter).
 *  4. Atomically transition to CANCELLED with a DynamoDB condition to
 *     prevent races.
 *  5. Best-effort: stop the compute session (ECS / AgentCore).
 *  6. Write a ``task_cancelled`` audit event.
 *
 * All compute-stop calls are best-effort — a failure there does not
 * change the returned result (the task is already CANCELLED in DDB and
 * the container will detect the status change at its next heartbeat).
 *
 * @param taskTableName - name of the TaskTable DynamoDB table
 * @param taskEventsTableName - name of the TaskEventsTable
 * @param linearIssueId - Linear issue UUID to resolve a task for
 * @param cancelledByUserId - platform user id to record in the audit event
 * @param ownerPlatformUserId - when supplied, only cancel if the task owner
 *   matches (prevents cross-user cancellation via a shared workspace)
 */
export async function cancelTaskForLinearIssue(
  taskTableName: string,
  taskEventsTableName: string,
  linearIssueId: string,
  cancelledByUserId: string,
  ownerPlatformUserId?: string,
): Promise<CancelTaskResult> {
  // 1. Resolve the newest task for this issue.
  const task = await resolveTaskByLinearIssue(ddb, taskTableName, linearIssueId);
  if (!task) {
    logger.info('Linear cancel: no ABCA task found for issue', { linear_issue_id: linearIssueId });
    return { kind: 'no_task' };
  }

  const taskId = task.task_id;

  // 2. Fetch the full task record to get status, compute info, etc.
  let record: TaskRecord;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: taskTableName,
      Key: { task_id: taskId },
    }));
    if (!result.Item) {
      logger.warn('Linear cancel: task resolved by GSI but not found in table', { task_id: taskId });
      return { kind: 'no_task' };
    }
    record = result.Item as TaskRecord;
  } catch (err) {
    logger.error('Linear cancel: failed to fetch task record', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'error', message: 'Failed to fetch task record' };
  }

  // 3. Ownership check (optional — only enforced when ownerPlatformUserId is supplied).
  if (ownerPlatformUserId && record.user_id !== ownerPlatformUserId) {
    logger.warn('Linear cancel: task owner mismatch', {
      task_id: taskId,
      record_user_id: record.user_id,
      requesting_user_id: ownerPlatformUserId,
    });
    return { kind: 'not_owner', taskId };
  }

  // 4. Guard against already-terminal tasks.
  if (TERMINAL_STATUSES.includes(record.status)) {
    logger.info('Linear cancel: task is already terminal', {
      task_id: taskId,
      status: record.status,
    });
    return { kind: 'already_terminal', taskId };
  }

  const wasRunning = record.status === TaskStatus.RUNNING;
  const runtimeSessionId = record.session_id;
  const agentRuntimeArn = record.agent_runtime_arn ?? RUNTIME_ARN;

  // 5. Atomically transition to CANCELLED.
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: taskTableName,
      Key: { task_id: taskId },
      UpdateExpression: 'SET #status = :cancelled, updated_at = :now, completed_at = :now, status_created_at = :sca, #ttl = :ttl',
      ConditionExpression: 'attribute_exists(task_id) AND NOT #status IN (:s1, :s2, :s3, :s4)',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':cancelled': TaskStatus.CANCELLED,
        ':now': now,
        ':sca': `${TaskStatus.CANCELLED}#${now}`,
        ':s1': TaskStatus.COMPLETED,
        ':s2': TaskStatus.FAILED,
        ':s3': TaskStatus.CANCELLED,
        ':s4': TaskStatus.TIMED_OUT,
        ':ttl': computeTtlEpoch(TASK_RETENTION_DAYS),
      },
    }));
  } catch (condErr: unknown) {
    const errName = condErr instanceof Error ? (condErr as NodeJS.ErrnoException).name : '';
    if (errName === 'ConditionalCheckFailedException') {
      // A concurrent cancel or terminal transition beat us here.
      logger.info('Linear cancel: race condition — task already terminal', { task_id: taskId });
      return { kind: 'already_terminal', taskId };
    }
    logger.error('Linear cancel: DynamoDB update failed', {
      task_id: taskId,
      error: condErr instanceof Error ? condErr.message : String(condErr),
    });
    return { kind: 'error', message: 'DynamoDB update failed' };
  }

  // 5b. Best-effort: stop the compute session so the container winds down.
  if (wasRunning && runtimeSessionId) {
    const computeType = record.compute_type;
    if (computeType === 'ecs') {
      const clusterArn = record.compute_metadata?.clusterArn ?? ECS_CLUSTER_ARN;
      const taskArn = record.compute_metadata?.taskArn;
      if (clusterArn && taskArn) {
        try {
          await ecsClient.send(new StopTaskCommand({
            cluster: clusterArn,
            task: taskArn,
            reason: 'Cancelled via Linear comment',
          }));
          logger.info('Linear cancel: ECS StopTask invoked', { task_id: taskId, ecs_task_arn: taskArn });
        } catch (stopErr) {
          logger.warn('Linear cancel: ECS StopTask failed (task may already be stopped)', {
            task_id: taskId,
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        }
      }
    } else if (agentRuntimeArn) {
      try {
        await agentCoreClient.send(new StopRuntimeSessionCommand({
          runtimeSessionId,
          agentRuntimeArn,
        }));
        logger.info('Linear cancel: StopRuntimeSession invoked', { task_id: taskId });
      } catch (stopErr) {
        logger.warn('Linear cancel: StopRuntimeSession failed (session may already be gone)', {
          task_id: taskId,
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    } else {
      // Compute handle missing — the container may still be running and consuming
      // tokens/concurrency. Log a diagnostic so ops can surface the orphan.
      logger.error('Linear cancel: running task has no recognized compute backend — possible orphan', {
        task_id: taskId,
        compute_type: computeType,
        has_runtime_arn: !!agentRuntimeArn,
      });
    }
  }

  // 6. Write audit event.
  try {
    await ddb.send(new PutCommand({
      TableName: taskEventsTableName,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'task_cancelled',
        timestamp: now,
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: { cancelled_by: cancelledByUserId, source: 'linear_comment' },
      },
    }));
  } catch (evtErr) {
    // Non-fatal — the DDB update already committed.
    logger.warn('Linear cancel: failed to write task_cancelled event', {
      task_id: taskId,
      error: evtErr instanceof Error ? evtErr.message : String(evtErr),
    });
  }

  logger.info('Linear cancel: task cancelled via Linear comment', {
    task_id: taskId,
    linear_issue_id: linearIssueId,
    cancelled_by: cancelledByUserId,
  });

  return { kind: 'cancelled', taskId };
}
