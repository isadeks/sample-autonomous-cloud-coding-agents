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
 * Proves the FakeSlack double behaves like the real Slack API for the calls the
 * handlers make. Two levels of assertion:
 *
 *  1. Direct — call the fake's `fetch` shim and check the `{ ok, error, ... }`
 *     envelope and stateful side-effects match Slack's documented semantics.
 *  2. Through the REAL transport — drive `slackFetch` / `slackFetchTs`
 *     (the code the handlers actually run) and the REAL `verifySlackSignature`
 *     against the fake, so the double is validated against the production code
 *     path, not just its own idea of Slack.
 */

import { FakeSlack } from './fake-slack';
import { slackFetch, slackFetchTs } from '../../src/handlers/shared/slack-api';
import { verifySlackSignature as verifySig } from '../../src/handlers/shared/slack-verify';

let fake: FakeSlack;
let restore: () => void;

beforeEach(() => {
  fake = new FakeSlack();
  fake.addWorkspace({ teamId: 'T1', botToken: 'xoxb-T1', botUserId: 'U-bot' });
  fake.addChannel({ id: 'C1', name: 'general' });
  restore = fake.install();
});

afterEach(() => {
  restore();
});

// ─── chat.postMessage ────────────────────────────────────────────────────────

describe('chat.postMessage', () => {
  test('posts a message, mints a ts, and stores it in the channel', async () => {
    const res = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'hello' });
    expect(res.ok).toBe(true);
    expect(typeof res.ts).toBe('string');
    const stored = fake.messagesIn('C1');
    expect(stored).toHaveLength(1);
    expect(stored[0].text).toBe('hello');
  });

  test('a threaded post is retrievable as a reply under its root', async () => {
    const root = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'root' });
    await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'reply', thread_ts: root.ts });
    const replies = await rawPost('conversations.replies', 'xoxb-T1', { channel: 'C1', ts: root.ts });
    expect(replies.messages).toHaveLength(2);
    expect(replies.messages[1].text).toBe('reply');
  });

  test('rejects a post to a channel the bot is not in with not_in_channel', async () => {
    fake.addChannel({ id: 'C2', is_member: false });
    const res = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C2', text: 'hi' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'not_in_channel' }));
  });

  test('rejects a post to an archived channel with is_archived', async () => {
    fake.addChannel({ id: 'C3', is_archived: true });
    const res = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C3', text: 'hi' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'is_archived' }));
  });

  test('rejects malformed blocks with invalid_blocks', async () => {
    const res = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x', blocks: ['not-an-object'] });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_blocks' }));
  });

  test('rejects an unknown bot token with invalid_auth', async () => {
    const res = await rawPost('chat.postMessage', 'xoxb-nope', { channel: 'C1', text: 'hi' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_auth' }));
  });
});

// ─── chat.update ─────────────────────────────────────────────────────────────

describe('chat.update', () => {
  test('edits a message in place, echoing the same ts', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'v1' });
    const upd = await rawPost('chat.update', 'xoxb-T1', { channel: 'C1', ts: post.ts, text: 'v2' });
    expect(upd).toEqual(expect.objectContaining({ ok: true, ts: post.ts }));
    expect(fake.message('C1', post.ts as string)?.text).toBe('v2');
    // The panel matures in place — still exactly one message in the channel.
    expect(fake.messagesIn('C1')).toHaveLength(1);
  });

  test('updating a ts that was never posted returns message_not_found', async () => {
    const res = await rawPost('chat.update', 'xoxb-T1', { channel: 'C1', ts: '1.2', text: 'x' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'message_not_found' }));
  });
});

// ─── chat.delete ─────────────────────────────────────────────────────────────

describe('chat.delete', () => {
  test('deletes a message so it no longer appears in the channel', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'bye' });
    const del = await rawPost('chat.delete', 'xoxb-T1', { channel: 'C1', ts: post.ts });
    expect(del.ok).toBe(true);
    expect(fake.messagesIn('C1')).toHaveLength(0);
  });

  test('deleting the same message twice returns message_not_found the second time', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'bye' });
    await rawPost('chat.delete', 'xoxb-T1', { channel: 'C1', ts: post.ts });
    const again = await rawPost('chat.delete', 'xoxb-T1', { channel: 'C1', ts: post.ts });
    expect(again).toEqual(expect.objectContaining({ ok: false, error: 'message_not_found' }));
  });
});

