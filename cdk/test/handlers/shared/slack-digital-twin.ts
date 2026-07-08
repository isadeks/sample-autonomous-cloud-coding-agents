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
 * Slack Digital Twin Test Harness
 *
 * Provides a local mock of the Slack API surface so every Slack flow can be
 * verified in CI without a live workspace:
 *
 *  - `MockSlackClient` intercepts outbound `fetch` calls to
 *    `https://slack.com/api/*` and `https://hooks.slack.com/*`, records every
 *    call, and returns realistic API response shapes including rate-limit
 *    headers.
 *  - Factory helpers build valid inbound event payloads (APIGatewayProxyEvent)
 *    for @mentions, slash commands, thread replies, button clicks, and
 *    url_verification challenges.  All signed variants produce correct
 *    HMAC-SHA256 `X-Slack-Signature` headers so they pass
 *    `verifySlackRequest()` unchanged.
 *  - `createSlackFetchMock()` returns a jest.fn() pre-wired with Slack success
 *    responses — a drop-in for the raw `global.fetch` mock pattern used in
 *    existing test files.
 *
 * API shapes follow the Slack Web API (chat.postMessage, reactions.add,
 * conversations.replies, etc.), Events API, and Block Kit Interactivity docs.
 *
 * Usage (recommended):
 * ```ts
 * const slack = new MockSlackClient();
 * beforeEach(() => { slack.install(); slack.reset(); });
 * afterEach(() => slack.restore());
 *
 * test('sends a message on task_created', async () => {
 *   await handler(appMentionEvent({ text: '<@BOT> submit org/repo fix it' }));
 *   expect(slack.sentMessages()).toHaveLength(1);
 *   expect(slack.sentMessages()[0].channel).toBe('C1');
 * });
 * ```
 */

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Slack API response shapes (Web API + Events API) ─────────────────────────

/**
 * chat.postMessage / chat.update success response.
 * Reflects the actual Slack Web API response shape.
 */
export interface SlackPostResponse {
  readonly ok: true;
  readonly ts: string;
  readonly channel: string;
}

/** Generic Slack API error response. */
export interface SlackErrorResponse {
  readonly ok: false;
  readonly error: string;
}

/** conversations.info success response channel object. */
export interface SlackChannelInfo {
  readonly id: string;
  readonly name: string;
  readonly is_private: boolean;
  readonly is_member: boolean;
}

/** conversations.info success response. */
export interface ConversationsInfoResponse {
  readonly ok: true;
  readonly channel: SlackChannelInfo;
}

// ─── Recorded call types ──────────────────────────────────────────────────────

/** A recorded outbound Slack API call captured by MockSlackClient. */
export interface SlackApiCall {
  /** Slack API method, e.g. 'chat.postMessage'. `response_url` for hooks.slack.com POSTs. */
  readonly method: string;
  /** Parsed JSON body sent in the request. */
  readonly body: Record<string, unknown>;
  /** Unix ms timestamp when the call was captured. */
  readonly timestamp: number;
}

/** chat.postMessage call body shape. */
export interface ChatPostMessageBody {
  readonly channel: string;
  readonly text?: string;
  readonly blocks?: readonly unknown[];
  readonly thread_ts?: string;
  readonly unfurl_links?: boolean;
}

/** reactions.add / reactions.remove call body shape. */
export interface ReactionBody {
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
}

/** chat.delete call body shape. */
export interface ChatDeleteBody {
  readonly channel: string;
  readonly ts: string;
}

/** chat.update call body shape. */
export interface ChatUpdateBody {
  readonly channel: string;
  readonly ts: string;
  readonly text?: string;
  readonly blocks?: readonly unknown[];
  readonly thread_ts?: string;
}

// ─── Per-method response configuration ────────────────────────────────────────

/**
 * Configuration for a single Slack API method's response behaviour.
 * Passed to `client.configureMethod(method, config)`.
 */
export interface SlackMethodConfig {
  /**
   * If set, the API returns `{ ok: false, error: '<code>' }`.
   * Use Slack documented error codes, e.g. 'channel_not_found', 'ratelimited'.
   */
  error?: string;
  /**
   * Adds a `Retry-After` header (seconds) to the response.
   * Relevant for `ratelimited` errors where callers inspect this header.
   */
  retryAfter?: string;
  /**
   * Override the `ts` value returned in chat.postMessage / chat.update
   * success responses.  Defaults to a monotonically increasing counter.
   */
  ts?: string;
}

