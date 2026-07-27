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

import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';
import { deriveOrchestrationId } from '../../../src/handlers/shared/orchestration-store';
import {
  consumeSlackPendingPlan,
  getSlackPendingPlan,
  putSlackPendingPlan,
  SLACK_PENDING_PLAN_SK,
} from '../../../src/handlers/shared/slack-plan-store';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const REF = 'C123:1700000000.0001';
const NOW = '2026-07-27T12:00:00.000Z';
const TTL = 1_800_000_000;
const NODES: PlannedSubIssue[] = [
  { title: 'A', description: 'a', size: 'S', max_budget_usd: 1, depends_on: [] },
  { title: 'B', description: 'b', size: 'M', max_budget_usd: 3, depends_on: [0] },
];

function conditionalFail() {
  return Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
}

function put(over: Partial<Parameters<typeof putSlackPendingPlan>[0]> = {}) {
  return {
    tableName: 'OrchTable',
    threadRef: REF,
    teamId: 'T1',
    channelId: 'C123',
    threadTs: '1700000000.0001',
    repo: 'owner/repo',
    nodes: NODES,
    platformUserId: 'u1',
    panelMessageTs: '1700000009.0009',
    now: NOW,
    ttlEpochSeconds: TTL,
    ...over,
  };
}

describe('putSlackPendingPlan', () => {
  test('upserts a row keyed on the derived thread id + slack SK, carrying the panel ts', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({}) };
    await putSlackPendingPlan({ ddb: ddb as never, ...put() });
    const cmd = ddb.send.mock.calls[0][0] as PutCommand;
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.Item!.orchestration_id).toBe(deriveOrchestrationId(REF));
    expect(cmd.input.Item!.sub_issue_id).toBe(SLACK_PENDING_PLAN_SK);
    expect(cmd.input.Item!.nodes).toEqual(NODES);
    expect(cmd.input.Item!.panel_message_ts).toBe('1700000009.0009');
    expect(cmd.input.Item!.ttl).toBe(TTL);
    // Unconditional upsert (a revise must overwrite).
    expect(cmd.input.ConditionExpression).toBeUndefined();
  });
});

describe('getSlackPendingPlan', () => {
  test('returns undefined when no row', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({ Item: undefined }) };
    expect(await getSlackPendingPlan(ddb as never, 'OrchTable', REF)).toBeUndefined();
    const cmd = ddb.send.mock.calls[0][0] as GetCommand;
    expect(cmd).toBeInstanceOf(GetCommand);
  });

  test('ignores a foreign item missing slack_thread_ref (not a live plan)', async () => {
    const ddb = { send: jest.fn().mockResolvedValue({ Item: { orchestration_id: 'x' } }) };
    expect(await getSlackPendingPlan(ddb as never, 'OrchTable', REF)).toBeUndefined();
  });

  test('parses a genuine row', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValue({
        Item: {
          orchestration_id: deriveOrchestrationId(REF),
          slack_thread_ref: REF,
          slack_team_id: 'T1',
          slack_channel_id: 'C123',
          slack_thread_ts: '1700000000.0001',
          repo: 'owner/repo',
          nodes: NODES,
          platform_user_id: 'u1',
          panel_message_ts: '1700000009.0009',
          created_at: NOW,
        },
      }),
    };
    const row = await getSlackPendingPlan(ddb as never, 'OrchTable', REF);
    expect(row?.slack_thread_ref).toBe(REF);
    expect(row?.nodes).toEqual(NODES);
    expect(row?.panel_message_ts).toBe('1700000009.0009');
  });
});

describe('consumeSlackPendingPlan', () => {
  test('conditional delete-and-return; returns the taken row', async () => {
    const ddb = {
      send: jest.fn().mockResolvedValue({
        Attributes: {
          orchestration_id: deriveOrchestrationId(REF),
          slack_thread_ref: REF,
          nodes: NODES,
          platform_user_id: 'u1',
          repo: 'owner/repo',
          slack_team_id: 'T1',
          slack_channel_id: 'C123',
          slack_thread_ts: '1700000000.0001',
          created_at: NOW,
        },
      }),
    };
    const row = await consumeSlackPendingPlan(ddb as never, 'OrchTable', REF);
    expect(row?.nodes).toEqual(NODES);
    const cmd = ddb.send.mock.calls[0][0] as DeleteCommand;
    expect(cmd).toBeInstanceOf(DeleteCommand);
    expect(cmd.input.ConditionExpression).toContain('attribute_exists');
    expect(cmd.input.ReturnValues).toBe('ALL_OLD');
  });

  test('racing loser (conditional check failed) returns undefined, no throw', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(conditionalFail()) };
    expect(await consumeSlackPendingPlan(ddb as never, 'OrchTable', REF)).toBeUndefined();
  });

  test('a genuine error propagates', async () => {
    const ddb = { send: jest.fn().mockRejectedValue(new Error('throttled')) };
    await expect(consumeSlackPendingPlan(ddb as never, 'OrchTable', REF)).rejects.toThrow('throttled');
  });
});
