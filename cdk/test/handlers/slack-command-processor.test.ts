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

const resolveTaskBySlackThreadMock = jest.fn();
jest.mock('../../src/handlers/shared/slack-task-by-thread', () => ({
  resolveTaskBySlackThread: (...args: unknown[]) => resolveTaskBySlackThreadMock(...args),
  // Reuse the real prNumberFromTask so the follow-up path's PR extraction is
  // exercised, not stubbed.
  prNumberFromTask: jest.requireActual('../../src/handlers/shared/linear-task-by-issue').prNumberFromTask,
}));

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';
process.env.TASK_TABLE_NAME = 'TaskTable';

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
    resolveTaskBySlackThreadMock.mockReset();
    resolveTaskBySlackThreadMock.mockResolvedValue(null);
    smSend.mockResolvedValue({ SecretString: 'xoxb-bot' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true }),
    });
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
      ([_url, opts]) => String((opts as { body: string }).body).includes('Use `@Shoof` to submit tasks'),
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
    // channel-default lookup returns a row without a repo → no default; then
    // swapReaction → getBotToken installation lookup.
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit not-a-repo fix' }));
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
    expect(createTaskCoreMock).not.toHaveBeenCalled();
  });

  test('mention submit with no repo falls back to channel default and uses full text as description', async () => {
    // 1. user mapping → linked
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
    // 2. channel-default lookup → active mapping to org/defaultrepo
    ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repo: 'org/defaultrepo' } });
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
    // channel-default lookup throws → fail open → no default → guidance reply
    ddbSend.mockRejectedValueOnce(new Error('ddb blip'));
    ddbSend.mockResolvedValue({ Item: { status: 'active' } });
    await handler(mention({ text: 'submit fix the bug' }));
    expect(createTaskCoreMock).not.toHaveBeenCalled();
    const reply = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('Please include a repo'),
    );
    expect(reply).toBeTruthy();
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
    // Must pin the coding workflow — an absent workflow_ref falls through the
    // resolution ladder to default/agent-v1, which never opens a PR. Mirrors
    // the Jira processor (#546/#547).
    expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
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
      ([_url, opts]) => String((opts as { body: string }).body).includes('bgagent slack link'),
    );
    expect(posted).toBeTruthy();
  });

  test('help subcommand replies with usage text', async () => {
    await handler(slashCommand({ text: 'help' }));
    const posted = fetchMock.mock.calls.find(
      ([_url, opts]) => String((opts as { body: string }).body).includes('Using Shoof'),
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

  // ─── ABCA-1015 thread follow-ups ─────────────────────────────────────────────
  describe('thread follow-up', () => {
    /** A follow-up reply the events handler forwarded (is_thread_reply set). */
    function followUp(overrides: Partial<MentionEvent> = {}): MentionEvent {
      return mention({
        text: 'submit also fix the header',
        is_thread_reply: true,
        follow_up_instruction: 'also fix the header',
        mention_thread_ts: '1000.0001',
        reply_message_ts: '1000.0009',
        ...overrides,
      });
    }

    /** Mock the DDB reads the follow-up path makes: the user mapping (linked by
     *  default) + an active workspace installation (so getBotToken succeeds and
     *  in-thread replies can post). Pass linked=false to simulate an unlinked
     *  user while still resolving a bot token. */
    function linkUser(opts: { linked?: boolean; platformUserId?: string } = {}): void {
      const { linked = true, platformUserId = 'user-123' } = opts;
      ddbSend.mockImplementation((cmd: { _type: string; input?: { Key?: { slack_identity?: string; team_id?: string } } }) => {
        if (cmd._type === 'Get' && cmd.input?.Key?.slack_identity) {
          return linked
            ? Promise.resolve({ Item: { platform_user_id: platformUserId, status: 'linked' } })
            : Promise.resolve({});
        }
        if (cmd._type === 'Get' && cmd.input?.Key?.team_id) {
          return Promise.resolve({ Item: { status: 'active' } });
        }
        return Promise.resolve({});
      });
    }

    test('resolves the thread and iterates the existing PR (pr-iteration-v1)', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', pr_number: 42, status: 'COMPLETED', user_id: 'orig',
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201, body: JSON.stringify({ data: { task_id: 'Tnew' } }),
      });

      await handler(followUp());

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(reqBody.pr_number).toBe(42);
      expect(reqBody.task_description).toBe('also fix the header');
      expect(ctx.channelSource).toBe('slack');
      expect(ctx.channelMetadata.slack_thread_ts).toBe('1000.0001');
      expect(ctx.channelMetadata.slack_follow_up).toBe('true');
      expect(ctx.idempotencyKey).toContain('slack-iterate-');
    });

    test('a bare re-mention iterates with the default review instruction', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', pr_number: 7, status: 'COMPLETED', user_id: 'orig',
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201, body: JSON.stringify({ data: { task_id: 'Tnew' } }),
      });

      await handler(followUp({ text: 'submit', follow_up_instruction: '' }));

      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.task_description).toBe('Address the latest review feedback on this pull request.');
    });

    test('recognises a plain "retry" after a failure and re-runs on the same PR', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', pr_number: 5, status: 'FAILED', user_id: 'orig',
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201, body: JSON.stringify({ data: { task_id: 'Tnew' } }),
      });

      await handler(followUp({ text: 'submit retry', follow_up_instruction: 'retry' }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(reqBody.pr_number).toBe(5);
    });

    test('thread with no ABCA task falls through to submit (new work)', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce(null);
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201, body: JSON.stringify({ data: { task_id: 'Tnew' } }),
      });

      await handler(followUp({ text: 'submit org/repo do a new thing', follow_up_instruction: 'org/repo do a new thing' }));

      // Fell through to the normal submit path → a fresh coding task, not an iteration.
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).not.toBe('coding/pr-iteration-v1');
    });

    test('task exists but has no PR yet (still running) → patient reply, no new task', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', status: 'RUNNING', user_id: 'orig',
      });

      await handler(followUp());

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('still working'),
      );
      expect(reply).toBeTruthy();
    });

    test('task finished with no PR → explains and does not diverge', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', status: 'COMPLETED', user_id: 'orig',
      });

      await handler(followUp());

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes("didn't open a pull request"),
      );
      expect(reply).toBeTruthy();
    });

    test('unlinked user (and no original owner) → link prompt, no task', async () => {
      // No user mapping (unlinked) — but a resolvable bot token so the reply posts.
      linkUser({ linked: false });
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', pr_number: 3, status: 'COMPLETED',
      });

      await handler(followUp());

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('linked ABCA account'),
      );
      expect(reply).toBeTruthy();
    });

    test('idempotent replay (200) does not double-notify', async () => {
      linkUser();
      resolveTaskBySlackThreadMock.mockResolvedValueOnce({
        task_id: 'Tprev', repo: 'org/repo', pr_number: 9, status: 'COMPLETED', user_id: 'orig',
      });
      createTaskCoreMock.mockResolvedValueOnce({ statusCode: 200, body: JSON.stringify({}) });

      await handler(followUp());

      // Still dispatched exactly once; the 200 path returns quietly.
      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
    });

    test('a non-thread mention is never treated as a follow-up', async () => {
      linkUser();
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201, body: JSON.stringify({ data: { task_id: 'T1' } }),
      });
      // No is_thread_reply flag → resolver is not consulted.
      await handler(mention({ text: 'submit org/repo fix the bug' }));
      expect(resolveTaskBySlackThreadMock).not.toHaveBeenCalled();
    });
  });
});
