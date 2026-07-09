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
}));

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
}));

const createTaskCoreMock = jest.fn();
jest.mock('../../src/handlers/shared/create-task-core', () => ({
  createTaskCore: (...args: unknown[]) => createTaskCoreMock(...args),
}));

const getChannelReposMock = jest.fn();
const addChannelRepoMock = jest.fn();
const removeChannelRepoMock = jest.fn();
jest.mock('../../src/handlers/shared/channel-config', () => ({
  getChannelRepos: (...args: unknown[]) => getChannelReposMock(...args),
  addChannelRepo: (...args: unknown[]) => addChannelRepoMock(...args),
  removeChannelRepo: (...args: unknown[]) => removeChannelRepoMock(...args),
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';

import { handler, type MentionEvent, type SlashCommandEvent } from '../../src/handlers/slack-command-processor';

function mention(overrides: Partial<MentionEvent> = {}): MentionEvent {
  return {
    source: 'mention',
    text: 'submit org/repo fix the bug',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    mention_thread_ts: '1000.0001',
    ...overrides,
  };
}

function slashCommand(overrides: Partial<SlashCommandEvent> = {}): SlashCommandEvent {
  return {
    source: 'slash',
    text: 'help',
    user_id: 'U1',
    team_id: 'T1',
    channel_id: 'C1',
    command: '/bgagent',
    user_name: 'u',
    team_domain: 'acme',
    channel_name: 'general',
    trigger_id: 'T.1',
    response_url: 'https://hooks.slack.com/cmd/X',
    ...overrides,
  };
}

function isSlackHooksRequestUrl(url: unknown): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

describe('slack-command-processor handler', () => {
  beforeEach(() => {
    ddbSend.mockReset();
    smSend.mockReset();
    fetchMock.mockReset();
    createTaskCoreMock.mockReset();
    getChannelReposMock.mockReset();
    addChannelRepoMock.mockReset();
    removeChannelRepoMock.mockReset();
    smSend.mockResolvedValue({ SecretString: 'xoxb-bot' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
    // Default: no channel repos configured
    getChannelReposMock.mockResolvedValue([]);
  });

  test('slash command without source flag defaults to slash and falls through to default branch', async () => {
    // Legacy shape: no source field — slash ack lambda forwards raw SlackCommandPayload
    const legacy = {
      command: '/bgagent',
      text: 'unknown_sub',
      user_id: 'U1',
      team_id: 'T1',
      channel_id: 'C1',
      user_name: '',
      team_domain: '',
      channel_name: '',
      trigger_id: '',
      response_url: 'https://hooks.slack.com/cmd/X',
    };
    await handler(legacy);
    // Posted the default "Use @Shoof" hint back to the response_url
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) =>
        isSlackHooksRequestUrl(url) && String((opts as { body: string }).body).includes('Use `@Shoof`'),
    );
    expect(posted).toBeTruthy();
  });

  test('slash submit tells user to use @mention', async () => {
    await handler(slashCommand({ text: 'submit org/repo fix' }));
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) => String((opts as { body: string }).body).includes('Use `@Shoof` to submit tasks'),
    );
    expect(posted).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit requires linked account (prompts /bgagent link)', async () => {
    // 1. User mapping lookup: not found
    ddbSend.mockResolvedValueOnce({ Item: undefined });
    // 2. swapReaction → getBotToken → installation lookup (for :x: swap)
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('not linked'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo and no channel default replies with guidance', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // getChannelRepos returns [] (the default from beforeEach) → no default
    // swapReaction → getBotToken installation lookup.
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit not-a-repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo falls back to channel default when exactly one repo configured', async () => {
    // 1. user mapping → linked
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // 2. getChannelRepos → single default
    getChannelReposMock.mockResolvedValueOnce(['org/defaultrepo']);
    // 3. checkChannelAccess installation lookup (+ bot token secret)
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/defaultrepo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit fix the spacing on the header' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/defaultrepo');
    expect(reqBody.issue_number).toBeUndefined();
    // The whole message is the description — the first token is NOT dropped.
    expect(reqBody.task_description).toBe('fix the spacing on the header');
  });

  test('mention submit with no repo fails open when the channel lookup throws', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // getChannelRepos → fail open (returns [])
    getChannelReposMock.mockResolvedValueOnce([]);
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit fix the bug' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
  });

  test('mention submit with no repo and multiple channel repos posts a repo picker', async () => {
    // 1. user mapping → linked
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // 2. getChannelRepos → two defaults
    getChannelReposMock.mockResolvedValueOnce(['org/frontend', 'org/backend']);
    // 3. getBotToken installation lookup (for postEphemeral)
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });

    await handler(mention({ text: 'submit fix the auth bug' }));

    expect(createTaskCoreMock).not.toHaveBeenCalled();
    // Should have posted a chat.postEphemeral with buttons
    const picker = fetchMock.mock.calls.find(
      ([url, opts]) =>
        String(url).includes('chat.postEphemeral') &&
        String((opts as { body: string }).body).includes('org/frontend'),
    );
    expect(picker).toBeTruthy();
    // Should have action buttons for each repo
    const pickerBody = JSON.parse((fetchMock.mock.calls.find(([url]) => String(url).includes('chat.postEphemeral'))![1] as { body: string }).body) as { blocks: Array<{ elements?: Array<{ action_id?: string }> }> };
    const actionBlock = pickerBody.blocks.find(b => b.elements);
    expect(actionBlock?.elements?.some(e => e.action_id?.includes('org/frontend'))).toBe(true);
    expect(actionBlock?.elements?.some(e => e.action_id?.includes('org/backend'))).toBe(true);
  });

  test('mention submit creates task via createTaskCore', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // Installation lookup for bot token (checkChannelAccess) + bot token secret
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active' } });
    // fetch: conversations.info response (public channel with bot as member)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'TASK123', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo#42 add validation' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
    expect(reqBody.repo).toBe('org/repo');
    expect(reqBody.issue_number).toBe(42);
    expect(reqBody.task_description).toBe('add validation');
    expect(ctx.channelSource).toBe('slack');
    expect(ctx.userId).toBe('cognito-1');
    // mention_thread_ts flows to channel_metadata
    expect(ctx.channelMetadata.slack_thread_ts).toBe('1000.0001');
  });

  test('mention submit in private channel bot is not in — replies with invite hint', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'channel_not_found' }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('private channel'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit fails open on transient Slack errors (ratelimited, internal_error)', async () => {
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    // conversations.info returns a non-hard failure — task creation should proceed.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: 'ratelimited' }),
    });
    createTaskCoreMock.mockResolvedValueOnce({
      statusCode: 201,
      body: JSON.stringify({ data: { task_id: 'T1', repo: 'org/repo', status: 'SUBMITTED' } }),
    });
    await handler(mention({ text: 'submit org/repo fix' }));
    expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
  });

  test('link subcommand persists pending mapping with a link code', async () => {
    ddbSend.mockResolvedValueOnce({}); // Put pending mapping
    await handler(slashCommand({ text: 'link' }));
    const putCall = ddbSend.mock.calls.find(([cmd]) => cmd._type === 'Put');
    expect(putCall).toBeTruthy();
    expect(putCall![0].input.Item.slack_identity).toMatch(/^pending#/);
    expect(putCall![0].input.Item.status).toBe('pending');
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) => String((opts as { body: string }).body).includes('bgagent slack link'),
    );
    expect(posted).toBeTruthy();
  });

  test('help subcommand replies with usage text', async () => {
    await handler(slashCommand({ text: 'help' }));
    const posted = fetchMock.mock.calls.find(
      ([url, opts]) => String((opts as { body: string }).body).includes('Using Shoof'),
    );
    expect(posted).toBeTruthy();
  });

  // ─── Slack file attachment extraction ────────────────────────────────────────

  describe('file attachments', () => {
    beforeEach(() => {
      // Standard setup: linked user, public channel
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
    });

    test('downloads Slack files and passes as inline attachments', async () => {
      // fetch for file download
      fetchMock.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('file content')),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });

      await handler(mention({
        text: 'submit org/repo fix the bug',
        files: [{
          id: 'F1',
          name: 'screenshot.png',
          mimetype: 'image/png',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/screenshot.png',
        }],
      }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toHaveLength(1);
      expect(reqBody.attachments[0].type).toBe('image');
      expect(reqBody.attachments[0].content_type).toBe('image/png');
      expect(reqBody.attachments[0].filename).toBe('screenshot.png');
      expect(reqBody.attachments[0].data).toBe(Buffer.from('file content').toString('base64'));
    });

    test('rejects files with unsupported MIME types', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'virus.exe',
          mimetype: 'application/x-executable',
          size: 1024,
          url_private_download: 'https://files.slack.com/files/F1/virus.exe',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('unsupported type'),
      );
      expect(reply).toBeTruthy();
    });

    test('rejects files exceeding 10 MB size limit', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [{
          id: 'F1',
          name: 'huge.png',
          mimetype: 'image/png',
          size: 11 * 1024 * 1024, // 11 MB
          url_private_download: 'https://files.slack.com/files/F1/huge.png',
        }],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('too large'),
      );
      expect(reply).toBeTruthy();
    });

    test('reports all file errors atomically', async () => {
      await handler(mention({
        text: 'submit org/repo fix',
        files: [
          { id: 'F1', name: 'big.png', mimetype: 'image/png', size: 11 * 1024 * 1024, url_private_download: 'https://files.slack.com/files/F1/big.png' },
          { id: 'F2', name: 'bad.exe', mimetype: 'application/x-executable', size: 100, url_private_download: 'https://files.slack.com/files/F2/bad.exe' },
        ],
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('2 attachment errors'),
      );
      expect(reply).toBeTruthy();
    });

    test('proceeds without attachments when no files are present', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      await handler(mention({ text: 'submit org/repo fix' }));
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.attachments).toBeUndefined();
    });
  });

  // ─── set-repo / remove-repo / list-repos subcommands ────────────────────────

  describe('set-repo', () => {
    test('adds a default repo for the channel and replies with confirmation', async () => {
      addChannelRepoMock.mockResolvedValueOnce(null); // success
      await handler(slashCommand({ text: 'set-repo org/backend' }));
      expect(addChannelRepoMock).toHaveBeenCalledWith(
        expect.anything(), 'SlackChannelMap', 'T1', 'C1', 'org/backend',
      );
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('added as a default repo'),
      );
      expect(posted).toBeTruthy();
    });

    test('replies with usage when no repo argument given', async () => {
      await handler(slashCommand({ text: 'set-repo' }));
      expect(addChannelRepoMock).not.toHaveBeenCalled();
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('Usage:'),
      );
      expect(posted).toBeTruthy();
    });

    test('relays error from addChannelRepo to user', async () => {
      addChannelRepoMock.mockResolvedValueOnce('Invalid repo format — use `owner/repo`.');
      await handler(slashCommand({ text: 'set-repo bad' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('Invalid repo format'),
      );
      expect(posted).toBeTruthy();
    });
  });

  describe('remove-repo', () => {
    test('removes a default repo and replies with confirmation', async () => {
      removeChannelRepoMock.mockResolvedValueOnce(null); // success
      await handler(slashCommand({ text: 'remove-repo org/backend' }));
      expect(removeChannelRepoMock).toHaveBeenCalledWith(
        expect.anything(), 'SlackChannelMap', 'T1', 'C1', 'org/backend',
      );
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('removed from this channel'),
      );
      expect(posted).toBeTruthy();
    });

    test('replies with usage when no repo argument given', async () => {
      await handler(slashCommand({ text: 'remove-repo' }));
      expect(removeChannelRepoMock).not.toHaveBeenCalled();
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('Usage:'),
      );
      expect(posted).toBeTruthy();
    });

    test('relays error from removeChannelRepo to user', async () => {
      removeChannelRepoMock.mockResolvedValueOnce('`org/gone` is not configured for this channel.');
      await handler(slashCommand({ text: 'remove-repo org/gone' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('not configured'),
      );
      expect(posted).toBeTruthy();
    });
  });

  describe('list-repos', () => {
    test('lists configured repos', async () => {
      getChannelReposMock.mockResolvedValueOnce(['org/a', 'org/b']);
      await handler(slashCommand({ text: 'list-repos' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) =>
          String((opts as { body: string }).body).includes('org/a') &&
          String((opts as { body: string }).body).includes('org/b'),
      );
      expect(posted).toBeTruthy();
    });

    test('replies with guidance when no repos are configured', async () => {
      getChannelReposMock.mockResolvedValueOnce([]);
      await handler(slashCommand({ text: 'list-repos' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => String((opts as { body: string }).body).includes('No default repos'),
      );
      expect(posted).toBeTruthy();
    });
  });
});
