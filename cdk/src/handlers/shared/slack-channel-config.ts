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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * TTL (seconds) for a pending repo-pick record. If the user never clicks a
 * button in the repo-picker message the record self-expires so the config
 * table doesn't accumulate abandoned picks.
 */
const PENDING_REPO_PICK_TTL_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;
export const PENDING_REPO_PICK_TTL_S = PENDING_REPO_PICK_TTL_MINUTES * SECONDS_PER_MINUTE;

/** Prefix that distinguishes transient pending-pick rows from channel config rows. */
const PENDING_KEY_PREFIX = 'pending#';

/** File reference carried through a pending repo pick (mirrors SlackFileRef). */
export interface PendingRepoPickFile {
  readonly id: string;
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  readonly url_private_download: string;
}

/**
 * The context needed to submit a task once the user picks a repo from the
 * Block Kit picker. Stored transiently keyed by a random token so the picker
 * message (and its interaction callback) only has to round-trip the token.
 */
export interface PendingRepoPick {
  readonly description: string;
  readonly team_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly thread_ts?: string;
  readonly files?: readonly PendingRepoPickFile[];
}

/** Build the composite partition-key value for a channel config row. */
function channelKey(teamId: string, channelId: string): string {
  return `${teamId}#${channelId}`;
}

/**
 * Read the list of default repos configured for a Slack channel.
 *
 * Backwards compatible with the single-repo rows written by
 * `bgagent slack onboard-channel` (which set a scalar `repo` field): a legacy
 * row is surfaced as a one-element list. New rows written by `/bgagent set-repo`
 * use a `repos` string-set/list. Only `status: 'active'` rows contribute repos.
 *
 * Fails open (returns `[]`) on any error so a lookup blip degrades to the
 * "please set a repo" guidance path rather than a 500.
 *
 * @param tableName - the channel mapping table name (undefined disables lookups).
 * @param teamId - Slack workspace/team id.
 * @param channelId - Slack channel id.
 */
export async function getChannelRepos(
  tableName: string | undefined,
  teamId: string,
  channelId: string,
): Promise<string[]> {
  if (!tableName) return [];
  const key = channelKey(teamId, channelId);
  try {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { channel_id: key },
    }));
    const item = result.Item;
    if (!item || item.status !== 'active') return [];

    // New multi-repo shape.
    const repos = item.repos;
    if (Array.isArray(repos)) {
      return dedupeRepos(repos.filter((r): r is string => typeof r === 'string'));
    }
    // DynamoDB string-set unmarshals to a JS Set via lib-dynamodb.
    if (repos instanceof Set) {
      return dedupeRepos([...repos].filter((r): r is string => typeof r === 'string'));
    }
    // Legacy single-repo shape.
    if (typeof item.repo === 'string' && item.repo) {
      return [item.repo];
    }
    return [];
  } catch (err) {
    logger.warn('Channel repo lookup failed, treating channel as having no default', {
      channel_id: key,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- fail-open is intentional; absent config → set-repo guidance path
  }
}

/**
 * Add a repo to a channel's default list (idempotent). Preserves any repos
 * already configured, migrating a legacy scalar `repo` row into the `repos`
 * list on first write. Returns the full repo list after the addition.
 */
export async function addChannelRepo(
  tableName: string,
  teamId: string,
  channelId: string,
  repo: string,
): Promise<string[]> {
  const existing = await getChannelRepos(tableName, teamId, channelId);
  const repos = dedupeRepos([...existing, repo]);
  await writeChannelRepos(tableName, teamId, channelId, repos);
  return repos;
}

/**
 * Remove a repo from a channel's default list. Returns the remaining repos.
 * A no-op (still writes the current list) when the repo wasn't configured.
 */
export async function removeChannelRepo(
  tableName: string,
  teamId: string,
  channelId: string,
  repo: string,
): Promise<string[]> {
  const existing = await getChannelRepos(tableName, teamId, channelId);
  const repos = existing.filter((r) => r !== repo);
  await writeChannelRepos(tableName, teamId, channelId, repos);
  return repos;
}

/** Persist the full repo list for a channel, stamping timestamps. */
async function writeChannelRepos(
  tableName: string,
  teamId: string,
  channelId: string,
  repos: string[],
): Promise<void> {
  const key = channelKey(teamId, channelId);
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      channel_id: key,
      repos,
      // Keep a scalar `repo` mirror of the first entry so older readers that
      // only understand the legacy single-repo shape still resolve a default.
      repo: repos[0],
      status: 'active',
      onboarded_at: now,
      updated_at: now,
    },
  }));
}

/** De-duplicate repos while preserving insertion order. */
function dedupeRepos(repos: string[]): string[] {
  return [...new Set(repos)];
}

// ─── Pending repo picks ────────────────────────────────────────────────────────

/**
 * Persist a pending repo-pick so the Block Kit picker message only has to
 * carry an opaque token. TTL-bounded so abandoned picks self-clean.
 */
export async function putPendingRepoPick(
  tableName: string,
  token: string,
  pick: PendingRepoPick,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + PENDING_REPO_PICK_TTL_S;
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      channel_id: `${PENDING_KEY_PREFIX}${token}`,
      kind: 'repo_pick',
      description: pick.description,
      team_id: pick.team_id,
      slack_channel_id: pick.channel_id,
      user_id: pick.user_id,
      ...(pick.thread_ts && { thread_ts: pick.thread_ts }),
      ...(pick.files && pick.files.length > 0 && { files: pick.files }),
      ttl,
      created_at: new Date().toISOString(),
    },
  }));
}

/** Load a pending repo-pick by token, or null if missing/expired. */
export async function getPendingRepoPick(
  tableName: string,
  token: string,
): Promise<PendingRepoPick | null> {
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { channel_id: `${PENDING_KEY_PREFIX}${token}` },
  }));
  const item = result.Item;
  if (!item || item.kind !== 'repo_pick') return null;
  // Guard against a record whose TTL sweep hasn't run yet.
  if (typeof item.ttl === 'number' && item.ttl * 1000 < Date.now()) return null;
  return {
    description: (item.description as string) ?? '',
    team_id: item.team_id as string,
    channel_id: item.slack_channel_id as string,
    user_id: item.user_id as string,
    thread_ts: item.thread_ts as string | undefined,
    files: item.files as PendingRepoPickFile[] | undefined,
  };
}

/** Delete a consumed pending repo-pick (best effort — TTL is the backstop). */
export async function deletePendingRepoPick(tableName: string, token: string): Promise<void> {
  try {
    await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { channel_id: `${PENDING_KEY_PREFIX}${token}` },
    }));
  } catch (err) {
    logger.warn('Failed to delete consumed pending repo pick', {
      token,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
