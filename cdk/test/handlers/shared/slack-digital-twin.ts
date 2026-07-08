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
 * Slack Digital Twin — local mock of the Slack Web API for CI testing.
 *
 * This harness intercepts every outbound `fetch()` call to `https://slack.com/api/*`
 * and records what was sent, returning realistic response shapes, rate-limit
 * headers, and error payloads that mirror the real Slack Web API surface.
 *
 * ## What it provides
 *
 * 1. **MockSlackWebClient** — intercepts `global.fetch` and tracks all
 *    `chat.postMessage`, `reactions.add/remove`, `conversations.replies`,
 *    and other Web API calls. Provides typed assertion helpers.
 *
 * 2. **Event payload factories** — `slackMention()`, `slashCommand()`,
 *    `threadReply()`, `buttonClick()`, `dmMessage()`, `fileShare()` —
 *    produce fully-valid Slack Events API / Block Kit Interactivity payloads
 *    ready to feed into handler tests.
 *
 * 3. **APIGatewayProxyEvent factories** — `signedEventsApiEvent()`,
 *    `signedCommandEvent()`, `signedInteractionEvent()` — wrap the above
 *    payloads in correctly-signed Lambda proxy events.
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   MockSlackWebClient,
 *   slackMention,
 *   signedEventsApiEvent,
 * } from '../shared/slack-digital-twin';
 *
 * let slack: MockSlackWebClient;
 * beforeEach(() => { slack = new MockSlackWebClient(); });
 * afterEach(() => { slack.restore(); });
 *
 * test('forwards mention and posts :eyes: reaction', async () => {
 *   const event = signedEventsApiEvent(
 *     slackMention({ text: '<@UBOT> fix the bug in org/repo', teamId: 'T1' }),
 *     SIGNING_SECRET,
 *   );
 *   await handler(event);
 *   expect(slack.reactionsAdded()).toContainEqual(
 *     expect.objectContaining({ name: 'eyes' }),
 *   );
 * });
 * ```
 *
 * ## Design decisions
 *
 * - The mock intercepts `global.fetch` using `jest.spyOn` so it is
 *   automatically undone by `restore()` without polluting other tests.
 * - Every API response mirrors the real Slack JSON shape (including
 *   `ok: true/false` and typed `error` codes from the Web API docs).
 * - Rate-limit responses include `Retry-After` and `X-RateLimit-*` headers
 *   matching Slack's actual header contract.
 * - Timestamps use a monotonically-increasing counter so tests can assert
 *   ordering without relying on wall-clock time.
 * - All factory helpers accept a `Partial<>` overrides bag so tests only
 *   need to specify the fields they care about.
 */

import * as crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Types mirroring the real Slack Web API ──────────────────────────────────

/** Slack message object returned by chat.postMessage and conversations.replies. */
export interface SlackMessage {
  /** Channel or DM the message was posted to. */
  readonly channel: string;
  /** Slack message timestamp (e.g. "1234567890.001234"). */
  readonly ts: string;
  /** Thread parent timestamp — present for threaded replies. */
  readonly thread_ts?: string;
  /** Mrkdwn or plain-text body. */
  readonly text?: string;
  /** Block Kit blocks payload. */
  readonly blocks?: readonly unknown[];
  /** Response URL (ephemeral messages posted to response_url). */
  readonly response_url?: string;
  /** User that sent the message. */
  readonly user?: string;
  /** Bot id when posted by a bot. */
  readonly bot_id?: string;
}

/** A recorded reaction.add or reactions.remove call. */
export interface SlackReaction {
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
}

/** A recorded reactions.remove call. */
export interface SlackReactionRemoval extends SlackReaction {
  // Same shape — distinct type for ergonomic filtering.
}

/** A recorded conversations.replies call. */
export interface SlackRepliesRequest {
  readonly channel: string;
  readonly ts: string;
  readonly limit?: number;
}

/** Shape of a real Slack `chat.postMessage` response body. */
export interface ChatPostMessageResponse {
  readonly ok: true;
  readonly channel: string;
  readonly ts: string;
  readonly message: {
    readonly text?: string;
    readonly blocks?: readonly unknown[];
    readonly ts: string;
    readonly thread_ts?: string;
    readonly bot_id: string;
    readonly type: 'message';
  };
}

/** Slack Web API error response. */
export interface SlackApiErrorResponse {
  readonly ok: false;
  readonly error: string;
}

/** Union of all Slack Web API responses the twin can emit. */
export type SlackApiResponse = ChatPostMessageResponse | SlackApiErrorResponse | { readonly ok: boolean; [key: string]: unknown };

/**
 * Slack Events API `event_callback` wrapper.
 * @see https://api.slack.com/apis/connections/events-api#payload
 */
export interface SlackEventCallbackPayload {
  readonly token: string;
  readonly team_id: string;
  readonly api_app_id: string;
  readonly event: SlackEventInner;
  readonly type: 'event_callback';
  readonly event_id: string;
  readonly event_time: number;
  readonly authorizations?: readonly SlackAuthorization[];
}

/** Inner event object. */
export interface SlackEventInner {
  readonly type: string;
  readonly user?: string;
  readonly text?: string;
  readonly channel?: string;
  readonly channel_type?: string;
  readonly ts?: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFileAttachment[];
  readonly bot_id?: string;
  readonly [key: string]: unknown;
}

/** Slack OAuth authorization context embedded in event payloads. */
export interface SlackAuthorization {
  readonly enterprise_id: string | null;
  readonly team_id: string;
  readonly user_id: string;
  readonly is_bot: boolean;
  readonly is_enterprise_install: boolean;
}

/** File attachment object matching the Slack Events API file share schema. */
export interface SlackFileAttachment {
  readonly id: string;
  readonly created: number;
  readonly timestamp: number;
  readonly name: string;
  readonly title: string;
  readonly mimetype: string;
  readonly filetype: string;
  readonly pretty_type: string;
  readonly user: string;
  readonly editable: boolean;
  readonly size: number;
  readonly mode: string;
  readonly is_external: boolean;
  readonly is_public: boolean;
  readonly public_url_shared: boolean;
  readonly display_as_bot: boolean;
  readonly username: string;
  readonly url_private: string;
  readonly url_private_download: string;
  readonly permalink: string;
  readonly permalink_public: string;
}

/**
 * Slack slash-command form body.
 * @see https://api.slack.com/interactivity/slash-commands#app_command_handling
 */
export interface SlackSlashCommandBody {
  readonly command: string;
  readonly text: string;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly user_id: string;
  readonly user_name: string;
  readonly team_id: string;
  readonly team_domain: string;
  readonly channel_id: string;
  readonly channel_name: string;
  readonly api_app_id: string;
  readonly is_enterprise_install: 'false' | 'true';
}

/**
 * Slack Block Kit interaction payload.
 * @see https://api.slack.com/reference/interaction-payloads/block-actions
 */
export interface SlackBlockActionsPayload {
  readonly type: 'block_actions';
  readonly team: { readonly id: string; readonly domain: string };
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  readonly api_app_id: string;
  readonly token: string;
  readonly container: {
    readonly type: 'message';
    readonly message_ts: string;
    readonly channel_id: string;
    readonly is_ephemeral: boolean;
  };
  readonly trigger_id: string;
  readonly channel: { readonly id: string; readonly name: string };
  readonly message: {
    readonly type: 'message';
    readonly text: string;
    readonly ts: string;
    readonly thread_ts?: string;
    readonly blocks: readonly unknown[];
  };
  readonly response_url: string;
  readonly actions: readonly SlackBlockAction[];
}

/** Single action element inside a block_actions payload. */
export interface SlackBlockAction {
  readonly type: 'button';
  readonly action_id: string;
  readonly block_id: string;
  readonly action_ts: string;
  readonly value?: string;
  readonly text: { readonly type: 'plain_text'; readonly text: string; readonly emoji: boolean };
  readonly style?: 'primary' | 'danger';
}

// ─── Timestamp counter (monotonic, independent of wall clock) ─────────────────

let _tsCounter = 1_700_000_000_000;

/** Generate a Slack-style message timestamp ("unix_seconds.microseconds"). */
export function nextTs(): string {
  _tsCounter += 1_337; // fixed increment — fully deterministic after resetTsCounter()
  return `${Math.floor(_tsCounter / 1000)}.${String(_tsCounter % 1000).padStart(6, '0')}`;
}

/** Reset the monotonic timestamp counter (call in beforeEach for determinism). */
export function resetTsCounter(): void {
  _tsCounter = 1_700_000_000_000;
}

// ─── MockSlackWebClient ──────────────────────────────────────────────────────

/**
 * Options for constructing a MockSlackWebClient.
 */
export interface MockSlackWebClientOptions {
  /**
   * Default response returned for any method not given a specific stub.
   * Defaults to `{ ok: true }`.
   */
  readonly defaultResponse?: SlackApiResponse;
  /**
   * Map of Slack Web API methods to the responses they should return.
   * The value may be a single response (returned for every call) or an
   * array of responses consumed one-by-one (the last is repeated when the
   * array is exhausted).
   */
  readonly methodResponses?: Partial<Record<string, SlackApiResponse | readonly SlackApiResponse[]>>;
  /**
   * When true, `chat.postMessage` auto-generates a `ts` in the response.
   * Defaults to true.
   */
  readonly autoGenerateTs?: boolean;
}

/**
 * A record of a single outbound Slack Web API call captured by the mock.
 */
export interface CapturedSlackCall {
  readonly method: string;
  readonly botToken: string;
  readonly body: Record<string, unknown>;
  readonly responseStatus: number;
  readonly response: SlackApiResponse;
}

/**
 * MockSlackWebClient intercepts `global.fetch` calls destined for
 * `https://slack.com/api/*`, records them, and returns configurable
 * responses mirroring the real Slack Web API.
 *
 * Install by constructing the object; uninstall by calling `restore()`.
 */
