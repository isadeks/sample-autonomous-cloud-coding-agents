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
 * Tests for the Slack digital twin test harness itself.
 *
 * These tests verify that:
 *  - Factory helpers produce payloads that the real Slack handlers accept
 *    (signature verification passes, event routing works, etc.)
 *  - MockSlackClient correctly records sent messages, reactions, deletes
 *  - configureMethod() and configureChannel() override response shapes
 *  - Rate-limit headers are forwarded accurately
 *  - createSlackFetchMock() / applySlackFetchDefaults() produce the right shapes
 *  - slackSmSendImpl() returns the correct signing secret
 *
 * These tests are integration tests for the harness, NOT for the Slack handlers
 * themselves (those live in slack-events.test.ts, slack-interactions.test.ts, etc.)
 */

import * as crypto from 'crypto';
import {
  MockSlackClient,
  DEFAULT_SIGNING_SECRET,
  signSlackRequest,
  slackSignatureHeaders,
  urlVerificationEvent,
  appMentionEvent,
  threadMentionEvent,
  directMessageEvent,
  slashCommandEvent,
  buttonClickEvent,
  appUninstalledEvent,
  tokensRevokedEvent,
  createSlackFetchMock,
  applySlackFetchDefaults,
  slackSmSendImpl,
  createSlackTestDoubles,
} from './slack-digital-twin';
import { verifySlackSignature } from '../../../src/handlers/shared/slack-verify';

// ─── MockSlackClient ──────────────────────────────────────────────────────────