/** Options for `configureChannel()`. */
export interface ChannelConfig {
  /** Whether the channel is private. Defaults to false. */
  isPrivate?: boolean;
  /** Whether the bot is a member of the channel. Defaults to true. */
  botIsMember?: boolean;
  /**
   * When set, `conversations.info` returns `{ ok: false, error: '<code>' }`
   * instead of the channel object.  Use 'channel_not_found' to simulate a
   * private channel the bot was never invited to.
   */
  error?: string;
}

// ─── Duck-typed fetch Response ────────────────────────────────────────────────

/** Minimal fetch Response duck-type used internally and in createSlackFetchMock(). */
export interface MockFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): MockFetchResponse {
  const body = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        const lc = name.toLowerCase();
        if (lc === 'content-type') return 'application/json; charset=utf-8';
        return extraHeaders[lc] ?? null;
      },
    },
    json: () => Promise.resolve(JSON.parse(body) as unknown),
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(Buffer.from(body).buffer as ArrayBuffer),
  };
}

function binaryResponse(data: Buffer): MockFetchResponse {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => name === 'content-type' ? 'application/octet-stream' : null },
    json: () => Promise.reject(new Error('not JSON')),
    text: () => Promise.resolve(data.toString()),
    arrayBuffer: () => Promise.resolve(data.buffer as ArrayBuffer),
  };
}

// ─── Monotonic timestamp generator ────────────────────────────────────────────

let _tsSeq = 10000;

/** Reset the timestamp sequence (called by MockSlackClient.reset()). */
function resetTsSeq(): void {
  _tsSeq = 10000;
}

/** Return the next unique Slack message timestamp. */
function nextTs(): string {
  _tsSeq += 1;
  return `${_tsSeq}.0001`;
}

// ─── MockSlackClient ──────────────────────────────────────────────────────────

/**
 * Mock Slack Web API client (digital twin).
 *
 * Intercepts every outbound `fetch` call made to `https://slack.com/api/*`
 * and `https://hooks.slack.com/*`.  Slack file CDN downloads from
 * `https://files.slack.com/*` return a one-byte binary payload.
 *
 * All other URLs fall through to a default "ok: true" response so tests do not
 * need to configure every dependency.
 *
 * Install once per suite:
 * ```ts
 * const slack = new MockSlackClient();
 * beforeEach(() => { slack.install(); slack.reset(); });
 * afterEach(() => slack.restore());
 * ```
 */
export class MockSlackClient {
  private _calls: SlackApiCall[] = [];
  private _methodConfig = new Map<string, SlackMethodConfig>();
  private _channelConfig: ChannelConfig = {};
  private _originalFetch: unknown = undefined;

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /** Replace `global.fetch` with the interceptor. */
  install(): void {
    this._originalFetch = (global as unknown as { fetch: unknown }).fetch;
    (global as unknown as { fetch: unknown }).fetch = this._interceptFetch.bind(this);
  }

  /** Restore `global.fetch` to its pre-install value. */
  restore(): void {
    (global as unknown as { fetch: unknown }).fetch = this._originalFetch;
    this._originalFetch = undefined;
  }

  /** Clear all recorded calls and reset method/channel config. Call in beforeEach. */
  reset(): void {
    this._calls = [];
    this._methodConfig = new Map();
    this._channelConfig = {};
    resetTsSeq();
  }

  // ─── Configuration ────────────────────────────────────────────────────────────

  /**
   * Set the response behaviour for a specific Slack API method.
   *
   * ```ts
   * // Make chat.postMessage return channel_not_found
   * slack.configureMethod('chat.postMessage', { error: 'channel_not_found' });
   *
   * // Make chat.postMessage return a rate-limit error with Retry-After: 30
   * slack.configureMethod('chat.postMessage', { error: 'ratelimited', retryAfter: '30' });
   *
   * // Override the ts returned by chat.postMessage
   * slack.configureMethod('chat.postMessage', { ts: '9999.0001' });
   * ```
   */
  configureMethod(method: string, config: SlackMethodConfig): this {
    this._methodConfig.set(method, config);
    return this;
  }

  /**
   * Configure the response for `conversations.info` calls.
   *
   * ```ts
   * // Private channel the bot is not in (causes channel-access denial)
   * slack.configureChannel({ isPrivate: true, botIsMember: false });
   *
   * // Hard error (bot never had access — Slack returns channel_not_found)
   * slack.configureChannel({ error: 'channel_not_found' });
   * ```
   */
  configureChannel(config: ChannelConfig): this {
    this._channelConfig = config;
    return this;
  }