export class MockSlackWebClient {
  private readonly _calls: CapturedSlackCall[] = [];
  private readonly _options: Required<MockSlackWebClientOptions>;
  private readonly _methodCallCounts: Map<string, number> = new Map();
  private readonly _originalFetch: typeof global.fetch;
  private readonly _spy: jest.SpyInstance;

  constructor(options: MockSlackWebClientOptions = {}) {
    this._options = {
      defaultResponse: options.defaultResponse ?? { ok: true },
      methodResponses: options.methodResponses ?? {},
      autoGenerateTs: options.autoGenerateTs ?? true,
    };

    // Intercept global.fetch
    this._originalFetch = global.fetch;
    this._spy = jest.spyOn(global, 'fetch').mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        return this._handleFetch(input, init);
      },
    );
  }

  // ── Internal fetch interceptor ──────────────────────────────────────────

  private async _handleFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

    if (!url.startsWith('https://slack.com/api/')) {
      // Pass non-Slack requests through to the original fetch.
      return this._originalFetch(input as Parameters<typeof fetch>[0], init);
    }

    const method = url.replace('https://slack.com/api/', '').split('?')[0];
    const botToken = this._extractBotToken(init?.headers);
    const body = this._parseBody(init?.body ?? null);

    const response = this._responseFor(method, body);
    const statusCode = this._statusCodeFor(response);

    this._calls.push({ method, botToken, body, responseStatus: statusCode, response });
    const count = (this._methodCallCounts.get(method) ?? 0) + 1;
    this._methodCallCounts.set(method, count);

    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'X-RateLimit-Limit': '1',
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
    });

    // If this is a rate-limit error, add Retry-After matching Slack's real header.
    if (!response.ok && (response as SlackApiErrorResponse).error === 'ratelimited') {
      headers.set('Retry-After', '30');
    }

    return new Response(JSON.stringify(response), {
      status: statusCode,
      headers,
    });
  }

  private _extractBotToken(headers: HeadersInit | undefined): string {
    if (!headers) return '';
    if (headers instanceof Headers) return headers.get('Authorization')?.replace('Bearer ', '') ?? '';
    if (Array.isArray(headers)) {
      const auth = headers.find(([k]) => k.toLowerCase() === 'authorization');
      return auth ? String(auth[1]).replace('Bearer ', '') : '';
    }
    const obj = headers as Record<string, string>;
    return (obj.Authorization ?? obj.authorization ?? '').replace('Bearer ', '');
  }

  private _parseBody(body: BodyInit | null): Record<string, unknown> {
    if (!body) return {};
    if (typeof body === 'string') {
      try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; }
    }
    if (body instanceof URLSearchParams) {
      const obj: Record<string, unknown> = {};
      body.forEach((v, k) => { obj[k] = v; });
      return obj;
    }
    return {};
  }

  private _responseFor(method: string, body: Record<string, unknown>): SlackApiResponse {
    const stubEntry = this._options.methodResponses[method];
    if (stubEntry !== undefined) {
      if (Array.isArray(stubEntry)) {
        const arr = stubEntry as readonly SlackApiResponse[];
        const idx = Math.min(this._methodCallCounts.get(method) ?? 0, arr.length - 1);
        const r = arr[idx];
        if (r !== undefined) return this._enrichResponse(method, body, r);
      } else {
        return this._enrichResponse(method, body, stubEntry as SlackApiResponse);
      }
    }
    return this._enrichResponse(method, body, this._options.defaultResponse);
  }

  /**
   * Enrich a response with auto-generated fields (e.g. `ts` for chat.postMessage).
   */
  private _enrichResponse(
    method: string,
    body: Record<string, unknown>,
    base: SlackApiResponse,
  ): SlackApiResponse {
    if (!base.ok) return base;

    if (method === 'chat.postMessage' && this._options.autoGenerateTs) {
      const ts = nextTs();
      return {
        ok: true,
        channel: String(body.channel ?? 'C_UNKNOWN'),
        ts,
        message: {
          type: 'message',
          text: typeof body.text === 'string' ? body.text : undefined,
          blocks: Array.isArray(body.blocks) ? body.blocks : undefined,
          ts,
          thread_ts: typeof body.thread_ts === 'string' ? body.thread_ts : undefined,
          bot_id: 'BTEST',
        },
      } satisfies ChatPostMessageResponse;
    }

    if (method === 'chat.update' && this._options.autoGenerateTs) {
      return {
        ok: true,
        channel: String(body.channel ?? 'C_UNKNOWN'),
        ts: String(body.ts ?? nextTs()),
        text: body.text ?? '',
      };
    }

    if (method === 'conversations.replies') {
      return {
        ok: true,
        messages: [],
        has_more: false,
      };
    }

    if (method === 'conversations.info') {
      return {
        ok: true,
        channel: {
          id: String(body.channel ?? 'C1'),
          name: 'general',
          is_channel: true,
          is_private: false,
          is_member: true,
          is_archived: false,
          created: 1_700_000_000,
          creator: 'U1',
          topic: { value: '', creator: '', last_set: 0 },
          purpose: { value: '', creator: '', last_set: 0 },
        },
      };
    }

    if (method === 'users.info') {
      const userId = String(body.user ?? 'U1');
      return {
        ok: true,
        user: {
          id: userId,
          name: 'testuser',
          real_name: 'Test User',
          profile: {
            display_name: 'testuser',
            real_name: 'Test User',
            email: 'testuser@example.com',
          },
          is_bot: false,
          is_app_user: false,
          team_id: 'T1',
        },
      };
    }

    return { ...base };
  }

  private _statusCodeFor(response: SlackApiResponse): number {
    if (!response.ok) {
      const err = (response as SlackApiErrorResponse).error;
      if (err === 'ratelimited') return 429;
      // All other Slack errors come back as HTTP 200 with ok:false per the API contract
      return 200;
    }
    return 200;
  }

  // ── Public assertion helpers ─────────────────────────────────────────────

  /** All captured calls, in order. */
  calls(): readonly CapturedSlackCall[] {
    return this._calls;
  }

  /** Calls to a specific Web API method. */
  callsTo(method: string): readonly CapturedSlackCall[] {
    return this._calls.filter(c => c.method === method);
  }

  /** Number of times a method was called. */
  callCount(method: string): number {
    return this._methodCallCounts.get(method) ?? 0;
  }

  /** All messages posted via chat.postMessage (not via response_url). */
  postedMessages(): readonly SlackMessage[] {
    return this.callsTo('chat.postMessage').map(c => ({
      channel: String(c.body.channel ?? ''),
      ts: (c.response as ChatPostMessageResponse).ts ?? '',
      thread_ts: typeof c.body.thread_ts === 'string' ? c.body.thread_ts : undefined,
      text: typeof c.body.text === 'string' ? c.body.text : undefined,
      blocks: Array.isArray(c.body.blocks) ? c.body.blocks : undefined,
      bot_id: 'BTEST',
    }));
  }

  /** All reactions added via reactions.add. */
  reactionsAdded(): readonly SlackReaction[] {
    return this.callsTo('reactions.add').map(c => ({
      channel: String(c.body.channel ?? ''),
      timestamp: String(c.body.timestamp ?? ''),
      name: String(c.body.name ?? ''),
    }));
  }

  /** All reactions removed via reactions.remove. */
  reactionsRemoved(): readonly SlackReactionRemoval[] {
    return this.callsTo('reactions.remove').map(c => ({
      channel: String(c.body.channel ?? ''),
      timestamp: String(c.body.timestamp ?? ''),
      name: String(c.body.name ?? ''),
    }));
  }

  /** All requests to conversations.replies. */
  repliesRequested(): readonly SlackRepliesRequest[] {
    return this.callsTo('conversations.replies').map(c => ({
      channel: String(c.body.channel ?? ''),
      ts: String(c.body.ts ?? ''),
      limit: typeof c.body.limit === 'number' ? c.body.limit : undefined,
    }));
  }

  /**
   * True if any chat.postMessage was sent to `channel` with text matching
   * the given substring or RegExp.
   */
  wasMessagePostedTo(channel: string, textMatch: string | RegExp): boolean {
    return this.postedMessages().some(m => {
      if (m.channel !== channel) return false;
      if (!m.text) return false;
      return typeof textMatch === 'string'
        ? m.text.includes(textMatch)
        : textMatch.test(m.text);
    });
  }

  /**
   * True if any chat.postMessage was sent as a thread reply under `threadTs`.
   */
  wasThreadedReplyPosted(threadTs: string, textMatch?: string | RegExp): boolean {
    return this.postedMessages().some(m => {
      if (m.thread_ts !== threadTs) return false;
      if (!textMatch) return true;
      if (!m.text) return false;
      return typeof textMatch === 'string'
        ? m.text.includes(textMatch)
        : textMatch.test(m.text);
    });
  }

  /**
   * True if a response_url fetch was made matching the optional text filter.
   * Response-URL calls are raw fetch() calls to `hooks.slack.com`, not
   * `slack.com/api/*`, so they pass through to the original fetch.
   * Use `wasResponseUrlPosted` with a separate `fetchMock` for those.
   */
  wasReactionAdded(channel: string, name: string): boolean {
    return this.reactionsAdded().some(r => r.channel === channel && r.name === name);
  }

  wasReactionRemoved(channel: string, name: string): boolean {
    return this.reactionsRemoved().some(r => r.channel === channel && r.name === name);
  }

  /** Clear all recorded calls (does not affect installed stubs). */
  reset(): void {
    this._calls.length = 0;
    this._methodCallCounts.clear();
  }

  /** Restore global.fetch to the original implementation. */
  restore(): void {
    this._spy.mockRestore();
  }

  /**
   * Configure a one-time error response for the next call to `method`.
   * Subsequent calls return the default response.
   *
   * Usage: `slack.failNextCall('chat.postMessage', 'channel_not_found')`
   */
  failNextCall(method: string, slackErrorCode: string): void {
    const existing = this._options.methodResponses[method];
    const errorResponse: SlackApiErrorResponse = { ok: false, error: slackErrorCode };
    if (Array.isArray(existing)) {
      (this._options.methodResponses as Record<string, unknown>)[method] = [
        errorResponse,
        ...existing,
      ];
    } else {
      (this._options.methodResponses as Record<string, unknown>)[method] = [
        errorResponse,
        this._options.defaultResponse,
      ];
    }
  }
}

