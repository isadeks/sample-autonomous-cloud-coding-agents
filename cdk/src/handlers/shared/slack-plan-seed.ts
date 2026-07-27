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
 * ABCA-1016 — seed the multi-step orchestration from an approved Slack plan, and
 * post the live epic panel via the SAME Slack channel adapter the engine uses for
 * every other surface.
 *
 * This is the Slack analogue of the reconciler's ``seedDecomposedGraph`` (Linear
 * :auto/approve path): map the approved plan → a declarative graph, run the shared
 * ``discoverOrchestration`` → ``releaseReadyChildren`` → ``upsertEpicPanel``
 * pipeline, and stamp ``channel_source: 'slack'`` on the release context so the
 * reconciler drives the ROLLUP back to Slack too. It is the first REAL Slack
 * submission through the orchestration engine's Slack adapter (which until now was
 * only exercised by tests) — exactly what the sub-issue asks for.
 *
 * The AWS boundaries (ddb, createTaskCore, the channel) are injected, so the seed
 * decision is unit-testable without live DynamoDB / Slack.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { type Channel } from './orchestration-channel';
import { makeSlackChannel, slackThreadRef } from './orchestration-channel-slack';
import type { PlannedSubIssue } from './orchestration-decomposition-types';
import { discoverOrchestration } from './orchestration-discovery';
import { declarativeGraphSource } from './orchestration-graph-source';
import { readConcurrencyBudget, releaseReadyChildren } from './orchestration-release';
import { upsertEpicPanel } from './orchestration-rollup';
import {
  loadOrchestration,
  type OrchestrationReleaseContext,
  setStatusCommentId,
} from './orchestration-store';
import { planToDeclarativeGraph } from './slack-plan-graph';

/** Injected dependencies + inputs for a Slack plan seed. */
export interface SeedSlackPlanParams {
  readonly ddb: DynamoDBDocumentClient;
  readonly orchestrationTable: string;
  /** Per-user concurrency table (throttles the initial root release). Optional. */
  readonly userConcurrencyTable?: string;
  /** Per-user max concurrent child tasks (the release budget ceiling). */
  readonly maxConcurrent: number;
  /** The shared create-task entrypoint each released child runs through. */
  readonly createTaskCore: Parameters<typeof releaseReadyChildren>[4];
  /** The approved plan pieces. */
  readonly nodes: readonly PlannedSubIssue[];
  readonly repo: string;
  readonly platformUserId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
  /**
   * The channel adapter to drive. Defaults to the in-tree Slack adapter; injectable
   * so a test can pass a fake without a live Slack token. This is where the "drive
   * the orchestration engine's already-existing Slack adapter" ask is realised.
   */
  readonly channel?: Channel;
}

/**
 * Seed + release + panel. Returns true when an orchestration was seeded (the
 * approve path can then freeze its panel), false when discovery declined (a
 * degenerate/empty graph — nothing to orchestrate). Never throws.
 */
export async function seedSlackApprovedPlan(params: SeedSlackPlanParams): Promise<boolean> {
  const {
    ddb, orchestrationTable, userConcurrencyTable, maxConcurrent, createTaskCore,
    nodes, repo, platformUserId, teamId, channelId, threadTs,
  } = params;

  // The Slack "issue" is the thread; its ref is <channel>:<thread_ts>, composed the
  // SAME way the adapter parses it (slackThreadRef) so panel edits land on it.
  const parentRef = slackThreadRef(channelId, threadTs);
  const children = planToDeclarativeGraph(parentRef, nodes);
  if (children.length === 0) return false;

  const releaseContext: OrchestrationReleaseContext = {
    platform_user_id: platformUserId,
    // Stamp Slack so the reconciler drives release + rollup back to this thread.
    channel_source: 'slack',
  };

  let discovery;
  try {
    discovery = await discoverOrchestration({
      ddb,
      tableName: orchestrationTable,
      parentIssueRef: parentRef,
      credentialsRef: teamId, // the workspace team_id keys the bot-token secret
      repo,
      now: new Date().toISOString(),
      releaseContext,
      graphSource: declarativeGraphSource(children),
    });
  } catch (err) {
    logger.error('Slack plan seed: discovery threw', {
      thread_ref: parentRef, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (discovery.kind !== 'seeded') {
    logger.info('Slack plan seed: discovery non-seeded', { thread_ref: parentRef, kind: discovery.kind });
    return false;
  }

  // Release the root pieces (throttled by the user's free concurrency budget).
  const snapshot = await loadOrchestration(ddb, orchestrationTable, discovery.orchestrationId);
  if (snapshot) {
    const budget = userConcurrencyTable
      ? await readConcurrencyBudget(ddb, userConcurrencyTable, platformUserId, maxConcurrent)
      : undefined;
    try {
      await releaseReadyChildren(
        ddb, orchestrationTable, snapshot.children, snapshot.meta.release_context,
        createTaskCore, new Date().toISOString(), snapshot.children, 'main', budget,
      );
    } catch (err) {
      logger.error('Slack plan seed: releasing roots failed (reconciler will retry)', {
        thread_ref: parentRef, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Post the live epic panel via the Slack adapter — the multi-step progress
  // surface for this thread. Best-effort: a Slack hiccup never strands the seed.
  const channel = params.channel ?? makeSlackChannel();
  try {
    const fresh = await loadOrchestration(ddb, orchestrationTable, discovery.orchestrationId);
    if (fresh) {
      const commentId = await upsertEpicPanel({
        channel,
        parent: { issueId: parentRef, credentialsRef: teamId },
        children: fresh.children,
        inProgress: true,
        // Slack has no workflow state / issue reaction to mirror, and the adapter
        // omits those ops, so keep the panel purely a comment upsert.
        mirrorParentState: false,
      });
      if (commentId) {
        await setStatusCommentId(ddb, orchestrationTable, discovery.orchestrationId, commentId);
      }
    }
  } catch (err) {
    logger.warn('Slack plan seed: epic panel post failed (non-fatal)', {
      thread_ref: parentRef, error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('Slack plan approved — orchestration seeded from plan', {
    thread_ref: parentRef,
    orchestration_id: discovery.orchestrationId,
    child_count: discovery.childCount,
  });
  return true;
}
