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
 * Resolve a repo's GitHub default branch for the epic orchestration release
 * path (ABCA-687).
 *
 * The epic release path opens child + integration PRs; their base branch must
 * be the target repo's ACTUAL default branch, not a hardcoded ``main``. On a
 * fork whose trunk is not ``main`` (e.g. ``linear-vercel``, ~453 commits ahead
 * of ``main``) a ``main`` base makes every epic PR render the whole
 * trunk-vs-main divergence instead of the real change.
 *
 * This is the CDK-side analogue of the agent's ``detect_default_branch``
 * (``agent/src/repo.py``) — single-issue tasks already target the right branch
 * because the agent queries GitHub at clone time. The epic path seeds the
 * orchestration in Lambda BEFORE any clone, so it resolves the default branch
 * here (via the GitHub REST API, the same pattern preflight's ``checkRepoAccess``
 * uses) and stamps it on the meta row.
 *
 * Fallback: ANY failure (no token, non-owner/repo string, GitHub unreachable,
 * missing field) resolves to ``'main'`` — the historical behaviour — so a
 * transient resolution failure never blocks seeding. ``main`` is ONLY ever a
 * last resort, never the primary base when the real trunk is known.
 */

import { logger } from './logger';

const GITHUB_API_TIMEOUT_MS = 5_000;

/** Last-resort default when the repo's real default branch can't be resolved. */
export const FALLBACK_DEFAULT_BRANCH = 'main';

/** Injected fetcher (defaults to the global ``fetch``) so tests avoid real HTTP. */
export type FetchLike = typeof fetch;

export interface ResolveRepoDefaultBranchParams {
  /** The ``owner/repo`` string. */
  readonly repo: string;
  /** GitHub token for the REST call. When absent, resolution falls back. */
  readonly token?: string;
  /** Test seam — defaults to the global ``fetch``. */
  readonly fetchImpl?: FetchLike;
}

/**
 * Query the GitHub REST API for a repo's ``default_branch``. Never throws:
 * returns ``'main'`` (the last-resort fallback) on any failure so a transient
 * hiccup can't block orchestration seeding.
 */
export async function resolveRepoDefaultBranch(
  params: ResolveRepoDefaultBranchParams,
): Promise<string> {
  const { repo, token } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  if (!token) {
    logger.warn('Default-branch resolution has no GitHub token — falling back to main', { repo });
    return FALLBACK_DEFAULT_BRANCH;
  }
  // Guard against a malformed repo string before hitting the API.
  const slash = repo.indexOf('/');
  if (slash <= 0 || slash === repo.length - 1) {
    logger.warn('Default-branch resolution given a malformed repo string — falling back to main', { repo });
    return FALLBACK_DEFAULT_BRANCH;
  }

  try {
    const resp = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn('Default-branch resolution: GitHub API non-OK — falling back to main', {
        repo, http_status: resp.status,
      });
      return FALLBACK_DEFAULT_BRANCH;
    }
    const body = await resp.json() as { default_branch?: unknown };
    const branch = body.default_branch;
    if (typeof branch === 'string' && branch.length > 0) {
      logger.info('Resolved repo default branch for orchestration', { repo, default_branch: branch });
      return branch;
    }
    logger.warn('Default-branch resolution: response missing default_branch — falling back to main', { repo });
    return FALLBACK_DEFAULT_BRANCH;
  } catch (err) {
    logger.warn('Default-branch resolution failed — falling back to main', {
      repo, error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_DEFAULT_BRANCH;
  }
}
