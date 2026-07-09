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
  QueryCommand: jest.fn((input: unknown) => ({ _type: 'Query', input })),
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

const fetchMock = jest.fn();
(global as unknown as { fetch: unknown }).fetch = fetchMock;

process.env.SLACK_USER_MAPPING_TABLE_NAME = 'SlackMap';
process.env.SLACK_INSTALLATION_TABLE_NAME = 'SlackInstall';
process.env.SLACK_CHANNEL_MAPPING_TABLE_NAME = 'SlackChannelMap';
process.env.TASK_TABLE_NAME = 'TaskTable';

import type { SlackThreadTask } from '../../src/handlers/shared/slack-task-by-thread';
import { handler, type MentionEvent, type SlashCommandEvent, type ThreadReplyEvent } from '../../src/handlers/slack-command-processor';

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
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('no default repo set'),
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
      ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('no default repo set'),
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

  // ─── ABCA-661: workflow_ref from keyword prefix ──────────────────────────

  describe('workflow_ref passthrough (ABCA-661)', () => {
    test('mention with workflow_ref passes it through to createTaskCore', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });

      await handler(mention({
        text: 'submit org/repo fix the auth bug',
        workflow_ref: 'coding/decompose-v1',
      }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBe('coding/decompose-v1');
    });

    test('mention without workflow_ref does not pass workflow_ref to createTaskCore', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1' } }),
      });

      await handler(mention({ text: 'submit org/repo fix the auth bug' }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBeUndefined();
    });
  });

  // ─── ABCA-661: ThreadReplyEvent handling ────────────────────────────────

  describe('ThreadReplyEvent handling (ABCA-661)', () => {
    function threadReplyEvent(taskOverrides: Partial<SlackThreadTask> = {}, replyText = 'please add a docstring'): ThreadReplyEvent {
      const thread_task: SlackThreadTask = {
        task_id: 'T99',
        repo: 'org/repo',
        pr_number: 7,
        status: 'COMPLETED',
        resolved_workflow_id: 'coding/new-task-v1',
        code_changed: true,
        ...taskOverrides,
      };
      return {
        source: 'thread_reply',
        text: replyText,
        user_id: 'U1',
        team_id: 'T1',
        channel_id: 'C1',
        thread_ts: '100.000',
        reply_text: replyText,
        thread_task,
      };
    }

    beforeEach(() => {
      // Default: linked user, active installation
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });

    test('PR-iteration: dispatches coding/pr-iteration-v1 when task has a pr_number', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T100' } }),
      });

      await handler(threadReplyEvent({ pr_number: 42, code_changed: true }, 'add a docstring'));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody, ctx] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(reqBody.pr_number).toBe(42);
      expect(reqBody.repo).toBe('org/repo');
      expect(reqBody.task_description).toBe('add a docstring');
      expect(ctx.channelSource).toBe('slack');
      expect(ctx.channelMetadata.slack_thread_ts).toBe('100.000');
    });

    test('PR-iteration: falls back to parsing pr_url when pr_number absent', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T101' } }),
      });

      await handler(threadReplyEvent({
        pr_number: undefined,
        pr_url: 'https://github.com/org/repo/pull/99',
        code_changed: true,
      }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBe('coding/pr-iteration-v1');
      expect(reqBody.pr_number).toBe(99);
    });

    test('clarify-resume: dispatches coding/new-task-v1 when task is in clarify-hold state', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T102' } }),
      });

      await handler(threadReplyEvent({
        pr_number: undefined,
        pr_url: undefined,
        resolved_workflow_id: 'coding/new-task-v1',
        code_changed: false,
        answer_text: 'Should this target Node 18 or 20?',
        task_description: 'upgrade the runtime',
      }, 'Node 20 please'));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      const [reqBody] = createTaskCoreMock.mock.calls[0];
      expect(reqBody.workflow_ref).toBe('coding/new-task-v1');
      // The resume description includes original task + question + answer
      expect(reqBody.task_description).toContain('upgrade the runtime');
      expect(reqBody.task_description).toContain('Node 20 please');
    });

    test('no actionable state (no PR, not clarify-hold) — silently ignored', async () => {
      // Task is running (no PR, code_changed=undefined) — reply is not actionable.
      await handler(threadReplyEvent({
        pr_number: undefined,
        pr_url: undefined,
        resolved_workflow_id: 'coding/new-task-v1',
        code_changed: undefined,
        answer_text: undefined,
      }));

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      // No error reply posted
      const errorReply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes(':x:'),
      );
      expect(errorReply).toBeFalsy();
    });

    test('unlinked user prompts /bgagent link', async () => {
      // Override the first DDB mock to simulate no mapping
      ddbSend.mockReset();
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });

      await handler(threadReplyEvent());

      expect(createTaskCoreMock).not.toHaveBeenCalled();
      const reply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('not linked'),
      );
      expect(reply).toBeTruthy();
    });

    test('createTaskCore failure for PR-iteration posts error reply', async () => {
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 400,
        body: JSON.stringify({ error: { message: 'PR not found' } }),
      });

      await handler(threadReplyEvent({ pr_number: 1, code_changed: true }));

      const errorReply = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage') && String((opts as { body: string }).body).includes('PR not found'),
      );
      expect(errorReply).toBeTruthy();
    });
  });

  describe('multi-repo channel defaults', () => {
    test('mention with no repo and multiple channel defaults posts a picker and defers submission', async () => {
      // 1. user mapping → linked
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      // 2. getChannelRepos → two configured repos
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a', 'org/b'] } });
      // 3. putPendingRepoPick
      ddbSend.mockResolvedValueOnce({});
      // 4+. getBotToken installation lookup for chat.postMessage
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });

      await handler(mention({ text: 'submit fix the auth bug' }));

      // No task created yet — deferred until the user picks.
      expect(createTaskCoreMock).not.toHaveBeenCalled();
      // Picker posted via chat.postMessage with actions blocks.
      const picker = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage')
          && String((opts as { body: string }).body).includes('pick_repo'),
      );
      expect(picker).toBeTruthy();
      const body = JSON.parse((picker![1] as { body: string }).body);
      expect(body.blocks.some((b: { type: string }) => b.type === 'actions')).toBe(true);
    });

    test('picker uses a static_select once repos exceed the button threshold', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      ddbSend.mockResolvedValueOnce({
        Item: { status: 'active', repos: ['o/a', 'o/b', 'o/c', 'o/d', 'o/e', 'o/f'] },
      });
      ddbSend.mockResolvedValueOnce({});
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });

      await handler(mention({ text: 'submit do the thing' }));

      const picker = fetchMock.mock.calls.find(
        ([url, opts]) => String(url).includes('chat.postMessage')
          && String((opts as { body: string }).body).includes('static_select'),
      );
      expect(picker).toBeTruthy();
    });

    test('explicit repo still overrides channel defaults (one-off cross-repo)', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', platform_user_id: 'cognito-1' } });
      // No channel lookup because the repo is explicit; go straight to channel access.
      ddbSend.mockResolvedValue({ Item: { status: 'active' } });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ok: true, channel: { is_private: false, is_member: true } }),
      });
      createTaskCoreMock.mockResolvedValueOnce({
        statusCode: 201,
        body: JSON.stringify({ data: { task_id: 'T1', repo: 'other/repo' } }),
      });

      await handler(mention({ text: 'submit other/repo fix it here' }));

      expect(createTaskCoreMock).toHaveBeenCalledTimes(1);
      expect(createTaskCoreMock.mock.calls[0][0].repo).toBe('other/repo');
    });
  });

  describe('set-repo / repos slash commands', () => {
    test('set-repo adds a repo to the channel and confirms', async () => {
      // getChannelRepos (empty) then put
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      ddbSend.mockResolvedValueOnce({});
      await handler(slashCommand({ text: 'set-repo org/website' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes('defaults to'),
      );
      expect(posted).toBeTruthy();
    });

    test('set-repo rejects a malformed repo', async () => {
      await handler(slashCommand({ text: 'set-repo not-a-repo' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes("doesn't look like a repo"),
      );
      expect(posted).toBeTruthy();
      // No write attempted.
      expect(ddbSend).not.toHaveBeenCalled();
    });

    test('set-repo with no argument shows usage', async () => {
      await handler(slashCommand({ text: 'set-repo' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes('Usage:'),
      );
      expect(posted).toBeTruthy();
    });

    test('repos lists configured channel repos', async () => {
      ddbSend.mockResolvedValueOnce({ Item: { status: 'active', repos: ['org/a', 'org/b'] } });
      await handler(slashCommand({ text: 'repos' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes('org/a')
          && String((opts as { body: string }).body).includes('org/b'),
      );
      expect(posted).toBeTruthy();
    });

    test('repos guides the user when no repos are configured', async () => {
      ddbSend.mockResolvedValueOnce({ Item: undefined });
      await handler(slashCommand({ text: 'repos' }));
      const posted = fetchMock.mock.calls.find(
        ([url, opts]) => isSlackHooksRequestUrl(url)
          && String((opts as { body: string }).body).includes('no default repo set'),
      );
      expect(posted).toBeTruthy();
    });
  });
});