// ─── Event payload factories ─────────────────────────────────────────────────

/** Options common to all Events API payloads. */
export interface SlackEventCommonOptions {
  readonly teamId?: string;
  readonly apiAppId?: string;
  readonly botUserId?: string;
  readonly eventId?: string;
  readonly eventTime?: number;
  readonly token?: string;
}

/** Options for `slackMention()`. */
export interface SlackMentionOptions extends SlackEventCommonOptions {
  /** Full text of the message, including the `<@UBOT>` token. */
  readonly text?: string;
  /** Slack user id of the sender. */
  readonly userId?: string;
  /** Channel the mention appeared in. */
  readonly channelId?: string;
  /** Message timestamp. */
  readonly ts?: string;
  /** Parent thread timestamp (when the mention is itself a reply). */
  readonly threadTs?: string;
  /** File attachments on the message. */
  readonly files?: readonly Partial<SlackFileAttachment>[];
}

/**
 * Build a Slack `app_mention` event_callback payload.
 *
 * The `<@UBOT>` mention prefix is injected automatically when `text` does not
 * already start with a `<@...>` token.
 *
 * @see https://api.slack.com/events/app_mention
 */
export function slackMention(opts: SlackMentionOptions = {}): SlackEventCallbackPayload {
  const teamId = opts.teamId ?? 'T1';
  const botUserId = opts.botUserId ?? 'UBOT';
  const userId = opts.userId ?? 'U_USER';
  const channelId = opts.channelId ?? 'C1';
  const ts = opts.ts ?? nextTs();
  const rawText = opts.text ?? `<@${botUserId}> submit org/repo fix the bug`;
  // Inject mention prefix if caller omitted it.
  const text = rawText.match(/^<@[A-Z0-9]+>/) ? rawText : `<@${botUserId}> ${rawText}`;

  const files: SlackFileAttachment[] = (opts.files ?? []).map(f => buildFileAttachment(userId, f));

  return {
    token: opts.token ?? 'test-token',
    team_id: teamId,
    api_app_id: opts.apiAppId ?? 'A_APP',
    type: 'event_callback',
    event_id: opts.eventId ?? `Ev${Date.now()}`,
    event_time: opts.eventTime ?? Math.floor(Date.now() / 1000),
    authorizations: [{
      enterprise_id: null,
      team_id: teamId,
      user_id: botUserId,
      is_bot: true,
      is_enterprise_install: false,
    }],
    event: {
      type: 'app_mention',
      user: userId,
      text,
      channel: channelId,
      ts,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      ...(files.length > 0 ? { files } : {}),
    },
  };
}