// ─── reactions.add / reactions.remove ────────────────────────────────────────

describe('reactions', () => {
  test('adds a reaction that then shows on the message', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x' });
    const res = await rawPost('reactions.add', 'xoxb-T1', { channel: 'C1', timestamp: post.ts, name: 'eyes' });
    expect(res.ok).toBe(true);
    expect(fake.reactionsOn('C1', post.ts as string)).toEqual(['eyes']);
  });

  test('adding the same reaction twice returns already_reacted', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x' });
    await rawPost('reactions.add', 'xoxb-T1', { channel: 'C1', timestamp: post.ts, name: 'eyes' });
    const dup = await rawPost('reactions.add', 'xoxb-T1', { channel: 'C1', timestamp: post.ts, name: 'eyes' });
    expect(dup).toEqual(expect.objectContaining({ ok: false, error: 'already_reacted' }));
  });

  test('removing a reaction that is not present returns no_reaction', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x' });
    const res = await rawPost('reactions.remove', 'xoxb-T1', { channel: 'C1', timestamp: post.ts, name: 'x' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'no_reaction' }));
  });

  test('add then remove leaves no reaction on the message', async () => {
    const post = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x' });
    await rawPost('reactions.add', 'xoxb-T1', { channel: 'C1', timestamp: post.ts, name: 'eyes' });
    await rawPost('reactions.remove', 'xoxb-T1', { channel: 'C1', timestamp: post.ts, name: 'eyes' });
    expect(fake.reactionsOn('C1', post.ts as string)).toEqual([]);
  });

  test('reacting to a ts that was never posted returns message_not_found', async () => {
    const res = await rawPost('reactions.add', 'xoxb-T1', { channel: 'C1', timestamp: '9.9', name: 'eyes' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'message_not_found' }));
  });
});

// ─── conversations.info ──────────────────────────────────────────────────────

describe('conversations.info', () => {
  test('returns channel membership flags via GET query params', async () => {
    fake.addChannel({ id: 'C-priv', is_private: true, is_member: false });
    const res = await rawGet('conversations.info', 'xoxb-T1', { channel: 'C-priv' });
    expect(res.ok).toBe(true);
    expect(res.channel).toEqual(expect.objectContaining({ is_private: true, is_member: false }));
  });

  test('unknown channel returns channel_not_found', async () => {
    const res = await rawGet('conversations.info', 'xoxb-T1', { channel: 'C-missing' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'channel_not_found' }));
  });
});

// ─── conversations.replies (thread read) ─────────────────────────────────────

describe('conversations.replies', () => {
  test('returns the root followed by its replies in order', async () => {
    const root = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'root' });
    await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'a', thread_ts: root.ts });
    await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'b', thread_ts: root.ts });
    const res = await rawPost('conversations.replies', 'xoxb-T1', { channel: 'C1', ts: root.ts });
    expect(res.messages.map((m: { text: string }) => m.text)).toEqual(['root', 'a', 'b']);
    expect(res.messages[0].reply_count).toBe(2);
  });

  test('a deleted reply drops out of the thread read', async () => {
    const root = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'root' });
    const reply = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'a', thread_ts: root.ts });
    await rawPost('chat.delete', 'xoxb-T1', { channel: 'C1', ts: reply.ts });
    const res = await rawPost('conversations.replies', 'xoxb-T1', { channel: 'C1', ts: root.ts });
    expect(res.messages.map((m: { text: string }) => m.text)).toEqual(['root']);
  });

  test('reading a thread whose root does not exist returns thread_not_found', async () => {
    const res = await rawPost('conversations.replies', 'xoxb-T1', { channel: 'C1', ts: '1.1' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'thread_not_found' }));
  });
});

// ─── oauth.v2.access ─────────────────────────────────────────────────────────

describe('oauth.v2.access', () => {
  test('exchanges a registered code for a bot token and team info', async () => {
    fake.addOAuthCode('good-code', 'T-new');
    const res = await rawForm('oauth.v2.access', { code: 'good-code', client_id: 'x', client_secret: 'y' });
    expect(res.ok).toBe(true);
    expect(res.access_token).toBe('xoxb-T-new');
    expect(res.team).toEqual(expect.objectContaining({ id: 'T-new' }));
    expect(res.bot_user_id).toBeTruthy();
  });

  test('an unknown code returns invalid_code', async () => {
    const res = await rawForm('oauth.v2.access', { code: 'nope' });
    expect(res).toEqual(expect.objectContaining({ ok: false, error: 'invalid_code' }));
  });
});

