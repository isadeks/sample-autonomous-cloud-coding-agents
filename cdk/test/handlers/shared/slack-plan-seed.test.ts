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

import type { PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../../src/handlers/shared/orchestration-discovery');
jest.mock('../../../src/handlers/shared/orchestration-release');
jest.mock('../../../src/handlers/shared/orchestration-rollup');
jest.mock('../../../src/handlers/shared/orchestration-store', () => ({
  ...jest.requireActual('../../../src/handlers/shared/orchestration-store'),
  loadOrchestration: jest.fn(),
  setStatusCommentId: jest.fn(),
}));

import { discoverOrchestration } from '../../../src/handlers/shared/orchestration-discovery';
import { readConcurrencyBudget, releaseReadyChildren } from '../../../src/handlers/shared/orchestration-release';
import { upsertEpicPanel } from '../../../src/handlers/shared/orchestration-rollup';
import { loadOrchestration, setStatusCommentId } from '../../../src/handlers/shared/orchestration-store';
import { seedSlackApprovedPlan } from '../../../src/handlers/shared/slack-plan-seed';

const discoverMock = discoverOrchestration as jest.Mock;
const releaseMock = releaseReadyChildren as jest.Mock;
const panelMock = upsertEpicPanel as jest.Mock;
const loadMock = loadOrchestration as jest.Mock;
const setStatusMock = setStatusCommentId as jest.Mock;
const budgetMock = readConcurrencyBudget as jest.Mock;

function node(title: string, depends_on: number[] = []): PlannedSubIssue {
  return { title, description: `${title} scope`, size: 'M', max_budget_usd: 4, depends_on };
}

const NODES: PlannedSubIssue[] = [node('API'), node('Careers'), node('Wire', [0, 1])];

function base(over: Partial<Parameters<typeof seedSlackApprovedPlan>[0]> = {}) {
  return {
    ddb: { send: jest.fn() } as never,
    orchestrationTable: 'OrchTable',
    maxConcurrent: 5,
    createTaskCore: jest.fn() as never,
    nodes: NODES,
    repo: 'owner/repo',
    platformUserId: 'u1',
    teamId: 'T1',
    channelId: 'C123',
    threadTs: '1700000000.0001',
    channel: { kind: 'slack', upsertComment: jest.fn() } as never,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  budgetMock.mockResolvedValue(5);
});

describe('seedSlackApprovedPlan', () => {
  test('empty plan → false, never touches discovery', async () => {
    const ok = await seedSlackApprovedPlan(base({ nodes: [] }));
    expect(ok).toBe(false);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  test('discovery declined (single_task) → false', async () => {
    discoverMock.mockResolvedValue({ kind: 'single_task', parentIssueRef: 'x' });
    const ok = await seedSlackApprovedPlan(base());
    expect(ok).toBe(false);
    expect(releaseMock).not.toHaveBeenCalled();
  });

  test('seeded → releases roots, posts the epic panel via the Slack channel, returns true', async () => {
    discoverMock.mockResolvedValue({ kind: 'seeded', orchestrationId: 'orch_x', childCount: 3 });
    loadMock.mockResolvedValue({
      children: [{ sub_issue_id: 's1' }],
      meta: { release_context: { platform_user_id: 'u1', channel_source: 'slack' } },
    });
    panelMock.mockResolvedValue('1700000009.0009');

    const params = base();
    const ok = await seedSlackApprovedPlan(params);

    expect(ok).toBe(true);
    // Discovery seeded from the declarative graph built from the plan.
    expect(discoverMock).toHaveBeenCalledTimes(1);
    const discArgs = discoverMock.mock.calls[0][0];
    expect(discArgs.credentialsRef).toBe('T1');
    expect(discArgs.releaseContext.channel_source).toBe('slack');
    // Roots released, throttled by the concurrency budget.
    expect(releaseMock).toHaveBeenCalledTimes(1);
    // Panel posted on the Slack thread ref via the injected channel + id stored.
    expect(panelMock).toHaveBeenCalledTimes(1);
    const panelArgs = panelMock.mock.calls[0][0];
    expect(panelArgs.parent).toEqual({ issueId: 'C123:1700000000.0001', credentialsRef: 'T1' });
    expect(panelArgs.channel).toBe(params.channel);
    expect(panelArgs.mirrorParentState).toBe(false);
    expect(setStatusMock).toHaveBeenCalledWith(params.ddb, 'OrchTable', 'orch_x', '1700000009.0009');
  });

  test('a discovery throw is swallowed → false (never throws out)', async () => {
    discoverMock.mockRejectedValue(new Error('ddb down'));
    const ok = await seedSlackApprovedPlan(base());
    expect(ok).toBe(false);
  });

  test('panel failure is non-fatal — still returns true (seed succeeded)', async () => {
    discoverMock.mockResolvedValue({ kind: 'seeded', orchestrationId: 'orch_x', childCount: 3 });
    loadMock.mockResolvedValue({
      children: [{ sub_issue_id: 's1' }],
      meta: { release_context: { platform_user_id: 'u1', channel_source: 'slack' } },
    });
    panelMock.mockRejectedValue(new Error('slack 500'));
    const ok = await seedSlackApprovedPlan(base());
    expect(ok).toBe(true);
  });
});
