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
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
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

// Mock resolveTaskBySlackThread (ABCA-661) so tests can control what the GSI returns.
const resolveTaskBySlackThreadMock = jest.fn();
jest.mock('../../src/handlers/shared/slack-task-by-thread', () => ({
  resolveTaskBySlackThread: (...args: unknown[]) => resolveTaskBySlackThreadMock(...args),
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
    resolveTaskBySlackThreadMock.mockReset();
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

  // ─── ABCA-661: keyword prefix (decompose / review) ───────────────────────

  describe('keyword prefix workflow selection (ABCA-661)', () => {
    function signedMention(text: string): APIGatewayProxyEvent {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: { type: 'app_mention', user: 'U1', channel: 'C1', text, ts: '9.0' },
      });
      return signedEvent(body);
    }

    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
      lambdaSend.mockResolvedValue({});
      smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
        if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
          return Promise.resolve({ SecretString: SIGNING_SECRET });
        }
        return Promise.resolve({ SecretString: 'xoxb-bot' });
      });
    });

    test('"decompose: …" prefix is stripped and workflow_ref coding/decompose-v1 is forwarded', async () => {
      await handler(signedMention('<@BOT> decompose: fix the auth bug in org/repo'));
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
      expect(payload.workflow_ref).toBe('coding/decompose-v1');
      // The keyword prefix should be stripped from the forwarded text
      expect(payload.text).not.toMatch(/^decompose\s*:/i);
      expect(payload.text).toContain('org/repo');
    });

    test('"DECOMPOSE:" (uppercase) is recognised case-insensitively', async () => {
      await handler(signedMention('<@BOT> DECOMPOSE: fix the auth bug in org/repo'));
      const payload = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
      expect(payload.workflow_ref).toBe('coding/decompose-v1');
    });

    test('"review: …" prefix sets workflow_ref to coding/pr-review-v1', async () => {
      await handler(signedMention('<@BOT> review: check PR in org/repo#42'));
      const payload = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
      expect(payload.workflow_ref).toBe('coding/pr-review-v1');
    });

    test('no keyword prefix — workflow_ref absent in forwarded payload', async () => {
      await handler(signedMention('<@BOT> fix the auth bug in org/repo'));
      const payload = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
      expect(payload.workflow_ref).toBeUndefined();
    });

    test('keyword prefix with empty text after stripping is silently ignored (not forwarded)', async () => {
      // "decompose: " with nothing after — no useful task description
      await handler(signedMention('<@BOT> decompose: '));
      expect(lambdaSend).not.toHaveBeenCalled();
    });
  });

  // ─── ABCA-661: thread reply routing ─────────────────────────────────────

  describe('thread reply routing (ABCA-661)', () => {
    function signedThreadReply(opts: {
      user?: string;
      channel?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
      subtype?: string;
    } = {}): APIGatewayProxyEvent {
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          user: opts.user ?? 'U1',
          channel: opts.channel ?? 'C1',
          text: opts.text ?? 'looks good to me',
          ts: opts.ts ?? '10.001',
          thread_ts: opts.thread_ts ?? '10.000', // must differ from ts → it is a reply
          ...(opts.bot_id && { bot_id: opts.bot_id }),
          ...(opts.subtype && { subtype: opts.subtype }),
        },
      });
      return signedEvent(body);
    }

    beforeEach(() => {
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
      lambdaSend.mockResolvedValue({});
      smSend.mockImplementation((cmd: { _type: string; input?: { SecretId?: string } }) => {
        if (cmd._type === 'GetSecretValue' && cmd.input?.SecretId === process.env.SLACK_SIGNING_SECRET_ARN) {
          return Promise.resolve({ SecretString: SIGNING_SECRET });
        }
        return Promise.resolve({ SecretString: 'xoxb-bot' });
      });
    });

    test('thread reply in an ABCA task thread is forwarded as ThreadReplyEvent', async () => {
      const task = { task_id: 'T1', repo: 'o/r', pr_number: 5, status: 'COMPLETED' };
      resolveTaskBySlackThreadMock.mockResolvedValueOnce(task);

      await handler(signedThreadReply({ text: 'please add a comment', thread_ts: '10.000' }));

      expect(resolveTaskBySlackThreadMock).toHaveBeenCalledWith(
        expect.anything(),
        'TaskTable',
        '10.000',
      );
      expect(lambdaSend).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(new TextDecoder().decode(lambdaSend.mock.calls[0][0].input.Payload));
      expect(payload.source).toBe('thread_reply');
      expect(payload.thread_ts).toBe('10.000');
      expect(payload.reply_text).toBe('please add a comment');
      expect(payload.thread_task).toEqual(task);
    });

    test('thread reply in a non-ABCA thread is silently ignored', async () => {
      resolveTaskBySlackThreadMock.mockResolvedValueOnce(null);

      await handler(signedThreadReply());

      expect(lambdaSend).not.toHaveBeenCalled();
    });

    test('bot messages in a thread are ignored', async () => {
      await handler(signedThreadReply({ bot_id: 'B1' }));
      // resolveTaskBySlackThread should never be called for bot messages
      expect(resolveTaskBySlackThreadMock).not.toHaveBeenCalled();
      expect(lambdaSend).not.toHaveBeenCalled();
    });

    test('message_changed subtype is ignored', async () => {
      await handler(signedThreadReply({ subtype: 'message_changed' }));
      expect(resolveTaskBySlackThreadMock).not.toHaveBeenCalled();
    });

    test('@mention text in a message event skips thread_reply routing (Slack sends a separate app_mention event)', async () => {
      // When a thread reply contains an @mention, Slack sends TWO events:
      // 1. A "message" event (this one) — we skip it to avoid double-processing.
      // 2. A separate "app_mention" event — handled by handleAppMention.
      // Our handler must NOT call resolveTaskBySlackThread or lambda for the message event.
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'C1',
          text: '<@BOT> review this thread',
          ts: '11.001',
          thread_ts: '11.000',
        },
      });
      await handler(signedEvent(body));
      // Should be silently skipped — resolveTaskBySlackThread NOT called
      expect(resolveTaskBySlackThreadMock).not.toHaveBeenCalled();
      // Lambda NOT invoked (the app_mention event will be dispatched separately by Slack)
      expect(lambdaSend).not.toHaveBeenCalled();
    });

    test('root message (ts === thread_ts) is not treated as a thread reply', async () => {
      // A root message has ts === thread_ts — must not be processed as a reply.
      const body = JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'C1',
          text: 'hello world',
          ts: '12.000',
          thread_ts: '12.000', // same as ts → root message
        },
      });
      await handler(signedEvent(body));
      expect(resolveTaskBySlackThreadMock).not.toHaveBeenCalled();
    });

    test('thread reply Lambda invoke failure swaps :eyes: to :x:', async () => {
      const task = { task_id: 'T2', repo: 'o/r', pr_number: 3, status: 'COMPLETED' };
      resolveTaskBySlackThreadMock.mockResolvedValueOnce(task);
      lambdaSend.mockRejectedValueOnce(new Error('lambda down'));

      await handler(signedThreadReply());

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
  });
});
