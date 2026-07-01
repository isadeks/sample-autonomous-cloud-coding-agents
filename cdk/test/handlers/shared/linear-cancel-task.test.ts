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

// Mock order matters: mock before import so the module picks up the mock.
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
}));

const stopRuntimeSessionMock = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: stopRuntimeSessionMock })),
  StopRuntimeSessionCommand: jest.fn((input: unknown) => ({ _type: 'StopRuntimeSession', input })),
}));

const stopTaskMock = jest.fn();
jest.mock('@aws-sdk/client-ecs', () => ({
  ECSClient: jest.fn(() => ({ send: stopTaskMock })),
  StopTaskCommand: jest.fn((input: unknown) => ({ _type: 'StopTask', input })),
}));

process.env.TASK_TABLE_NAME = 'TaskTable';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEventsTable';
process.env.TASK_RETENTION_DAYS = '90';

import { cancelTaskForLinearIssue } from '../../../src/handlers/shared/linear-cancel-task';

/** Minimal task record for active tasks. */
function activeTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 'task-abc',
    user_id: 'user-1',
    status: 'RUNNING',
    session_id: 'session-1',
    channel_source: 'linear',
    linear_issue_id: 'issue-1',
    branch_name: 'bgagent/task-abc/fix-bug',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    status_created_at: 'RUNNING#2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('cancelTaskForLinearIssue', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    stopRuntimeSessionMock.mockReset();
    stopTaskMock.mockReset();
    stopRuntimeSessionMock.mockResolvedValue({});
    stopTaskMock.mockResolvedValue({});
  });

  test('returns no_task when the GSI returns no results', async () => {
    // LinearIssueIndex query returns no items
    ddbSend.mockResolvedValueOnce({ Items: [] });

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('no_task');
    expect(ddbSend).toHaveBeenCalledTimes(1);
  });

  test('returns no_task when the GSI returns items but GetItem misses', async () => {
    // LinearIssueIndex query returns a task_id
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      // GetItem returns nothing (task deleted between GSI read and GetItem)
      .mockResolvedValueOnce({ Item: undefined });

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('no_task');
  });

  test('returns already_terminal when the task is already COMPLETED', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask({ status: 'COMPLETED' }) });

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('already_terminal');
    if (result.kind === 'already_terminal') {
      expect(result.taskId).toBe('task-abc');
    }
  });

  test('returns already_terminal when the task is already CANCELLED', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask({ status: 'CANCELLED' }) });

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('already_terminal');
  });

  test('returns not_owner when ownerPlatformUserId does not match', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask({ user_id: 'user-a' }) });

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-b',
      'user-b', // ownerPlatformUserId check enabled
    );

    expect(result.kind).toBe('not_owner');
  });

  test('skips ownership check when ownerPlatformUserId not supplied', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask({ user_id: 'user-a' }) })
      // UpdateCommand (transition to CANCELLED)
      .mockResolvedValueOnce({})
      // PutCommand (audit event)
      .mockResolvedValueOnce({});

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-b',
      // ownerPlatformUserId omitted — ownership not checked
    );

    expect(result.kind).toBe('cancelled');
  });

  test('cancels a RUNNING task and invokes StopRuntimeSession', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({
        Item: activeTask({
          status: 'RUNNING',
          session_id: 'sess-1',
          agent_runtime_arn: 'arn:aws:bedrock:us-east-1::runtime/rt-1',
        }),
      })
      // UpdateCommand
      .mockResolvedValueOnce({})
      // PutCommand (audit event)
      .mockResolvedValueOnce({});

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('cancelled');
    if (result.kind === 'cancelled') {
      expect(result.taskId).toBe('task-abc');
    }
    // StopRuntimeSession should have been called
    expect(stopRuntimeSessionMock).toHaveBeenCalledTimes(1);
    expect(stopTaskMock).not.toHaveBeenCalled();
  });

  test('cancels a SUBMITTED task without trying to stop a session', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({
        Item: activeTask({ status: 'SUBMITTED' }),
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('cancelled');
    // No session to stop
    expect(stopRuntimeSessionMock).not.toHaveBeenCalled();
    expect(stopTaskMock).not.toHaveBeenCalled();
  });

  test('cancels an ECS-backed task and invokes StopTask', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({
        Item: activeTask({
          status: 'RUNNING',
          session_id: 'sess-1',
          compute_type: 'ecs',
          compute_metadata: {
            clusterArn: 'arn:aws:ecs:us-east-1:123:cluster/main',
            taskArn: 'arn:aws:ecs:us-east-1:123:task/abc',
          },
        }),
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('cancelled');
    expect(stopTaskMock).toHaveBeenCalledTimes(1);
    expect(stopRuntimeSessionMock).not.toHaveBeenCalled();
  });

  test('handles ConditionalCheckFailedException as already_terminal', async () => {
    const condErr = new Error('ConditionalCheckFailed');
    condErr.name = 'ConditionalCheckFailedException';

    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask({ status: 'RUNNING' }) })
      // UpdateCommand throws conditional check failure (race condition)
      .mockRejectedValueOnce(condErr);

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('already_terminal');
  });

  test('returns error on unexpected DynamoDB failure', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask({ status: 'RUNNING' }) })
      .mockRejectedValueOnce(new Error('DynamoDB offline'));

    const result = await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    expect(result.kind).toBe('error');
  });

  test('writes task_cancelled audit event with source=linear_comment', async () => {
    ddbSend
      .mockResolvedValueOnce({ Items: [{ task_id: 'task-abc' }] })
      .mockResolvedValueOnce({ Item: activeTask() })
      .mockResolvedValueOnce({}) // UpdateCommand
      .mockResolvedValueOnce({}); // PutCommand (event)

    await cancelTaskForLinearIssue(
      'TaskTable', 'TaskEventsTable', 'issue-1', 'user-1',
    );

    // The last DDB call should be the PutCommand for the audit event
    const putCalls = ddbSend.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>)._type === 'Put',
    );
    expect(putCalls).toHaveLength(1);
    const putItem = (putCalls[0][0] as Record<string, unknown>).input as Record<string, unknown>;
    expect((putItem.Item as Record<string, unknown>).event_type).toBe('task_cancelled');
    expect((putItem.Item as Record<string, unknown>).metadata).toMatchObject({
      cancelled_by: 'user-1',
      source: 'linear_comment',
    });
  });
});
