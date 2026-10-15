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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
const createTaskCore = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...a: unknown[]) => createTaskCore(...a),
}));
const resolveGitHubToken = jest.fn(async (_arn: string) => 'ghp_test');
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: (arn: string) => resolveGitHubToken(arn),
}));
const loadRepoConfig = jest.fn();
jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...a: unknown[]) => loadRepoConfig(...a),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:gh';

import { handler } from '../../src/handlers/github-comment-task';
import { addressableText, decideTrigger, type GitHubCommentTrigger } from '../../src/handlers/shared/github-comment-trigger';

const ORIGIN = '01M4YGVR62SHKJPEFZQN716HRP';
const payload = (o: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { number: 7, pull_request: {} },
  comment: {
    id: 555,
    body: '@bgagent please resolve the merge conflicts with main',
    author_association: 'COLLABORATOR',
    user: { login: 'sphia', type: 'User' },
    html_url: 'https://github.com/o/r/pull/7#c555',
  },
  repository: { full_name: 'o/r' },
  ...o,
});
const trigger = (o: Partial<GitHubCommentTrigger> = {}): GitHubCommentTrigger => ({
  kind: 'github_pr_comment',
  repo: 'o/r',
  prNumber: 7,
  instruction: 'please resolve the merge conflicts with main',
  commentId: 555,
  commentUrl: 'https://github.com/o/r/pull/7#c555',
  author: 'sphia',
  ...o,
});

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
const openAbcaPr = (o: Record<string, unknown> = {}) =>
  json(200, { state: 'open', head: { ref: `bgagent/${ORIGIN}/fix`, repo: { full_name: 'o/r' } }, ...o });

/** Route GitHub API calls by method + path; unmatched calls fail the test loudly. */
function github(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string, init: { method: string }) => {
    const key = `${init.method} ${url.replace('https://api.github.com', '')}`;
    if (!(key in routes)) throw new Error(`unexpected GitHub call ${key}`);
    return routes[key];
  });
}
const happyRoutes = (o: Record<string, unknown> = {}) => ({
  'GET /user': json(200, { login: 'abca-bot' }),
  'GET /repos/o/r/collaborators/sphia/permission': json(200, { permission: 'write', role_name: 'write' }),
  'GET /repos/o/r/pulls/7': openAbcaPr(),
  'POST /repos/o/r/issues/7/comments': json(201, {}),
  ...o,
});
const postedComments = () =>
  fetchMock.mock.calls.filter(([, init]) => init.method === 'POST').map(([, init]) => JSON.parse(init.body).body as string);

describe('decideTrigger', () => {
  test('extracts the instruction without the mention', () => {
    expect(decideTrigger(payload())).toMatchObject({
      ok: true,
      repo: 'o/r',
      prNumber: 7,
      commentId: 555,
      author: 'sphia',
      instruction: 'please resolve the merge conflicts with main',
    });
  });
  test('an empty instruction is not a trigger', () => {
    expect(decideTrigger(payload({ comment: { id: 1, body: '@bgagent', author_association: 'OWNER', user: { login: 'a' } } })))
      .toEqual({ ok: false, reason: 'empty_instruction' });
  });
  test('the mention must be a word, not an email-ish substring', () => {
    expect(decideTrigger(payload({ comment: { id: 1, body: 'mail x@bgagent.dev', author_association: 'OWNER', user: { login: 'a' } } })))
      .toEqual({ ok: false, reason: 'no_mention' });
  });
  test.each([
    ['a quoted earlier request', '> @bgagent do the thing\n\nthanks, looks good'],
    ['an inline code span', 'the trigger is `@bgagent <instruction>`'],
    ['a fenced block', '```\n@bgagent do it\n```'],
  ])('ignores a mention inside %s', (_label, body) => {
    expect(decideTrigger(payload({ comment: { id: 1, body, author_association: 'OWNER', user: { login: 'a' } } })))
      .toEqual({ ok: false, reason: 'no_mention' });
  });
  test('quoted text is dropped from the instruction', () => {
    expect(addressableText('> old @bgagent ask\n@bgagent new ask')).toBe('@bgagent new ask');
  });
});

