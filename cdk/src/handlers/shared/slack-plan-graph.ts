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
 * ABCA-1016 — map an approved Slack plan to the declarative orchestration graph.
 *
 * On Linear a Mode-B plan is written back to real sub-issues, whose Linear ids
 * become the {@link SubIssueNode} ids the executor seeds
 * (orchestration-decomposition-writeback.ts). Slack has no issue object to write
 * back to — a Slack thread IS the "issue" — so there are no external ids to
 * borrow. Instead we mint STABLE SYNTHETIC ids from the parent thread ref, so the
 * SAME approved plan produces the SAME node ids on a redelivery, keeping the
 * orchestration seed idempotent (``deriveOrchestrationId`` + ``seedOrchestration``
 * are frozen-at-first-seed; stable child ids mean a replay finds the same graph).
 *
 * This is the Slack analogue of write-back, minus the create-issues I/O: a pure
 * translation from the plan's INDEX-based ``depends_on`` to the ID-based
 * ``depends_on`` ``declarativeGraphSource`` + ``validateDag`` expect. The engine's
 * validate → seed → release → reconcile → rollup pipeline downstream is identical
 * to every other surface — that reuse is the whole point of the graph-source seam.
 */

import type { SubIssueNode } from './linear-subissue-fetch';
import type { PlannedSubIssue } from './orchestration-decomposition-types';

/** Fixed-width position so ``slack-<thread>-n01`` sorts/reads predictably even
 *  past 9 nodes (the plan cap is small, so 2 digits is ample). */
function positionSuffix(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/**
 * Build a stable synthetic node id for the ``i``th plan node under a parent ref.
 * Deterministic in (parentRef, index): a redelivery of the same approved plan
 * mints identical ids, so the seed stays idempotent. Exported so a caller/test can
 * assert the id scheme without reaching into the mapper.
 */
export function slackPlanNodeId(parentRef: string, index: number): string {
  return `slack-plan:${parentRef}#${positionSuffix(index)}`;
}

/**
 * Translate an approved plan's {@link PlannedSubIssue}s (index-based ``depends_on``)
 * into the {@link SubIssueNode}s the declarative graph source seeds (id-based
 * ``depends_on``). PURE. Each node's title/description ride along so the released
 * child task gets the scope the reviewer approved (the same reason the Linear
 * seed path threads ``description`` onto the child — PM-4).
 *
 * ``depends_on`` indices that fall outside the plan are dropped defensively;
 * ``validateDag`` downstream is the real guard against a malformed graph, but a
 * dangling index here would just point at a non-existent id and be rejected, so we
 * drop it and let a genuine structural problem surface as a validation error.
 */
export function planToDeclarativeGraph(
  parentRef: string,
  nodes: readonly PlannedSubIssue[],
): SubIssueNode[] {
  const ids = nodes.map((_, i) => slackPlanNodeId(parentRef, i));
  return nodes.map((node, i) => ({
    id: ids[i],
    title: node.title,
    ...(node.description !== undefined && { description: node.description }),
    depends_on: [...node.depends_on]
      .filter((d) => Number.isInteger(d) && d >= 0 && d < nodes.length && d !== i)
      .map((d) => ids[d]),
  }));
}
