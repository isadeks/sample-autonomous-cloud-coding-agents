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
  renderSlackPlanApproved,
  renderSlackPlanDiscarded,
  renderSlackPlanNudge,
  renderSlackPlanProposal,
} from '../../../src/handlers/shared/slack-plan-panel';

function node(title: string, depends_on: number[] = [], size: 'S' | 'M' | 'L' = 'M', budget = 4): PlannedSubIssue {
  return { title, description: `${title} scope`, size, max_budget_usd: budget, depends_on };
}

const PLAN: PlannedSubIssue[] = [
  node('API layer', [], 'L', 8),
  node('Careers page', [], 'S', 2),
  node('Wire it up', [0, 1], 'M', 4),
];

describe('renderSlackPlanProposal', () => {
  test('proposed state: header, numbered pieces, deps, cost ceiling, action footer', () => {
    const out = renderSlackPlanProposal(PLAN);
    expect(out).toContain('*Proposed plan* — 3 pieces');
    expect(out).toContain('1. *API layer* `L`');
    expect(out).toContain('2. *Careers page* `S`');
    expect(out).toContain('3. *Wire it up* `M` _(after #1, #2)_');
    // Σ budget = 8 + 2 + 4 = 14.
    expect(out).toContain('$14');
    expect(out).toContain('approve');
    expect(out).toContain('cancel');
    expect(out).toContain('drop #3');
  });

  test('revised state: header flips to "Updated plan" and shows the change summary', () => {
    const out = renderSlackPlanProposal(PLAN.slice(0, 2), { changeSummary: 'Dropped #3 — now 2 pieces.' });
    expect(out).toContain('*Updated plan* — 2 pieces');
    expect(out).toContain('*What changed:* Dropped #3 — now 2 pieces.');
  });

  test('sequencing copy reflects the critical path (all-parallel vs chain)', () => {
    const allRoots = [node('a'), node('b')];
    expect(renderSlackPlanProposal(allRoots)).toContain('they can all run at the same time');
    const chain = [node('a'), node('b', [0])];
    expect(renderSlackPlanProposal(chain)).toContain('they run one after another');
  });
});

describe('renderSlackPlanApproved / Discarded / Nudge (maturing states)', () => {
  test('approved reference lists the agreed pieces and drops the action footer', () => {
    const out = renderSlackPlanApproved(PLAN);
    expect(out).toContain('*Approved plan* — 3 pieces');
    expect(out).toContain('1. *API layer*');
    expect(out).not.toContain('cancel');
    expect(out).toContain('progress');
  });

  test('discarded reference is a one-liner, nothing ran', () => {
    expect(renderSlackPlanDiscarded()).toContain('Plan discarded');
    expect(renderSlackPlanDiscarded()).toContain('nothing ran');
  });

  test('nudge without detail prompts the three choices', () => {
    const out = renderSlackPlanNudge();
    expect(out).toContain('approve');
    expect(out).toContain('cancel');
    expect(out).toContain('what to change');
  });

  test('nudge with a detail leads with the specific reason (punctuation added)', () => {
    const out = renderSlackPlanNudge("There's no piece #9 — the plan has 3");
    expect(out).toContain('#9');
    expect(out).toContain('.'); // ensured terminating punctuation before the choices
    expect(out).toContain('approve');
  });
});
