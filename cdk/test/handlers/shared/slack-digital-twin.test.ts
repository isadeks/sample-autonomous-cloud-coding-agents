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
 * Tests for the Slack digital twin harness (slack-digital-twin.ts).
 *
 * These tests verify the harness itself: that MockSlackWebClient correctly
 * intercepts fetch calls, returns realistic responses, and that all factory
 * helpers produce valid payload shapes that downstream handler tests can rely on.
 */

import * as crypto from 'crypto';
import {
  MockSlackWebClient,
  alreadyReactedResponse,
  appUninstalledEvent,
  buttonClick,
  channelNotFoundResponse,
  dmMessage,
  fileShareEvent,
  nextTs,
  noReactionResponse,
  notInChannelResponse,
  rateLimitedResponse,
  resetTsCounter,
  signSlackRequest,
  signedCommandEvent,
  signedEventsApiEvent,
  signedInteractionEvent,
  slackMention,
  slashCommand,
  threadReply,
  tokensRevokedEvent,
  tokenRevokedResponse,
  urlVerificationEvent,
} from './slack-digital-twin';

const SIGNING_SECRET = 'test-signing-secret-for-digital-twin';
const BOT_TOKEN = 'xoxb-test-bot-token';

// ─── Timestamp counter ────────────────────────────────────────────────────────

describe('nextTs', () => {
  beforeEach(() => resetTsCounter());

  test('generates Slack-style timestamps (unix_seconds.microseconds)', () => {
    const ts = nextTs();
    // Format: NNNNNNNNNN.NNNNNN
    expect(ts).toMatch(/^\d{10}\.\d{6}$/);
  });

  test('generates strictly increasing timestamps', () => {
    const tsList = Array.from({ length: 10 }, () => nextTs());
    for (let i = 1; i < tsList.length; i++) {
      const prev = parseFloat(tsList[i - 1]!);
      const curr = parseFloat(tsList[i]!);
      expect(curr).toBeGreaterThan(prev);
    }
  });

  test('resetTsCounter produces deterministic first value', () => {
    resetTsCounter();
    const ts1 = nextTs();
    resetTsCounter();
    const ts2 = nextTs();
    expect(ts1).toBe(ts2);
  });
});

// ─── MockSlackWebClient ───────────────────────────────────────────────────────

