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

import { validateDag } from '../../../src/handlers/shared/orchestration-dag';
import type { PlannedSubIssue } from '../../../src/handlers/shared/orchestration-decomposition-types';
import { planToDeclarativeGraph, slackPlanNodeId } from '../../../src/handlers/shared/slack-plan-graph';

function node(title: string, depends_on: number[] = []): PlannedSubIssue {
  return { title, description: `${title} scope`, size: 'M', max_budget_usd: 4, depends_on };
}

const REF = 'C123:1700000000.0001';

describe('slackPlanNodeId', () => {
  test('deterministic in (ref, index) with a padded position', () => {
    expect(slackPlanNodeId(REF, 0)).toBe(`slack-plan:${REF}#01`);
    expect(slackPlanNodeId(REF, 9)).toBe(`slack-plan:${REF}#10`);
    // Same inputs → same id (idempotent seed on redelivery).
    expect(slackPlanNodeId(REF, 2)).toBe(slackPlanNodeId(REF, 2));
  });
});

describe('planToDeclarativeGraph', () => {
  const plan: PlannedSubIssue[] = [node('API'), node('Careers'), node('Wire', [0, 1])];

  test('maps index deps to synthetic id deps, carrying title + description', () => {
    const graph = planToDeclarativeGraph(REF, plan);
    expect(graph.map((n) => n.id)).toEqual([
      slackPlanNodeId(REF, 0),
      slackPlanNodeId(REF, 1),
      slackPlanNodeId(REF, 2),
    ]);
    expect(graph[0].title).toBe('API');
    expect(graph[0].description).toBe('API scope');
    expect(graph[2].depends_on).toEqual([slackPlanNodeId(REF, 0), slackPlanNodeId(REF, 1)]);
  });

  test('the produced graph is a valid DAG the engine can seed', () => {
    const graph = planToDeclarativeGraph(REF, plan);
    const v = validateDag(graph);
    expect(v.ok).toBe(true);
  });

  test('drops out-of-range / self dependency indices defensively', () => {
    const bad: PlannedSubIssue[] = [node('A', [5, 0]), node('B', [1])];
    const graph = planToDeclarativeGraph(REF, bad);
    // #1's dep on out-of-range 5 and on itself (0) are dropped → root.
    expect(graph[0].depends_on).toEqual([]);
    // #2's dep on itself (1) is dropped → root.
    expect(graph[1].depends_on).toEqual([]);
  });

  test('is stable across calls — same plan yields identical node ids', () => {
    const a = planToDeclarativeGraph(REF, plan);
    const b = planToDeclarativeGraph(REF, plan);
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
  });
});