  // ─── Introspection ────────────────────────────────────────────────────────────

  /** All recorded API calls in order. */
  calls(): readonly SlackApiCall[] {
    return this._calls;
  }

  /** All recorded calls to `method`. */
  callsTo(method: string): readonly SlackApiCall[] {
    return this._calls.filter(c => c.method === method);
  }

  /** Bodies of all `chat.postMessage` calls. */
  sentMessages(): readonly ChatPostMessageBody[] {
    return this.callsTo('chat.postMessage').map(c => c.body as ChatPostMessageBody);
  }

  /** Bodies of all `reactions.add` calls. */
  reactionsAdded(): readonly ReactionBody[] {
    return this.callsTo('reactions.add').map(c => c.body as ReactionBody);
  }

  /** Bodies of all `reactions.remove` calls. */
  reactionsRemoved(): readonly ReactionBody[] {
    return this.callsTo('reactions.remove').map(c => c.body as ReactionBody);
  }

  /** Bodies of all `chat.delete` calls. */
  deletedMessages(): readonly ChatDeleteBody[] {
    return this.callsTo('chat.delete').map(c => c.body as ChatDeleteBody);
  }

  /** Bodies of all `chat.update` calls. */
  updatedMessages(): readonly ChatUpdateBody[] {
    return this.callsTo('chat.update').map(c => c.body as ChatUpdateBody);
  }

  /** The most recent message sent via `chat.postMessage`, or `undefined`. */
  lastMessage(): ChatPostMessageBody | undefined {
    const msgs = this.sentMessages();
    return msgs[msgs.length - 1];
  }

  /**
   * Whether a reaction with `name` was added at any point.
   * Useful for asserting that the `:eyes:` reaction fires on @mention receipt.
   */
  hasReactionAdded(name: string): boolean {
    return this.reactionsAdded().some(r => r.name === name);
  }

  /**
   * Whether a reaction with `name` was removed at any point.
   */
  hasReactionRemoved(name: string): boolean {
    return this.reactionsRemoved().some(r => r.name === name);
  }

  /** The raw body POSTed to the response_url (slash command ephemeral reply). */
  responseUrlBodies(): readonly Record<string, unknown>[] {
    return this.callsTo('response_url').map(c => c.body);
  }

  // ─── Fetch interceptor ────────────────────────────────────────────────────────

  private _interceptFetch(url: string, init?: RequestInit): Promise<MockFetchResponse> {
    // Slack file CDN — file attachment downloads
    if (url.startsWith('https://files.slack.com/')) {
      this._calls.push({ method: 'file_download', body: { url }, timestamp: Date.now() });
      return Promise.resolve(binaryResponse(Buffer.from('mock-file-content')));
    }

    // Response URL — slash command ephemeral replies and interaction responses
    if (url.startsWith('https://hooks.slack.com/')) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch { /* swallow */ }
      this._calls.push({ method: 'response_url', body, timestamp: Date.now() });
      return Promise.resolve(jsonResponse({ ok: true }));
    }

    // Slack Web API — https://slack.com/api/{method}?querystring
    const apiMatch = /^https:\/\/slack\.com\/api\/([^?]+)/.exec(url);
    if (apiMatch) {
      const method = apiMatch[1];
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      } catch { /* swallow */ }
      this._calls.push({ method, body, timestamp: Date.now() });
      return Promise.resolve(this._responseForMethod(method, body));
    }

    // Anything else — permissive default so unrelated deps don't break
    return Promise.resolve(jsonResponse({ ok: true }));
  }

  private _responseForMethod(method: string, _body: Record<string, unknown>): MockFetchResponse {
    // conversations.info uses its own channel config, not the generic method config
    if (method === 'conversations.info') {
      return this._conversationsInfoResponse();
    }

    const config = this._methodConfig.get(method);

    if (config?.error) {
      const headers: Record<string, string> = {};
      if (config.retryAfter) headers['retry-after'] = config.retryAfter;
      return jsonResponse({ ok: false, error: config.error }, 200, headers);
    }

    const ts = config?.ts ?? nextTs();

    switch (method) {
      case 'chat.postMessage':
      case 'chat.update':
        return jsonResponse({ ok: true, ts, channel: (_body.channel as string | undefined) ?? 'C1' });
      case 'chat.delete':
        return jsonResponse({ ok: true, channel: (_body.channel as string | undefined) ?? 'C1', ts: (_body.ts as string | undefined) ?? ts });
      case 'reactions.add':
      case 'reactions.remove':
        return jsonResponse({ ok: true });
      default:
        return jsonResponse({ ok: true, ts });
    }
  }

  private _conversationsInfoResponse(): MockFetchResponse {
    const cfg = this._channelConfig;

    if (cfg.error) {
      return jsonResponse({ ok: false, error: cfg.error });
    }

    return jsonResponse({
      ok: true,
      channel: {
        id: 'C1',
        name: 'general',
        is_private: cfg.isPrivate ?? false,
        is_member: cfg.botIsMember ?? true,
      },
    });
  }
}