// ─── file downloads ──────────────────────────────────────────────────────────

describe('file download', () => {
  test('serves the file bytes to an authenticated bot token', async () => {
    const file = fake.addFile({ id: 'F1', name: 'spec.txt', mimetype: 'text/plain', content: 'contents' });
    const response = await fetch(file.url_private_download, { headers: { Authorization: 'Bearer xoxb-T1' } });
    expect(response.ok).toBe(true);
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.toString('utf-8')).toBe('contents');
  });

  test('rejects a download with no/invalid token (401, not file bytes)', async () => {
    const file = fake.addFile({ id: 'F1', name: 'spec.txt', mimetype: 'text/plain', content: 'contents' });
    const response = await fetch(file.url_private_download, { headers: { Authorization: 'Bearer bad' } });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(401);
  });

  test('an unknown file url returns 404', async () => {
    const response = await fetch('https://files.slack.com/files-pri/F9/download/ghost.txt', {
      headers: { Authorization: 'Bearer xoxb-T1' },
    });
    expect(response.status).toBe(404);
  });
});

// ─── scripted failures (rate limits / transient errors) ──────────────────────

describe('scripted failures', () => {
  test('failNextCall makes exactly the next call fail, then recovers', async () => {
    fake.failNextCall('chat.postMessage', 'internal_error');
    const first = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x' });
    const second = await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'y' });
    expect(first).toEqual(expect.objectContaining({ ok: false, error: 'internal_error' }));
    expect(second.ok).toBe(true);
    // The failed call did not persist a message; only the recovered one did.
    expect(fake.messagesIn('C1')).toHaveLength(1);
  });

  test('rateLimitNextCall returns 429 with a Retry-After header', async () => {
    fake.rateLimitNextCall('chat.postMessage', 30);
    const raw = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer xoxb-T1' },
      body: JSON.stringify({ channel: 'C1', text: 'x' }),
    });
    expect(raw.status).toBe(429);
    expect(raw.headers.get('Retry-After')).toBe('30');
    expect((await raw.json() as { error: string }).error).toBe('ratelimited');
  });
});

// ─── through the REAL transport (slackFetch / slackFetchTs) ──────────────────

describe('drives the real Slack transport unchanged', () => {
  test('slackFetchTs returns the ts the fake minted for a post', async () => {
    const ts = await slackFetchTs('xoxb-T1', 'chat.postMessage', { channel: 'C1', text: 'via transport' });
    expect(ts).toBeTruthy();
    expect(fake.message('C1', ts as string)?.text).toBe('via transport');
  });

  test('slackFetch treats already_reacted as benign success (matches BENIGN_SLACK_ERRORS)', async () => {
    const ts = await slackFetchTs('xoxb-T1', 'chat.postMessage', { channel: 'C1', text: 'x' });
    const first = await slackFetch('xoxb-T1', 'reactions.add', { channel: 'C1', timestamp: ts, name: 'eyes' });
    const dup = await slackFetch('xoxb-T1', 'reactions.add', { channel: 'C1', timestamp: ts, name: 'eyes' });
    expect(first).toBe(true);
    // The fake returns already_reacted; slackFetch's benign-error set maps it to
    // true. This is the exact contract the reaction-swap logic relies on.
    expect(dup).toBe(true);
  });

  test('slackFetch reports a real Slack error (channel_not_found) as false', async () => {
    const ok = await slackFetch('xoxb-T1', 'chat.postMessage', { channel: 'X-nope', text: 'x' });
    expect(ok).toBe(false);
  });

  test('slackFetchTs returns null when the fake rejects the call', async () => {
    fake.failNextCall('chat.update', 'message_not_found');
    const ts = await slackFetchTs('xoxb-T1', 'chat.update', { channel: 'C1', ts: '1.1', text: 'x' });
    expect(ts).toBeNull();
  });
});

// ─── inbound event signing matches the real verifier ─────────────────────────

