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
 * which has verified the HMAC signature, applied the payload gate
 * (`decideTrigger`) and deduplicated the comment.
 *
 * Who may trigger, checked here against the GitHub API:
 * - the commenter must have write, maintain or admin permission on the
 *   repository (the receiver's author_association check is only a pre-filter);
 * - comments posted with the platform's own token are ignored, so the agent's
 *   replies can never start another task;
 * - only open PRs whose head is an ABCA branch `bgagent/<task_id>/...` in the
 *   same repository (not a fork), for a task on that repository.
 *
 * Identity: the iteration runs as the ABCA user who owns the original task —
 * GitHub logins are not mapped to ABCA users, so the commenter's write access
 * is what authorises spending that user's budget. A login-to-user mapping (as
 * the Jira and Linear channels have) would let the commenter's own identity be
 * used instead. The instruction is screened by createTaskCore's input guardrail
 * like any submitted task description.
 */

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { resolveGitHubToken } from './shared/context-hydration';
import { createTaskCore } from './shared/create-task-core';
import { ABCA_BRANCH, ABCA_COMMENT_TAG, type GitHubCommentTrigger } from './shared/github-comment-trigger';
import { logger } from './shared/logger';
import { loadRepoConfig } from './shared/repo-config';
import { makeDocClient } from './shared/ua';

const ddb = makeDocClient();
const TASK_TABLE_NAME = process.env.TASK_TABLE_NAME!;
const GITHUB_API_TIMEOUT_MS = 10_000;
/** Repository permissions that may start work on the repo's PRs. */
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export type CommentTriggerResult = { readonly status: string; readonly task_id?: string };

/** Login behind each token, cached for the Lambda's lifetime (a rotated token is looked up again). */

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
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
  });
}

async function reply(token: string, repo: string, prNumber: number, text: string): Promise<void> {
  const body = `${ABCA_COMMENT_TAG}\n${text}`;
  const res = await github(token, 'POST', `/repos/${repo}/issues/${prNumber}/comments`, { body });
  if (!res.ok) {
    logger.warn('PR comment trigger: reply failed', { repo, pr_number: prNumber, status: res.status });
  }
}

async function hasWriteAccess(token: string, repo: string, login: string): Promise<boolean> {
  const res = await github(token, 'GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`GitHub permission lookup failed (HTTP ${res.status})`);
  const json = (await res.json()) as { permission?: string; role_name?: string };
  return WRITE_PERMISSIONS.has(json.role_name ?? '') || WRITE_PERMISSIONS.has(json.permission ?? '');
}

/** Handler entry point (served by the webhook task Lambda; see webhook-create-task.ts). */
export async function handler(event: GitHubCommentTrigger): Promise<CommentTriggerResult> {
  const platformSecretArn = process.env.GITHUB_TOKEN_SECRET_ARN;
  if (!platformSecretArn) {
    throw new Error('GITHUB_TOKEN_SECRET_ARN is not configured for the PR-comment trigger');
  }
  const { repo, prNumber, instruction, commentId, commentUrl, author } = event;
  const repoConfig = await loadRepoConfig(repo);
  const secretArn = repoConfig?.github_token_secret_arn ?? platformSecretArn;
  const token = await resolveGitHubToken(secretArn);

  if (!await hasWriteAccess(token, repo, author)) {
    logger.info('PR comment trigger: commenter lacks write access', { repo, pr_number: prNumber, author });
    return { status: 'skipped:insufficient_permission' };
  }

  const pr = await github(token, 'GET', `/repos/${repo}/pulls/${prNumber}`);
  if (!pr.ok) {
    logger.warn('PR comment trigger: PR lookup failed', { repo, pr_number: prNumber, status: pr.status });
    return { status: 'pr_lookup_failed' };
  }
  const prJson = await pr.json() as { head?: { ref?: string; repo?: { full_name?: string } | null }; state?: string };
  const branchMatch = ABCA_BRANCH.exec(prJson.head?.ref ?? '');
  const sameRepo = prJson.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase();
  if (!branchMatch || !sameRepo || prJson.state !== 'open') {
    logger.info('PR comment trigger: not an open ABCA PR in this repository', { repo, pr_number: prNumber });
    return { status: 'skipped:not_abca_pr' };
  }
  const origin = await ddb.send(new GetCommand({ TableName: TASK_TABLE_NAME, Key: { task_id: branchMatch[1] } }));
  const originTask = origin.Item as { user_id?: string; repo?: string } | undefined;
  if (!originTask?.user_id || originTask.repo?.toLowerCase() !== repo.toLowerCase()) {
    logger.warn('PR comment trigger: originating task not found for branch', { repo, pr_number: prNumber });
    return { status: 'skipped:no_origin_task' };
  }

  const taskId = ulid();
  const idempotencyKey = `gh-pr-comment-${commentId}`;
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
      // a redelivery of the same comment must not start a second task
      idempotencyKey,
    },
    idempotencyKey,
  );
  if (result.statusCode === 200 && result.headers?.['Idempotent-Replay'] === 'true') {
    // An async-invoke retry of a comment that already created its task (and its ack).
    return { status: 'replayed' };
  }
  if (result.statusCode !== 201) {
    logger.warn('PR comment trigger: task not created', { repo, pr_number: prNumber, status: result.statusCode });
    await reply(token, repo, prNumber, `ABCA could not start a task for [this comment](${commentUrl}) (HTTP ${result.statusCode}).`);
    return { status: `create_failed:${result.statusCode}` };
  }
  const waits = repoConfig?.ci_wait_timeout_s
    ? ' It will push to this PR and wait for its CI/CD checks before finishing.'
    : ' It will push to this PR.';
  await reply(
    token,
    repo,
    prNumber,
    `🤖 ABCA picked up [this request](${commentUrl}) as task \`${taskId}\` (PR iteration), `
      + `running as the ABCA user who owns this pull request's original task.${waits}`,
  );
  logger.info('PR comment trigger: pr-iteration task created', { repo, pr_number: prNumber, task_id: taskId });
  return { status: 'created', task_id: taskId };
}
