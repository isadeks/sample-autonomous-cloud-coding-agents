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
 * Pure gate for the `@bgagent` GitHub PR-comment trigger, shared by the webhook
 * receiver (cheap pre-filter) and the trigger Lambda (github-comment-task.ts).
 */

/** Associations GitHub reports for people with write access to the repo. */
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const MENTION = /(^|\s)@bgagent\b/i;
export const ABCA_BRANCH = /^bgagent\/([0-9A-HJKMNP-TV-Z]{26})\//;
const MAX_INSTRUCTION_CHARS = 4000;

export interface GitHubCommentEvent {
  readonly raw_body: string;
}

export interface IssueCommentPayload {
  readonly action?: string;
  readonly issue?: { readonly number?: number; readonly pull_request?: unknown };
  readonly comment?: {
    readonly id?: number;
    readonly body?: string;
    readonly html_url?: string;
    readonly author_association?: string;
    readonly user?: { readonly login?: string; readonly type?: string };
  };
  readonly repository?: { readonly full_name?: string };
}

export type TriggerDecision =
  | {
    readonly ok: true;
    readonly repo: string;
    readonly prNumber: number;
    readonly instruction: string;
    readonly commentId: number;
    readonly commentUrl: string;
    readonly author: string;
  }
  | { readonly ok: false; readonly reason: string };

/** Pure gate on the webhook payload (no I/O). */
export function decideTrigger(payload: IssueCommentPayload): TriggerDecision {
  if (payload.action !== 'created') return { ok: false, reason: 'not_created' };
  if (!payload.issue?.pull_request) return { ok: false, reason: 'not_a_pull_request' };
  const c = payload.comment;
  const body = c?.body ?? '';
  if (!MENTION.test(body)) return { ok: false, reason: 'no_mention' };
  if (c?.user?.type === 'Bot') return { ok: false, reason: 'bot_author' };
  if (!TRUSTED_ASSOCIATIONS.has(c?.author_association ?? '')) return { ok: false, reason: 'untrusted_author' };
  const repo = payload.repository?.full_name ?? '';
  const prNumber = payload.issue?.number;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !prNumber || !c?.id) return { ok: false, reason: 'missing_fields' };
  const instruction = body.replace(MENTION, ' ').trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!instruction) return { ok: false, reason: 'empty_instruction' };
  return {
    ok: true,
    repo,
    prNumber,
    instruction,
    commentId: c.id,
    commentUrl: c.html_url ?? '',
    author: c.user?.login ?? '',
  };
}
