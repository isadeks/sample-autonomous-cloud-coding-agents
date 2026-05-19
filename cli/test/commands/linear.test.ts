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

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  autoLinkTokenOwner,
  buildLinearProviderInput,
  initiateOauthDance,
  isWebhookSecretConfigured,
  LINEAR_OAUTH_SCOPES,
  pollForOauthAccessToken,
  providerNameForWorkspace,
  registerLinearWorkspace,
  renderLinearAppTemplate,
} from '../../src/commands/linear';
import * as config from '../../src/config';

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: ddbSend })),
    },
  };
});

const ddbSend = jest.fn();

// Build a fake JWT with a `sub` claim; the CLI only base64url-decodes the payload.
function fakeIdToken(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.sig`;
}

describe('autoLinkTokenOwner', () => {
  const originalFetch = global.fetch;
  let consoleLogSpy: jest.SpiedFunction<typeof console.log>;
  let loadCredentialsSpy: jest.SpiedFunction<typeof config.loadCredentials>;

  beforeEach(() => {
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({});
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    loadCredentialsSpy = jest.spyOn(config, 'loadCredentials');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleLogSpy.mockRestore();
    loadCredentialsSpy.mockRestore();
  });

  test('writes an active mapping row when Linear responds and user is authenticated', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          viewer: { id: 'linear-user-uuid', name: 'Jean', email: 'jean@example.com' },
          organization: { id: 'linear-org-uuid', name: 'ACME' },
        },
      }),
    }) as unknown as typeof fetch;
    loadCredentialsSpy.mockReturnValue({
      id_token: fakeIdToken('cognito-sub-123'),
      refresh_token: 'r',
      token_expiry: new Date(Date.now() + 60_000).toISOString(),
    });

    await autoLinkTokenOwner({
      region: 'us-east-1',
      apiToken: 'lin_api_xyz',
      userMappingTable: 'test-LinearUserMappingTable',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'lin_api_xyz' }),
      }),
    );
    expect(ddbSend).toHaveBeenCalledTimes(1);
    const putCmd = ddbSend.mock.calls[0][0] as PutCommand;
    expect(putCmd.input.TableName).toBe('test-LinearUserMappingTable');
    expect(putCmd.input.Item).toEqual(expect.objectContaining({
      linear_identity: 'linear-org-uuid#linear-user-uuid',
      platform_user_id: 'cognito-sub-123',
      linear_workspace_id: 'linear-org-uuid',
      linear_user_id: 'linear-user-uuid',
      status: 'active',
      link_method: 'auto_setup',
    }));
  });

  test('skips gracefully with a warning when Linear API errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    loadCredentialsSpy.mockReturnValue({
      id_token: fakeIdToken('cognito-sub-123'),
      refresh_token: 'r',
      token_expiry: new Date(Date.now() + 60_000).toISOString(),
    });

    await autoLinkTokenOwner({
      region: 'us-east-1',
      apiToken: 'lin_api_bad',
      userMappingTable: 'test-LinearUserMappingTable',
    });

    expect(ddbSend).not.toHaveBeenCalled();
    const msgs = consoleLogSpy.mock.calls.map(c => String(c[0]));
    expect(msgs.some(m => m.includes('Could not auto-link'))).toBe(true);
  });

  test('skips gracefully when user is not logged in', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          viewer: { id: 'linear-user-uuid' },
          organization: { id: 'linear-org-uuid' },
        },
      }),
    }) as unknown as typeof fetch;
    loadCredentialsSpy.mockReturnValue(null);

    await autoLinkTokenOwner({
      region: 'us-east-1',
      apiToken: 'lin_api_xyz',
      userMappingTable: 'test-LinearUserMappingTable',
    });

    expect(ddbSend).not.toHaveBeenCalled();
    const msgs = consoleLogSpy.mock.calls.map(c => String(c[0]));
    expect(msgs.some(m => m.includes('Could not resolve your platform user'))).toBe(true);
    expect(msgs.some(m => m.includes('bgagent login'))).toBe(true);
  });
});

describe('renderLinearAppTemplate', () => {
  test('uses sane defaults when no options are passed', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('bgagent[bot]');
    expect(out).toContain('Webhooks:            ON');
    expect(out).toContain('REQUIRED for actor=app');
  });

  test('includes the AWS callback URL placeholder when not provided', () => {
    const out = renderLinearAppTemplate();
    expect(out).toContain('<paste callbackUrl from `aws bedrock-agentcore-control create-oauth2-credential-provider`>');
  });

  test('substitutes the AWS callback URL when supplied', () => {
    const url = 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/abc-123';
    const out = renderLinearAppTemplate({ awsCallbackUrl: url });
    expect(out).toContain(url);
    expect(out).not.toContain('<paste callbackUrl');
  });

  test('overrides bot name, developer fields, description', () => {
    const out = renderLinearAppTemplate({
      botName: 'acme-bot[bot]',
      developerName: 'Acme Corp',
      developerUrl: 'https://acme.com',
      description: 'Internal coding agent',
    });
    expect(out).toContain('acme-bot[bot]');
    expect(out).toContain('Acme Corp');
    expect(out).toContain('https://acme.com');
    expect(out).toContain('Internal coding agent');
  });

  test('explains why each gating field matters (actor=app context)', () => {
    const out = renderLinearAppTemplate();
    // The "why" explainer is the core differentiator of this command vs. raw
    // docs — without it operators paste blindly and hit the cryptic Linear
    // "Invalid redirect_uri" error documented in the 2.0b spike.
    expect(out).toContain('Invalid redirect_uri');
    expect(out).toContain('Wildcard callback URLs are not accepted');
  });
});

describe('providerNameForWorkspace', () => {
  test('prefixes workspace slug with linear-oauth-', () => {
    expect(providerNameForWorkspace('acme')).toBe('linear-oauth-acme');
    expect(providerNameForWorkspace('acme-corp')).toBe('linear-oauth-acme-corp');
  });
});

describe('buildLinearProviderInput', () => {
  test('uses CustomOauth2 vendor with explicit Linear endpoints', () => {
    const input = buildLinearProviderInput({
      slug: 'acme',
      clientId: 'cid-1',
      clientSecret: 'csecret-1',
    });
    // Linear is NOT a built-in vendor, so the helper must use CustomOauth2
    // with explicit authorizationServerMetadata. Regression-locking that
    // here so a refactor doesn't accidentally try to use a vendor enum.
    expect(input.credentialProviderVendor).toBe('CustomOauth2');
    expect(input.name).toBe('linear-oauth-acme');
    const cfg = input.oauth2ProviderConfigInput.customOauth2ProviderConfig;
    expect(cfg.clientId).toBe('cid-1');
    expect(cfg.clientSecret).toBe('csecret-1');
    expect(cfg.oauthDiscovery.authorizationServerMetadata).toEqual({
      issuer: 'https://linear.app',
      authorizationEndpoint: 'https://linear.app/oauth/authorize',
      tokenEndpoint: 'https://api.linear.app/oauth/token',
      responseTypes: ['code'],
      // tokenEndpointAuthMethods locked here as a regression guard:
      // Linear's /oauth/token expects credentials in the POST body, not
      // HTTP Basic. Without this, AgentCore defaults to client_secret_basic
      // and Linear silently rejects with 401, surfacing as stuck-on-IN_PROGRESS
      // (caught during the 2.0b smoke test 2026-05-19).
      tokenEndpointAuthMethods: ['client_secret_post'],
    });
  });
});

describe('registerLinearWorkspace', () => {
  // The control-plane client uses the standard send() shape, so we mock
  // a minimal interface — same pattern as the autoLinkTokenOwner tests.
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof registerLinearWorkspace>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns callbackUrl + created=true on first registration', async () => {
    mockSend.mockResolvedValueOnce({
      callbackUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/uuid',
    });
    const result = await registerLinearWorkspace(mockClient, {
      slug: 'acme',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    expect(result.created).toBe(true);
    expect(result.providerName).toBe('linear-oauth-acme');
    expect(result.callbackUrl).toContain('bedrock-agentcore.us-east-1.amazonaws.com');
  });

  test('on duplicate-name ValidationException, fetches existing provider and returns created=false', async () => {
    // Verified-from-spike: AWS uses ValidationException (NOT ConflictException)
    // for the duplicate-name case, with message "Credential provider with name:
    // <name> already exists". We detect this via message-substring match.
    const conflict = new Error('Credential provider with name: linear-oauth-acme already exists');
    conflict.name = 'ValidationException';
    mockSend.mockRejectedValueOnce(conflict);
    mockSend.mockResolvedValueOnce({
      callbackUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/existing-uuid',
    });

    const result = await registerLinearWorkspace(mockClient, {
      slug: 'acme',
      clientId: 'cid',
      clientSecret: 'csec',
    });
    expect(result.created).toBe(false);
    expect(result.providerName).toBe('linear-oauth-acme');
    expect(result.callbackUrl).toContain('existing-uuid');
    // Two calls: Create (failed) → Get (succeeded)
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test('rethrows non-duplicate ValidationException (e.g. bad input shape)', async () => {
    // ValidationException is NOT only used for duplicates — also for invalid
    // input shape. We must not swallow those and turn them into Get-attempts.
    const validationFailure = new Error('Invalid OAuth2 endpoint URL');
    validationFailure.name = 'ValidationException';
    mockSend.mockRejectedValueOnce(validationFailure);
    await expect(
      registerLinearWorkspace(mockClient, { slug: 'acme', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(/Invalid OAuth2 endpoint URL/);
    // Only one call — the GetOauth2CredentialProviderCommand path is NOT taken.
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('translates AccessDeniedException to a remediation hint', async () => {
    const denied = new Error('User: ... is not authorized to perform: bedrock-agentcore:CreateOauth2CredentialProvider');
    denied.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(denied);
    let captured: Error | undefined;
    try {
      await registerLinearWorkspace(mockClient, { slug: 'acme', clientId: 'c', clientSecret: 's' });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeDefined();
    expect(captured!.message).toMatch(/Cannot create OAuth2 credential provider/);
    expect(captured!.message).toMatch(/bedrock-agentcore:CreateOauth2CredentialProvider/);
  });

  test('throws when create returns no callbackUrl', async () => {
    // Defensive: if AWS ever returns a successful response without callbackUrl,
    // we surface the corner case rather than silently returning undefined.
    mockSend.mockResolvedValueOnce({});
    await expect(
      registerLinearWorkspace(mockClient, { slug: 'acme', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(/no callbackUrl/);
  });

  test('throws when existing provider has no callbackUrl', async () => {
    const conflict = new Error('Credential provider with name: linear-oauth-acme already exists');
    conflict.name = 'ValidationException';
    mockSend.mockRejectedValueOnce(conflict);
    mockSend.mockResolvedValueOnce({});  // GetOauth2CredentialProvider returns no callbackUrl
    await expect(
      registerLinearWorkspace(mockClient, { slug: 'acme', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(/exists but has no callbackUrl/);
  });

  test('rethrows unknown errors verbatim (no remediation hint)', async () => {
    const oops = new Error('unexpected boom');
    oops.name = 'InternalServerError';
    mockSend.mockRejectedValueOnce(oops);
    await expect(
      registerLinearWorkspace(mockClient, { slug: 'acme', clientId: 'c', clientSecret: 's' }),
    ).rejects.toThrow(/unexpected boom/);
  });
});

describe('LINEAR_OAUTH_SCOPES', () => {
  test('matches the actor=app-compatible scope set verified in the spike', () => {
    // Locking the exact scope list: the spike confirmed `admin` is incompatible
    // with `actor=app`, and `app:assignable` + `app:mentionable` are required
    // for the agent install variant. Drift here is a silent OAuth failure.
    expect(LINEAR_OAUTH_SCOPES).toEqual(['read', 'write', 'app:assignable', 'app:mentionable']);
  });
});

describe('initiateOauthDance', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof initiateOauthDance>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns authorizationUrl + sessionUri on first call', async () => {
    mockSend.mockResolvedValueOnce({
      authorizationUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=urn:...',
      sessionUri: 'urn:ietf:params:oauth:request_uri:abc',
    });
    const result = await initiateOauthDance(mockClient, {
      workloadAccessToken: 'wat',
      providerName: 'linear-oauth-acme',
    });
    expect(result.authorizationUrl).toContain('bedrock-agentcore.us-east-1.amazonaws.com');
    expect(result.sessionUri).toBe('urn:ietf:params:oauth:request_uri:abc');
  });

  test('passes customParameters: {actor:"app"} on the request', async () => {
    mockSend.mockResolvedValueOnce({
      authorizationUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize?request_uri=urn:...',
      sessionUri: 'urn:x',
    });
    await initiateOauthDance(mockClient, {
      workloadAccessToken: 'wat',
      providerName: 'linear-oauth-acme',
    });
    // Inspect the command-input passed into client.send. The shape:
    // mockSend.mock.calls[0][0] is the Command instance; its .input member
    // is the raw request body the SDK sends.
    const sentInput = (mockSend.mock.calls[0][0] as { input: Record<string, unknown> }).input;
    expect(sentInput.customParameters).toEqual({ actor: 'app' });
    expect(sentInput.oauth2Flow).toBe('USER_FEDERATION');
    expect(sentInput.scopes).toEqual(['read', 'write', 'app:assignable', 'app:mentionable']);
  });

  test('throws when AgentCore returns a cached accessToken instead of authorizationUrl', async () => {
    // Per the spike, this happens if the workspace is already authorized.
    // Setup wizard would silently fall through; better to fail loudly.
    mockSend.mockResolvedValueOnce({ accessToken: 'cached-token' });
    await expect(
      initiateOauthDance(mockClient, { workloadAccessToken: 'wat', providerName: 'p' }),
    ).rejects.toThrow(/cached access token/);
  });

  test('throws when AgentCore response has neither authorizationUrl nor accessToken', async () => {
    mockSend.mockResolvedValueOnce({});
    await expect(
      initiateOauthDance(mockClient, { workloadAccessToken: 'wat', providerName: 'p' }),
    ).rejects.toThrow(/did not return an authorization URL/);
  });
});

describe('pollForOauthAccessToken', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof pollForOauthAccessToken>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns the access token on first successful poll', async () => {
    mockSend.mockResolvedValueOnce({ accessToken: 'tok-1', sessionStatus: 'IN_PROGRESS' });
    const token = await pollForOauthAccessToken(mockClient, {
      workloadAccessToken: 'wat',
      providerName: 'p',
      sessionUri: 'urn:x',
      timeoutMs: 1_000,
      intervalMs: 50,
    });
    expect(token).toBe('tok-1');
  });

  test('keeps polling while accessToken is missing, returns once it appears', async () => {
    mockSend
      .mockResolvedValueOnce({ sessionStatus: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ sessionStatus: 'IN_PROGRESS' })
      .mockResolvedValueOnce({ accessToken: 'tok-eventual' });
    const token = await pollForOauthAccessToken(mockClient, {
      workloadAccessToken: 'wat',
      providerName: 'p',
      sessionUri: 'urn:x',
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    expect(token).toBe('tok-eventual');
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  test('throws on sessionStatus=FAILED with a remediation hint', async () => {
    mockSend.mockResolvedValueOnce({ sessionStatus: 'FAILED' });
    await expect(
      pollForOauthAccessToken(mockClient, {
        workloadAccessToken: 'wat',
        providerName: 'p',
        sessionUri: 'urn:x',
        timeoutMs: 1_000,
        intervalMs: 50,
      }),
    ).rejects.toThrow(/sessionStatus=FAILED/);
  });

  test('throws on timeout when accessToken never arrives', async () => {
    mockSend.mockResolvedValue({ sessionStatus: 'IN_PROGRESS' });
    await expect(
      pollForOauthAccessToken(mockClient, {
        workloadAccessToken: 'wat',
        providerName: 'p',
        sessionUri: 'urn:x',
        timeoutMs: 100,
        intervalMs: 25,
      }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe('isWebhookSecretConfigured', () => {
  const mockSend = jest.fn();
  const mockClient = { send: mockSend } as unknown as Parameters<typeof isWebhookSecretConfigured>[0];

  beforeEach(() => {
    mockSend.mockReset();
  });

  test('returns true for a Linear-shaped lin_wh_ secret', async () => {
    mockSend.mockResolvedValueOnce({ SecretString: 'lin_wh_AbCdEfGhIjKlMnOpQrStUvWxYz' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(true);
  });

  test('returns false for the CDK-autogenerated placeholder', async () => {
    // CDK's default Secret value is a JSON-encoded random string — does
    // NOT start with lin_wh_. The check is a heuristic, not authoritative,
    // but good enough to avoid re-prompting on every setup re-run.
    mockSend.mockResolvedValueOnce({ SecretString: '{"":"abcd"}' });
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('returns false on Secrets Manager error (best-effort: re-prompt is harmless)', async () => {
    mockSend.mockRejectedValueOnce(new Error('AccessDenied'));
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });

  test('returns false when SecretString is missing', async () => {
    mockSend.mockResolvedValueOnce({});
    expect(await isWebhookSecretConfigured(mockClient, 'arn:secret')).toBe(false);
  });
});
