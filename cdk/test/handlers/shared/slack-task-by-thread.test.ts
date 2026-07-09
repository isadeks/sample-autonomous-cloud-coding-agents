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

import {
  prNumberFromSlackTask,
  resolveTaskBySlackThread,
} from '../../../src/handlers/shared/slack-task-by-thread';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('resolveTaskBySlackThread', () => {
  const send = jest.fn();
  const ddb = { send } as never;

  beforeEach(() => send.mockReset());

  test('queries SlackThreadIndex descending (newest task) and maps the row', async () => {
    send.mockResolvedValueOnce({
      Items: [{
        task_id: 'T9',
        user_id: 'u1',
        repo: 'o/r',
        pr_number: 42,
        status: 'COMPLETED',
        resolved_workflow: { id: 'coding/new-task-v1', version: 1 },
        code_changed: true,
        task_description: 'fix the bug',
      }],
    });

    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', '1234.5678');

    expect(task).toEqual({
      task_id: 'T9',
      user_id: 'u1',
      repo: 'o/r',
      pr_number: 42,
      status: 'COMPLETED',
      resolved_workflow_id: 'coding/new-task-v1',
      code_changed: true,
      task_description: 'fix the bug',
    });
    const input = send.mock.calls[0][0].input;
    expect(input.IndexName).toBe('SlackThreadIndex');
    expect(input.KeyConditionExpression).toContain('slack_thread_ts');
    expect(input.ExpressionAttributeValues[':tts']).toBe('1234.5678');
    expect(input.ScanIndexForward).toBe(false); // newest first
    expect(input.Limit).toBe(1);
  });

  test('GSI miss (no rows) → null', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    expect(await resolveTaskBySlackThread(ddb, 'TaskTable', '1.0')).toBeNull();
  });

  test('query error → null (swallowed, treated as non-ABCA thread)', async () => {
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await resolveTaskBySlackThread(ddb, 'TaskTable', '1.0')).toBeNull();
  });

  test('omits absent optional fields', async () => {
    send.mockResolvedValueOnce({ Items: [{ task_id: 'T1' }] });
    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', '1.0');
    expect(task).toEqual({ task_id: 'T1' });
  });

  test('extracts resolved_workflow_id from nested resolved_workflow map', async () => {
    send.mockResolvedValueOnce({
      Items: [{ task_id: 'T2', resolved_workflow: { id: 'coding/pr-review-v1', version: 2 } }],
    });
    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', '2.0');
    expect(task!.resolved_workflow_id).toBe('coding/pr-review-v1');
  });

  test('resolved_workflow without id field → no resolved_workflow_id', async () => {
    send.mockResolvedValueOnce({
      Items: [{ task_id: 'T3', resolved_workflow: {} }],
    });
    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', '3.0');
    expect(task).toEqual({ task_id: 'T3' });
    expect(task!.resolved_workflow_id).toBeUndefined();
  });

  test('maps clarify-hold fields (code_changed=false, answer_text, task_description)', async () => {
    send.mockResolvedValueOnce({
      Items: [{
        task_id: 'T4',
        repo: 'org/repo',
        resolved_workflow: { id: 'coding/new-task-v1' },
        code_changed: false,
        answer_text: 'Do you want to target Node 18 or 20?',
        task_description: 'upgrade the runtime',
        status: 'COMPLETED',
      }],
    });
    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', '4.0');
    expect(task!.code_changed).toBe(false);
    expect(task!.answer_text).toBe('Do you want to target Node 18 or 20?');
    expect(task!.task_description).toBe('upgrade the runtime');
  });
});

describe('prNumberFromSlackTask', () => {
  test('prefers numeric pr_number', () => {
    expect(prNumberFromSlackTask({ task_id: 'T', pr_number: 7, pr_url: 'https://github.com/o/r/pull/9' })).toBe(7);
  });

  test('falls back to parsing pr_url', () => {
    expect(prNumberFromSlackTask({ task_id: 'T', pr_url: 'https://github.com/o/r/pull/123' })).toBe(123);
  });

  test('null when neither yields a number', () => {
    expect(prNumberFromSlackTask({ task_id: 'T' })).toBeNull();
    expect(prNumberFromSlackTask({ task_id: 'T', pr_url: 'https://github.com/o/r/tree/main' })).toBeNull();
  });
});
