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
 * FakeSlack — an in-test "digital twin" of the Slack platform.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Linear side of ABCA has a rich test double that simulates the tracker's
 * webhooks and API responses, so its conversational behaviour is driven
 * end-to-end without touching the network. Slack had no equivalent: handler
 * tests each hand-rolled a `jest.fn()` over `global.fetch` returning
 * `{ ok: true }`, which pins call SHAPES but not Slack's SEMANTICS — a message
 * `ts` isn't remembered, so a `chat.update` against an id we never posted still
 * "succeeds", `reactions.add` twice never yields `already_reacted`, and a thread
 * read returns whatever the test scripted rather than what was actually posted.
 * That gap is exactly where the interesting conversational bugs hide.
 *
 * FakeSlack is a single stateful object that:
 *
 *  1. Answers the Slack Web API methods the integration calls, off a real
 *     message/reaction/channel store, with Slack's own `{ ok, error }` envelope
 *     and error codes (`channel_not_found`, `message_not_found`,
 *     `already_reacted`, `not_in_channel`, `ratelimited`, …).
 *       - chat.postMessage / chat.update / chat.delete
 *       - reactions.add / reactions.remove
 *       - conversations.info (GET) / conversations.replies (thread read)
 *       - oauth.v2.access (install code exchange)
 *       - authenticated file downloads from `files.slack.com`
 *  2. Installs as `global.fetch`, so the REAL handler code path — `slackFetch`,
 *     `slackFetchTs`, the direct `fetch` calls in the processors — runs unchanged
 *     against it (see {@link FakeSlack.install}).
 *  3. Manufactures realistic, correctly-SIGNED inbound traffic — Events API
 *     payloads (app_mention, threaded message replies, url_verification) and
 *     interactivity payloads (Block Kit button clicks) — as
 *     `APIGatewayProxyEvent`s the `slack-events` / `slack-interactions` handlers
 *     accept and whose signatures `verifySlackRequest` validates
 *     (see {@link FakeSlack.appMentionEvent} etc.).
 *  4. Exposes the resulting state (messages, reactions, threads) and a call log
 *     for assertions.
 *
 * It is deliberately reusable test infrastructure: the sibling conversational
 * sub-issues can drive their handlers against one FakeSlack instead of each
 * re-deriving Slack's response shapes. Its OWN behaviour is pinned by
 * `fake-slack.test.ts`, which proves the double answers like the real API for
 * the calls the handlers make.
 */

import * as crypto from 'crypto';

// ─── Slack response envelope helpers ─────────────────────────────────────────

/** Minimal subset of the WHATWG `Response` the handlers touch. */
export interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A stored Slack message, keyed by `(channel, ts)`. */
export interface StoredMessage {
  readonly ts: string;
  readonly channel: string;
  text: string;
  blocks?: unknown[];
  /** Present on replies — the ts of the thread's root message. */
  readonly thread_ts?: string;
  /** The bot/user that authored it. */
  readonly user: string;
  /** emoji name → set of user ids that reacted with it. */
  readonly reactions: Map<string, Set<string>>;
  deleted: boolean;
}

/** Registered channel and its posting-eligibility flags. */
export interface FakeChannel {
  readonly id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  is_archived: boolean;
}

/** A file the bot can download with `url_private_download`. */
export interface FakeFile {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly content: Buffer;
  readonly url_private_download: string;
}

/** A workspace install — the token→team→bot-user mapping Slack keys calls by. */
export interface FakeWorkspace {
  readonly teamId: string;
  readonly teamName: string;
  readonly botToken: string;
  readonly botUserId: string;
}

/** One recorded Web API call, for assertions. */
export interface RecordedCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly token: string | null;
}

/** A scripted failure for the next call to a given method. */
interface ScriptedError {
  readonly error: string;
  readonly httpStatus: number;
  readonly retryAfter?: string;
}

const DEFAULT_SIGNING_SECRET = 'fake-slack-signing-secret';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): FakeResponse {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  };
}

function binaryResponse(status: number, content: Buffer): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(content.toString('utf-8')),
    // Copy into a standalone ArrayBuffer — Buffer's backing store is pooled, and
    // callers do `Buffer.from(await res.arrayBuffer())`.
    arrayBuffer: () => {
      const copy = new ArrayBuffer(content.byteLength);
      new Uint8Array(copy).set(content);
      return Promise.resolve(copy);
    },
  };
}