// ─── Signing helpers ──────────────────────────────────────────────────────────

/** Default signing secret used by the factory helpers. */
export const DEFAULT_SIGNING_SECRET = 'test-signing-secret-digital-twin';

/**
 * Compute a valid `X-Slack-Signature` header for the given body and timestamp.
 *
 * @param body - Raw request body string.
 * @param signingSecret - Slack app signing secret.
 * @param timestamp - Unix timestamp string; defaults to `Math.floor(Date.now()/1000)`.
 * @returns The `v0=<hex>` signature value.
 */
export function signSlackRequest(
  body: string,
  signingSecret = DEFAULT_SIGNING_SECRET,
  timestamp = String(Math.floor(Date.now() / 1000)),
): string {
  return 'v0=' + crypto.createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex');
}

/**
 * Build the `X-Slack-Signature` and `X-Slack-Request-Timestamp` header pair
 * for a given body.
 *
 * @param body - Raw request body string.
 * @param signingSecret - Slack app signing secret.
 * @returns `{ 'X-Slack-Signature': '...', 'X-Slack-Request-Timestamp': '...' }`
 */
export function slackSignatureHeaders(
  body: string,
  signingSecret = DEFAULT_SIGNING_SECRET,
): { 'X-Slack-Signature': string; 'X-Slack-Request-Timestamp': string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'X-Slack-Signature': signSlackRequest(body, signingSecret, timestamp),
    'X-Slack-Request-Timestamp': timestamp,
  };
}

// ─── APIGatewayProxyEvent builder ─────────────────────────────────────────────

/** Shared base options for all event factories. */
interface BaseEventOptions {
  /** Override or add headers. Signing headers are computed automatically unless overridden. */
  headers?: Record<string, string>;
  /** Signing secret to use. Defaults to `DEFAULT_SIGNING_SECRET`. */
  signingSecret?: string;
  /** Explicitly set the retry number header (simulates Slack retries). */
  retryNum?: string;
}

function buildApiGwEvent(
  body: string,
  path: string,
  extraHeaders: Record<string, string>,
  options: BaseEventOptions,
): APIGatewayProxyEvent {
  const signingSecret = options.signingSecret ?? DEFAULT_SIGNING_SECRET;
  const sigHeaders = slackSignatureHeaders(body, signingSecret);
  const headers: Record<string, string> = {
    ...sigHeaders,
    ...(options.retryNum ? { 'X-Slack-Retry-Num': options.retryNum, 'X-Slack-Retry-Reason': 'http_timeout' } : {}),
    ...extraHeaders,
    ...options.headers,
  };
  return {
    body,
    headers,
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as APIGatewayProxyEvent['requestContext'],
    resource: '',
  };
}

// ─── Inbound event factory helpers ────────────────────────────────────────────

// ── URL verification ──────────────────────────────────────────────────────────

/** Options for `urlVerificationEvent()`. */
export interface UrlVerificationOptions extends BaseEventOptions {
  /** The challenge string Slack sends. Defaults to `'challenge-abc123'`. */
  challenge?: string;
}

/**
 * Build a signed `url_verification` event (Slack sends this when configuring
 * the Events API endpoint URL).
 *
 * @param options - Override challenge or signing secret.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-events handler.
 */
export function urlVerificationEvent(options: UrlVerificationOptions = {}): APIGatewayProxyEvent {
  const body = JSON.stringify({
    type: 'url_verification',
    challenge: options.challenge ?? 'challenge-abc123',
    token: 'deprecated-verification-token',
  });
  return buildApiGwEvent(body, '/v1/slack/events', {}, options);
}

