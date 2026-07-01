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
 * Shared core logic for cancelling a task: flip DDB to CANCELLED, stop compute,
 * and emit the ``task_cancelled`` event that drives the fan-out plane (Linear
 * reply + other channels). Extracted so both the REST handler
 * (``cancel-task.ts``) and the Linear webhook processor (``@bgagent cancel``)
 * can reuse the same atomic cancel semantics without duplicating the DDB +
 * compute-stop calls.
 *
 * The caller is responsible for:
 *   - Auth / ownership checks (the REST handler gates on Cognito; the webhook
 *     processor gates on the Linear workspace ↔ platform-user mapping).
 *   - Loading the TaskRecord before calling (the caller decides which task to
 *     cancel).
 */

import { BedrockAgentCoreClient, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECSClient, StopTaskCommand } from '@aws-sdk/client-ecs';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { logger } from './logger';
import type { TaskRecord } from './types';
import { computeTtlEpoch } from './validation';
import { TaskStatus, TERMINAL_STATUSES } from '../../constructs/task-status';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentCoreClient = new BedrockAgentCoreClient({});
const ecsClient = new ECSClient({});

const TASK_RETENTION_DAYS = Number(process.env.TASK_RETENTION_DAYS ?? '90');
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;

export type CancelOutcome =
  | { kind: 'cancelled'; taskId: string; cancelledAt: string }
  | { kind: 'already_terminal'; status: string }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

/**
 * Cancel a task: flip its status to CANCELLED in DDB, stop the compute session
 * (best-effort), and emit ``task_cancelled``. The ``cancelledBy`` value is
 * stored in the event metadata for audit.
 *
 * Accepts an optional pre-loaded ``taskRecord`` to avoid a redundant DDB
 * GetCommand when the caller already fetched the record (e.g. for ownership
 * checks). When absent, the record is loaded internally.
 *
 * Returns a discriminated outcome so callers can surface appropriate feedback
 * without needing to catch exceptions for control flow.
 */
export async function cancelTaskCore(
  taskId: string,
  cancelledBy: string,
  taskRecord?: TaskRecord,
): Promise<CancelOutcome> {
  const tableName = process.env.TASK_TABLE_NAME;
  const eventsTableName = process.env.TASK_EVENTS_TABLE_NAME;
  if (!tableName || !eventsTableName) {
    return { kind: 'error', message: 'TASK_TABLE_NAME or TASK_EVENTS_TABLE_NAME not set' };
  }

  // Use the pre-loaded record when available; otherwise fetch from DDB.
  let record: TaskRecord;
  if (taskRecord) {
    record = taskRecord;
  } else {
    try {
      const result = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { task_id: taskId },
      }));
      if (!result.Item) return { kind: 'not_found' };
      record = result.Item as TaskRecord;
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Already terminal — nothing to do.
  if (TERMINAL_STATUSES.includes(record.status)) {
    return { kind: 'already_terminal', status: record.status };
  }

  const wasRunning = record.status === TaskStatus.RUNNING;
  const runtimeSessionId = record.session_id;
  const agentRuntimeArn = record.agent_runtime_arn ?? RUNTIME_ARN;
  const now = new Date().toISOString();

  // Flip status to CANCELLED with a condition so concurrent cancels are safe.
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
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
    if ((condErr as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return { kind: 'already_terminal', status: record.status };
    }
    return { kind: 'error', message: condErr instanceof Error ? condErr.message : String(condErr) };
  }

  // Stop compute session (best-effort — the task record is already CANCELLED).
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
            reason: 'Cancelled via @bgagent cancel',
          }));
          logger.info('[cancel-core] ECS StopTask invoked', { task_id: taskId, ecs_task_arn: taskArn });
        } catch (stopErr) {
          logger.warn('[cancel-core] ECS StopTask failed (non-fatal)', {
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
        logger.info('[cancel-core] StopRuntimeSession invoked', { task_id: taskId });
      } catch (stopErr) {
        logger.warn('[cancel-core] StopRuntimeSession failed (non-fatal)', {
          task_id: taskId,
          error: stopErr instanceof Error ? stopErr.message : String(stopErr),
        });
      }
    } else {
      logger.warn('[cancel-core] running task has no compute handle — possible orphan after cancel', {
        task_id: taskId,
        compute_type: record.compute_type,
      });
    }
  }

  // Emit task_cancelled event → fan-out plane posts the Linear reply.
  try {
    await ddb.send(new PutCommand({
      TableName: eventsTableName,
      Item: {
        task_id: taskId,
        event_id: ulid(),
        event_type: 'task_cancelled',
        timestamp: now,
        ttl: computeTtlEpoch(TASK_RETENTION_DAYS),
        metadata: { cancelled_by: cancelledBy },
      },
    }));
  } catch (eventErr) {
    // The task IS cancelled in DDB; the event write failure means fan-out
    // won't post the Linear reply — log but don't unwind the cancellation.
    logger.warn('[cancel-core] failed to write task_cancelled event (task is still cancelled)', {
      task_id: taskId,
      error: eventErr instanceof Error ? eventErr.message : String(eventErr),
    });
  }

  logger.info('[cancel-core] task cancelled', { task_id: taskId, cancelled_by: cancelledBy });
  return { kind: 'cancelled', taskId, cancelledAt: now };
}