/** Options for `dmMessage()`. */
export interface SlackDmMessageOptions extends SlackEventCommonOptions {
  readonly text?: string;
  readonly userId?: string;
  readonly channelId?: string;
  readonly ts?: string;
  readonly files?: readonly Partial<SlackFileAttachment>[];
}

/**
 * Build a Slack `message` event for a direct message (channel_type: 'im').
 *
 * @see https://api.slack.com/events/message.im
 */
export function dmMessage(opts: SlackDmMessageOptions = {}): SlackEventCallbackPayload {
  const teamId = opts.teamId ?? 'T1';
  const userId = opts.userId ?? 'U_USER';
  const channelId = opts.channelId ?? 'D_DM';
  const ts = opts.ts ?? nextTs();
  const files = (opts.files ?? []).map(f => buildFileAttachment(userId, f));

  return {
    token: opts.token ?? 'test-token',
    team_id: teamId,
    api_app_id: opts.apiAppId ?? 'A_APP',
    type: 'event_callback',
    event_id: opts.eventId ?? `Ev${Date.now()}`,
    event_time: opts.eventTime ?? Math.floor(Date.now() / 1000),
    event: {
      type: 'message',
      user: userId,
      text: opts.text ?? 'submit org/repo fix the bug',
      channel: channelId,
      channel_type: 'im',
      ts,
      ...(files.length > 0 ? { files } : {}),
    },
  };
}