/**
 * The in-test Slack. Construct one per test, register workspaces/channels, then
 * either call {@link install} to route the handler's `fetch` here, or drive the
 * handlers with the inbound-event builders.
 */
export class FakeSlack {
  /** Signing secret used to sign inbound events (matches `verifySlackRequest`). */
  public readonly signingSecret: string;

  private readonly workspacesByToken = new Map<string, FakeWorkspace>();
  private readonly workspacesByTeam = new Map<string, FakeWorkspace>();
  private readonly channels = new Map<string, FakeChannel>();
  private readonly messages = new Map<string, StoredMessage>();
  private readonly files = new Map<string, FakeFile>();
  private readonly oauthCodes = new Map<string, string>();
  private readonly scriptedErrors = new Map<string, ScriptedError[]>();
  private readonly calls: RecordedCall[] = [];

  private tsCounter = 0;
  private tsSeconds = 1_700_000_000;
  private originalFetch: typeof global.fetch | undefined;

  public constructor(opts: { signingSecret?: string } = {}) {
    this.signingSecret = opts.signingSecret ?? DEFAULT_SIGNING_SECRET;
  }

  // ── Setup ──────────────────────────────────────────────────────────────

  /** Register an installed workspace. Returns it so tests can grab the token. */
  public addWorkspace(opts: {
    teamId: string;
    botToken?: string;
    teamName?: string;
    botUserId?: string;
  }): FakeWorkspace {
    const ws: FakeWorkspace = {
      teamId: opts.teamId,
      teamName: opts.teamName ?? `Team ${opts.teamId}`,
      botToken: opts.botToken ?? `xoxb-${opts.teamId}`,
      botUserId: opts.botUserId ?? `U-bot-${opts.teamId}`,
    };
    this.workspacesByToken.set(ws.botToken, ws);
    this.workspacesByTeam.set(ws.teamId, ws);
    return ws;
  }

  /** Register a channel. Defaults to a public channel the bot has joined. */
  public addChannel(opts: {
    id: string;
    name?: string;
    is_private?: boolean;
    is_member?: boolean;
    is_archived?: boolean;
  }): FakeChannel {
    const ch: FakeChannel = {
      id: opts.id,
      name: opts.name ?? opts.id,
      is_private: opts.is_private ?? false,
      is_member: opts.is_member ?? true,
      is_archived: opts.is_archived ?? false,
    };
    this.channels.set(ch.id, ch);
    return ch;
  }

  /** Register a downloadable file and return its `url_private_download`. */
  public addFile(opts: {
    id: string;
    name: string;
    mimetype: string;
    content: Buffer | string;
  }): FakeFile {
    const content = Buffer.isBuffer(opts.content) ? opts.content : Buffer.from(opts.content);
    const file: FakeFile = {
      id: opts.id,
      name: opts.name,
      mimetype: opts.mimetype,
      content,
      url_private_download: `https://files.slack.com/files-pri/${opts.id}/download/${encodeURIComponent(opts.name)}`,
    };
    this.files.set(file.url_private_download, file);
    return file;
  }

  /** Register an OAuth code so `oauth.v2.access` can exchange it for a token. */
  public addOAuthCode(code: string, teamId: string): void {
    this.oauthCodes.set(code, teamId);
  }

  /**
   * Script the NEXT call to `method` to fail with a Slack error code. Queued in
   * order, so multiple calls script multiple sequential failures.
   */
  public failNextCall(method: string, error: string, opts: { httpStatus?: number; retryAfter?: string } = {}): void {
    const queue = this.scriptedErrors.get(method) ?? [];
    queue.push({ error, httpStatus: opts.httpStatus ?? 200, retryAfter: opts.retryAfter });
    this.scriptedErrors.set(method, queue);
  }

