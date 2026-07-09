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

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-I';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';
process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME = 'CommandProcessorFn';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-interactions';

const SIGNING_SECRET = 'test-signing';

function sign(body: string, ts: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex');
}

function makeInteractionEvent(payload: object): APIGatewayProxyEvent {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    body,
    headers: {
      'X-Slack-Signature': sign(body, ts),
      'X-Slack-Request-Timestamp': ts,
    },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/interactions',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function interactionPayload(actionId: string, userId = 'U1', teamId = 'T1'): object {
  return {
    type: 'block_actions',
    user: { id: userId, username: 'u', team_id: teamId },
    response_url: 'https://hooks.slack.com/response/xyz',
    trigger_id: 't.1',
    actions: [{ action_id: actionId, block_id: 'task-123' }],
    channel: { id: 'C1' },
  };
}

function isSlackHooksRequestUrl(url: unknown): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

describe('slack-interactions handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    lambdaSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    smSend.mockResolvedValue({ SecretString: SIGNING_SECRET });
    lambdaSend.mockResolvedValue({});
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });

  test('rejects invalid signature with 401', async () => {
    const body = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
    const ts = String(Math.floor(Date.now() / 1000));
    const event: APIGatewayProxyEvent = {
      body,
      headers: { 'X-Slack-Signature': 'v0=000', 'X-Slack-Request-Timestamp': ts },
      multiValueHeaders: {},
      httpMethod: 'POST',
      isBase64Encoded: false,
      path: '/v1/slack/interactions',
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      stageVariables: null,
      requestContext: {} as APIGatewayProxyEvent['requestContext'],
      resource: '',
    };
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('cancel_task transitions owned task to CANCELLED', async () => {
    // 1. user mapping lookup → platform user id
    ddbSend.mockResolvedValueOnce({ Item: { platform_user_id: 'user-42' } });
    // 2. task lookup → same owner
    ddbSend.mockResolvedValueOnce({ Item: { task_id: 'task-42', user_id: 'user-42', channel_metadata: {} } });
    // 3. update → success
    ddbSend.mockResolvedValueOnce({});

    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42', 'U1', 'T1'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const updateCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Update');
    expect(updateCall).toBeTruthy();
    expect(updateCall![0].input.ExpressionAttributeValues[':cancelled']).toBe('CANCELLED');
  });

  test('cancel_task rejects when caller is not task owner', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { platform_user_id: 'attacker' } });
    ddbSend.mockResolvedValueOnce({ Item: { task_id: 'task-42', user_id: 'user-42' } });

    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    // No update attempted
    const updateCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Update');
    expect(updateCall).toBeFalsy();
    // Posted to response_url with "own your own tasks"
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('your own tasks'),
    );
    expect(posted).toBeTruthy();
  });

  test('cancel_task on already-terminal task warns the user', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { platform_user_id: 'user-42' } });
    ddbSend.mockResolvedValueOnce({ Item: { task_id: 'task-42', user_id: 'user-42' } });
    // ConditionalCheckFailedException => already in terminal state
    const err = new Error('conditional failed');
    err.name = 'ConditionalCheckFailedException';
    ddbSend.mockRejectedValueOnce(err);

    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('terminal state'),
    );
    expect(posted).toBeTruthy();
  });

  test('unknown action_id is ignored silently', async () => {
    const event = makeInteractionEvent(interactionPayload('other_action:xyz'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    expect(ddbSend).not.toHaveBeenCalled();
  });

  test('unlinked account receives :link: message instead of cancel', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'pending' } });
    const event = makeInteractionEvent(interactionPayload('cancel_task:task-42'));
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('not linked'),
    );
    expect(posted).toBeTruthy();
  });

  describe('repo picker (pick_repo)', () => {
    const pendingRow = {
      channel_id: 'pending#tok1',
      kind: 'repo_pick',
      description: 'fix the auth bug',
      team_id: 'T1',
      slack_channel_id: 'C1',
      user_id: 'U1',
      thread_ts: '1000.1',
      ttl: Math.floor(Date.now() / 1000) + 600,
    };

    function repoPickPayload(actionId: string, value: string, userId = 'U1'): object {
      return {
        type: 'block_actions',
        user: { id: userId, username: 'u', team_id: 'T1' },
        response_url: 'https://hooks.slack.com/response/xyz',
        trigger_id: 't.1',
        actions: [{ action_id: actionId, block_id: 'tok1', value }],
        channel: { id: 'C1' },
      };
    }

    test('button click forwards an explicit-repo submit to the command processor', async () => {
      // getPendingRepoPick
      ddbSend.mockResolvedValueOnce({ Item: pendingRow });
      // deletePendingRepoPick
      ddbSend.mockResolvedValueOnce({});

      const event = makeInteractionEvent(repoPickPayload('pick_repo:tok1#org/a', 'org/a'));
      const result = await handler(event);
      expect(result.statusCode).toBe(200);

      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const invoke = lambdaSend.mock.calls[0][0];
      expect(invoke.input.FunctionName).toBe('CommandProcessorFn');
      const forwarded = JSON.parse(new TextDecoder().decode(invoke.input.Payload));
      expect(forwarded.source).toBe('mention');
      expect(forwarded.text).toBe('submit org/a fix the auth bug');
      expect(forwarded.user_id).toBe('U1');
      expect(forwarded.mention_thread_ts).toBe('1000.1');
    });

    test('static_select choice reads the repo from selected_option', async () => {
      ddbSend.mockResolvedValueOnce({ Item: pendingRow });
      ddbSend.mockResolvedValueOnce({});

      const payload = {
        type: 'block_actions',
        user: { id: 'U1', username: 'u', team_id: 'T1' },
        response_url: 'https://hooks.slack.com/response/xyz',
        trigger_id: 't.1',
        actions: [{ action_id: 'pick_repo:tok1', block_id: 'tok1', selected_option: { value: 'org/b' } }],
        channel: { id: 'C1' },
      };
      const event = makeInteractionEvent(payload);
      await handler(event);

      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const forwarded = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
      expect(forwarded.text).toBe('submit org/b fix the auth bug');
    });

    test('expired / missing pending pick warns the user and does not submit', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      const event = makeInteractionEvent(repoPickPayload('pick_repo:tok1#org/a', 'org/a'));
      await handler(event);
      expect(lambdaSend).not.toHaveBeenCalled();
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes('expired'),
      );
      expect(posted).toBeTruthy();
    });

    test('a different user cannot resolve someone else\'s picker', async () => {
      ddbSend.mockResolvedValueOnce({ Item: pendingRow });
      const event = makeInteractionEvent(repoPickPayload('pick_repo:tok1#org/a', 'org/a', 'U2'));
      await handler(event);
      expect(lambdaSend).not.toHaveBeenCalled();
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes('Only the person who asked'),
      );
      expect(posted).toBeTruthy();
    });
  });
});