// ── App mention (@mention in channel) ────────────────────────────────────────

/** Fields that describe the inner `event` object of an app_mention event_callback. */
export interface AppMentionEventFields {
  /** Slack user ID of the mentioning user. Defaults to `'U_TESTER'`. */
  user?: string;
  /** Channel where the mention occurred. Defaults to `'C_GENERAL'`. */
  channel?: string;
  /** Raw message text including the `<@BOT_ID>` prefix. Defaults to `'<@U_BOT> submit org/repo fix it'`. */
  text?: string;
  /** Message timestamp. Defaults to `'1700000001.000100'`. */
  ts?: string;
  /** Parent thread timestamp (set when mention is inside a thread). */
  thread_ts?: string;
  /** File attachments on the message. */
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    size: number;
    url_private_download: string;
  }>;
}

/** Options for `appMentionEvent()`. */
export interface AppMentionEventOptions extends BaseEventOptions {
  /** Override any fields of the inner event object. */
  event?: AppMentionEventFields;
  /** Slack team ID. Defaults to `'T_TEAM'`. */
  teamId?: string;
}

/**
 * Build a signed `event_callback` / `app_mention` event — the shape Slack
 * sends when a user @-mentions the bot in a channel.
 *
 * The generated text defaults to `<@U_BOT> submit org/repo fix it` so it
 * exercises the task-submission path without extra configuration.
 *
 * @param options - Override event fields, team ID, or signing secret.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-events handler.
 */
export function appMentionEvent(options: AppMentionEventOptions = {}): APIGatewayProxyEvent {
  const ev = options.event ?? {};
  const innerEvent: Record<string, unknown> = {
    type: 'app_mention',
    user: ev.user ?? 'U_TESTER',
    channel: ev.channel ?? 'C_GENERAL',
    text: ev.text ?? '<@U_BOT> submit org/repo fix it',
    ts: ev.ts ?? '1700000001.000100',
  };
  if (ev.thread_ts) innerEvent.thread_ts = ev.thread_ts;
  if (ev.files) innerEvent.files = ev.files;

  const body = JSON.stringify({
    type: 'event_callback',
    team_id: options.teamId ?? 'T_TEAM',
    event: innerEvent,
  });
  return buildApiGwEvent(body, '/v1/slack/events', {}, options);
}

// ── Thread reply (@mention in a thread) ─────────────────────────────────────

/** Options for `threadMentionEvent()`. */
export interface ThreadMentionEventOptions extends BaseEventOptions {
  /** Inner event field overrides. */
  event?: AppMentionEventFields;
  /** Slack team ID. Defaults to `'T_TEAM'`. */
  teamId?: string;
  /**
   * Parent thread timestamp.  The generated event automatically sets
   * `thread_ts` to this value (or `'1700000000.000100'` when omitted).
   */
  parentTs?: string;
}

/**
 * Build a signed `app_mention` event that arrives inside a thread — i.e.
 * where `thread_ts` differs from `ts`.  Models the "reply to an existing task
 * thread" pattern.
 *
 * @param options - Override event fields or parent timestamp.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-events handler.
 */
export function threadMentionEvent(options: ThreadMentionEventOptions = {}): APIGatewayProxyEvent {
  const parentTs = options.parentTs ?? '1700000000.000100';
  return appMentionEvent({
    ...options,
    event: {
      ...(options.event ?? {}),
      thread_ts: options.event?.thread_ts ?? parentTs,
      ts: options.event?.ts ?? '1700000002.000200',
    },
  });
}

// ── Direct message (DM to bot) ───────────────────────────────────────────────

/** Options for `directMessageEvent()`. */
export interface DirectMessageEventOptions extends BaseEventOptions {
  /** Inner event field overrides. */
  event?: Omit<AppMentionEventFields, 'channel'>;
  /** Slack team ID. Defaults to `'T_TEAM'`. */
  teamId?: string;
  /** DM channel ID. Must start with `'D'`. Defaults to `'D_DM_CHANNEL'`. */
  dmChannelId?: string;
}

/**
 * Build a signed `event_callback` / `message` event in a DM channel (the
 * channel_type is `im`).  Exercises the DM-to-bot path that `slack-events.ts`
 * routes the same way as an app_mention.
 *
 * @param options - Override event fields or DM channel ID.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-events handler.
 */
