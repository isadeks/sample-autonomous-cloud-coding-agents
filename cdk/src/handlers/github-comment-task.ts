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
 * GitHub PR-comment trigger: `@bgagent <instruction>` on one of ABCA's own pull
 * requests starts a `coding/pr-iteration-v1` task on that PR.
 *
 * Invoked asynchronously by the GitHub webhook receiver (`github-webhook.ts`),
 * which has already verified the HMAC signature and deduplicated the delivery.
 *
 * Guardrails on who and what:
 * - only `issue_comment` `created` events on a pull request whose body mentions
 *   `@bgagent`, from a non-bot author with write-level association
 *   (OWNER / MEMBER / COLLABORATOR);
 * - only PRs whose head branch is an ABCA branch `bgagent/<task_id>/...` of a
 *   task on the same repo — the iteration runs as THAT task's user, so the
 *   comment cannot spend some other user's budget;
 * - the instruction is screened by createTaskCore's input guardrail like any
 *   submitted task description.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { resolveGitHubToken } from './shared/context-hydration';
import { createTaskCore } from './shared/create-task-core';
import { ABCA_BRANCH, decideTrigger, type GitHubCommentEvent, type IssueCommentPayload } from './shared/github-comment-trigger';
import { logger } from './shared/logger';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN ?? '';

async function github(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'abca-pr-comment-trigger',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** Lambda entry point (async invoke from the GitHub webhook receiver). */
export async function handler(event: GitHubCommentEvent): Promise<{ status: string; task_id?: string }> {
  let payload: IssueCommentPayload;
  try {
    payload = JSON.parse(event.raw_body) as IssueCommentPayload;
  } catch {
    return { status: 'invalid_json' };
  }
  const decision = decideTrigger(payload);
  if (!decision.ok) {
    logger.info('PR comment not a trigger', { reason: decision.reason });
    return { status: `skipped:${decision.reason}` };
  }
  const { repo, prNumber, instruction, commentId, commentUrl, author } = decision;
  const token = await resolveGitHubToken(GITHUB_TOKEN_SECRET_ARN);

  const pr = await github(token, 'GET', `/repos/${repo}/pulls/${prNumber}`);
  if (!pr.ok) {
    logger.warn('PR comment trigger: PR lookup failed', { repo, pr_number: prNumber, status: pr.status });
    return { status: 'pr_lookup_failed' };
  }
  const prJson = await pr.json() as { head?: { ref?: string }; state?: string };
  const branchMatch = ABCA_BRANCH.exec(prJson.head?.ref ?? '');
  if (!branchMatch || prJson.state !== 'open') {
    logger.info('PR comment trigger: not an open ABCA PR', { repo, pr_number: prNumber });
    return { status: 'skipped:not_abca_pr' };
  }
  const origin = await ddb.send(new GetCommand({ TableName: TASK_TABLE_NAME, Key: { task_id: branchMatch[1] } }));
  const originTask = origin.Item as { user_id?: string; repo?: string } | undefined;
  if (!originTask?.user_id || originTask.repo?.toLowerCase() !== repo.toLowerCase()) {
    logger.warn('PR comment trigger: originating task not found for branch', { repo, pr_number: prNumber });
    return { status: 'skipped:no_origin_task' };
  }

  const taskId = ulid();
  const result = await createTaskCore(
    {
      repo,
      workflow_ref: 'coding/pr-iteration-v1',
      pr_number: prNumber,
      task_description: `Request from @${author} in a pull request comment (${commentUrl}):\n\n${instruction}`,
    },
    {
      userId: originTask.user_id,
      channelSource: 'webhook',
      channelMetadata: {
        trigger: 'github_pr_comment',
        github_comment_id: String(commentId),
        github_comment_url: commentUrl,
        github_comment_author: author,
      },
      taskId,
      // a webhook redelivery of the same comment must not start a second task
      idempotencyKey: `gh-pr-comment-${commentId}`,
    },
    `gh-pr-comment-${commentId}`,
  );
  if (result.statusCode !== 201) {
    logger.warn('PR comment trigger: task not created', { repo, pr_number: prNumber, status: result.statusCode });
    await github(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, {
      body: `ABCA could not start a task for [this comment](${commentUrl}) (HTTP ${result.statusCode}).`,
    });
    return { status: `create_failed:${result.statusCode}` };
  }
  await github(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, {
    body: `🤖 ABCA picked up [this request](${commentUrl}) as task \`${taskId}\` (PR iteration). `
      + 'It will push to this PR and wait for CI/CD before finishing.',
  });
  logger.info('PR comment trigger: pr-iteration task created', { repo, pr_number: prNumber, task_id: taskId });
  return { status: 'created', task_id: taskId };
}