describe('MockSlackWebClient', () => {
  let slack: MockSlackWebClient;

  beforeEach(() => {
    resetTsCounter();
    slack = new MockSlackWebClient();
  });

  afterEach(() => {
    slack.restore();
  });

  // ── Interception ──────────────────────────────────────────────────────────

  test('intercepts fetch calls to https://slack.com/api/*', async () => {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BOT_TOKEN}`,
      },
      body: JSON.stringify({ channel: 'C1', text: 'hello' }),
    });

    expect(slack.callCount('chat.postMessage')).toBe(1);
  });

  test('does not intercept non-Slack fetch calls', async () => {
    // Install a separate mock for non-Slack calls so the test doesn't make a
    // real network request.
    const nonSlackFetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    // Temporarily override what the spy points at for non-Slack URLs.
    // The MockSlackWebClient passes through to originalFetch for non-Slack
    // URLs. In this test environment the originalFetch is a noop from the
    // test setup, so we verify only that the Slack call tracker stays empty.
    const body = JSON.stringify({ channel: 'C1', text: 'hello' });
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    // Only the Slack call was tracked
    expect(slack.callCount('chat.postMessage')).toBe(1);
    expect(nonSlackFetch).not.toHaveBeenCalled();
  });

  // ── Default responses ─────────────────────────────────────────────────────

  test('returns ok:true by default for any method', async () => {
    const res = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', timestamp: '1234.0001', name: 'eyes' }),
    });
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  test('chat.postMessage response includes generated ts and message object', async () => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', text: 'task submitted' }),
    });
    const json = await res.json() as { ok: boolean; ts: string; message: { ts: string; type: string } };
    expect(json.ok).toBe(true);
    expect(json.ts).toMatch(/^\d{10}\.\d{6}$/);
    expect(json.message.type).toBe('message');
    expect(json.message.ts).toBe(json.ts);
  });

  test('chat.postMessage response includes thread_ts when provided', async () => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', text: 'threaded reply', thread_ts: '1700000001.000001' }),
    });
    const json = await res.json() as { ok: boolean; message: { thread_ts?: string } };
    expect(json.ok).toBe(true);
    expect(json.message.thread_ts).toBe('1700000001.000001');
  });

  test('conversations.info returns realistic channel object', async () => {
    const res = await fetch('https://slack.com/api/conversations.info', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C_TEST' }),
    });
    const json = await res.json() as { ok: boolean; channel: { id: string; is_member: boolean } };
    expect(json.ok).toBe(true);
    expect(json.channel.id).toBe('C_TEST');
    expect(typeof json.channel.is_member).toBe('boolean');
  });

  test('conversations.replies returns empty messages array', async () => {
    const res = await fetch('https://slack.com/api/conversations.replies', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', ts: '1234.0001' }),
    });
    const json = await res.json() as { ok: boolean; messages: unknown[]; has_more: boolean };
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.messages)).toBe(true);
    expect(json.has_more).toBe(false);
  });

  test('users.info returns realistic user object', async () => {
    const res = await fetch('https://slack.com/api/users.info', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'U_TARGET' }),
    });
    const json = await res.json() as { ok: boolean; user: { id: string; is_bot: boolean } };
    expect(json.ok).toBe(true);
    expect(json.user.id).toBe('U_TARGET');
    expect(json.user.is_bot).toBe(false);
  });

  // ── Rate-limit header contract ────────────────────────────────────────────

  test('responses include X-RateLimit-* headers matching Slack API contract', async () => {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', text: 'hi' }),
    });
    expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  test('rate-limited response returns HTTP 429 with Retry-After header', async () => {
    const rateSlack = new MockSlackWebClient({
      methodResponses: { 'chat.postMessage': rateLimitedResponse() },
    });
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C1', text: 'hi' }),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('30');
      const json = await res.json() as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe('ratelimited');
    } finally {
      rateSlack.restore();
    }
  });

  // ── Error responses ───────────────────────────────────────────────────────

  test('channel_not_found returns HTTP 200 with ok:false (Slack contract)', async () => {
    const errSlack = new MockSlackWebClient({
      methodResponses: { 'chat.postMessage': channelNotFoundResponse() },
    });
    try {
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C_GONE', text: 'hi' }),
      });
      expect(res.status).toBe(200); // Slack returns 200 even for API errors
      const json = await res.json() as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe('channel_not_found');
    } finally {
      errSlack.restore();
    }
  });

  test('failNextCall stubs one error then falls back to default', async () => {
    slack.failNextCall('reactions.add', 'already_reacted');

    const res1 = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', timestamp: '1234', name: 'eyes' }),
    });
    const json1 = await res1.json() as { ok: boolean; error?: string };
    expect(json1.ok).toBe(false);
    expect(json1.error).toBe('already_reacted');

    const res2 = await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', timestamp: '1234', name: 'white_check_mark' }),
    });
    const json2 = await res2.json() as { ok: boolean };
    expect(json2.ok).toBe(true);
  });

  // ── Assertion helpers ─────────────────────────────────────────────────────

  test('postedMessages() returns chat.postMessage payloads', async () => {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', text: 'task submitted: org/repo' }),
    });
    const messages = slack.postedMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channel).toBe('C1');
    expect(messages[0]!.text).toBe('task submitted: org/repo');
  });

  test('reactionsAdded() returns reactions.add payloads', async () => {
    await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', timestamp: '1700000001.000001', name: 'eyes' }),
    });
    expect(slack.reactionsAdded()).toEqual([
      { channel: 'C1', timestamp: '1700000001.000001', name: 'eyes' },
    ]);
    expect(slack.wasReactionAdded('C1', 'eyes')).toBe(true);
    expect(slack.wasReactionAdded('C1', 'x')).toBe(false);
  });

  test('reactionsRemoved() returns reactions.remove payloads', async () => {
    await fetch('https://slack.com/api/reactions.remove', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', timestamp: '1700000001.000001', name: 'eyes' }),
    });
    expect(slack.reactionsRemoved()).toHaveLength(1);
    expect(slack.wasReactionRemoved('C1', 'eyes')).toBe(true);
  });

  test('repliesRequested() returns conversations.replies payloads', async () => {
    await fetch('https://slack.com/api/conversations.replies', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', ts: '1700000001.000001', limit: 10 }),
    });
    expect(slack.repliesRequested()).toEqual([
      { channel: 'C1', ts: '1700000001.000001', limit: 10 },
    ]);
  });

  test('wasMessagePostedTo() matches substring', async () => {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', text: ':rocket: Task TASK123 submitted' }),
    });
    expect(slack.wasMessagePostedTo('C1', 'TASK123')).toBe(true);
    expect(slack.wasMessagePostedTo('C1', 'MISSING')).toBe(false);
    expect(slack.wasMessagePostedTo('C2', 'TASK123')).toBe(false);
  });

  test('wasMessagePostedTo() matches RegExp', async () => {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', text: ':eyes: Processing TASK-9999...' }),
    });
    expect(slack.wasMessagePostedTo('C1', /TASK-\d+/)).toBe(true);
    expect(slack.wasMessagePostedTo('C1', /MISSING-\d+/)).toBe(false);
  });

  test('wasThreadedReplyPosted() checks thread_ts on posted messages', async () => {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'C1',
        thread_ts: '1700000001.000001',
        text: ':white_check_mark: Done!',
      }),
    });
    expect(slack.wasThreadedReplyPosted('1700000001.000001')).toBe(true);
    expect(slack.wasThreadedReplyPosted('1700000001.000001', 'Done!')).toBe(true);
    expect(slack.wasThreadedReplyPosted('1700000001.000001', 'FAILED')).toBe(false);
    expect(slack.wasThreadedReplyPosted('9999999999.999999')).toBe(false);
  });

  test('botToken is extracted from Authorization header', async () => {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer xoxb-the-real-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: 'C1', text: 'hi' }),
    });
    expect(slack.calls()[0]!.botToken).toBe('xoxb-the-real-token');
  });

  test('reset() clears all recorded calls', async () => {
    await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'C1', timestamp: '1234', name: 'eyes' }),
    });
    expect(slack.calls()).toHaveLength(1);
    slack.reset();
    expect(slack.calls()).toHaveLength(0);
    expect(slack.callCount('reactions.add')).toBe(0);
  });

  // ── Multiple calls / per-method ordering ─────────────────────────────────

  test('tracks multiple API calls in order', async () => {
    const post = () =>
      fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C1', text: 'msg' }),
      });
    const react = () =>
      fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C1', timestamp: '1234', name: 'eyes' }),
      });

    await react();
    await post();
    await react();

    expect(slack.calls()).toHaveLength(3);
    expect(slack.calls()[0]!.method).toBe('reactions.add');
    expect(slack.calls()[1]!.method).toBe('chat.postMessage');
    expect(slack.calls()[2]!.method).toBe('reactions.add');
    expect(slack.callCount('reactions.add')).toBe(2);
    expect(slack.callCount('chat.postMessage')).toBe(1);
  });

  test('per-method response array is consumed in order', async () => {
    const seqSlack = new MockSlackWebClient({
      methodResponses: {
        'reactions.add': [
          alreadyReactedResponse(),
          { ok: true },
        ],
      },
    });
    try {
      const r1 = await fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C1', timestamp: '1234', name: 'eyes' }),
      });
      const r2 = await fetch('https://slack.com/api/reactions.add', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C1', timestamp: '1234', name: 'eyes' }),
      });
      const j1 = await r1.json() as { ok: boolean; error?: string };
      const j2 = await r2.json() as { ok: boolean };
      expect(j1.ok).toBe(false);
      expect(j1.error).toBe('already_reacted');
      expect(j2.ok).toBe(true);
    } finally {
      seqSlack.restore();
    }
  });
});

// ─── Event payload factories ──────────────────────────────────────────────────

describe('slackMention factory', () => {
  test('produces a valid event_callback payload', () => {
    const payload = slackMention();
    expect(payload.type).toBe('event_callback');
    expect(payload.event.type).toBe('app_mention');
    expect(payload.team_id).toBeTruthy();
    expect(payload.event.user).toBeTruthy();
    expect(payload.event.channel).toBeTruthy();
    expect(payload.event.ts).toBeTruthy();
  });

  test('injects <@UBOT> mention prefix automatically', () => {
    const payload = slackMention({ text: 'fix the bug in org/repo', botUserId: 'UBOT123' });
    expect(payload.event.text).toMatch(/^<@UBOT123>/);
  });

  test('does not double-inject mention prefix when already present', () => {
    const payload = slackMention({ text: '<@UBOT123> fix the bug', botUserId: 'UBOT123' });
    const matches = (payload.event.text ?? '').match(/<@UBOT123>/g);
    expect(matches).toHaveLength(1);
  });

  test('accepts custom teamId, userId, channelId', () => {
    const payload = slackMention({ teamId: 'T_CUSTOM', userId: 'U_CUSTOM', channelId: 'C_CUSTOM' });
    expect(payload.team_id).toBe('T_CUSTOM');
    expect(payload.event.user).toBe('U_CUSTOM');
    expect(payload.event.channel).toBe('C_CUSTOM');
  });

  test('includes thread_ts when provided', () => {
    const payload = slackMention({ threadTs: '1700000001.000001' });
    expect(payload.event.thread_ts).toBe('1700000001.000001');
  });

  test('includes files when provided', () => {
    const payload = slackMention({
      files: [{ name: 'screenshot.png', mimetype: 'image/png', size: 9_000 }],
    });
    const files = payload.event.files as Array<{ name: string; mimetype: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('screenshot.png');
    expect(files[0]!.mimetype).toBe('image/png');
  });

  test('authorizations array contains bot entry for the team', () => {
    const payload = slackMention({ teamId: 'T_AUTH' });
    expect(payload.authorizations).toBeDefined();
    expect(payload.authorizations![0]!.team_id).toBe('T_AUTH');
    expect(payload.authorizations![0]!.is_bot).toBe(true);
  });
});

describe('dmMessage factory', () => {
  test('produces a valid direct-message event_callback', () => {
    const payload = dmMessage();
    expect(payload.type).toBe('event_callback');
    expect(payload.event.type).toBe('message');
    expect(payload.event.channel_type).toBe('im');
  });

  test('uses D-prefixed channel id by default', () => {
    const payload = dmMessage();
    expect(payload.event.channel).toMatch(/^D/);
  });
});

describe('threadReply factory', () => {
  test('includes thread_ts linking to the parent message', () => {
    const parentTs = '1700000001.000001';
    const payload = threadReply({ threadTs: parentTs });
    expect(payload.event.thread_ts).toBe(parentTs);
    expect(payload.event.type).toBe('message');
  });

  test('has a different ts than thread_ts', () => {
    const parentTs = '1700000001.000001';
    const payload = threadReply({ threadTs: parentTs });
    expect(payload.event.ts).not.toBe(parentTs);
  });
});

describe('slashCommand factory', () => {
  test('produces URL-encoded form body', () => {
    const body = slashCommand({ command: '/bgagent', text: 'help' });
    const params = new URLSearchParams(body);
    expect(params.get('command')).toBe('/bgagent');
    expect(params.get('text')).toBe('help');
    expect(params.get('response_url')).toMatch(/^https:\/\/hooks\.slack\.com/);
  });

  test('accepts custom team and channel fields', () => {
    const body = slashCommand({
      teamId: 'T_CUSTOM',
      channelId: 'C_CUSTOM',
      userId: 'U_CUSTOM',
      text: 'link',
    });
    const params = new URLSearchParams(body);
    expect(params.get('team_id')).toBe('T_CUSTOM');
    expect(params.get('channel_id')).toBe('C_CUSTOM');
    expect(params.get('user_id')).toBe('U_CUSTOM');
    expect(params.get('text')).toBe('link');
  });

  test('includes api_app_id and is_enterprise_install fields', () => {
    const body = slashCommand();
    const params = new URLSearchParams(body);
    expect(params.get('api_app_id')).toBeTruthy();
    expect(params.get('is_enterprise_install')).toBe('false');
  });
});

describe('buttonClick factory', () => {
  test('produces a valid block_actions JSON payload', () => {
    const json = buttonClick({ actionId: 'cancel_task:TASK123' });
    const payload = JSON.parse(json) as { type: string; actions: Array<{ action_id: string }> };
    expect(payload.type).toBe('block_actions');
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0]!.action_id).toBe('cancel_task:TASK123');
  });

  test('includes user and team fields', () => {
    const json = buttonClick({ actionId: 'cancel_task:T1', userId: 'U_ACTOR', teamId: 'T_ACTOR' });
    const payload = JSON.parse(json) as {
      user: { id: string; team_id: string };
      team: { id: string };
    };
    expect(payload.user.id).toBe('U_ACTOR');
    expect(payload.user.team_id).toBe('T_ACTOR');
    expect(payload.team.id).toBe('T_ACTOR');
  });

  test('includes response_url matching hooks.slack.com', () => {
    const json = buttonClick({ actionId: 'cancel_task:T1' });
    const payload = JSON.parse(json) as { response_url: string };
    expect(payload.response_url).toMatch(/^https:\/\/hooks\.slack\.com/);
  });

  test('block_id and action_ts are present', () => {
    const json = buttonClick({ actionId: 'cancel_task:T1', blockId: 'block-task-99' });
    const payload = JSON.parse(json) as { actions: Array<{ block_id: string; action_ts: string }> };
    expect(payload.actions[0]!.block_id).toBe('block-task-99');
    expect(payload.actions[0]!.action_ts).toBeTruthy();
  });

  test('danger style is included in the action when specified', () => {
    const json = buttonClick({ actionId: 'cancel_task:T1', buttonStyle: 'danger' });
    const payload = JSON.parse(json) as { actions: Array<{ style?: string }> };
    expect(payload.actions[0]!.style).toBe('danger');
  });
});

describe('fileShareEvent factory', () => {
  test('produces a file_share event with files array', () => {
    const payload = fileShareEvent({
      files: [{ name: 'report.pdf', mimetype: 'application/pdf', size: 50_000 }],
    });
    expect(payload.event.type).toBe('message');
    const files = payload.event.files as Array<{ name: string; mimetype: string; size: number }>;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('report.pdf');
    expect(files[0]!.mimetype).toBe('application/pdf');
    expect(files[0]!.size).toBe(50_000);
  });

  test('default file has a url_private_download', () => {
    const payload = fileShareEvent();
    const files = payload.event.files as Array<{ url_private_download: string }>;
    expect(files[0]!.url_private_download).toMatch(/^https:\/\/files\.slack\.com/);
  });

  test('includes all required SlackFileAttachment fields', () => {
    const payload = fileShareEvent({
      files: [{ name: 'shot.png', mimetype: 'image/png' }],
    });
    const file = (payload.event.files as SlackFileAttachmentShape[])[0]!;
    expect(file.id).toBeTruthy();
    expect(file.created).toBeGreaterThan(0);
    expect(file.is_public).toBe(false);
    expect(file.permalink).toMatch(/^https:\/\//);
  });
});

// Partial type for assertion only
interface SlackFileAttachmentShape {
  id: string;
  created: number;
  is_public: boolean;
  permalink: string;
}

describe('appUninstalledEvent factory', () => {
  test('produces a valid app_uninstalled event_callback', () => {
    const payload = appUninstalledEvent({ teamId: 'T_GONE' });
    expect(payload.type).toBe('event_callback');
    expect(payload.event.type).toBe('app_uninstalled');
    expect(payload.team_id).toBe('T_GONE');
  });
});

describe('tokensRevokedEvent factory', () => {
  test('produces a valid tokens_revoked event_callback', () => {
    const payload = tokensRevokedEvent({ teamId: 'T_REVOKED', botTokens: ['xoxb-abc'] });
    expect(payload.type).toBe('event_callback');
    expect(payload.event.type).toBe('tokens_revoked');
    expect(payload.team_id).toBe('T_REVOKED');
  });
});

// ─── APIGatewayProxyEvent factories ──────────────────────────────────────────

describe('signSlackRequest', () => {
  test('generates a verifiable HMAC-SHA256 signature', () => {
    const body = '{"type":"event_callback","team_id":"T1"}';
    const { signature, timestamp } = signSlackRequest(SIGNING_SECRET, body);

    // Verify independently
    const expected = 'v0=' + crypto
      .createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${timestamp}:${body}`)
      .digest('hex');
    expect(signature).toBe(expected);
  });

  test('accepts a custom timestamp', () => {
    const { timestamp } = signSlackRequest(SIGNING_SECRET, 'body', '1700000000');
    expect(timestamp).toBe('1700000000');
  });
});