export function directMessageEvent(options: DirectMessageEventOptions = {}): APIGatewayProxyEvent {
  const ev = options.event ?? {};
  const channelId = options.dmChannelId ?? 'D_DM_CHANNEL';

  const body = JSON.stringify({
    type: 'event_callback',
    team_id: options.teamId ?? 'T_TEAM',
    event: {
      type: 'message',
      channel_type: 'im',
      user: ev.user ?? 'U_TESTER',
      channel: channelId,
      text: ev.text ?? '<@U_BOT> submit org/repo fix it',
      ts: ev.ts ?? '1700000001.000100',
    },
  });
  return buildApiGwEvent(body, '/v1/slack/events', {}, options);
}

// ── Slash command ─────────────────────────────────────────────────────────────

/** Fields of the URL-encoded slash command payload. */
export interface SlashCommandFields {
  /** The slash command, e.g. `'/bgagent'`. Defaults to `'/bgagent'`. */
  command?: string;
  /** Text after the command, e.g. `'link'` or `'help'`. Defaults to `'link'`. */
  text?: string;
  /** User ID. Defaults to `'U_TESTER'`. */
  user_id?: string;
  /** User name. Defaults to `'tester'`. */
  user_name?: string;
  /** Team ID. Defaults to `'T_TEAM'`. */
  team_id?: string;
  /** Team domain. Defaults to `'acme'`. */
  team_domain?: string;
  /** Channel ID. Defaults to `'C_GENERAL'`. */
  channel_id?: string;
  /** Channel name. Defaults to `'general'`. */
  channel_name?: string;
  /** Trigger ID. Defaults to `'TRIG.1.abc'`. */
  trigger_id?: string;
  /**
   * `response_url` for posting ephemeral replies back.
   * Defaults to `'https://hooks.slack.com/commands/T_TEAM/CMD_TOKEN'`.
   */
  response_url?: string;
}

/** Options for `slashCommandEvent()`. */
export interface SlashCommandEventOptions extends BaseEventOptions {
  /** Override any fields of the slash command payload. */
  payload?: SlashCommandFields;
}

/**
 * Build a signed slash command event (URL-encoded body) — what Slack sends
 * when a user invokes `/bgagent <subcommand>`.
 *
 * The `response_url` points to `hooks.slack.com` so that any replies go
 * through the mock's response_url interceptor.
 *
 * @param options - Override command fields or signing secret.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-commands handler.
 */