describe('inbound event signing', () => {
  test('appMentionEvent is signed so the REAL verifier accepts it', () => {
    const evt = fake.appMentionEvent({ teamId: 'T1', channel: 'C1', user: 'U9', text: '<@U-bot> ship it' });
    const sig = evt.headers['X-Slack-Signature'];
    const ts = evt.headers['X-Slack-Request-Timestamp'];
    expect(verifySig(fake.signingSecret, sig, ts, evt.body)).toBe(true);
  });

  test('a tampered body fails verification', () => {
    const evt = fake.appMentionEvent({ teamId: 'T1', channel: 'C1', user: 'U9', text: 'hi' });
    const tampered = evt.body.replace('hi', 'HACKED');
    expect(verifySig(fake.signingSecret, evt.headers['X-Slack-Signature'], evt.headers['X-Slack-Request-Timestamp'], tampered)).toBe(false);
  });

  test('a signature made with the wrong secret is rejected', () => {
    const evt = fake.appMentionEvent({ teamId: 'T1', channel: 'C1', user: 'U9', text: 'hi', signingSecret: 'other-secret' });
    expect(verifySig(fake.signingSecret, evt.headers['X-Slack-Signature'], evt.headers['X-Slack-Request-Timestamp'], evt.body)).toBe(false);
  });

  test('the app_mention body has the event_callback shape the handler dispatches on', () => {
    const evt = fake.appMentionEvent({ teamId: 'T1', channel: 'C1', user: 'U9', text: 'hi', threadTs: '100.1' });
    const parsed = JSON.parse(evt.body);
    expect(parsed.type).toBe('event_callback');
    expect(parsed.team_id).toBe('T1');
    expect(parsed.event.type).toBe('app_mention');
    expect(parsed.event.thread_ts).toBe('100.1');
  });

  test('url_verification challenge round-trips through the verifier', () => {
    const evt = fake.urlVerificationEvent('challenge-token-abc');
    expect(verifySig(fake.signingSecret, evt.headers['X-Slack-Signature'], evt.headers['X-Slack-Request-Timestamp'], evt.body)).toBe(true);
    expect(JSON.parse(evt.body)).toEqual({ type: 'url_verification', challenge: 'challenge-token-abc' });
  });

  test('a retry event carries the X-Slack-Retry-Num header', () => {
    const evt = fake.revocationEvent({ teamId: 'T1', type: 'tokens_revoked', retryNum: 2 });
    expect(evt.headers['X-Slack-Retry-Num']).toBe('2');
  });
});

// ─── inbound interactivity (button clicks) ───────────────────────────────────

describe('button click interactions', () => {
  test('buttonClickEvent produces a signed url-encoded block_actions payload', () => {
    const evt = fake.buttonClickEvent({ teamId: 'T1', user: 'U9', actionId: 'cancel_task:task-123', value: 'task-123' });
    expect(verifySig(fake.signingSecret, evt.headers['X-Slack-Signature'], evt.headers['X-Slack-Request-Timestamp'], evt.body)).toBe(true);
    const params = new URLSearchParams(evt.body);
    const payload = JSON.parse(params.get('payload') as string);
    expect(payload.type).toBe('block_actions');
    expect(payload.actions[0].action_id).toBe('cancel_task:task-123');
    expect(payload.user.team_id).toBe('T1');
  });

  test('the interaction can carry the channel the button lives in', () => {
    const evt = fake.buttonClickEvent({ teamId: 'T1', user: 'U9', actionId: 'a', channel: 'C1' });
    const payload = JSON.parse(new URLSearchParams(evt.body).get('payload') as string);
    expect(payload.channel.id).toBe('C1');
  });
});

// ─── call log ────────────────────────────────────────────────────────────────

describe('call recording', () => {
  test('records every Web API call with method, body, and token', async () => {
    await rawPost('chat.postMessage', 'xoxb-T1', { channel: 'C1', text: 'x' });
    await rawPost('reactions.add', 'xoxb-T1', { channel: 'C1', timestamp: '1.1', name: 'eyes' });
    expect(fake.recordedCalls()).toHaveLength(2);
    expect(fake.callsTo('chat.postMessage')).toHaveLength(1);
    expect(fake.callsTo('chat.postMessage')[0].token).toBe('xoxb-T1');
    expect(fake.callsTo('chat.postMessage')[0].body).toEqual(expect.objectContaining({ text: 'x' }));
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function rawPost(method: string, token: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return await res.json() as Record<string, any>;
}

async function rawGet(method: string, token: string, query: Record<string, string>): Promise<Record<string, any>> {
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return await res.json() as Record<string, any>;
}

async function rawForm(method: string, body: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return await res.json() as Record<string, any>;
}