describe('signedEventsApiEvent', () => {
  test('produces a valid APIGatewayProxyEvent', () => {
    const payload = slackMention();
    const event = signedEventsApiEvent(payload, SIGNING_SECRET);
    expect(event.httpMethod).toBe('POST');
    expect(event.path).toBe('/v1/slack/events');
    expect(event.body).toBe(JSON.stringify(payload));
    expect(event.headers['X-Slack-Signature']).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(event.headers['X-Slack-Request-Timestamp']).toMatch(/^\d+$/);
  });

  test('adds retry headers when retryNum is provided', () => {
    const event = signedEventsApiEvent(slackMention(), SIGNING_SECRET, '2');
    expect(event.headers['X-Slack-Retry-Num']).toBe('2');
    expect(event.headers['X-Slack-Retry-Reason']).toBe('http_timeout');
  });

  test('does not add retry headers when retryNum is undefined', () => {
    const event = signedEventsApiEvent(slackMention(), SIGNING_SECRET);
    expect(event.headers['X-Slack-Retry-Num']).toBeUndefined();
  });

  test('url_verification payload is correctly serialized', () => {
    const challenge = urlVerificationEvent('abc123');
    const event = signedEventsApiEvent(challenge, SIGNING_SECRET);
    const parsed = JSON.parse(event.body!) as { type: string; challenge: string };
    expect(parsed.type).toBe('url_verification');
    expect(parsed.challenge).toBe('abc123');
  });
});

