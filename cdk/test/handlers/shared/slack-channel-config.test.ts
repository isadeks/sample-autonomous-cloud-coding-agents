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

const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: ddbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  DeleteCommand: jest.fn((input: unknown) => ({ _type: 'Delete', input })),
}));

import {
  addChannelRepo,
  deletePendingRepoPick,
  getChannelRepos,
  getPendingRepoPick,
  putPendingRepoPick,
  removeChannelRepo,
} from '../../../src/handlers/shared/slack-channel-config';

const TABLE = 'ChannelMap';

describe('slack-channel-config', () => {
  beforeEach(() => {
    ddbSend.mockReset();
  });

  describe('getChannelRepos', () => {
    test('returns [] when table name is undefined', async () => {
      const repos = await getChannelRepos(undefined, 'T1', 'C1');
      expect(repos).toEqual([]);
      expect(ddbSend).not.toHaveBeenCalled();
    });

    test('returns [] when no item exists', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      expect(await getChannelRepos(TABLE, 'T1', 'C1')).toEqual([]);
    });

    test('returns [] when status is not active', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'removed', repos: ['org/a'] } });
      expect(await getChannelRepos(TABLE, 'T1', 'C1')).toEqual([]);
    });

    test('reads a legacy scalar repo row as a one-element list', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/legacy' } });
      expect(await getChannelRepos(TABLE, 'T1', 'C1')).toEqual(['org/legacy']);
    });

    test('reads a multi-repo list row', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a', 'org/b'] } });
      expect(await getChannelRepos(TABLE, 'T1', 'C1')).toEqual(['org/a', 'org/b']);
    });

    test('reads a DynamoDB string-set row', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: new Set(['org/a', 'org/b']) } });
      expect(await getChannelRepos(TABLE, 'T1', 'C1').then((r) => r.sort())).toEqual(['org/a', 'org/b']);
    });

    test('uses the composite {team}#{channel} key', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a'] } });
      await getChannelRepos(TABLE, 'T1', 'C1');
      expect(ddbSend.mock.calls[0][0].input.Key).toEqual({ channel_id: 'T1#C1' });
    });

    test('fails open (returns []) when the lookup throws', async () => {
      ddbSend.mockRejectedValueOnce(new Error('ddb blip'));
      expect(await getChannelRepos(TABLE, 'T1', 'C1')).toEqual([]);
    });
  });

  describe('addChannelRepo', () => {
    test('adds a repo to an empty channel and writes status active', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined }); // getChannelRepos
      ddbSend.mockResolvedValueOnce({}); // put
      const repos = await addChannelRepo(TABLE, 'T1', 'C1', 'org/new');
      expect(repos).toEqual(['org/new']);
      const putInput = ddbSend.mock.calls[1][0].input;
      expect(putInput.Item.repos).toEqual(['org/new']);
      expect(putInput.Item.repo).toBe('org/new');
      expect(putInput.Item.status).toBe('active');
      expect(putInput.Item.channel_id).toBe('T1#C1');
    });

    test('appends to an existing list without duplicating', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a'] } });
      ddbSend.mockResolvedValueOnce({});
      const repos = await addChannelRepo(TABLE, 'T1', 'C1', 'org/b');
      expect(repos).toEqual(['org/a', 'org/b']);
    });

    test('is idempotent when re-adding the same repo', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a'] } });
      ddbSend.mockResolvedValueOnce({});
      const repos = await addChannelRepo(TABLE, 'T1', 'C1', 'org/a');
      expect(repos).toEqual(['org/a']);
    });

    test('migrates a legacy scalar repo row into the list', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/legacy' } });
      ddbSend.mockResolvedValueOnce({});
      const repos = await addChannelRepo(TABLE, 'T1', 'C1', 'org/new');
      expect(repos).toEqual(['org/legacy', 'org/new']);
    });
  });

  describe('removeChannelRepo', () => {
    test('removes a repo and writes the remaining list', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a', 'org/b'] } });
      ddbSend.mockResolvedValueOnce({});
      const repos = await removeChannelRepo(TABLE, 'T1', 'C1', 'org/a');
      expect(repos).toEqual(['org/b']);
    });
  });

  describe('pending repo picks', () => {
    test('putPendingRepoPick stores a TTL-bounded record keyed by token', async () => {
      ddbSend.mockResolvedValueOnce({});
      await putPendingRepoPick(TABLE, 'tok1', {
        description: 'fix the bug',
        team_id: 'T1',
        channel_id: 'C1',
        user_id: 'U1',
        thread_ts: '1000.1',
      });
      const input = ddbSend.mock.calls[0][0].input;
      expect(input.Item.channel_id).toBe('pending#tok1');
      expect(input.Item.kind).toBe('repo_pick');
      expect(input.Item.description).toBe('fix the bug');
      expect(input.Item.thread_ts).toBe('1000.1');
      expect(typeof input.Item.ttl).toBe('number');
    });

    test('getPendingRepoPick returns the stored context', async () => {
      ddbSend.mockResolvedValueOnce({
        Item: {
          channel_id: 'pending#tok1',
          kind: 'repo_pick',
          description: 'fix the bug',
          team_id: 'T1',
          slack_channel_id: 'C1',
          user_id: 'U1',
          thread_ts: '1000.1',
          ttl: Math.floor(Date.now() / 1000) + 600,
        },
      });
      const pick = await getPendingRepoPick(TABLE, 'tok1');
      expect(pick).toEqual({
        description: 'fix the bug',
        team_id: 'T1',
        channel_id: 'C1',
        user_id: 'U1',
        thread_ts: '1000.1',
        files: undefined,
      });
    });

    test('getPendingRepoPick returns null for a missing record', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      expect(await getPendingRepoPick(TABLE, 'nope')).toBeNull();
    });

    test('getPendingRepoPick returns null for an expired record', async () => {
      ddbSend.mockResolvedValueOnce({
        Item: {
          kind: 'repo_pick',
          team_id: 'T1',
          slack_channel_id: 'C1',
          user_id: 'U1',
          ttl: Math.floor(Date.now() / 1000) - 10,
        },
      });
      expect(await getPendingRepoPick(TABLE, 'tok1')).toBeNull();
    });

    test('getPendingRepoPick ignores records of the wrong kind', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { kind: 'something_else' } });
      expect(await getPendingRepoPick(TABLE, 'tok1')).toBeNull();
    });

    test('deletePendingRepoPick deletes by token key and swallows errors', async () => {
      ddbSend.mockResolvedValueOnce({});
      await deletePendingRepoPick(TABLE, 'tok1');
      expect(ddbSend.mock.calls[0][0].input.Key).toEqual({ channel_id: 'pending#tok1' });

      ddbSend.mockRejectedValueOnce(new Error('blip'));
      await expect(deletePendingRepoPick(TABLE, 'tok1')).resolves.toBeUndefined();
    });
  });
});
