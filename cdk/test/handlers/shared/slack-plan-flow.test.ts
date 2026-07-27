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
import {
  runSlackPlanReply,
  type SlackPendingPlan,
  type SlackPlanEffects,
} from '../../../src/handlers/shared/slack-plan-flow';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function node(title: string, depends_on: number[] = [], size: 'S' | 'M' | 'L' = 'M'): PlannedSubIssue {
  return { title, description: `${title} scope`, size, max_budget_usd: 4, depends_on };
}

const NODES: PlannedSubIssue[] = [node('API'), node('Careers'), node('Wire', [0, 1])];
const PANEL_TS = '1700000000.0001';

function pending(over: Partial<SlackPendingPlan> = {}): SlackPendingPlan {
  return { nodes: NODES, panelMessageTs: PANEL_TS, ...over };
}

function effects(over: Partial<SlackPlanEffects> = {}): SlackPlanEffects {
  return {
    editPanel: jest.fn().mockResolvedValue(PANEL_TS),
    postReply: jest.fn().mockResolvedValue(undefined),
    replacePendingPlan: jest.fn().mockResolvedValue(undefined),
    consumePendingPlan: jest.fn().mockResolvedValue({ nodes: NODES }),
    seedApprovedPlan: jest.fn().mockResolvedValue(true),
    ...over,
  };
}

describe('runSlackPlanReply — no pending plan', () => {
  test('returns no_pending_plan and touches nothing', async () => {
    const e = effects();
    const r = await runSlackPlanReply({ instruction: 'approve', pending: null, effects: e });
    expect(r).toEqual({ kind: 'no_pending_plan' });
    expect(e.consumePendingPlan).not.toHaveBeenCalled();
    expect(e.editPanel).not.toHaveBeenCalled();
  });
});

describe('runSlackPlanReply — approve', () => {
  test('consumes the plan, seeds it, freezes the panel into the approved reference', async () => {
    const e = effects();
    const r = await runSlackPlanReply({ instruction: 'looks good', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'seeded' });
    expect(e.consumePendingPlan).toHaveBeenCalledTimes(1);
    expect(e.seedApprovedPlan).toHaveBeenCalledWith(NODES);
    expect(e.editPanel).toHaveBeenCalledTimes(1);
    const [body, ts] = (e.editPanel as jest.Mock).mock.calls[0];
    expect(body).toContain('Approved plan');
    expect(ts).toBe(PANEL_TS);
  });

  test('a racing second approve (already consumed) no-ops without seeding', async () => {
    const e = effects({ consumePendingPlan: jest.fn().mockResolvedValue(null) });
    const r = await runSlackPlanReply({ instruction: 'approve', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'no_pending_plan' });
    expect(e.seedApprovedPlan).not.toHaveBeenCalled();
    expect(e.editPanel).not.toHaveBeenCalled();
  });

  test('seed decline is surfaced (not a silent success); plan already consumed', async () => {
    const e = effects({ seedApprovedPlan: jest.fn().mockResolvedValue(false) });
    const r = await runSlackPlanReply({ instruction: 'yes', pending: pending(), effects: e });
    expect(r.kind).toBe('error');
    expect(e.postReply).toHaveBeenCalledTimes(1);
    expect(e.editPanel).not.toHaveBeenCalled();
  });
});

describe('runSlackPlanReply — reject', () => {
  test('consumes the plan and freezes the panel into the discarded reference', async () => {
    const e = effects();
    const r = await runSlackPlanReply({ instruction: 'cancel', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'discarded' });
    expect(e.consumePendingPlan).toHaveBeenCalledTimes(1);
    expect(e.seedApprovedPlan).not.toHaveBeenCalled();
    const [body] = (e.editPanel as jest.Mock).mock.calls[0];
    expect(body).toContain('Plan discarded');
  });

  test('racing second reject (already consumed) no-ops', async () => {
    const e = effects({ consumePendingPlan: jest.fn().mockResolvedValue(null) });
    const r = await runSlackPlanReply({ instruction: 'discard', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'no_pending_plan' });
    expect(e.editPanel).not.toHaveBeenCalled();
  });
});

describe('runSlackPlanReply — revise (matures the SAME panel in place)', () => {
  test('persists the revised plan, then edits the panel with a "what changed" note', async () => {
    const e = effects();
    const r = await runSlackPlanReply({ instruction: 'drop #3', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'revised' });
    // Never consumed/seeded — a revise keeps waiting for approval.
    expect(e.consumePendingPlan).not.toHaveBeenCalled();
    expect(e.seedApprovedPlan).not.toHaveBeenCalled();
    // Persisted with only the two surviving nodes, keyed to the same panel ts.
    const [savedNodes, savedTs] = (e.replacePendingPlan as jest.Mock).mock.calls[0];
    expect(savedNodes.map((n: PlannedSubIssue) => n.title)).toEqual(['API', 'Careers']);
    expect(savedTs).toBe(PANEL_TS);
    // Panel edited in place with the update + change summary.
    const [body, ts] = (e.editPanel as jest.Mock).mock.calls[0];
    expect(body).toContain('Updated plan');
    expect(body).toContain('What changed');
    expect(ts).toBe(PANEL_TS);
  });

  test('persist happens before the panel edit (store is source of truth)', async () => {
    const order: string[] = [];
    const e = effects({
      replacePendingPlan: jest.fn(async () => { order.push('persist'); }),
      editPanel: jest.fn(async () => { order.push('edit'); return PANEL_TS; }),
    });
    await runSlackPlanReply({ instruction: 'merge 1 and 2', pending: pending(), effects: e });
    expect(order).toEqual(['persist', 'edit']);
  });
});

describe('runSlackPlanReply — nudge (never destroys the plan)', () => {
  test('ambiguous "no" posts a nudge reply, leaves the panel + plan intact', async () => {
    const e = effects();
    const r = await runSlackPlanReply({ instruction: 'no', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'nudged' });
    expect(e.postReply).toHaveBeenCalledTimes(1);
    expect(e.consumePendingPlan).not.toHaveBeenCalled();
    expect(e.replacePendingPlan).not.toHaveBeenCalled();
    expect(e.editPanel).not.toHaveBeenCalled();
  });

  test('bare re-mention (empty) nudges', async () => {
    const e = effects();
    const r = await runSlackPlanReply({ instruction: '', pending: pending(), effects: e });
    expect(r).toEqual({ kind: 'nudged' });
  });

  test('out-of-range structural command nudges with the specific reason', async () => {
    const e = effects();
    await runSlackPlanReply({ instruction: 'drop #9', pending: pending(), effects: e });
    const [body] = (e.postReply as jest.Mock).mock.calls[0];
    expect(body).toContain('#9');
  });
});

describe('runSlackPlanReply — effect failure', () => {
  test('a thrown effect is caught and reported as error (never throws out)', async () => {
    const e = effects({ seedApprovedPlan: jest.fn().mockRejectedValue(new Error('boom')) });
    const r = await runSlackPlanReply({ instruction: 'approve', pending: pending(), effects: e });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.message).toBe('boom');
  });
});