/** Options for `threadReply()`. */
export interface SlackThreadReplyOptions extends SlackEventCommonOptions {
  readonly text?: string;
  readonly userId?: string;
  readonly channelId?: string;
  readonly ts?: string;
  /** Thread parent timestamp (required to form a reply). */
  readonly threadTs: string;
}

/**
 * Build a Slack `message` event that is a reply in an existing thread.
 *
 * @see https://api.slack.com/events/message#thread_broadcast
 */
export function threadReply(opts: SlackThreadReplyOptions): SlackEventCallbackPayload {
  const teamId = opts.teamId ?? 'T1';
  const userId = opts.userId ?? 'U_USER';
  const channelId = opts.channelId ?? 'C1';
  const ts = opts.ts ?? nextTs();

  return {
    token: opts.token ?? 'test-token',
    team_id: teamId,
    api_app_id: opts.apiAppId ?? 'A_APP',
    type: 'event_callback',
    event_id: opts.eventId ?? `Ev${Date.now()}`,
    event_time: opts.eventTime ?? Math.floor(Date.now() / 1000),
    event: {
      type: 'message',
      user: userId,
      text: opts.text ?? 'update: still working on it',
      channel: channelId,
      ts,
      thread_ts: opts.threadTs,
    },
  };
}

/** Options for `slashCommand()`. */
export interface SlashCommandOptions {
  readonly command?: string;
  readonly text?: string;
  readonly userId?: string;
  readonly userName?: string;
  readonly teamId?: string;
  readonly teamDomain?: string;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly triggerId?: string;
  readonly responseUrl?: string;
  readonly apiAppId?: string;
}

