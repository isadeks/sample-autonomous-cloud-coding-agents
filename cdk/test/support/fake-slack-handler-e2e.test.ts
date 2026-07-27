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
 * End-to-end proof that FakeSlack can drive a REAL Slack handler with no network.
 *
 * This is the payoff the double exists for: the sibling conversational sub-issues
 * want to assert "a user clicked Cancel and the panel updated + the rocket
 * message was deleted" without a hand-rolled fetch mock per test. Here we take
 * the REAL `slack-interactions` handler and:
 *
 *   - sign a Block Kit button-click payload with the fake (so the handler's REAL
 *     `verifySlackRequest` accepts it),
 *   - back the handler's Slack calls with the fake's `fetch` (so `chat.update`
 *     and `chat.delete` mutate real fake state),
 *   - stub ONLY the AWS edges the handler talks to (DynamoDB, Secrets Manager) —
 *     the Slack surface is the fake, unchanged.
 *
 * Then we assert on the fake's observable Slack state, exactly as a downstream
 * conversational test would.
 */

// ── AWS edges: DynamoDB (task + user mapping) and the Slack signing secret ──
const ddbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

// The signing secret and the per-workspace bot token both come through
// `getSlackSecret`, which reads Secrets Manager. Mock ONLY that AWS edge — the
// REAL `slack-verify` (including `verifySlackRequest`) runs against these
// values, so the fake's inbound-event signatures are validated by production
// code, not a stubbed verifier.
const SIGNING_SECRET = 'e2e-signing-secret';
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({
    send: async (cmd: { input: { SecretId: string } }) => {
      const id = cmd.input.SecretId;
      if (id === 'arn:signing') return { SecretString: SIGNING_SECRET };
      if (id === 'bgagent/slack/T1') return { SecretString: 'xoxb-T1' };
      const err = new Error('not found');
      err.name = 'ResourceNotFoundException';
      throw err;
    },
  })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ input })),
}));

process.env.SLACK_SIGNING_SECRET_ARN = 'arn:signing';
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.SLACK_USER_MAPPING_TABLE_NAME = 'UserMap';

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { FakeSlack } from './fake-slack';
import { handler as interactionsHandler } from '../../src/handlers/slack-interactions';

let fake: FakeSlack;
let restore: () => void;

beforeEach(() => {
  jest.clearAllMocks();
  fake = new FakeSlack({ signingSecret: SIGNING_SECRET });
  fake.addWorkspace({ teamId: 'T1', botToken: 'xoxb-T1', botUserId: 'U-bot' });
  fake.addChannel({ id: 'C1', name: 'general' });
  restore = fake.install();
});

afterEach(() => restore());

/** Turn a fake-built inbound event into the APIGatewayProxyEvent the handler reads. */
function asApiGwEvent(built: { body: string; headers: Record<string, string> }): APIGatewayProxyEvent {
  return { body: built.body, headers: built.headers } as unknown as APIGatewayProxyEvent;
}

describe('slack-interactions handler driven end-to-end through FakeSlack', () => {
  test('a Cancel button click updates the session panel and deletes the rocket message', async () => {
    // Seed the panel + rocket message the way the notify handler would have.
    const session = await slackPost('C1', 'Working on it…');
    const rocket = await slackPost('C1', ':rocket: task started');

    // DDB: user is linked, task is theirs and cancellable, cancel UpdateItem OK.
    ddbSend.mockImplementation(async (cmd: { _type: string; input: { Key?: Record<string, string> } }) => {
      if (cmd._type === 'Get' && cmd.input.Key?.slack_identity) {
        return { Item: { slack_identity: 'T1#U9', platform_user_id: 'user-9', status: 'active' } };
      }
      if (cmd._type === 'Get') {
        return {
          Item: {
            task_id: 'task-123',
            user_id: 'user-9',
            status: 'RUNNING',
            channel_metadata: {
              slack_channel_id: 'C1',
              slack_session_msg_ts: session.ts,
              slack_created_msg_ts: rocket.ts,
            },
          },
        };
      }
      return {}; // UpdateItem
    });

    const evt = fake.buttonClickEvent({
      teamId: 'T1',
      user: 'U9',
      channel: 'C1',
      actionId: 'cancel_task:task-123',
      value: 'task-123',
    });

    const res = await interactionsHandler(asApiGwEvent(evt));
    expect(res.statusCode).toBe(200);

    // The session panel matured in place to "Cancelling…" — same ts, edited text.
    expect(fake.message('C1', session.ts)?.text).toContain('Cancelling');
    // The rocket message was cleaned up.
    expect(fake.message('C1', rocket.ts)?.deleted).toBe(true);
    // Exactly one visible message remains (the cancelling panel).
    expect(fake.messagesIn('C1')).toHaveLength(1);
    // And the handler cancelled the task via a conditional UpdateItem.
    expect(ddbSend.mock.calls.some(([c]) => c._type === 'Update')).toBe(true);
  });

  test('a click with a bad signature is rejected before any Slack call', async () => {
    const evt = fake.buttonClickEvent({
      teamId: 'T1', user: 'U9', actionId: 'cancel_task:task-123', signingSecret: 'wrong-secret',
    });
    const res = await interactionsHandler(asApiGwEvent(evt));
    expect(res.statusCode).toBe(401);
    // No Slack traffic and no DDB reads happened.
    expect(fake.recordedCalls()).toHaveLength(0);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

/** Post a message straight through the fake (bypasses the handler under test). */
async function slackPost(channel: string, text: string): Promise<{ ts: string }> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer xoxb-T1' },
    body: JSON.stringify({ channel, text }),
  });
  const body = await res.json() as { ts: string };
  return { ts: body.ts };
}
