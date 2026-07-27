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
import { classifySlackPlanReply } from '../../../src/handlers/shared/slack-plan-reply';

function node(title: string, depends_on: number[] = [], size: 'S' | 'M' | 'L' = 'M'): PlannedSubIssue {
  return { title, description: `${title} scope`, size, max_budget_usd: 4, depends_on };
}

/** A 3-piece plan: two roots + one dependent. */
const PLAN: PlannedSubIssue[] = [
  node('API layer'),
  node('Careers page'),
  node('Wire it up', [0, 1]),
];

describe('classifySlackPlanReply — approvals (delegates to parsePlanVerdict)', () => {
  test.each(['approve', 'Approved!', 'lgtm', 'yes', 'looks good', 'ship it', '👍', 'sounds good'])(
    'natural approval %p → approve',
    (text) => {
      expect(classifySlackPlanReply(text, PLAN)).toEqual({ kind: 'approve' });
    },
  );
});

describe('classifySlackPlanReply — rejections', () => {
  test.each(['cancel', 'reject', 'discard', 'stop', '👎', 'abort it'])(
    'explicit discard %p → reject',
    (text) => {
      expect(classifySlackPlanReply(text, PLAN)).toEqual({ kind: 'reject' });
    },
  );
});

describe('classifySlackPlanReply — structural revises (delegates to parsePlanCommand)', () => {
  test('drop #3 → revised, node removed', () => {
    const r = classifySlackPlanReply('drop #3', PLAN);
    expect(r.kind).toBe('revised');
    if (r.kind === 'revised') {
      expect(r.nodes.map((n) => n.title)).toEqual(['API layer', 'Careers page']);
      expect(r.summary).toContain('#3');
    }
  });

  test('merge 1 and 2 → revised, two folded into one', () => {
    const r = classifySlackPlanReply('merge 1 and 2', PLAN);
    expect(r.kind).toBe('revised');
    if (r.kind === 'revised') {
      expect(r.nodes).toHaveLength(2);
      expect(r.nodes[0].title).toBe('API layer + Careers page');
      expect(r.summary).toContain('Merged');
    }
  });

  test('make #2 small → revised, resized (not dropped/merged)', () => {
    const r = classifySlackPlanReply('make #2 small', PLAN);
    expect(r.kind).toBe('revised');
    if (r.kind === 'revised') {
      expect(r.nodes).toHaveLength(3);
      expect(r.nodes[1].size).toBe('S');
      expect(r.summary).toContain('#2');
    }
  });
});

describe('classifySlackPlanReply — nudges (never guess-and-destroy)', () => {
  test('empty reply (bare re-mention) → nudge', () => {
    expect(classifySlackPlanReply('', PLAN)).toEqual({ kind: 'nudge' });
    expect(classifySlackPlanReply('   ', PLAN)).toEqual({ kind: 'nudge' });
  });

  test('ambiguous soft negation "no" → nudge (not reject)', () => {
    expect(classifySlackPlanReply('no', PLAN)).toEqual({ kind: 'nudge' });
    expect(classifySlackPlanReply('no thanks', PLAN)).toEqual({ kind: 'nudge' });
  });

  test('semantic re-plan we cannot apply deterministically → nudge', () => {
    // "make it simpler" is a change verb with no (index, size) pair — parsePlanCommand
    // returns null, so we nudge rather than silently no-op.
    expect(classifySlackPlanReply('make it simpler', PLAN)).toEqual({ kind: 'nudge' });
    expect(classifySlackPlanReply('split the API work into two', PLAN)).toEqual({ kind: 'nudge' });
  });

  test('out-of-range structural command → nudge with the specific reason', () => {
    const r = classifySlackPlanReply('drop #9', PLAN);
    expect(r.kind).toBe('nudge');
    if (r.kind === 'nudge') expect(r.detail).toContain('#9');
  });

  test('a change that collapses to one piece → nudge (plan kept)', () => {
    // Dropping two of three leaves one → nothing to orchestrate.
    const r = classifySlackPlanReply('drop 2 and 3', PLAN);
    expect(r.kind).toBe('nudge');
    if (r.kind === 'nudge') expect(r.detail).toContain('one piece');
  });

  test('soft negation carrying a numeric-count directive is NOT approved', () => {
    // "no, just 2 tasks" — parsePlanVerdict routes this to 'none' (revise). It is
    // not a structural command grammar, so Slack nudges rather than guessing.
    expect(classifySlackPlanReply('no, just 2 tasks', PLAN)).toEqual({ kind: 'nudge' });
  });

  test('approve word paired with a change qualifier is NOT a clean approve', () => {
    // "yes, but smaller" → parsePlanVerdict returns 'none'; no structural grammar → nudge.
    expect(classifySlackPlanReply('yes, but smaller', PLAN)).toEqual({ kind: 'nudge' });
  });
});