  /** Convenience: script a `ratelimited` failure with a `Retry-After` header. */
  public rateLimitNextCall(method: string, retryAfterSeconds: number): void {
    this.failNextCall(method, 'ratelimited', { httpStatus: 429, retryAfter: String(retryAfterSeconds) });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  /**
   * Route `global.fetch` here for the duration of a test. Returns a restore
   * function (also reversible via {@link uninstall}). Non-Slack URLs still throw,
   * surfacing an accidental real network call.
   */
  public install(): () => void {
    this.originalFetch = global.fetch;
    (global as unknown as { fetch: unknown }).fetch = (url: unknown, init?: unknown) =>
      Promise.resolve(this.fetch(String(url), init as { method?: string; headers?: unknown; body?: unknown } | undefined));
    return () => this.uninstall();
  }

  /** Undo {@link install}. */
  public uninstall(): void {
    if (this.originalFetch !== undefined) {
      (global as unknown as { fetch: unknown }).fetch = this.originalFetch;
      this.originalFetch = undefined;
    }
  }

  /**
   * The `fetch` shim itself — exposed so a test can assign it directly
   * (`fetchMock.mockImplementation(fake.fetch)`) instead of touching the global.
   */
  public readonly fetch = (url: string, init?: { method?: string; headers?: unknown; body?: unknown }): FakeResponse => {
    const token = this.extractToken(init?.headers);

    // File download from the Slack CDN — authenticated GET, binary body.
    if (url.startsWith('https://files.slack.com/')) {
      return this.handleFileDownload(url, token);
    }

    const apiMatch = url.match(/^https:\/\/slack\.com\/api\/([a-zA-Z0-9._]+)/);
    if (!apiMatch) {
      throw new Error(`FakeSlack: unexpected fetch to ${url} — only slack.com/api and files.slack.com are served`);
    }
    const method = apiMatch[1];
    const body = this.parseBody(url, init?.body);
    this.calls.push({ method, body, token });

    // Scripted failure (rate limits, transient errors) takes precedence.
    const scripted = this.scriptedErrors.get(method)?.shift();
    if (scripted) {
      const headers: Record<string, string> = {};
      if (scripted.retryAfter) headers['Retry-After'] = scripted.retryAfter;
      return jsonResponse(scripted.httpStatus, { ok: false, error: scripted.error }, headers);
    }

    switch (method) {
      case 'chat.postMessage': return this.handlePostMessage(body, token);
      case 'chat.update': return this.handleUpdate(body, token);
      case 'chat.delete': return this.handleDelete(body, token);
      case 'reactions.add': return this.handleReaction(body, token, 'add');
      case 'reactions.remove': return this.handleReaction(body, token, 'remove');
      case 'conversations.info': return this.handleConversationsInfo(body, token);
      case 'conversations.replies': return this.handleConversationsReplies(body, token);
      case 'oauth.v2.access': return this.handleOAuth(body);
      default:
        return jsonResponse(200, { ok: false, error: 'unknown_method' });
    }
  };

  // ── State accessors (for assertions) ─────────────────────────────────────

  /** All non-deleted messages in a channel, oldest first. */
  public messagesIn(channel: string): StoredMessage[] {
    return [...this.messages.values()]
      .filter(m => m.channel === channel && !m.deleted)
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }

  /** A single message by `(channel, ts)`, including deleted ones (or undefined). */
  public message(channel: string, ts: string): StoredMessage | undefined {
    return this.messages.get(this.msgKey(channel, ts));
  }

  /** Emoji names currently on a message (excludes any removed). */
  public reactionsOn(channel: string, ts: string): string[] {
    const msg = this.messages.get(this.msgKey(channel, ts));
    if (!msg) return [];
    return [...msg.reactions.entries()].filter(([, users]) => users.size > 0).map(([name]) => name);
  }

  /** Every Web API call recorded, in order. */
  public recordedCalls(): readonly RecordedCall[] {
    return this.calls;
  }

  /** Calls to one method, in order. */
  public callsTo(method: string): RecordedCall[] {
    return this.calls.filter(c => c.method === method);
  }

  // ── Inbound event builders ───────────────────────────────────────────────

  /**
   * A signed `app_mention` Events API request as an `APIGatewayProxyEvent`. This
   * is what a user typing "@bgagent …" in a channel produces.
   */
  public appMentionEvent(opts: {
    teamId: string;
    channel: string;
    user: string;
    text: string;
    ts?: string;
    threadTs?: string;
    files?: Array<{ id?: string; name: string; mimetype: string; size: number; url_private_download: string }>;
    retryNum?: number;
    signingSecret?: string;
  }): ApiGatewayEvent {
    const event: Record<string, unknown> = {
      type: 'app_mention',
      user: opts.user,
      text: opts.text,
      channel: opts.channel,
      ts: opts.ts ?? this.nextTs(),
    };
    if (opts.threadTs) event.thread_ts = opts.threadTs;
    if (opts.files) event.files = opts.files;
    return this.eventCallback(opts.teamId, event, { retryNum: opts.retryNum, signingSecret: opts.signingSecret });
  }

  /**
   * A signed threaded `message` reply in a DM (`channel_type: 'im'`) — the shape
   * the events handler routes to the command processor as a follow-up.
   */
  public directMessageEvent(opts: {
    teamId: string;
    channel: string;
    user: string;
    text: string;
    ts?: string;
    threadTs?: string;
    botId?: string;
    signingSecret?: string;
  }): ApiGatewayEvent {
    const event: Record<string, unknown> = {
      type: 'message',
      channel_type: 'im',
      user: opts.user,
      text: opts.text,
      channel: opts.channel,
      ts: opts.ts ?? this.nextTs(),
    };
    if (opts.threadTs) event.thread_ts = opts.threadTs;
    if (opts.botId) event.bot_id = opts.botId;
    return this.eventCallback(opts.teamId, event, { signingSecret: opts.signingSecret });
  }

  /** A signed `url_verification` challenge request. */
  public urlVerificationEvent(challenge: string, opts: { signingSecret?: string } = {}): ApiGatewayEvent {
    return this.signedEvent(JSON.stringify({ type: 'url_verification', challenge }), opts.signingSecret);
  }

  /** A signed `tokens_revoked` / `app_uninstalled` event. */
  public revocationEvent(opts: {
    teamId: string;
    type: 'tokens_revoked' | 'app_uninstalled';
    retryNum?: number;
    signingSecret?: string;
  }): ApiGatewayEvent {
    return this.eventCallback(opts.teamId, { type: opts.type }, { retryNum: opts.retryNum, signingSecret: opts.signingSecret });
  }

  /**
   * A signed Block Kit `block_actions` interaction — a button click. Slack sends
   * these URL-encoded as `payload=<json>`, which is what this builder produces.
   */
  public buttonClickEvent(opts: {
    teamId: string;
    user: string;
    username?: string;
    channel?: string;
    actionId: string;
    blockId?: string;
    value?: string;
    responseUrl?: string;
    triggerId?: string;
    signingSecret?: string;
  }): ApiGatewayEvent {
    const payload = {
      type: 'block_actions',
      user: { id: opts.user, username: opts.username ?? opts.user, team_id: opts.teamId },
      actions: [{
        action_id: opts.actionId,
        block_id: opts.blockId ?? 'actions_block',
        value: opts.value,
      }],
      response_url: opts.responseUrl ?? 'https://hooks.slack.com/actions/fake',
      trigger_id: opts.triggerId ?? 'trigger.fake',
      ...(opts.channel ? { channel: { id: opts.channel } } : {}),
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    return this.signedEvent(body, opts.signingSecret);
  }

  /** Sign an arbitrary raw body the way Slack does, returning `{ headers }`. */
  public sign(body: string, timestamp?: string, signingSecret?: string): Record<string, string> {
    const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
    const secret = signingSecret ?? this.signingSecret;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
    return {
      'X-Slack-Signature': sig,
      'X-Slack-Request-Timestamp': ts,
      'Content-Type': 'application/json',
    };
  }

  // ── Internals: Web API method handlers ───────────────────────────────────

  private handlePostMessage(body: Record<string, unknown>, token: string | null): FakeResponse {
    const ws = this.authOrError(token);
    if (!ws.ok) return ws.response;
    const channelId = String(body.channel ?? '');
    const chErr = this.channelPostError(channelId);
    if (chErr) return jsonResponse(200, { ok: false, error: chErr });
    const text = typeof body.text === 'string' ? body.text : '';
    const blocks = Array.isArray(body.blocks) ? body.blocks : undefined;
    if (blocks && blocks.some(b => b === null || typeof b !== 'object')) {
      return jsonResponse(200, { ok: false, error: 'invalid_blocks' });
    }
    const threadTs = typeof body.thread_ts === 'string' ? body.thread_ts : undefined;
    const ts = this.nextTs();
    const msg: StoredMessage = {
      ts,
      channel: channelId,
      text,
      blocks,
      thread_ts: threadTs,
      user: ws.ws.botUserId,
      reactions: new Map(),
      deleted: false,
    };
    this.messages.set(this.msgKey(channelId, ts), msg);
    return jsonResponse(200, {
      ok: true,
      channel: channelId,
      ts,
      message: { text, ts, user: ws.ws.botUserId, ...(threadTs ? { thread_ts: threadTs } : {}) },
    });
  }

  private handleUpdate(body: Record<string, unknown>, token: string | null): FakeResponse {
    const ws = this.authOrError(token);
    if (!ws.ok) return ws.response;
    const channelId = String(body.channel ?? '');
    const ts = String(body.ts ?? '');
    const msg = this.messages.get(this.msgKey(channelId, ts));
    if (!msg || msg.deleted) return jsonResponse(200, { ok: false, error: 'message_not_found' });
    if (msg.user !== ws.ws.botUserId) return jsonResponse(200, { ok: false, error: 'cant_update_message' });
    if (typeof body.text === 'string') msg.text = body.text;
    if (Array.isArray(body.blocks)) msg.blocks = body.blocks;
    return jsonResponse(200, { ok: true, channel: channelId, ts, text: msg.text });
  }

  private handleDelete(body: Record<string, unknown>, token: string | null): FakeResponse {
    const ws = this.authOrError(token);
    if (!ws.ok) return ws.response;
    const channelId = String(body.channel ?? '');
    const ts = String(body.ts ?? '');
    const msg = this.messages.get(this.msgKey(channelId, ts));
    if (!msg || msg.deleted) return jsonResponse(200, { ok: false, error: 'message_not_found' });
    if (msg.user !== ws.ws.botUserId) return jsonResponse(200, { ok: false, error: 'cant_delete_message' });
    msg.deleted = true;
    return jsonResponse(200, { ok: true, channel: channelId, ts });
  }

  private handleReaction(body: Record<string, unknown>, token: string | null, op: 'add' | 'remove'): FakeResponse {
    const ws = this.authOrError(token);
    if (!ws.ok) return ws.response;
    const channelId = String(body.channel ?? '');
    const ts = String(body.timestamp ?? '');
    const name = String(body.name ?? '');
    if (!name) return jsonResponse(200, { ok: false, error: 'invalid_name' });
    const msg = this.messages.get(this.msgKey(channelId, ts));
    if (!msg || msg.deleted) return jsonResponse(200, { ok: false, error: 'message_not_found' });
    const users = msg.reactions.get(name) ?? new Set<string>();
    const userId = ws.ws.botUserId;
    if (op === 'add') {
      if (users.has(userId)) return jsonResponse(200, { ok: false, error: 'already_reacted' });
      users.add(userId);
      msg.reactions.set(name, users);
      return jsonResponse(200, { ok: true });
    }
    // remove
    if (!users.has(userId)) return jsonResponse(200, { ok: false, error: 'no_reaction' });
    users.delete(userId);
    return jsonResponse(200, { ok: true });
  }

  private handleConversationsInfo(body: Record<string, unknown>, token: string | null): FakeResponse {
    const ws = this.authOrError(token);
    if (!ws.ok) return ws.response;
    const channelId = String(body.channel ?? '');
    const ch = this.channels.get(channelId);
    if (!ch) return jsonResponse(200, { ok: false, error: 'channel_not_found' });
    return jsonResponse(200, {
      ok: true,
      channel: {
        id: ch.id,
        name: ch.name,
        is_private: ch.is_private,
        is_member: ch.is_member,
        is_archived: ch.is_archived,
      },
    });
  }

  private handleConversationsReplies(body: Record<string, unknown>, token: string | null): FakeResponse {
    const ws = this.authOrError(token);
    if (!ws.ok) return ws.response;
    const channelId = String(body.channel ?? '');
    if (!this.channels.has(channelId)) return jsonResponse(200, { ok: false, error: 'channel_not_found' });
    const rootTs = String(body.ts ?? '');
    const root = this.messages.get(this.msgKey(channelId, rootTs));
    if (!root || root.deleted) return jsonResponse(200, { ok: false, error: 'thread_not_found' });
    const replies = [...this.messages.values()]
      .filter(m => m.channel === channelId && !m.deleted && m.thread_ts === rootTs && m.ts !== rootTs)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const thread = [root, ...replies];
    return jsonResponse(200, {
      ok: true,
      has_more: false,
      messages: thread.map(m => ({
        type: 'message',
        user: m.user,
        text: m.text,
        ts: m.ts,
        ...(m.thread_ts ? { thread_ts: m.thread_ts } : { thread_ts: m.ts, reply_count: replies.length }),
      })),
    });
  }

  private handleOAuth(body: Record<string, unknown>): FakeResponse {
    const code = String(body.code ?? '');
    const teamId = this.oauthCodes.get(code);
    if (!teamId) return jsonResponse(200, { ok: false, error: 'invalid_code' });
    // A successful exchange mints (and registers) a workspace token.
    const ws = this.workspacesByTeam.get(teamId) ?? this.addWorkspace({ teamId });
    return jsonResponse(200, {
      ok: true,
      app_id: 'A-fake',
      access_token: ws.botToken,
      token_type: 'bot',
      scope: 'chat:write,reactions:write,commands',
      bot_user_id: ws.botUserId,
      team: { id: ws.teamId, name: ws.teamName },
      authed_user: { id: 'U-installer' },
    });
  }

  private handleFileDownload(url: string, token: string | null): FakeResponse {
    if (!token || !this.workspacesByToken.has(token)) {
      // Real Slack serves a 200 HTML sign-in page for a bad/absent token, which
      // the handler must not treat as file bytes. Model the auth failure as 401
      // so `response.ok` is false — the contract the downloader checks.
      return jsonResponse(401, { ok: false, error: 'not_authed' });
    }
    const file = this.files.get(url);
    if (!file) return jsonResponse(404, { ok: false, error: 'file_not_found' });
    return binaryResponse(200, file.content);
  }

  // ── Internals: helpers ───────────────────────────────────────────────────

  private authOrError(token: string | null): { ok: true; ws: FakeWorkspace } | { ok: false; response: FakeResponse } {
    if (!token) return { ok: false, response: jsonResponse(200, { ok: false, error: 'not_authed' }) };
    const ws = this.workspacesByToken.get(token);
    if (!ws) return { ok: false, response: jsonResponse(200, { ok: false, error: 'invalid_auth' }) };
    return { ok: true, ws };
  }

  /** The Slack error a `chat.postMessage` to this channel would fail with, if any. */
  private channelPostError(channelId: string): string | null {
    // DMs (channel ids starting with 'D') and unregistered channels that look
    // like ids are allowed by default so tests need not register every channel.
    const ch = this.channels.get(channelId);
    if (!ch) {
      if (channelId.startsWith('D') || channelId.startsWith('C') || channelId.startsWith('G')) return null;
      return 'channel_not_found';
    }
    if (ch.is_archived) return 'is_archived';
    if (!ch.is_member) return 'not_in_channel';
    return null;
  }

  private extractToken(headers: unknown): string | null {
    if (!headers || typeof headers !== 'object') return null;
    const record = headers as Record<string, unknown>;
    const auth = record.Authorization ?? record.authorization;
    if (typeof auth !== 'string') return null;
    return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
  }

  private parseBody(url: string, body: unknown): Record<string, unknown> {
    // GET query params (conversations.info uses `?channel=`).
    const q = url.indexOf('?');
    const fromQuery: Record<string, unknown> = {};
    if (q >= 0) {
      for (const [k, v] of new URLSearchParams(url.slice(q + 1))) fromQuery[k] = v;
    }
    if (typeof body !== 'string' || body.length === 0) return fromQuery;
    // JSON body (Web API) vs form-encoded (oauth.v2.access).
    if (body.trimStart().startsWith('{')) {
      try {
        return { ...fromQuery, ...(JSON.parse(body) as Record<string, unknown>) };
      } catch {
        return fromQuery;
      }
    }
    const form: Record<string, unknown> = { ...fromQuery };
    for (const [k, v] of new URLSearchParams(body)) form[k] = v;
    return form;
  }

  private eventCallback(
    teamId: string,
    event: Record<string, unknown>,
    opts: { retryNum?: number; signingSecret?: string },
  ): ApiGatewayEvent {
    const body = JSON.stringify({ type: 'event_callback', team_id: teamId, event });
    const built = this.signedEvent(body, opts.signingSecret);
    if (opts.retryNum !== undefined) built.headers['X-Slack-Retry-Num'] = String(opts.retryNum);
    return built;
  }

  private signedEvent(body: string, signingSecret?: string): ApiGatewayEvent {
    const headers = this.sign(body, undefined, signingSecret);
    return { body, headers, isBase64Encoded: false };
  }

  private msgKey(channel: string, ts: string): string {
    return `${channel} ${ts}`;
  }

  private nextTs(): string {
    this.tsCounter += 1;
    if (this.tsCounter >= 1_000_000) {
      this.tsCounter = 0;
      this.tsSeconds += 1;
    }
    return `${this.tsSeconds}.${String(this.tsCounter).padStart(6, '0')}`;
  }
}

/** The `APIGatewayProxyEvent` subset the Slack handlers actually read. */
export interface ApiGatewayEvent {
  body: string;
  headers: Record<string, string>;
  isBase64Encoded: boolean;
}