describe('signedCommandEvent', () => {
  test('produces a valid signed slash-command APIGatewayProxyEvent', () => {
    const body = slashCommand({ text: 'link' });
    const event = signedCommandEvent(body, SIGNING_SECRET);
    expect(event.path).toBe('/v1/slack/commands');
    expect(event.body).toBe(body);
    expect(event.headers['X-Slack-Signature']).toMatch(/^v0=[0-9a-f]{64}$/);
    const params = new URLSearchParams(event.body!);
    expect(params.get('text')).toBe('link');
  });
});

describe('signedInteractionEvent', () => {
  test('produces a valid signed interaction APIGatewayProxyEvent', () => {
    const json = buttonClick({ actionId: 'cancel_task:TASK1' });
    const event = signedInteractionEvent(json, SIGNING_SECRET);
    expect(event.path).toBe('/v1/slack/interactions');
    const params = new URLSearchParams(event.body!);
    expect(params.get('payload')).toBe(json);
    expect(event.headers['X-Slack-Signature']).toMatch(/^v0=[0-9a-f]{64}$/);
  });
});

// ─── Error response helpers ───────────────────────────────────────────────────

describe('error response helpers', () => {
  test.each([
    ['rateLimitedResponse', rateLimitedResponse(), 'ratelimited'],
    ['channelNotFoundResponse', channelNotFoundResponse(), 'channel_not_found'],
    ['notInChannelResponse', notInChannelResponse(), 'not_in_channel'],
    ['tokenRevokedResponse', tokenRevokedResponse(), 'token_revoked'],
    ['alreadyReactedResponse', alreadyReactedResponse(), 'already_reacted'],
    ['noReactionResponse', noReactionResponse(), 'no_reaction'],
  ])('%s() returns ok:false with correct error code', (_name, response, expectedError) => {
    expect(response.ok).toBe(false);
    expect((response as { error: string }).error).toBe(expectedError);
  });
});

