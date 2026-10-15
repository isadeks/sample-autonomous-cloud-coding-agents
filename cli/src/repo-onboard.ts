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

import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { documentClient } from './dynamo-clients';
import { CliError } from './errors';
import {
  LambdaMicrovmProbeClientFactory,
  requireLambdaMicrovmAvailability,
} from './lambda-microvm-availability';
import {
  assertRepoFormat,
  loadRepoConfig,
  parseRepoConfigRow,
  RepoConfigRow,
  RepoNotOnboardedError,
} from './repo-lookup';

/** TTL (days) for soft-deleted repo rows — matches Blueprint construct. */
export const REMOVED_REPO_TTL_DAYS = 30;

/** Upper bound for ``--ci-wait-timeout`` (6 h; matches the agent's TaskConfig bound). */
export const MAX_CI_WAIT_TIMEOUT_S = 21600;

export interface OnboardRepoOptions {
  readonly computeType?: 'agentcore' | 'ecs' | 'lambda-microvm';
  readonly runtimeArn?: string;
  readonly modelId?: string;
  readonly maxTurns?: number;
  readonly githubTokenSecretArn?: string;
  readonly pollIntervalMs?: number;
  /** Post-agent build/lint verify commands (previously CDK Blueprint-only). */
  readonly buildCommand?: string;
  readonly lintCommand?: string;
  /** In-session CI/CD convergence: seconds to wait for the PR's checks (0 = off). */
  readonly ciWaitTimeoutS?: number;
  /** Checks that must all report green, e.g. a CI status context and `deployment:Preview`. */
  readonly ciRequiredChecks?: string[];
  /** Repo-relative folder of agent-written UI checks that the repo's CD runs on the PR preview ('' clears). */
  readonly uiChecksDir?: string;
  /** Extra system-prompt text for this repo, e.g. its CD's UI-check contract ('' clears). */
  readonly systemPromptOverrides?: string;
  /** Verify an agent's "unrelated CI failure" claim by running CI on the base branch (pushes `abca-baseline/<task>`). */
  readonly ciBaselineProbe?: boolean;
  /** Require project tests for behaviour changes (true/false; undefined keeps the stored value). */
  readonly requireTests?: boolean;
}

export interface OnboardRepoDependencies {
  /** Override for deterministic/offline tests; production uses the regional AWS client. */
  readonly lambdaMicrovmClientFactory?: LambdaMicrovmProbeClientFactory;
}

/** Register or re-activate a repository in RepoTable (operator path). */
export async function onboardRepo(
  region: string,
  tableName: string,
  repo: string,
  options: OnboardRepoOptions = {},
  dependencies: OnboardRepoDependencies = {},
): Promise<RepoConfigRow> {
  assertRepoFormat(repo);
  const now = new Date().toISOString();
  const ddb = documentClient(region);

  let existing: RepoConfigRow | undefined;
  try {
    existing = await loadRepoConfig(region, tableName, repo);
  } catch (err) {
    // Only a genuinely absent row means "start from scratch". Any other failure
    // (table missing, AccessDenied, throttling) must propagate — swallowing it
    // would silently wipe the existing blueprint overrides carried forward below.
    if (!(err instanceof RepoNotOnboardedError)) {
      throw err;
    }
    existing = undefined;
  }

  const effectiveComputeType = options.computeType ?? existing?.compute_type ?? 'agentcore';
  if (effectiveComputeType === 'lambda-microvm') {
    await requireLambdaMicrovmAvailability(region, dependencies.lambdaMicrovmClientFactory);
  }

  // Start from the WHOLE existing row so fields this command does not manage
  // (build/lint commands, mcp_servers, skills, cedar_policy_modules, ...) survive
  // a re-onboard; PutCommand replaces the item. Drop the soft-delete TTL so a
  // re-activated repo is not reaped.
  const { ttl: _removedTtl, ...carried } = (existing ?? {}) as Record<string, unknown>;
  const item: Record<string, unknown> = {
    ...carried,
    repo,
    status: 'active',
    onboarded_at: existing?.onboarded_at ?? now,
    updated_at: now,
  };

  // Explicit options override the carried row; `undefined` keeps the stored value.
  if (options.computeType) item.compute_type = options.computeType;
  if (options.runtimeArn) item.runtime_arn = options.runtimeArn;
  if (options.modelId) item.model_id = options.modelId;
  if (options.maxTurns !== undefined) item.max_turns = options.maxTurns;
  if (options.githubTokenSecretArn) item.github_token_secret_arn = options.githubTokenSecretArn;
  if (options.pollIntervalMs !== undefined) item.poll_interval_ms = options.pollIntervalMs;
  if (options.buildCommand !== undefined) item.build_command = options.buildCommand;
  if (options.lintCommand !== undefined) item.lint_command = options.lintCommand;
  if (options.systemPromptOverrides !== undefined) {
    setOrDelete(item, 'system_prompt_overrides', options.systemPromptOverrides.trim() || undefined);
  }
  if (options.ciWaitTimeoutS !== undefined) {
    if (!Number.isInteger(options.ciWaitTimeoutS) || options.ciWaitTimeoutS < 0 || options.ciWaitTimeoutS > MAX_CI_WAIT_TIMEOUT_S) {
      throw new CliError(`--ci-wait-timeout must be an integer number of seconds between 0 and ${MAX_CI_WAIT_TIMEOUT_S}`);
    }
    setOrDelete(item, 'ci_wait_timeout_s', options.ciWaitTimeoutS || undefined);
  }
  if (options.ciRequiredChecks !== undefined) {
    setOrDelete(item, 'ci_required_checks', options.ciRequiredChecks.length ? options.ciRequiredChecks : undefined);
  }
  if (options.ciBaselineProbe !== undefined) setOrDelete(item, 'ci_baseline_probe', options.ciBaselineProbe || undefined);
  if (options.uiChecksDir !== undefined) {
    const dir = options.uiChecksDir.trim().replace(/^\/+|\/+$/g, '');
    if (dir.split('/').includes('..')) throw new CliError('--ui-checks-dir must stay inside the repository');
    setOrDelete(item, 'ui_checks_dir', dir || undefined);
  }
  if (options.requireTests !== undefined) setOrDelete(item, 'require_tests', options.requireTests || undefined);

  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: item,
  }));

  return parseRepoConfigRow(item);
}

/** Set ``key`` to ``value``, or remove it from the row when ``value`` is undefined. */
function setOrDelete(item: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete item[key];
  else item[key] = value;
}

/** Soft-delete a repository (Blueprint delete semantics). */
export async function offboardRepo(
  region: string,
  tableName: string,
  repo: string,
): Promise<RepoConfigRow> {
  assertRepoFormat(repo);
  await loadRepoConfig(region, tableName, repo);

  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + REMOVED_REPO_TTL_DAYS * 86400;
  const ddb = documentClient(region);

  await ddb.send(new UpdateCommand({
    TableName: tableName,
    Key: { repo },
    UpdateExpression: 'SET #status = :removed, #updated = :now, #ttl = :ttl',
    ExpressionAttributeNames: {
      '#status': 'status',
      '#updated': 'updated_at',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':removed': 'removed',
      ':now': now,
      ':ttl': ttl,
    },
  }));

  return loadRepoConfig(region, tableName, repo);
}
