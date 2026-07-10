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
 * Best-effort GitHub token resolution for the orchestration SEED path
 * (ABCA-687). The seed path resolves the repo's default branch via the GitHub
 * REST API before creating the orchestration; that read needs a token.
 *
 * Resolution order mirrors the fan-out dispatcher's ``resolveTokenSecretArn``:
 * the per-repo blueprint's ``github_token_secret_arn`` wins, else the Lambda's
 * platform-default ``GITHUB_TOKEN_SECRET_ARN`` env var. The secret string is
 * then read via {@link resolveGitHubToken}.
 *
 * Best-effort by contract: ANY failure (no config, no env, unreadable secret)
 * resolves to ``undefined`` and is logged, never thrown — a token hiccup must
 * not block orchestration seeding (the default-branch resolver then falls back
 * to ``'main'``). This is a READ used only to pick a PR base, not a
 * task-critical credential.
 */

import { resolveGitHubToken } from './context-hydration';
import { logger } from './logger';
import { loadRepoConfig } from './repo-config';

/**
 * Resolve a usable GitHub token for the repo, or ``undefined`` on any failure.
 * Never throws.
 */
export async function resolveRepoGithubToken(repo: string): Promise<string | undefined> {
  let secretArn: string | undefined;
  try {
    const config = await loadRepoConfig(repo);
    secretArn = config?.github_token_secret_arn ?? process.env.GITHUB_TOKEN_SECRET_ARN;
  } catch (err) {
    // A RepoTable read hiccup shouldn't block seeding — fall back to the
    // platform-default secret if one is wired.
    secretArn = process.env.GITHUB_TOKEN_SECRET_ARN;
    logger.warn('Orchestration token resolution: repo config read failed — using platform default', {
      repo, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!secretArn) {
    logger.warn('Orchestration token resolution: no GitHub token secret configured', { repo });
    return undefined;
  }
  try {
    return await resolveGitHubToken(secretArn);
  } catch (err) {
    logger.warn('Orchestration token resolution: could not read GitHub token secret — default-branch resolution will fall back', {
      repo, error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
