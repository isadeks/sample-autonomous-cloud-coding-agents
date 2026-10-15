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
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: jest.fn(async () => 'ghp_test'),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:1:secret:gh';

import { handler } from '../../src/handlers/github-comment-task';
import { decideTrigger } from '../../src/handlers/shared/github-comment-trigger';

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

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });

describe('decideTrigger', () => {
  test('extracts the instruction without the mention', () => {
    const d = decideTrigger(payload());
    expect(d).toMatchObject({ ok: true, repo: 'o/r', prNumber: 7, commentId: 555, instruction: 'please resolve the merge conflicts with main' });
  });
  test('an empty instruction is not a trigger', () => {
    expect(decideTrigger(payload({ comment: { id: 1, body: '@bgagent', author_association: 'OWNER', user: {} } })))
      .toEqual({ ok: false, reason: 'empty_instruction' });
  });
  test('the mention must be a word, not an email-ish substring', () => {
    expect(decideTrigger(payload({ comment: { id: 1, body: 'mail x@bgagent.dev', author_association: 'OWNER', user: {} } })))
      .toEqual({ ok: false, reason: 'no_mention' });
  });
});

describe('github-comment-task handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    createTaskCore.mockReset();
    fetchMock.mockReset();
  });

  test('creates a pr-iteration task as the PR\'s originating user and acknowledges on the PR', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { state: 'open', head: { ref: `bgagent/${ORIGIN}/fix-stacks` } }))
      .mockResolvedValueOnce(json(201, {}));
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 201, body: '{}' });

    const out = await handler({ raw_body: JSON.stringify(payload()) });

    expect(out.status).toBe('created');
    const [body, ctx] = createTaskCore.mock.calls[0];
    expect(body).toMatchObject({ repo: 'o/r', workflow_ref: 'coding/pr-iteration-v1', pr_number: 7 });
    expect(body.task_description).toContain('please resolve the merge conflicts with main');
    expect(ctx).toMatchObject({ userId: 'user-1', channelSource: 'webhook', idempotencyKey: 'gh-pr-comment-555' });
    expect(ctx.channelMetadata.trigger).toBe('github_pr_comment');
    const ack = fetchMock.mock.calls[1];
    expect(ack[0]).toBe('https://api.github.com/repos/o/r/issues/7/comments');
    expect(JSON.parse(ack[1].body).body).toContain(out.task_id);
  });

  test('ignores PRs that are not ABCA branches', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { state: 'open', head: { ref: 'feature/mine' } }));
    expect((await handler({ raw_body: JSON.stringify(payload()) })).status).toBe('skipped:not_abca_pr');
    expect(createTaskCore).not.toHaveBeenCalled();
  });

  test('refuses when the branch task belongs to another repo', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { state: 'open', head: { ref: `bgagent/${ORIGIN}/x` } }));
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'other/repo' } });
    expect((await handler({ raw_body: JSON.stringify(payload()) })).status).toBe('skipped:no_origin_task');
    expect(createTaskCore).not.toHaveBeenCalled();
  });

  test('reports a rejected task (e.g. guardrail) on the PR', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { state: 'open', head: { ref: `bgagent/${ORIGIN}/x` } }))
      .mockResolvedValueOnce(json(201, {}));
    ddbSend.mockResolvedValueOnce({ Item: { task_id: ORIGIN, user_id: 'user-1', repo: 'o/r' } });
    createTaskCore.mockResolvedValueOnce({ statusCode: 400, body: '{}' });
    expect((await handler({ raw_body: JSON.stringify(payload()) })).status).toBe('create_failed:400');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).body).toContain('HTTP 400');
  });
});