/**
 * Build a URL-encoded Slack slash-command form body string.
 *
 * Compatible with `parseFormBody()` in `slack-commands.ts`.
 *
 * @see https://api.slack.com/interactivity/slash-commands
 */
export function slashCommand(opts: SlashCommandOptions = {}): string {
  const params = new URLSearchParams({
    command: opts.command ?? '/bgagent',
    text: opts.text ?? 'help',
    response_url: opts.responseUrl ?? 'https://hooks.slack.com/commands/T1/C1/xyz',
    trigger_id: opts.triggerId ?? `${Date.now()}.1.abc`,
    user_id: opts.userId ?? 'U_USER',
    user_name: opts.userName ?? 'testuser',
    team_id: opts.teamId ?? 'T1',
    team_domain: opts.teamDomain ?? 'test-workspace',
    channel_id: opts.channelId ?? 'C1',
    channel_name: opts.channelName ?? 'general',
    api_app_id: opts.apiAppId ?? 'A_APP',
    is_enterprise_install: 'false',
  });
  return params.toString();
}

/** Options for `buttonClick()`. */
export interface ButtonClickOptions {
  readonly actionId: string;
  readonly blockId?: string;
  readonly value?: string;
  readonly buttonText?: string;
  readonly buttonStyle?: 'primary' | 'danger';
  readonly userId?: string;
  readonly userName?: string;
  readonly teamId?: string;
  readonly teamDomain?: string;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly messageTs?: string;
  readonly threadTs?: string;
  readonly triggerId?: string;
  readonly responseUrl?: string;
  readonly apiAppId?: string;
}

/**
 * Build a Slack Block Kit `block_actions` interaction payload (JSON string
 * ready to be URL-encoded as `payload=<json>`).
 *
 * @see https://api.slack.com/reference/interaction-payloads/block-actions
 */
export function buttonClick(opts: ButtonClickOptions): string {
  const messageTs = opts.messageTs ?? nextTs();
  const payload: SlackBlockActionsPayload = {
    type: 'block_actions',
    team: {
      id: opts.teamId ?? 'T1',
      domain: opts.teamDomain ?? 'test-workspace',
    },
    user: {
      id: opts.userId ?? 'U_USER',
      username: opts.userName ?? 'testuser',
      team_id: opts.teamId ?? 'T1',
    },
    api_app_id: opts.apiAppId ?? 'A_APP',
    token: 'test-token',
    container: {
      type: 'message',
      message_ts: messageTs,
      channel_id: opts.channelId ?? 'C1',
      is_ephemeral: false,
    },
    trigger_id: opts.triggerId ?? `${Date.now()}.2.def`,
    channel: {
      id: opts.channelId ?? 'C1',
      name: opts.channelName ?? 'general',
    },
    message: {
      type: 'message',
      text: 'Task notification',
      ts: messageTs,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      blocks: [],
    },
    response_url: opts.responseUrl ?? 'https://hooks.slack.com/actions/T1/C1/xyz',
    actions: [
      {
        type: 'button',
        action_id: opts.actionId,
        block_id: opts.blockId ?? 'block-1',
        action_ts: String(Date.now()),
        ...(opts.value ? { value: opts.value } : {}),
        text: {
          type: 'plain_text',
          text: opts.buttonText ?? 'Click',
          emoji: true,
        },
        ...(opts.buttonStyle ? { style: opts.buttonStyle } : {}),
      },
    ],
  };
  return JSON.stringify(payload);
}