describe('MockSlackClient', () => {
  const slack = new MockSlackClient();

  beforeEach(() => {
    slack.install();
    slack.reset();
  });

  afterEach(() => {
    slack.restore();
  });

  test('intercepts chat.postMessage and records the call', async () => {
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer xoxb-test' },
        body: JSON.stringify({ channel: 'C1', text: 'hello' }),
      });
    const data = await (resp as { json: () => Promise<unknown> }).json() as { ok: boolean; ts: string };
    expect(data.ok).toBe(true);
    expect(typeof data.ts).toBe('string');
    expect(slack.sentMessages()).toHaveLength(1);
    expect(slack.sentMessages()[0].channel).toBe('C1');
    expect(slack.sentMessages()[0].text).toBe('hello');
  });

  test('intercepts reactions.add and records emoji', async () => {
    await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        body: JSON.stringify({ channel: 'C1', timestamp: '1234.0001', name: 'eyes' }),
      });
    expect(slack.reactionsAdded()).toHaveLength(1);
    expect(slack.reactionsAdded()[0].name).toBe('eyes');
    expect(slack.hasReactionAdded('eyes')).toBe(true);
    expect(slack.hasReactionAdded('white_check_mark')).toBe(false);
  });

  test('intercepts reactions.remove and records emoji', async () => {
    await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/reactions.remove', {
        method: 'POST',
        body: JSON.stringify({ channel: 'C1', timestamp: '1234.0001', name: 'hourglass_flowing_sand' }),
      });
    expect(slack.reactionsRemoved()).toHaveLength(1);
    expect(slack.hasReactionRemoved('hourglass_flowing_sand')).toBe(true);
  });

  test('intercepts chat.delete and records the call', async () => {
    await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.delete', {
        method: 'POST',
        body: JSON.stringify({ channel: 'C1', ts: '1234.0001' }),
      });
    expect(slack.deletedMessages()).toHaveLength(1);
    expect(slack.deletedMessages()[0].ts).toBe('1234.0001');
  });

  test('intercepts chat.update and records the call', async () => {
    await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.update', {
        method: 'POST',
        body: JSON.stringify({ channel: 'C1', ts: '1234.0001', text: 'updated' }),
      });
    expect(slack.updatedMessages()).toHaveLength(1);
    expect(slack.updatedMessages()[0].text).toBe('updated');
  });

  test('intercepts hooks.slack.com response_url POSTs', async () => {
    await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://hooks.slack.com/commands/T1/TOKEN', {
        method: 'POST',
        body: JSON.stringify({ text: 'Processing...', response_type: 'ephemeral' }),
      });
    expect(slack.responseUrlBodies()).toHaveLength(1);
    expect(slack.responseUrlBodies()[0].text).toBe('Processing...');
  });

  test('callsTo() filters by method', async () => {
    const fetch = (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> }).fetch;
    await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1' }) });
    await fetch('https://slack.com/api/reactions.add', { method: 'POST', body: JSON.stringify({ channel: 'C1', timestamp: '1.0', name: 'eyes' }) });
    expect(slack.callsTo('chat.postMessage')).toHaveLength(1);
    expect(slack.callsTo('reactions.add')).toHaveLength(1);
    expect(slack.callsTo('chat.delete')).toHaveLength(0);
  });

  test('lastMessage() returns the most recent postMessage', async () => {
    const fetch = (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> }).fetch;
    await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1', text: 'first' }) });
    await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C2', text: 'second' }) });
    expect(slack.lastMessage()?.text).toBe('second');
  });

  test('reset() clears all recorded calls', async () => {
    await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1' }) });
    slack.reset();
    expect(slack.calls()).toHaveLength(0);
    expect(slack.sentMessages()).toHaveLength(0);
  });

  test('configureMethod() returns error response for target method', async () => {
    slack.configureMethod('chat.postMessage', { error: 'channel_not_found' });
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1' }) });
    const data = await (resp as { json: () => Promise<unknown> }).json() as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('channel_not_found');
    // Call is still recorded
    expect(slack.sentMessages()).toHaveLength(1);
  });

  test('configureMethod() returns ratelimited with Retry-After header', async () => {
    slack.configureMethod('chat.postMessage', { error: 'ratelimited', retryAfter: '30' });
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1' }) });
    const mockResp = resp as { json: () => Promise<unknown>; headers: { get(name: string): string | null } };
    const data = await mockResp.json() as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('ratelimited');
    expect(mockResp.headers.get('retry-after')).toBe('30');
  });

  test('configureMethod() overrides ts in chat.postMessage response', async () => {
    slack.configureMethod('chat.postMessage', { ts: '9999.9999' });
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1' }) });
    const data = await (resp as { json: () => Promise<unknown> }).json() as { ok: boolean; ts: string };
    expect(data.ts).toBe('9999.9999');
  });

  test('configureChannel() returns channel_not_found error', async () => {
    slack.configureChannel({ error: 'channel_not_found' });
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/conversations.info?channel=C1', { method: 'GET' });
    const data = await (resp as { json: () => Promise<unknown> }).json() as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toBe('channel_not_found');
  });

  test('configureChannel() returns private channel not in bot', async () => {
    slack.configureChannel({ isPrivate: true, botIsMember: false });
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://slack.com/api/conversations.info?channel=C_PRIV', { method: 'GET' });
    const data = await (resp as { json: () => Promise<unknown> }).json() as { ok: boolean; channel: { is_private: boolean; is_member: boolean } };
    expect(data.ok).toBe(true);
    expect(data.channel.is_private).toBe(true);
    expect(data.channel.is_member).toBe(false);
  });

  test('files.slack.com downloads return mock binary content', async () => {
    const resp = await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
      .fetch('https://files.slack.com/files/F1/screenshot.png');
    const mockResp = resp as { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> };
    expect(mockResp.ok).toBe(true);
    const buf = Buffer.from(await mockResp.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  test('monotonic ts values are unique across multiple calls', async () => {
    const fetch = (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> }).fetch;
    const r1 = await (await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C1' }) }) as { json: () => Promise<unknown> }).json() as { ts: string };
    const r2 = await (await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', body: JSON.stringify({ channel: 'C2' }) }) as { json: () => Promise<unknown> }).json() as { ts: string };
    expect(r1.ts).not.toBe(r2.ts);
  });
});

// ─── Signature helpers ────────────────────────────────────────────────────────

describe('signSlackRequest', () => {
  test('produces a valid HMAC-SHA256 v0 signature', () => {
    const body = 'test-body';
    const ts = '1700000000';
    const sig = signSlackRequest(body, DEFAULT_SIGNING_SECRET, ts);
    const expected = 'v0=' + crypto.createHmac('sha256', DEFAULT_SIGNING_SECRET)
      .update(`v0:${ts}:${body}`)
      .digest('hex');
    expect(sig).toBe(expected);
  });

  test('signature starts with v0=', () => {
    expect(signSlackRequest('body')).toMatch(/^v0=[0-9a-f]{64}$/);
  });
});

describe('slackSignatureHeaders', () => {
  test('returns both required Slack signing headers', () => {
    const headers = slackSignatureHeaders('some-body');
    expect(headers['X-Slack-Signature']).toMatch(/^v0=/);
    expect(headers['X-Slack-Request-Timestamp']).toMatch(/^\d+$/);
  });

  test('generated signature verifies against the same secret', () => {
    const body = 'verify-me';
    const headers = slackSignatureHeaders(body, DEFAULT_SIGNING_SECRET);
    const ts = headers['X-Slack-Request-Timestamp'];
    const expected = signSlackRequest(body, DEFAULT_SIGNING_SECRET, ts);
    expect(headers['X-Slack-Signature']).toBe(expected);
  });
});

// ─── Factory helpers ──────────────────────────────────────────────────────────

describe('urlVerificationEvent', () => {
  test('produces a JSON body with type=url_verification and challenge', () => {
    const event = urlVerificationEvent({ challenge: 'my-challenge' });
    const body = JSON.parse(event.body as string) as { type: string; challenge: string };
    expect(body.type).toBe('url_verification');
    expect(body.challenge).toBe('my-challenge');
  });

  test('uses default challenge when not specified', () => {
    const event = urlVerificationEvent();
    const body = JSON.parse(event.body as string) as { challenge: string };
    expect(body.challenge).toBe('challenge-abc123');
  });

  test('includes correct signing headers', () => {
    const event = urlVerificationEvent();
    expect(event.headers['X-Slack-Signature']).toMatch(/^v0=/);
    expect(event.headers['X-Slack-Request-Timestamp']).toBeDefined();
  });

  test('path is /v1/slack/events', () => {
    expect(urlVerificationEvent().path).toBe('/v1/slack/events');
  });
});

describe('appMentionEvent', () => {
  test('produces an event_callback / app_mention JSON body', () => {
    const event = appMentionEvent();
    const body = JSON.parse(event.body as string) as { type: string; event: { type: string; text: string } };
    expect(body.type).toBe('event_callback');
    expect(body.event.type).toBe('app_mention');
    expect(body.event.text).toBe('<@U_BOT> submit org/repo fix it');
  });

  test('allows overriding text, user, channel, and ts', () => {
    const event = appMentionEvent({
      event: { text: '<@BOT> link', user: 'U_OTHER', channel: 'C_PRIVATE', ts: '9.0' },
    });
    const body = JSON.parse(event.body as string) as { event: { text: string; user: string; channel: string; ts: string } };
    expect(body.event.text).toBe('<@BOT> link');
    expect(body.event.user).toBe('U_OTHER');
    expect(body.event.channel).toBe('C_PRIVATE');
    expect(body.event.ts).toBe('9.0');
  });

  test('accepts teamId override', () => {
    const event = appMentionEvent({ teamId: 'T_OTHER' });
    const body = JSON.parse(event.body as string) as { team_id: string };
    expect(body.team_id).toBe('T_OTHER');
  });

  test('includes files in the event when provided', () => {
    const event = appMentionEvent({
      event: {
        files: [{
          id: 'F1',
          name: 'img.png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/img.png',
        }],
      },
    });
    const body = JSON.parse(event.body as string) as { event: { files: unknown[] } };
    expect(body.event.files).toHaveLength(1);
  });

  test('path is /v1/slack/events', () => {
    expect(appMentionEvent().path).toBe('/v1/slack/events');
  });

  test('X-Slack-Retry-Num header is present when retryNum is set', () => {
    const event = appMentionEvent({ retryNum: '1' });
    expect(event.headers['X-Slack-Retry-Num']).toBe('1');
    expect(event.headers['X-Slack-Retry-Reason']).toBe('http_timeout');
  });

  test('X-Slack-Retry-Num header is absent by default', () => {
    const event = appMentionEvent();
    expect(event.headers['X-Slack-Retry-Num']).toBeUndefined();
  });
});

describe('threadMentionEvent', () => {
  test('sets thread_ts on the inner event', () => {
    const event = threadMentionEvent({ parentTs: '1700000000.000100' });
    const body = JSON.parse(event.body as string) as { event: { thread_ts: string } };
    expect(body.event.thread_ts).toBe('1700000000.000100');
  });

  test('thread_ts differs from ts', () => {
    const event = threadMentionEvent();
    const body = JSON.parse(event.body as string) as { event: { ts: string; thread_ts: string } };
    expect(body.event.ts).not.toBe(body.event.thread_ts);
  });
});

describe('directMessageEvent', () => {
  test('produces event with channel_type=im', () => {
    const event = directMessageEvent();
    const body = JSON.parse(event.body as string) as { event: { type: string; channel_type: string; channel: string } };
    expect(body.event.type).toBe('message');
    expect(body.event.channel_type).toBe('im');
  });

  test('DM channel id starts with D by default', () => {
    const event = directMessageEvent();
    const body = JSON.parse(event.body as string) as { event: { channel: string } };
    expect(body.event.channel).toMatch(/^D/);
  });

  test('custom dmChannelId is used', () => {
    const event = directMessageEvent({ dmChannelId: 'D_CUSTOM' });
    const body = JSON.parse(event.body as string) as { event: { channel: string } };
    expect(body.event.channel).toBe('D_CUSTOM');
  });

  test('does not include bot_id (prevents self-loop)', () => {
    const event = directMessageEvent();
    const body = JSON.parse(event.body as string) as { event: Record<string, unknown> };
    expect(body.event.bot_id).toBeUndefined();
  });
});

describe('slashCommandEvent', () => {
  test('body is URL-encoded form data', () => {
    const event = slashCommandEvent();
    const params = new URLSearchParams(event.body as string);
    expect(params.get('command')).toBe('/bgagent');
    expect(params.get('text')).toBe('link');
  });

  test('accepts payload overrides', () => {
    const event = slashCommandEvent({ payload: { text: 'help', user_id: 'U_OTHER', team_id: 'T_X' } });
    const params = new URLSearchParams(event.body as string);
    expect(params.get('text')).toBe('help');
    expect(params.get('user_id')).toBe('U_OTHER');
    expect(params.get('team_id')).toBe('T_X');
  });

  test('response_url is a hooks.slack.com URL', () => {
    const event = slashCommandEvent();
    const params = new URLSearchParams(event.body as string);
    const responseUrl = params.get('response_url') as string;
    expect(responseUrl).toMatch(/^https:\/\/hooks\.slack\.com\//);
  });

  test('path is /v1/slack/commands', () => {
    expect(slashCommandEvent().path).toBe('/v1/slack/commands');
  });

  test('Content-Type is application/x-www-form-urlencoded', () => {
    const event = slashCommandEvent();
    expect(event.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('buttonClickEvent', () => {
  test('body is URL-encoded payload= field containing JSON', () => {
    const event = buttonClickEvent({ action: { action_id: 'cancel_task:task-123' } });
    const params = new URLSearchParams(event.body as string);
    const payload = JSON.parse(params.get('payload') as string) as { type: string; actions: Array<{ action_id: string }> };
    expect(payload.type).toBe('block_actions');
    expect(payload.actions[0].action_id).toBe('cancel_task:task-123');
  });

  test('includes user.id and user.team_id', () => {
    const event = buttonClickEvent({ action: { user_id: 'U_BOB', team_id: 'T_ACME' } });
    const payload = JSON.parse(new URLSearchParams(event.body as string).get('payload') as string) as { user: { id: string; team_id: string } };
    expect(payload.user.id).toBe('U_BOB');
    expect(payload.user.team_id).toBe('T_ACME');
  });

  test('response_url is a hooks.slack.com URL', () => {
    const event = buttonClickEvent();
    const payload = JSON.parse(new URLSearchParams(event.body as string).get('payload') as string) as { response_url: string };
    expect(payload.response_url).toMatch(/^https:\/\/hooks\.slack\.com\//);
  });

  test('path is /v1/slack/interactions', () => {
    expect(buttonClickEvent().path).toBe('/v1/slack/interactions');
  });

  test('Content-Type is application/x-www-form-urlencoded', () => {
    expect(buttonClickEvent().headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  test('value field is included when set', () => {
    const event = buttonClickEvent({ action: { action_id: 'my_action', value: 'some-value' } });
    const payload = JSON.parse(new URLSearchParams(event.body as string).get('payload') as string) as { actions: Array<{ value: string }> };
    expect(payload.actions[0].value).toBe('some-value');
  });
});

describe('appUninstalledEvent', () => {
  test('produces event_callback / app_uninstalled body', () => {
    const event = appUninstalledEvent({ teamId: 'T_REVOKE' });
    const body = JSON.parse(event.body as string) as { team_id: string; event: { type: string } };
    expect(body.team_id).toBe('T_REVOKE');
    expect(body.event.type).toBe('app_uninstalled');
  });

  test('path is /v1/slack/events', () => {
    expect(appUninstalledEvent().path).toBe('/v1/slack/events');
  });
});

describe('tokensRevokedEvent', () => {
  test('produces event_callback / tokens_revoked body', () => {
    const event = tokensRevokedEvent({ teamId: 'T_REVOKE2' });
    const body = JSON.parse(event.body as string) as { team_id: string; event: { type: string } };
    expect(body.team_id).toBe('T_REVOKE2');
    expect(body.event.type).toBe('tokens_revoked');
  });
});

// ─── createSlackFetchMock ─────────────────────────────────────────────────────

describe('createSlackFetchMock', () => {
  test('returns a jest.fn() that responds ok to chat.postMessage', async () => {
    const mock = createSlackFetchMock();
    const resp = await mock('https://slack.com/api/chat.postMessage', {}) as { json: () => Promise<unknown> };
    const data = await resp.json() as { ok: boolean; ts: string };
    expect(data.ok).toBe(true);
    expect(data.ts).toBe('1234.0001');
  });

  test('returns channel object for conversations.info', async () => {
    const mock = createSlackFetchMock();
    const resp = await mock('https://slack.com/api/conversations.info?channel=C1') as { json: () => Promise<unknown> };
    const data = await resp.json() as { ok: boolean; channel: { is_private: boolean; is_member: boolean } };
    expect(data.ok).toBe(true);
    expect(data.channel.is_private).toBe(false);
    expect(data.channel.is_member).toBe(true);
  });

  test('returns binary arrayBuffer for files.slack.com', async () => {
    const mock = createSlackFetchMock();
    const resp = await mock('https://files.slack.com/files/F1/test.png') as { ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> };
    expect(resp.ok).toBe(true);
    const buf = Buffer.from(await resp.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  test('returns { ok: true } for reactions.add', async () => {
    const mock = createSlackFetchMock();
    const resp = await mock('https://slack.com/api/reactions.add', {}) as { json: () => Promise<unknown> };
    const data = await resp.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });

  test('headers.get returns null for unknown headers', async () => {
    const mock = createSlackFetchMock();
    const resp = await mock('https://slack.com/api/reactions.add', {}) as { headers: { get(n: string): string | null } };
    expect(resp.headers.get('retry-after')).toBeNull();
  });
});

describe('applySlackFetchDefaults', () => {
  test('reconfigures an already-reset mock', async () => {
    const mock = jest.fn();
    applySlackFetchDefaults(mock);
    const resp = await mock('https://slack.com/api/chat.postMessage', {}) as { json: () => Promise<unknown> };
    const data = await resp.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

// ─── slackSmSendImpl ──────────────────────────────────────────────────────────

describe('slackSmSendImpl', () => {
  test('returns the signing secret for GetSecretValue', async () => {
    const impl = slackSmSendImpl('my-secret');
    const result = await impl({ _type: 'GetSecretValue' });
    expect(result.SecretString).toBe('my-secret');
  });

  test('uses DEFAULT_SIGNING_SECRET when no argument is given', async () => {
    const impl = slackSmSendImpl();
    const result = await impl({ _type: 'GetSecretValue' });
    expect(result.SecretString).toBe(DEFAULT_SIGNING_SECRET);
  });

  test('returns empty string for other command types', async () => {
    const impl = slackSmSendImpl();
    const result = await impl({ _type: 'DeleteSecret' });
    expect(result.SecretString).toBe('');
  });
});

// ─── createSlackTestDoubles ───────────────────────────────────────────────────

describe('createSlackTestDoubles', () => {
  test('returns a MockSlackClient and a smImpl', () => {
    const { slack, smImpl } = createSlackTestDoubles();
    expect(slack).toBeInstanceOf(MockSlackClient);
    expect(typeof smImpl).toBe('function');
  });

  test('smImpl returns the same secret used by the factory helpers', async () => {
    const { smImpl } = createSlackTestDoubles(DEFAULT_SIGNING_SECRET);
    const result = await smImpl({ _type: 'GetSecretValue' });
    expect(result.SecretString).toBe(DEFAULT_SIGNING_SECRET);
  });

  test('slack client records calls after install', async () => {
    const { slack } = createSlackTestDoubles();
    slack.install();
    try {
      await (global as unknown as { fetch: (url: string, init?: unknown) => Promise<unknown> })
        .fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          body: JSON.stringify({ channel: 'C1', text: 'hi' }),
        });
      expect(slack.sentMessages()).toHaveLength(1);
    } finally {
      slack.restore();
    }
  });
});

// ─── End-to-end harness self-test: verify signatures pass real Slack verify ───

describe('factory helpers produce signatures that pass verifySlackSignature', () => {
  // verifySlackSignature is imported at the top of the file.
  // This suite proves the factory helpers generate signatures that pass the
  // real HMAC verifier (without going through Secrets Manager).

  test('appMentionEvent signature passes verifySlackSignature', () => {
    const event = appMentionEvent();
    const sig = event.headers['X-Slack-Signature'];
    const ts = event.headers['X-Slack-Request-Timestamp'];
    const body = event.body as string;
    expect(verifySlackSignature(DEFAULT_SIGNING_SECRET, sig, ts, body)).toBe(true);
  });

  test('slashCommandEvent signature passes verifySlackSignature', () => {
    const event = slashCommandEvent();
    const sig = event.headers['X-Slack-Signature'];
    const ts = event.headers['X-Slack-Request-Timestamp'];
    const body = event.body as string;
    expect(verifySlackSignature(DEFAULT_SIGNING_SECRET, sig, ts, body)).toBe(true);
  });

  test('buttonClickEvent signature passes verifySlackSignature', () => {
    const event = buttonClickEvent({ action: { action_id: 'cancel_task:task-1' } });
    const sig = event.headers['X-Slack-Signature'];
    const ts = event.headers['X-Slack-Request-Timestamp'];
    const body = event.body as string;
    expect(verifySlackSignature(DEFAULT_SIGNING_SECRET, sig, ts, body)).toBe(true);
  });

  test('urlVerificationEvent signature passes verifySlackSignature', () => {
    const event = urlVerificationEvent({ challenge: 'xyz' });
    const sig = event.headers['X-Slack-Signature'];
    const ts = event.headers['X-Slack-Request-Timestamp'];
    const body = event.body as string;
    expect(verifySlackSignature(DEFAULT_SIGNING_SECRET, sig, ts, body)).toBe(true);
  });

  test('tampering with the body makes the signature invalid', () => {
    const event = appMentionEvent();
    const sig = event.headers['X-Slack-Signature'];
    const ts = event.headers['X-Slack-Request-Timestamp'];
    expect(verifySlackSignature(DEFAULT_SIGNING_SECRET, sig, ts, 'tampered-body')).toBe(false);
  });
});