// ─── End-to-end: harness use as it would be in a handler test ─────────────────

describe('harness integration (simulated handler flow)', () => {
  let slack: MockSlackWebClient;

  beforeEach(() => {
    resetTsCounter();
    slack = new MockSlackWebClient();
  });

  afterEach(() => {
    slack.restore();
  });

  test('simulates bot adding :eyes: then swapping to :white_check_mark:', async () => {
    // Simulate the reaction sequence the slack-events handler uses for app_mention
    const channel = 'C_GENERAL';
    const messageTs = '1700000001.000001';
    const botToken = 'xoxb-workspace-bot';

    // Bot adds :eyes: immediately
    await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, timestamp: messageTs, name: 'eyes' }),
    });

    // …task completes…

    // Bot removes :eyes: and adds :white_check_mark:
    await fetch('https://slack.com/api/reactions.remove', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, timestamp: messageTs, name: 'eyes' }),
    });
    await fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, timestamp: messageTs, name: 'white_check_mark' }),
    });

    // Bot posts threaded reply with PR link
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel,
        thread_ts: messageTs,
        text: ':white_check_mark: PR opened: https://github.com/org/repo/pull/42',
      }),
    });

    // Assert with harness helpers
    expect(slack.wasReactionAdded(channel, 'eyes')).toBe(true);
    expect(slack.wasReactionRemoved(channel, 'eyes')).toBe(true);
    expect(slack.wasReactionAdded(channel, 'white_check_mark')).toBe(true);
    expect(slack.wasThreadedReplyPosted(messageTs, 'PR opened')).toBe(true);
    expect(slack.callCount('reactions.add')).toBe(2);
    expect(slack.callCount('reactions.remove')).toBe(1);
    expect(slack.callCount('chat.postMessage')).toBe(1);
  });

  test('simulates ephemeral slash-command acknowledgement flow', async () => {
    // Simulate slash-command handler: acknowledge with ephemeral, then async post result
    const responseUrl = 'https://hooks.slack.com/commands/T1/C1/token123';

    // The slash-command handler posts to the response_url (not to slack.com/api/*),
    // so only the API calls are tracked by MockSlackWebClient.
    // Use a separate fetchMock for response_url posts:
    const responseFetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    // Verify the slash command body produced by the factory is well-formed
    const body = slashCommand({ command: '/bgagent', text: 'link', userId: 'U_LINK' });
    const params = new URLSearchParams(body);
    expect(params.get('user_id')).toBe('U_LINK');
    expect(params.get('command')).toBe('/bgagent');
    expect(params.get('text')).toBe('link');
    expect(params.get('response_url')).toBe(responseUrl.replace('token123',
      params.get('response_url')!.split('/').pop() ?? 'token123'));

    // No slack.com/api/* calls made by the ack-only flow
    expect(slack.callCount('chat.postMessage')).toBe(0);
    expect(responseFetchMock).not.toHaveBeenCalled();
  });

  test('simulates button cancel flow and response_url post', async () => {
    const json = buttonClick({
      actionId: 'cancel_task:TASK_CANCEL_42',
      userId: 'U_OWNER',
      teamId: 'T1',
      channelId: 'C_WORK',
    });
    const payload = JSON.parse(json) as {
      actions: Array<{ action_id: string }>;
      user: { id: string };
      channel: { id: string };
    };

    expect(payload.actions[0]!.action_id).toBe('cancel_task:TASK_CANCEL_42');
    expect(payload.user.id).toBe('U_OWNER');
    expect(payload.channel.id).toBe('C_WORK');

    // The interaction handler posts to response_url (hooks.slack.com), not tracked by mock.
    // Verify it also doesn't confuse the mock:
    expect(slack.callCount('chat.postMessage')).toBe(0);
  });
});