/** Options for `fileShareEvent()`. */
export interface FileShareEventOptions extends SlackEventCommonOptions {
  readonly userId?: string;
  readonly channelId?: string;
  readonly ts?: string;
  readonly text?: string;
  /** The files to attach — each can be a Partial; defaults are filled in. */
  readonly files?: readonly Partial<SlackFileAttachment>[];
}

/**
 * Build a Slack `message` event with file shares.
 *
 * @see https://api.slack.com/events/message/file_share
 */
export function fileShareEvent(opts: FileShareEventOptions = {}): SlackEventCallbackPayload {
  const teamId = opts.teamId ?? 'T1';
  const userId = opts.userId ?? 'U_USER';
  const channelId = opts.channelId ?? 'C1';
  const ts = opts.ts ?? nextTs();
  const files = (opts.files ?? [defaultFileAttachment()]).map(f => buildFileAttachment(userId, f));

  return {
    token: opts.token ?? 'test-token',
    team_id: teamId,
    api_app_id: opts.apiAppId ?? 'A_APP',
    type: 'event_callback',
    event_id: opts.eventId ?? `Ev${Date.now()}`,
    event_time: opts.eventTime ?? Math.floor(Date.now() / 1000),
    event: {
      type: 'message',
      subtype: 'file_share',
      user: userId,
      text: opts.text ?? '',
      channel: channelId,
      ts,
      files,
    },
  };
}

/**
 * Build a Slack `app_uninstalled` event_callback.
 *
 * @see https://api.slack.com/events/app_uninstalled
 */
export function appUninstalledEvent(opts: SlackEventCommonOptions = {}): SlackEventCallbackPayload {
  const teamId = opts.teamId ?? 'T1';
  return {
    token: opts.token ?? 'test-token',
    team_id: teamId,
    api_app_id: opts.apiAppId ?? 'A_APP',
    type: 'event_callback',
    event_id: opts.eventId ?? `Ev${Date.now()}`,
    event_time: opts.eventTime ?? Math.floor(Date.now() / 1000),
    event: {
      type: 'app_uninstalled',
    },
  };
}

/**
 * Build a Slack `tokens_revoked` event_callback.
 *
 * @see https://api.slack.com/events/tokens_revoked
 */
export function tokensRevokedEvent(opts: SlackEventCommonOptions & {
  readonly botTokens?: readonly string[];
  readonly appTokens?: readonly string[];
} = {}): SlackEventCallbackPayload {
  const teamId = opts.teamId ?? 'T1';
  return {
    token: opts.token ?? 'test-token',
    team_id: teamId,
    api_app_id: opts.apiAppId ?? 'A_APP',
    type: 'event_callback',
    event_id: opts.eventId ?? `Ev${Date.now()}`,
    event_time: opts.eventTime ?? Math.floor(Date.now() / 1000),
    event: {
      type: 'tokens_revoked',
      tokens: {
        oauth: opts.botTokens ?? [],
        bot: opts.botTokens ?? [],
        app: opts.appTokens ?? [],
      },
    },
  };
}

// ─── File attachment helpers ─────────────────────────────────────────────────

/** Minimal valid file attachment (override individual fields as needed). */
function defaultFileAttachment(): Partial<SlackFileAttachment> {
  return {
    name: 'screenshot.png',
    mimetype: 'image/png',
    size: 12_345,
    url_private_download: 'https://files.slack.com/files-pri/T1-FTEST/screenshot.png',
  };
}

function buildFileAttachment(userId: string, partial: Partial<SlackFileAttachment>): SlackFileAttachment {
  const id = partial.id ?? `F${Date.now()}`;
  const name = partial.name ?? 'attachment.bin';
  const mimetype = partial.mimetype ?? 'application/octet-stream';
  const size = partial.size ?? 1_024;
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    created: now,
    timestamp: now,
    name,
    title: name,
    mimetype,
    filetype: mimetype.split('/')[1] ?? 'bin',
    pretty_type: mimetype,
    user: userId,
    editable: false,
    size,
    mode: 'hosted',
    is_external: false,
    is_public: false,
    public_url_shared: false,
    display_as_bot: false,
    username: '',
    url_private: partial.url_private_download ?? `https://files.slack.com/files-pri/T1-${id}/${name}`,
    url_private_download: partial.url_private_download ?? `https://files.slack.com/files-pri/T1-${id}/${name}`,
    permalink: `https://workspace.slack.com/files/${userId}/${id}/${name}`,
    permalink_public: `https://slack-files.com/T1-${id}-abc`,
    ...partial,
  };
}