describe('github-comment-task handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCore.mockReset();
    fetchMock.mockReset();
    loadRepoConfig.mockReset();
    loadRepoConfig.mockResolvedValue(null);
    resolveGitHubToken.mockClear();
  });

  test('creates a pr-iteration task as the PR\'s originating user and acknowledges on the PR', async () => {
    github(happyRoutes());
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 201, body: '{}' });

    const out = await handler(trigger());

    expect(out.status).toBe('created');
    const [body, ctx] = createTaskCore.mock.calls[0];
    expect(body).toMatchObject({ repo: 'o/r', workflow_ref: 'coding/pr-iteration-v1', pr_number: 7 });
    expect(body.task_description).toContain('please resolve the merge conflicts with main');
    expect(ctx).toMatchObject({ userId: 'user-1', channelSource: 'webhook', idempotencyKey: 'gh-pr-comment-555' });
    expect(ctx.channelMetadata.trigger).toBe('github_pr_comment');
    const [ack] = postedComments();
    expect(ack).toContain(out.task_id);
    expect(ack).toContain('owns this pull request\'s original task');
    expect(ack).not.toContain('CI/CD'); // the repo does not wait for CI
  });

  test('the ack promises the CI/CD wait only when the repo configures it', async () => {
    loadRepoConfig.mockResolvedValue({ ci_wait_timeout_s: 1800 });
    github(happyRoutes());
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 201, body: '{}' });
    await handler(trigger());
    expect(postedComments()[0]).toContain('wait for its CI/CD checks');
  });

  test('uses the repo\'s own GitHub token secret when it has one', async () => {
    loadRepoConfig.mockResolvedValue({ github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:1:secret:repo-token' });
    github(happyRoutes());
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 201, body: '{}' });
    await handler(trigger());
    expect(resolveGitHubToken).toHaveBeenCalledWith('arn:aws:secretsmanager:us-east-1:1:secret:repo-token');
  });

  test.each([
    ['read', 'read'],
    ['triage', 'read'],
  ])('refuses a commenter with %s access', async (role, permission) => {
    github(happyRoutes({ 'GET /repos/o/r/collaborators/sphia/permission': json(200, { permission, role_name: role }) }));
    expect((await handler(trigger())).status).toBe('skipped:insufficient_permission');
    expect(createTaskCore).not.toHaveBeenCalled();
    expect(postedComments()).toEqual([]);
  });

  test('refuses a commenter who is not a collaborator at all (404)', async () => {
    github(happyRoutes({ 'GET /repos/o/r/collaborators/sphia/permission': json(404, {}) }));
    expect((await handler(trigger())).status).toBe('skipped:insufficient_permission');
  });

  test('ignores comments posted with the platform\'s own token (no self-trigger loop)', async () => {
    resolveGitHubToken.mockResolvedValueOnce('ghp_other_token'); // not cached yet
    github(happyRoutes({ 'GET /user': json(200, { login: 'Sphia' }) }));
    expect((await handler(trigger({ author: 'sphia' }))).status).toBe('skipped:self_comment');
    expect(createTaskCore).not.toHaveBeenCalled();
  });

  test.each([
    ['a non-ABCA branch', { head: { ref: 'feature/mine', repo: { full_name: 'o/r' } } }],
    ['a fork named like an ABCA branch', { head: { ref: `bgagent/${ORIGIN}/x`, repo: { full_name: 'mallory/r' } } }],
    ['a deleted fork', { head: { ref: `bgagent/${ORIGIN}/x`, repo: null } }],
    ['a closed PR', { state: 'closed' }],
  ])('ignores %s', async (_label, override) => {
    github(happyRoutes({ 'GET /repos/o/r/pulls/7': openAbcaPr(override) }));
    expect((await handler(trigger())).status).toBe('skipped:not_abca_pr');
    expect(createTaskCore).not.toHaveBeenCalled();
  });

  test('refuses when the branch task belongs to another repo', async () => {
    github(happyRoutes());
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'other/repo' } });
    expect((await handler(trigger())).status).toBe('skipped:no_origin_task');
    expect(createTaskCore).not.toHaveBeenCalled();
  });

  test('an async-invoke retry replays the existing task without a second ack', async () => {
    github(happyRoutes());
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 200, body: '{}', headers: { 'Idempotent-Replay': 'true' } });
    expect((await handler(trigger())).status).toBe('replayed');
    expect(postedComments()).toEqual([]);
  });

  test('reports a rejected task (e.g. guardrail) on the PR', async () => {
    github(happyRoutes());
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 400, body: '{}' });
    expect((await handler(trigger())).status).toBe('create_failed:400');
    expect(postedComments()[0]).toContain('HTTP 400');
  });

  test('a failing permission lookup throws rather than guessing', async () => {
    github(happyRoutes({ 'GET /repos/o/r/collaborators/sphia/permission': json(502, {}) }));
    await expect(handler(trigger())).rejects.toThrow('permission lookup failed (HTTP 502)');
  });

  test('fails loudly without the platform token secret', async () => {
    const saved = process.env.GITHUB_TOKEN_SECRET_ARN;
    delete process.env.GITHUB_TOKEN_SECRET_ARN;
    try {
      await expect(handler(trigger())).rejects.toThrow('GITHUB_TOKEN_SECRET_ARN is not configured');
    } finally {
      process.env.GITHUB_TOKEN_SECRET_ARN = saved;
    }
  });
});