export function slashCommandEvent(options: SlashCommandEventOptions = {}): APIGatewayProxyEvent {
  const f = options.payload ?? {};
  const params = new URLSearchParams({
    command: f.command ?? '/bgagent',
    text: f.text ?? 'link',
    user_id: f.user_id ?? 'U_TESTER',
    user_name: f.user_name ?? 'tester',
    team_id: f.team_id ?? 'T_TEAM',
    team_domain: f.team_domain ?? 'acme',
    channel_id: f.channel_id ?? 'C_GENERAL',
    channel_name: f.channel_name ?? 'general',
    trigger_id: f.trigger_id ?? 'TRIG.1.abc',
    response_url: f.response_url ?? 'https://hooks.slack.com/commands/T_TEAM/CMD_TOKEN',
  });
  const body = params.toString();
  return buildApiGwEvent(body, '/v1/slack/commands', {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, options);
}

// ── Block Kit button click ────────────────────────────────────────────────────

/** Fields of the Block Kit interaction payload. */
export interface BlockActionFields {
  /**
   * The `action_id` of the clicked button, e.g. `'cancel_task:task-123'`.
   * Defaults to `'cancel_task:task-PLACEHOLDER'`.
   */
  action_id?: string;
  /** `block_id` of the actions block. Defaults to `'task-PLACEHOLDER'`. */
  block_id?: string;
  /** Interacting user ID. Defaults to `'U_TESTER'`. */
  user_id?: string;
  /** Interacting user name. Defaults to `'tester'`. */
  user_name?: string;
  /** Team ID. Defaults to `'T_TEAM'`. */
  team_id?: string;
  /** Channel ID where the interaction originated. Defaults to `'C_GENERAL'`. */
  channel_id?: string;
  /**
   * `response_url` for posting ephemeral replies.
   * Defaults to `'https://hooks.slack.com/actions/T_TEAM/ACT_TOKEN'`.
   */
  response_url?: string;
  /** Trigger ID. Defaults to `'TRIG.2.def'`. */
  trigger_id?: string;
  /** Optional button value (passed through as `actions[].value`). */
  value?: string;
}

/** Options for `buttonClickEvent()`. */
export interface ButtonClickEventOptions extends BaseEventOptions {
  /** Override any fields of the block_actions payload. */
  action?: BlockActionFields;
}

/**
 * Build a signed Block Kit `block_actions` interaction event — what Slack
 * sends when a user clicks a button in a message (e.g. the "Cancel Task"
 * danger button).
 *
 * The body is URL-encoded `payload=<JSON>` per the Slack interactivity spec.
 *
 * @param options - Override action fields or signing secret.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-interactions handler.
 */
export function buttonClickEvent(options: ButtonClickEventOptions = {}): APIGatewayProxyEvent {
  const f = options.action ?? {};
  const actionId = f.action_id ?? 'cancel_task:task-PLACEHOLDER';
  const blockId = f.block_id ?? actionId.replace(':', '-');

  const interactionPayload = {
    type: 'block_actions',
    user: {
      id: f.user_id ?? 'U_TESTER',
      username: f.user_name ?? 'tester',
      team_id: f.team_id ?? 'T_TEAM',
    },
    channel: { id: f.channel_id ?? 'C_GENERAL', name: 'general' },
    response_url: f.response_url ?? 'https://hooks.slack.com/actions/T_TEAM/ACT_TOKEN',
    trigger_id: f.trigger_id ?? 'TRIG.2.def',
    actions: [{
      action_id: actionId,
      block_id: blockId,
      type: 'button',
      ...(f.value !== undefined ? { value: f.value } : {}),
    }],
    // token is deprecated but present in real payloads for compatibility
    token: 'deprecated-verification-token',
  };

  const body = `payload=${encodeURIComponent(JSON.stringify(interactionPayload))}`;
  return buildApiGwEvent(body, '/v1/slack/interactions', {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, options);
}

// ── App uninstalled / tokens revoked events ───────────────────────────────────

/** Options for `appUninstalledEvent()` and `tokensRevokedEvent()`. */
export interface RevocationEventOptions extends BaseEventOptions {
  /** Team ID. Defaults to `'T_TEAM'`. */
  teamId?: string;
}

/**
 * Build a signed `app_uninstalled` event — what Slack sends when a workspace
 * admin uninstalls the app.  Exercises the `revokeInstallation()` path in
 * `slack-events.ts`.
 *
 * @param options - Override team ID or signing secret.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-events handler.
 */
export function appUninstalledEvent(options: RevocationEventOptions = {}): APIGatewayProxyEvent {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: options.teamId ?? 'T_TEAM',
    event: { type: 'app_uninstalled' },
  });
  return buildApiGwEvent(body, '/v1/slack/events', {}, options);
}

/**
 * Build a signed `tokens_revoked` event — what Slack sends when tokens are
 * revoked (e.g. via the OAuth revocation API).
 *
 * @param options - Override team ID or signing secret.
 * @returns A signed `APIGatewayProxyEvent` ready for the slack-events handler.
 */
export function tokensRevokedEvent(options: RevocationEventOptions = {}): APIGatewayProxyEvent {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: options.teamId ?? 'T_TEAM',
    event: {
      type: 'tokens_revoked',
      tokens: { oauth: [], bot: ['xoxb-revoked'] },
    },
  });
  return buildApiGwEvent(body, '/v1/slack/events', {}, options);
}

// ─── Mock for global.fetch (drop-in for existing test patterns) ───────────────

/**
 * Create a `jest.fn()` pre-configured with realistic Slack API success
 * responses.  Drop-in replacement for the raw `fetchMock.mockResolvedValue`
 * pattern used throughout the existing test files.
 *
 * ```ts
 * const fetchMock = createSlackFetchMock();
 * (global as unknown as { fetch: unknown }).fetch = fetchMock;
 *
 * beforeEach(() => {
 *   fetchMock.mockReset();
 *   // Responses are re-applied after each reset:
 *   applySlackFetchDefaults(fetchMock);
 * });
 * ```
 *
 * @returns A `jest.fn()` that returns a Slack-shaped fetch response by default.
 */
export function createSlackFetchMock(): jest.Mock {
  const mock = jest.fn();
  applySlackFetchDefaults(mock);
  return mock;
}