// ─── APIGatewayProxyEvent factories ──────────────────────────────────────────

/**
 * Create a valid HMAC-SHA256 Slack request signature for the given body/timestamp.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function signSlackRequest(signingSecret: string, body: string, timestamp?: string): {
  readonly signature: string;
  readonly timestamp: string;
} {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const basestring = `v0:${ts}:${body}`;
  const signature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex');
  return { signature, timestamp: ts };
}

/** Base shape for a Lambda APIGatewayProxyEvent (all optional fields filled). */
function baseApiGwEvent(
  path: string,
  body: string,
  headers: Record<string, string>,
): APIGatewayProxyEvent {
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

/**
 * Wrap a Slack `event_callback` payload in a signed APIGatewayProxyEvent for
 * the `/v1/slack/events` handler.
 *
 * @param payload - the event_callback payload (from one of the factory helpers).
 * @param signingSecret - the Slack signing secret to sign with.
 * @param retryNum - set to '1' or '2' to simulate a Slack delivery retry.
 */
export function signedEventsApiEvent(
  payload: SlackEventCallbackPayload | { type: string; challenge?: string; [key: string]: unknown },
  signingSecret: string,
  retryNum?: string,
): APIGatewayProxyEvent {
  const body = JSON.stringify(payload);
  const { signature, timestamp } = signSlackRequest(signingSecret, body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Slack-Signature': signature,
    'X-Slack-Request-Timestamp': timestamp,
  };
  if (retryNum !== undefined) {
    headers['X-Slack-Retry-Num'] = retryNum;
    headers['X-Slack-Retry-Reason'] = 'http_timeout';
  }
  return baseApiGwEvent('/v1/slack/events', body, headers);
}

/**
 * Wrap a slash-command URL-encoded body in a signed APIGatewayProxyEvent for
 * the `/v1/slack/commands` handler.
 *
 * @param body - URL-encoded form body (from `slashCommand()`).
 * @param signingSecret - the Slack signing secret to sign with.
 */
export function signedCommandEvent(body: string, signingSecret: string): APIGatewayProxyEvent {
  const { signature, timestamp } = signSlackRequest(signingSecret, body);
  return baseApiGwEvent('/v1/slack/commands', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Slack-Signature': signature,
    'X-Slack-Request-Timestamp': timestamp,
  });
}

/**
 * Wrap a Block Kit interaction JSON payload in a signed APIGatewayProxyEvent
 * for the `/v1/slack/interactions` handler.
 *
 * Slack sends interactions as `payload=<url-encoded-json>`.
 *
 * @param payloadJson - JSON string (from `buttonClick()`).
 * @param signingSecret - the Slack signing secret to sign with.
 */
export function signedInteractionEvent(payloadJson: string, signingSecret: string): APIGatewayProxyEvent {
  const body = `payload=${encodeURIComponent(payloadJson)}`;
  const { signature, timestamp } = signSlackRequest(signingSecret, body);
  return baseApiGwEvent('/v1/slack/interactions', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Slack-Signature': signature,
    'X-Slack-Request-Timestamp': timestamp,
  });
}

/**
 * Build a Slack url_verification challenge event (used when first setting up
 * the Events API endpoint).
 *
 * @see https://api.slack.com/events/url_verification
 */
export function urlVerificationEvent(challenge: string): { type: 'url_verification'; challenge: string; token: string } {
  return { type: 'url_verification', challenge, token: 'test-token' };
}

// ─── Rate-limit error helpers ─────────────────────────────────────────────────

/**
 * Build a Slack rate-limit error response.
 *
 * @see https://api.slack.com/docs/rate-limits
 */
export function rateLimitedResponse(): SlackApiErrorResponse {
  return { ok: false, error: 'ratelimited' };
}

/**
 * Build a Slack channel_not_found error response.
 */
export function channelNotFoundResponse(): SlackApiErrorResponse {
  return { ok: false, error: 'channel_not_found' };
}

/**
 * Build a Slack not_in_channel error response.
 */
export function notInChannelResponse(): SlackApiErrorResponse {
  return { ok: false, error: 'not_in_channel' };
}

/**
 * Build a Slack token_revoked error response.
 */
export function tokenRevokedResponse(): SlackApiErrorResponse {
  return { ok: false, error: 'token_revoked' };
}

/**
 * Build a Slack already_reacted error response (benign — same reaction added twice).
 */
export function alreadyReactedResponse(): SlackApiErrorResponse {
  return { ok: false, error: 'already_reacted' };
}

/**
 * Build a Slack no_reaction error response (benign — removing a reaction that was never added).
 */
export function noReactionResponse(): SlackApiErrorResponse {
  return { ok: false, error: 'no_reaction' };
}
