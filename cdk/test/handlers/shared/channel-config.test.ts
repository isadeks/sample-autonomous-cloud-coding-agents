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

const ddbSendMock = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSendMock })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CHANNEL_REPOS_MAX,
  addChannelRepo,
  getChannelRepos,
  removeChannelRepo,
} from '../../../src/handlers/shared/channel-config';

const TABLE = 'ChannelMappingTable';
const TEAM_ID = 'T1';
const CHANNEL_ID = 'C1';
const KEY = `${TEAM_ID}#${CHANNEL_ID}`;

// The DDB client constructed during module load.
const ddb = DynamoDBDocumentClient.from({} as never);

beforeEach(() => ddbSendMock.mockReset());

// ─── getChannelRepos ─────────────────────────────────────────────────────────

describe('getChannelRepos', () => {
  test('returns empty array when item not found', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: undefined });
    const repos = await getChannelRepos(ddb, TABLE, TEAM_ID, CHANNEL_ID);
    expect(repos).toEqual([]);
  });

  test('returns empty array when status is "removed"', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'removed', repos: ['org/repo'] } });
    const repos = await getChannelRepos(ddb, TABLE, TEAM_ID, CHANNEL_ID);
    expect(repos).toEqual([]);
  });

  test('returns repos array from item', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repos: ['org/a', 'org/b'] } });
    const repos = await getChannelRepos(ddb, TABLE, TEAM_ID, CHANNEL_ID);
    expect(repos).toEqual(['org/a', 'org/b']);
  });

  test('falls back to legacy `repo` string field when `repos` is absent', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repo: 'org/legacy' } });
    const repos = await getChannelRepos(ddb, TABLE, TEAM_ID, CHANNEL_ID);
    expect(repos).toEqual(['org/legacy']);
  });

  test('fails open (returns []) on DynamoDB error', async () => {
    ddbSendMock.mockRejectedValueOnce(new Error('DDB blip'));
    const repos = await getChannelRepos(ddb, TABLE, TEAM_ID, CHANNEL_ID);
    expect(repos).toEqual([]);
  });
});

// ─── addChannelRepo ──────────────────────────────────────────────────────────

describe('addChannelRepo', () => {
  test('returns error for invalid repo format', async () => {
    const err = await addChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'not-a-valid-repo');
    expect(err).toMatch(/Invalid repo format/);
    expect(ddbSendMock).not.toHaveBeenCalled();
  });

  test('adds first repo when channel has no config', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: undefined }); // Get → not found
    ddbSendMock.mockResolvedValueOnce({}); // Put → ok

    const err = await addChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/repo');
    expect(err).toBeNull();

    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    const item = putCall![0].input.Item;
    expect(item.repos).toEqual(['org/repo']);
    expect(item.repo).toBe('org/repo');
    expect(item.status).toBe('active');
  });

  test('appends to existing list', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repos: ['org/a'], repo: 'org/a', onboarded_at: '2024-01-01' } });
    ddbSendMock.mockResolvedValueOnce({});

    const err = await addChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/b');
    expect(err).toBeNull();
    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall![0].input.Item.repos).toEqual(['org/a', 'org/b']);
  });

  test('is idempotent — does not duplicate an already-configured repo', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repos: ['org/a'], repo: 'org/a' } });

    const err = await addChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/a');
    expect(err).toBeNull();
    // No Put should have been issued
    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeFalsy();
  });

  test('returns error when at CHANNEL_REPOS_MAX limit', async () => {
    const full = Array.from({ length: CHANNEL_REPOS_MAX }, (_, i) => `org/repo${i}`);
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repos: full, repo: full[0] } });

    const err = await addChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/new');
    expect(err).toMatch(/already has/);
    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeFalsy();
  });

  test('treats a removed item as empty and creates fresh record', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'removed', repos: [], repo: null } });
    ddbSendMock.mockResolvedValueOnce({});

    const err = await addChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/repo');
    expect(err).toBeNull();
    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall![0].input.Item.repos).toEqual(['org/repo']);
  });
});

// ─── removeChannelRepo ───────────────────────────────────────────────────────

describe('removeChannelRepo', () => {
  test('returns error when channel has no config', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: undefined });
    const err = await removeChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/repo');
    expect(err).toMatch(/No repos are configured/);
  });

  test('returns error when channel status is "removed"', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { status: 'removed', repos: [] } });
    const err = await removeChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/repo');
    expect(err).toMatch(/No repos are configured/);
  });

  test('returns error when repo is not in the list', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/other'] } });
    const err = await removeChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/repo');
    expect(err).toMatch(/not configured/);
  });

  test('removes a repo from the list', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repos: ['org/a', 'org/b'], repo: 'org/a', onboarded_at: '2024-01-01' } });
    ddbSendMock.mockResolvedValueOnce({});

    const err = await removeChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/a');
    expect(err).toBeNull();
    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall![0].input.Item.repos).toEqual(['org/b']);
    expect(putCall![0].input.Item.repo).toBe('org/b');
    expect(putCall![0].input.Item.status).toBe('active');
  });

  test('sets status to "removed" when the last repo is removed', async () => {
    ddbSendMock.mockResolvedValueOnce({ Item: { channel_id: KEY, status: 'active', repos: ['org/only'], repo: 'org/only' } });
    ddbSendMock.mockResolvedValueOnce({});

    const err = await removeChannelRepo(ddb, TABLE, TEAM_ID, CHANNEL_ID, 'org/only');
    expect(err).toBeNull();
    const putCall = ddbSendMock.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall![0].input.Item.repos).toEqual([]);
    expect(putCall![0].input.Item.status).toBe('removed');
  });
});