/**
 * Apply default Slack API success responses to an existing `jest.fn()`.
 * Call this in `beforeEach` after `mockReset()` to keep the defaults active.
 *
 * The default implementation routes by URL:
 * - `chat.postMessage` / `chat.update` → `{ ok: true, ts: '1234.0001' }`
 * - `reactions.add` / `reactions.remove` / others → `{ ok: true }`
 * - `conversations.info` → `{ ok: true, channel: { is_private: false, is_member: true } }`
 * - `hooks.slack.com` response URLs → plain 200
 *
 * @param mock - The jest.fn() to configure.
 */
export function applySlackFetchDefaults(mock: jest.Mock): void {
  mock.mockImplementation(async (url: string) => {
    if (String(url).includes('conversations.info')) {
      return {
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
        text: () => Promise.resolve(''),
        arrayBuffer: () => Promise.resolve(Buffer.from('').buffer as ArrayBuffer),
      };
    }
    if (
      String(url).includes('chat.postMessage') ||
      String(url).includes('chat.update')
    ) {
      return {
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ ok: true, ts: '1234.0001', channel: 'C1' }),
        text: () => Promise.resolve(''),
        arrayBuffer: () => Promise.resolve(Buffer.from('').buffer as ArrayBuffer),
      };
    }
    if (String(url).startsWith('https://files.slack.com/')) {
      return {
        ok: true,
        headers: { get: () => null },
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('mock-file'),
        arrayBuffer: () => Promise.resolve(Buffer.from('mock-file-content').buffer as ArrayBuffer),
      };
    }
    return {
      ok: true,
      headers: { get: () => null },
      json: () => Promise.resolve({ ok: true }),
      text: () => Promise.resolve(''),
      arrayBuffer: () => Promise.resolve(Buffer.from('').buffer as ArrayBuffer),
    };
  });
}

// ─── Secrets Manager stub helper ─────────────────────────────────────────────

/**
 * Return a pre-configured `smSend` mock implementation suitable for tests
 * that exercise signed Slack endpoints.
 *
 * Matches the signing secret against `DEFAULT_SIGNING_SECRET` for any
 * `GetSecretValueCommand` call so that `verifySlackRequest()` passes on events
 * produced by this module's factory helpers.
 *
 * Usage:
 * ```ts
 * const smSend = jest.fn();
 * jest.mock('@aws-sdk/client-secrets-manager', () => ({
 *   SecretsManagerClient: jest.fn(() => ({ send: smSend })),
 *   GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
 * }));
 *
 * beforeEach(() => {
 *   smSend.mockReset();
 *   smSend.mockImplementation(slackSmSendImpl());
 * });
 * ```
 *
 * @param signingSecret - The signing secret to return. Defaults to `DEFAULT_SIGNING_SECRET`.
 * @returns An async mock implementation function.
 */
export function slackSmSendImpl(
  signingSecret = DEFAULT_SIGNING_SECRET,
): (cmd: { _type: string }) => Promise<{ SecretString: string }> {
  return async (cmd: { _type: string }) => {
    if (cmd._type === 'GetSecretValue') return { SecretString: signingSecret };
    return { SecretString: '' };
  };
}

// ─── Convenience: pre-assembled test doubles ─────────────────────────────────

/**
 * Build a complete set of test doubles for Slack handler tests.
 *
 * Returns `{ slack, smImpl }` where:
 * - `slack` is a `MockSlackClient` (not yet installed — call `slack.install()`)
 * - `smImpl` is a `smSend` implementation that returns the matching signing secret
 *
 * This is the recommended entry point for new test files.
 *
 * ```ts
 * const { slack, smImpl } = createSlackTestDoubles();
 *
 * const smSend = jest.fn();
 * jest.mock('@aws-sdk/client-secrets-manager', () => ({
 *   SecretsManagerClient: jest.fn(() => ({ send: smSend })),
 *   GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
 *   DeleteSecretCommand: jest.fn((input: unknown) => ({ _type: 'DeleteSecret', input })),
 * }));
 *
 * beforeEach(() => {
 *   slack.install();
 *   slack.reset();
 *   smSend.mockReset();
 *   smSend.mockImplementation(smImpl);
 * });
 * afterEach(() => slack.restore());
 * ```
 */
export function createSlackTestDoubles(signingSecret = DEFAULT_SIGNING_SECRET): {
  slack: MockSlackClient;
  smImpl: (cmd: { _type: string }) => Promise<{ SecretString: string }>;
} {
  return {
    slack: new MockSlackClient(),
    smImpl: slackSmSendImpl(signingSecret),
  };
}
