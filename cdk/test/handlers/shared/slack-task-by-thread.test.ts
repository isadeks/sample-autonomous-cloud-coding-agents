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
  prNumberFromTask,
  resolveTaskBySlackThread,
  slackThreadIdentity,
} from '../../../src/handlers/shared/slack-task-by-thread';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('slackThreadIdentity', () => {
  test('composes {team}#{channel}#{threadTs}', () => {
    expect(slackThreadIdentity('T1', 'C1', '1234.5678')).toBe('T1#C1#1234.5678');
  });
});

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
        channel_metadata: { slack_thread_ts: '1234.5678' },
      }],
    });

    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', 'T1', 'C1', '1234.5678');

    expect(task).toEqual({
      task_id: 'T9',
      user_id: 'u1',
      repo: 'o/r',
      pr_number: 42,
      status: 'COMPLETED',
      channel_metadata: { slack_thread_ts: '1234.5678' },
    });
    const input = send.mock.calls[0][0].input;
    expect(input.IndexName).toBe('SlackThreadIndex');
    expect(input.KeyConditionExpression).toContain('slack_thread_identity');
    expect(input.ExpressionAttributeValues[':sid']).toBe('T1#C1#1234.5678');
    expect(input.ScanIndexForward).toBe(false); // newest first
    expect(input.Limit).toBe(1);
  });

  test('GSI miss (no rows) → null', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    expect(await resolveTaskBySlackThread(ddb, 'TaskTable', 'T1', 'C1', 'x')).toBeNull();
  });

  test('query error → null (swallowed, treated as non-ABCA thread)', async () => {
    send.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await resolveTaskBySlackThread(ddb, 'TaskTable', 'T1', 'C1', 'x')).toBeNull();
  });

  test('omits absent optional fields', async () => {
    send.mockResolvedValueOnce({ Items: [{ task_id: 'T1' }] });
    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', 'T1', 'C1', 'x');
    expect(task).toEqual({ task_id: 'T1' });
  });

  test('drops a non-string channel_metadata map', async () => {
    send.mockResolvedValueOnce({ Items: [{ task_id: 'T1', channel_metadata: { n: 5 } }] });
    const task = await resolveTaskBySlackThread(ddb, 'TaskTable', 'T1', 'C1', 'x');
    expect(task).toEqual({ task_id: 'T1' });
  });
});

describe('prNumberFromTask (re-exported)', () => {
  test('prefers numeric pr_number', () => {
    expect(prNumberFromTask({ task_id: 'T', pr_number: 7, pr_url: 'https://github.com/o/r/pull/9' })).toBe(7);
  });

  test('falls back to parsing pr_url', () => {
    expect(prNumberFromTask({ task_id: 'T', pr_url: 'https://github.com/o/r/pull/123' })).toBe(123);
  });

  test('null when neither yields a number', () => {
    expect(prNumberFromTask({ task_id: 'T' })).toBeNull();
  });
});
