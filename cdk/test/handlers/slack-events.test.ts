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

// --- Mocks ---
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
  ScanCommand: jest.fn((input: unknown) => ({ _type: 'Scan', input })),
}));

const lambdaSend = jest.fn();
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn(() => ({ send: lambdaSend })),
  InvokeCommand: jest.fn((input: unknown) => ({ _type: 'Invoke', input })),
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
  DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_SIGNING_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123:secret:bgagent/slack/signing-XYZ';
process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME = 'cmd-processor';
process.env.TASK_TABLE_NAME = 'TaskTable';

import { invalidateSlackSecretCache } from '../../src/handlers/shared/slack-verify';
import { handler } from '../../src/handlers/slack-events';

const SIGNING_SECRET = 'test-signing-secret';

function sign(body: string, timestamp: string): string {
  return 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex');
}

function currentTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeEvent(body: string, headers: Record<string, string> = {}): APIGatewayProxyEvent {
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/v1/slack/events',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

function signedEvent(body: string, retryNum?: string): APIGatewayProxyEvent {
  const ts = currentTs();
  const headers: Record<string, string> = {
    'X-Slack-Signature': sign(body, ts),
    'X-Slack-Request-Timestamp': ts,
  };
  if (retryNum) headers['X-Slack-Retry-Num'] = retryNum;
  return makeEvent(body, headers);
}

describe('slack-events handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    lambdaSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    // Default: signing secret fetched on demand
    smSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetSecretValue') return Promise.resolve({ SecretString: SIGNING_SECRET });
      return Promise.resolve({});
    });
  });

  test('400s when body is missing', async () => {
    const event = makeEvent(null as unknown as string);
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('answers url_verification challenge with valid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ challenge: 'abc123' });
  });

  test('rejects url_verification with invalid signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const ts = currentTs();
    const event = makeEvent(body, {
      'X-Slack-Signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
      'X-Slack-Request-Timestamp': ts,
    });
    const result = await handler(event);
    expect(result.statusCode).toBe(401);
  });

  test('answers url_verification during initial setup when signing secret missing', async () => {
    smSend.mockImplementation(() => Promise.resolve({ SecretString: undefined }));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'url_verification', challenge: 'initial' });
    // No signature provided — pre-setup flow
    const result = await handler(makeEvent(body, {}));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ challenge: 'initial' });
  });

  test('rejects non-url_verification when signing secret missing', async () => {
    smSend.mockImplementation(() => Promise.resolve({ SecretString: undefined }));
    invalidateSlackSecretCache(process.env.SLACK_SIGNING_SECRET_ARN!);
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });
    const result = await handler(makeEvent(body, {}));
    expect(result.statusCode).toBe(500);
  });

  test('drops non-critical retries without reprocessing', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> hi', ts: '1.0' },
    });
    const result = await handler(signedEvent(body, '1'));
    expect(result.statusCode).toBe(200);
    // No lambda invocation because the retry is short-circuited
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  test('reprocesses retries for app_uninstalled (security-critical)', async () => {
    ddbSend.mockResolvedValueOnce({}); // UpdateCommand
    smSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === 'GetSecretValue') return Promise.resolve({ SecretString: SIGNING_SECRET });
      if (cmd._type === 'DeleteSecret') return Promise.resolve({});
      return Promise.resolve({});
    });
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_revoke',
      event: { type: 'app_uninstalled' },
    });
    const result = await handler(signedEvent(body, '2'));
    expect(result.statusCode).toBe(200);
    // DDB was updated (status→revoked) even though this is a retry
    expect(ddbSend).toHaveBeenCalledTimes(1);
    // And the secret deletion happened
    const deleteCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'DeleteSecret');
    expect(deleteCalled).toBe(true);
  });

  test('does not delete bot token if DDB revocation update failed', async () => {
    ddbSend.mockRejectedValueOnce(new Error('ddb throttle'));
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_revoke',
      event: { type: 'tokens_revoked' },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(500);
    // Critical invariant: don't delete secret if install is still "active" in DDB
    const deleteCalled = smSend.mock.calls.some(([cmd]) => cmd._type === 'DeleteSecret');
    expect(deleteCalled).toBe(false);
  });

  test('forwards app_mention to command processor with :eyes: reaction', async () => {
    // First fetch is reactions.add for :eyes:, returns { ok: true }
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockResolvedValueOnce({});
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      // Bot token lookup
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix the bug in org/repo#42',
        ts: '1234.0001',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(payload.source).toBe('mention');
    expect(payload.text).toContain('submit');
    expect(payload.text).toContain('org/repo#42');
    expect(payload.channel_id).toBe('C1');
    // Reactions.add was called
    const reactionCall = fetchMock.mock.calls.find(([url]) => String(url).includes('reactions.add'));
    expect(reactionCall).toBeTruthy();
  });

  test('app_mention without repo is forwarded to the processor (channel-default fallback)', async () => {
    // The events handler no longer answers no-repo mentions inline — it forwards
    // them so the processor can apply the channel's onboarded default repo (and,
    // only if there is none, reply with guidance). The whole text is forwarded
    // as the submit description.
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: { type: 'app_mention', user: 'U1', channel: 'C1', text: '<@BOT> just a question', ts: '1.0' },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    // Forwarded to the processor rather than answered inline.
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const invokePayload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(invokePayload.text).toBe('submit just a question');
    // No inline "Please include a repo" reply from the events handler.
    const postedReply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(postedReply).toBeFalsy();
  });

  test('app_mention with keyword prefix "decompose:" is forwarded verbatim (no repo reorder)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> decompose: plan the auth refactor in org/repo',
        ts: '1.0',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    // Must contain "decompose:" so the processor's parseWorkflowPrefix can extract it
    expect(payload.text).toContain('decompose:');
    expect(payload.text).toContain('org/repo');
  });

  test('app_mention with "review pr #N" is forwarded verbatim', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> review pr #42 in org/repo',
        ts: '2.0',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200);
    expect(lambdaSend).toHaveBeenCalledTimes(1);
    const [invokeCmd] = lambdaSend.mock.calls[0];
    const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
    expect(payload.text).toContain('review pr');
    expect(payload.text).toContain('#42');
  });

  test('app_mention with Lambda invoke failure swaps :eyes: to :x:', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    lambdaSend.mockRejectedValueOnce(new Error('lambda outage'));
    smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
      if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
        return Promise.resolve({ SecretString: SIGNING_SECRET });
      }
      return Promise.resolve({ SecretString: 'xoxb-bot' });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T1',
      event: {
        type: 'app_mention',
        user: 'U1',
        channel: 'C1',
        text: '<@BOT> fix org/repo',
        ts: '1.0',
      },
    });
    const result = await handler(signedEvent(body));
    expect(result.statusCode).toBe(200); // Still 200 — Slack retries give a second chance
    // Should have swapped reaction: remove :eyes:, add :x:, then post error message
    const removeCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('reactions.remove') && String((opts as { body: string }).body).includes('eyes'),
    );
    const addCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('reactions.add') && String((opts as { body: string }).body).includes('"name":"x"'),
    );
    const errorReply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Something went wrong'),
    );
    expect(removeCall).toBeTruthy();
    expect(addCall).toBeTruthy();
    expect(errorReply).toBeTruthy();
  });

  // ─── Thread-reply routing ─────────────────────────────────────────────────

  describe('thread reply routing', () => {
    const THREAD_TS = '1000.0001';
    const REPLY_TS = '1001.0002';

    function commonSmSetup(): void {
      smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
        if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
          return Promise.resolve({ SecretString: SIGNING_SECRET });
        }
        return Promise.resolve({ SecretString: 'xoxb-bot' });
      });
    }

    function threadReplyBody(text: string, channelType = 'channel'): string {
      return JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'C1',
          channel_type: channelType,
          text,
          ts: REPLY_TS,
          thread_ts: THREAD_TS, // thread_ts != ts → this is a reply
        },
      });
    }

    test('thread reply in a PR-bearing task thread routes to pr-iteration-v1', async () => {
      commonSmSetup();
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      // DDB Scan returns a task with a pr_number
      ddbSend.mockResolvedValueOnce({
        Items: [{
          task_id: 'TASK1',
          status: 'COMPLETED',
          channel_source: 'slack',
          repo: 'org/repo',
          pr_number: 42,
          created_at: '2024-01-01T00:00:00Z',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_thread_ts: THREAD_TS,
          },
        }],
      });
      lambdaSend.mockResolvedValueOnce({});

      const result = await handler(signedEvent(threadReplyBody('please also add unit tests')));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const [invokeCmd] = lambdaSend.mock.calls[0];
      const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
      expect(payload.source).toBe('mention');
      expect(payload.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(payload.pr_number).toBe(42);
      expect(payload.mention_thread_ts).toBe(THREAD_TS);
    });

    test('thread reply in a clarify-hold task thread routes to new-task-v1 with assembled description', async () => {
      commonSmSetup();
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      // DDB Scan returns a clarify-hold task (code_changed=false, answer_text, no PR)
      ddbSend.mockResolvedValueOnce({
        Items: [{
          task_id: 'TASK2',
          status: 'COMPLETED',
          channel_source: 'slack',
          repo: 'org/repo',
          code_changed: false,
          answer_text: 'Which file should I focus on?',
          task_description: 'Fix the login bug',
          resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
          created_at: '2024-01-01T00:00:00Z',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_thread_ts: THREAD_TS,
          },
        }],
      });
      lambdaSend.mockResolvedValueOnce({});

      const result = await handler(signedEvent(threadReplyBody('auth/login.ts please')));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const [invokeCmd] = lambdaSend.mock.calls[0];
      const payload = JSON.parse(new TextDecoder().decode(invokeCmd.input.Payload));
      expect(payload.workflow_ref).toBe('coding/new-task-v1');
      expect(payload.pre_built_description).toContain('Fix the login bug');
      expect(payload.pre_built_description).toContain('Which file should I focus on?');
      expect(payload.pre_built_description).toContain('auth/login.ts please');
    });

    test('thread reply with no matching task is silently ignored', async () => {
      commonSmSetup();
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      // DDB Scan returns empty — no matching task
      ddbSend.mockResolvedValueOnce({ Items: [] });

      const result = await handler(signedEvent(threadReplyBody('some reply in a non-ABCA thread')));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).not.toHaveBeenCalled();
    });

    test('thread reply on active task is ignored to prevent concurrent execution', async () => {
      commonSmSetup();
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });
      // DDB Scan returns a RUNNING task
      ddbSend.mockResolvedValueOnce({
        Items: [{
          task_id: 'TASK3',
          status: 'RUNNING',
          channel_source: 'slack',
          repo: 'org/repo',
          pr_number: 42,
          created_at: '2024-01-01T00:00:00Z',
          channel_metadata: {
            slack_team_id: 'T1',
            slack_channel_id: 'C1',
            slack_thread_ts: THREAD_TS,
          },
        }],
      });

      const result = await handler(signedEvent(threadReplyBody('a message in an active task thread')));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).not.toHaveBeenCalled();
    });

    test('bot messages (bot_id set) in threads are not treated as thread replies', async () => {
      commonSmSetup();
      const botThreadBody = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          bot_id: 'B123', // bot message — must be ignored
          channel: 'C1',
          channel_type: 'channel',
          text: 'Task started.',
          ts: REPLY_TS,
          thread_ts: THREAD_TS,
        },
      });
      const result = await handler(signedEvent(botThreadBody));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).not.toHaveBeenCalled();
    });

    test('root message (thread_ts == ts) in a channel is ignored', async () => {
      commonSmSetup();
      const rootMsgBody = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          text: 'A plain channel message with no thread',
          ts: '5000.0001',
          // No thread_ts — root message
        },
      });
      const result = await handler(signedEvent(rootMsgBody));
      expect(result.statusCode).toBe(200);
      expect(lambdaSend).not.toHaveBeenCalled();
    });
  });
});
