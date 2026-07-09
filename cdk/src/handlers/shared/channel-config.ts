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

import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from './logger';
import { isValidRepo } from './validation';

/** Maximum repos a single channel may have configured. */
export const CHANNEL_REPOS_MAX = 10;

/**
 * Canonical composite partition key for a (team, channel) pair.
 */
function channelKey(teamId: string, channelId: string): string {
  return `${teamId}#${channelId}`;
}

/**
 * Coerce raw DynamoDB item repo fields into an ordered list.
 * Handles both the new `repos` (string[]) and legacy `repo` (string) schemas.
 */
function itemToRepos(item: Record<string, unknown>): string[] {
  const repos = item.repos as string[] | undefined;
  if (Array.isArray(repos) && repos.length > 0) return repos;
  // Legacy fallback: single `repo` field
  const repo = item.repo as string | undefined;
  if (repo) return [repo];
  return [];
}

/**
 * Return the list of default repos configured for a Slack channel.
 * Returns an empty array when the channel has no configuration or it has
 * been removed.  Fails open (returns []) on transient DynamoDB errors so
 * that a lookup blip degrades to the "please include a repo" help path
 * rather than a 500.
 */
export async function getChannelRepos(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  teamId: string,
  channelId: string,
): Promise<string[]> {
  const key = channelKey(teamId, channelId);
  try {
    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { channel_id: key },
    }));
    if (!result.Item || result.Item.status === 'removed') return [];
    return itemToRepos(result.Item as Record<string, unknown>);
  } catch (err) {
    logger.warn('Channel repo lookup failed, failing open', {
      channel_id: key,
      error: err instanceof Error ? err.message : String(err),
    });
    return []; // nosemgrep: ts-silent-success-masking -- fail-open is intentional; absent default → explicit-repo error path
  }
}

/**
 * Add `repo` to the channel's default repo list (idempotent).
 *
 * Returns `null` on success, or a human-readable error string that callers
 * should relay back to the user.
 */
export async function addChannelRepo(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  teamId: string,
  channelId: string,
  repo: string,
): Promise<string | null> {
  if (!isValidRepo(repo)) {
    return 'Invalid repo format — use `owner/repo` (e.g. `acme/backend`).';
  }

  const key = channelKey(teamId, channelId);
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { channel_id: key },
  }));

  let existing: string[] = [];
  if (result.Item && result.Item.status !== 'removed') {
    existing = itemToRepos(result.Item as Record<string, unknown>);
  }

  if (existing.includes(repo)) {
    // Idempotent — already configured.
    return null;
  }

  if (existing.length >= CHANNEL_REPOS_MAX) {
    return `This channel already has ${CHANNEL_REPOS_MAX} repos configured. Remove one with \`/bgagent remove-repo owner/repo\` first.`;
  }

  const newRepos = [...existing, repo];
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      channel_id: key,
      repos: newRepos,
      // Keep legacy `repo` field as the first (oldest) repo so old code
      // that reads only `repo` still gets a sensible fallback.
      repo: newRepos[0],
      status: 'active',
      onboarded_at: (result.Item?.onboarded_at as string | undefined) ?? now,
      updated_at: now,
    },
  }));

  logger.info('Channel repo added', { channel_id: key, repo, total: newRepos.length });
  return null;
}

/**
 * Remove `repo` from the channel's default repo list (idempotent).
 *
 * Returns `null` on success, or a human-readable error string.
 */
export async function removeChannelRepo(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  teamId: string,
  channelId: string,
  repo: string,
): Promise<string | null> {
  const key = channelKey(teamId, channelId);
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { channel_id: key },
  }));

  if (!result.Item || result.Item.status === 'removed') {
    return 'No repos are configured for this channel.';
  }

  const existing = itemToRepos(result.Item as Record<string, unknown>);
  if (!existing.includes(repo)) {
    return `\`${repo}\` is not configured for this channel.`;
  }

  const newRepos = existing.filter(r => r !== repo);
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: tableName,
    Item: {
      channel_id: key,
      repos: newRepos,
      repo: newRepos[0] ?? null,
      status: newRepos.length > 0 ? 'active' : 'removed',
      onboarded_at: (result.Item.onboarded_at as string | undefined) ?? now,
      updated_at: now,
    },
  }));

  logger.info('Channel repo removed', { channel_id: key, repo, remaining: newRepos.length });
  return null;
}
