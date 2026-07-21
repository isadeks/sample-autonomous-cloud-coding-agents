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

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import type { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';

import { CliError } from '../src/errors';
import {
  cognitoDiscoveryUrl,
  completeResourceTokenAuth,
  gatewayResourceNames,
  GATEWAY_POST_AUTH_LANDING_URL,
  LINEAR_MCP_ENDPOINT,
  provisionGatewayPhase1,
  provisionGatewayPhase2,
  sessionUriFromAuthorizationUrl,
  waitForTargetReady,
} from '../src/linear-gateway';

/**
 * Minimal fake AgentCore client: records every command sent and returns queued
 * responses keyed by command constructor name. Cast to the SDK client type — the
 * module only ever calls `.send()`.
 */
function fakeClient(responses: Record<string, unknown | unknown[]>): {
  client: BedrockAgentCoreControlClient;
  sent: { name: string; input: unknown }[];
} {
  const sent: { name: string; input: unknown }[] = [];
  const queues: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(responses)) queues[k] = Array.isArray(v) ? [...v] : [v];
  const client = {
    send: (cmd: { constructor: { name: string }; input: unknown }) => {
      const name = cmd.constructor.name;
      sent.push({ name, input: cmd.input });
      const q = queues[name];
      if (!q || q.length === 0) throw new Error(`fakeClient: no queued response for ${name}`);
      return Promise.resolve(q.length === 1 ? q[0] : q.shift());
    },
  } as unknown as BedrockAgentCoreControlClient;
  return { client, sent };
}

describe('gatewayResourceNames', () => {
  test('derives greppable per-workspace names and hyphenates underscores', () => {
    expect(gatewayResourceNames('acme')).toEqual({
      gatewayName: 'bgagent-linear-gw-acme',
      providerName: 'bgagent-linear-oauth-acme',
      targetName: 'linear-mcp',
    });
    // gateway names can't contain underscores → normalized to hyphens
    expect(gatewayResourceNames('my_team').gatewayName).toBe('bgagent-linear-gw-my-team');
    expect(gatewayResourceNames('my_team').providerName).toBe('bgagent-linear-oauth-my-team');
  });
});

describe('cognitoDiscoveryUrl', () => {
  test('builds the OIDC well-known URL for the pool', () => {
    expect(cognitoDiscoveryUrl('us-east-1', 'us-east-1_ABC123')).toBe(
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123/.well-known/openid-configuration',
    );
  });
});

describe('provisionGatewayPhase1', () => {
  const input = {
    slug: 'acme',
    clientId: 'cid-123',
    clientSecret: 'csec-456',
    gatewayRoleArn: 'arn:aws:iam::111122223333:role/gw-role',
    userPoolId: 'us-east-1_POOL',
    cognitoClientId: 'app-client-1',
  };

  test('creates a CustomOauth2 provider pointed at Linear and a CUSTOM_JWT gateway, returning callback + gateway url', async () => {
    const { client, sent } = fakeClient({
      CreateOauth2CredentialProviderCommand: {
        credentialProviderArn: 'arn:prov',
        callbackUrl: 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/uuid-1',
        clientSecretArn: { secretArn: 'arn:secret' },
      },
      CreateGatewayCommand: {
        gatewayId: 'gw-1',
        gatewayUrl: 'https://gw-1.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp',
      },
    });

    const out = await provisionGatewayPhase1({ region: 'us-east-1', client }, input);

    expect(out.callbackUrl).toContain('/identities/oauth2/callback/uuid-1');
    expect(out.gatewayUrl).toContain('gw-1.gateway.bedrock-agentcore');
    expect(out.providerArn).toBe('arn:prov');
    expect(out.providerSecretArn).toBe('arn:secret');

    // provider config: CustomOauth2 vendor + Linear endpoints + client creds
    const prov = sent.find(s => s.name === 'CreateOauth2CredentialProviderCommand')!.input as any;
    expect(prov.credentialProviderVendor).toBe('CustomOauth2');
    const asm = prov.oauth2ProviderConfigInput.customOauth2ProviderConfig;
    expect(asm.clientId).toBe('cid-123');
    expect(asm.clientSecret).toBe('csec-456');
    expect(asm.oauthDiscovery.authorizationServerMetadata.tokenEndpoint).toBe('https://api.linear.app/oauth/token');

    // gateway: CUSTOM_JWT inbound reusing the platform Cognito pool (NOT AWS_IAM — rejected for 3LO)
    const gw = sent.find(s => s.name === 'CreateGatewayCommand')!.input as any;
    expect(gw.authorizerType).toBe('CUSTOM_JWT');
    expect(gw.protocolType).toBe('MCP');
    expect(gw.authorizerConfiguration.customJWTAuthorizer.discoveryUrl).toContain('us-east-1_POOL');
    expect(gw.authorizerConfiguration.customJWTAuthorizer.allowedClients).toEqual(['app-client-1']);
  });

  test('throws if AgentCore omits the provider callback url', async () => {
    const { client } = fakeClient({
      CreateOauth2CredentialProviderCommand: { credentialProviderArn: 'arn:prov' }, // no callbackUrl
      CreateGatewayCommand: { gatewayId: 'gw-1', gatewayUrl: 'https://x/mcp' },
    });
    await expect(provisionGatewayPhase1({ region: 'us-east-1', client }, input)).rejects.toBeInstanceOf(CliError);
  });
});

describe('provisionGatewayPhase2', () => {
  const base = {
    slug: 'acme',
    gatewayId: 'gw-1',
    providerArn: 'arn:prov',
  };

  test('creates a 3LO Linear target (DEFAULT listing, actor=app + prompt=consent, app scopes) and returns the auth URL', async () => {
    const { client, sent } = fakeClient({
      CreateGatewayTargetCommand: {
        targetId: 't-1',
        status: 'CREATE_PENDING_AUTH',
        authorizationData: { oauth2: { authorizationUrl: 'https://consent', userId: 'u-1' } },
      },
    });

    const out = await provisionGatewayPhase2({ region: 'us-east-1', client }, base);
    expect(out.targetId).toBe('t-1');
    expect(out.status).toBe('CREATE_PENDING_AUTH');
    expect(out.authorizationUrl).toBe('https://consent');
    expect(out.userId).toBe('u-1');

    const tgt = sent[0].input as any;
    expect(tgt.targetConfiguration.mcp.mcpServer.endpoint).toBe(LINEAR_MCP_ENDPOINT);
    expect(tgt.targetConfiguration.mcp.mcpServer.listingMode).toBe('DEFAULT');
    const oc = tgt.credentialProviderConfigurations[0].credentialProvider.oauthCredentialProvider;
    expect(oc.grantType).toBe('AUTHORIZATION_CODE');
    expect(oc.customParameters).toEqual({ actor: 'app', prompt: 'consent' });
    // app-actor requests the full scope set incl. the app:* scopes
    expect(oc.scopes).toEqual(['read', 'write', 'app:assignable', 'app:mentionable']);
  });

  test('defaultReturnUrl falls back to the benign landing page, NOT the callback', async () => {
    // Regression: setting defaultReturnUrl to the callback URL makes the browser
    // re-hit /callback with no code/state → "authorizationCode must not be null".
    const { client, sent } = fakeClient({
      CreateGatewayTargetCommand: { targetId: 't-1', status: 'CREATE_PENDING_AUTH', authorizationData: { oauth2: {} } },
    });
    await provisionGatewayPhase2({ region: 'us-east-1', client }, base);
    const oc = (sent[0].input as any).credentialProviderConfigurations[0].credentialProvider.oauthCredentialProvider;
    expect(oc.defaultReturnUrl).toBe(GATEWAY_POST_AUTH_LANDING_URL);
    expect(oc.defaultReturnUrl).not.toContain('/callback/');
  });

  test('an explicit returnUrl is honored when provided', async () => {
    const { client, sent } = fakeClient({
      CreateGatewayTargetCommand: { targetId: 't-1', status: 'CREATE_PENDING_AUTH', authorizationData: { oauth2: {} } },
    });
    await provisionGatewayPhase2({ region: 'us-east-1', client }, { ...base, returnUrl: 'https://example.com/done' });
    const oc = (sent[0].input as any).credentialProviderConfigurations[0].credentialProvider.oauthCredentialProvider;
    expect(oc.defaultReturnUrl).toBe('https://example.com/done');
  });

  test('--no-actor-app drops actor=app AND requests only user scopes (app:* invalid in user actor mode)', async () => {
    const { client, sent } = fakeClient({
      CreateGatewayTargetCommand: { targetId: 't-2', status: 'CREATE_PENDING_AUTH', authorizationData: { oauth2: {} } },
    });
    await provisionGatewayPhase2({ region: 'us-east-1', client }, { ...base, actorApp: false });
    const oc = (sent[0].input as any).credentialProviderConfigurations[0].credentialProvider.oauthCredentialProvider;
    expect(oc.customParameters).toEqual({ prompt: 'consent' });
    expect(oc.customParameters.actor).toBeUndefined();
    expect(oc.scopes).toEqual(['read', 'write']);
  });
});

describe('sessionUriFromAuthorizationUrl', () => {
  test('extracts the PAR request_uri from the authorization URL', () => {
    const url = 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/authorize'
      + '?request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AABC123';
    expect(sessionUriFromAuthorizationUrl(url)).toBe('urn:ietf:params:oauth:request_uri:ABC123');
  });

  test('returns undefined when there is no request_uri', () => {
    expect(sessionUriFromAuthorizationUrl('https://consent.example/authorize')).toBeUndefined();
  });

  test('returns undefined for a malformed URL', () => {
    expect(sessionUriFromAuthorizationUrl('not a url')).toBeUndefined();
  });
});

describe('completeResourceTokenAuth', () => {
  function fakeDataClient(): { client: BedrockAgentCoreClient; sent: { name: string; input: unknown }[] } {
    const sent: { name: string; input: unknown }[] = [];
    const client = {
      send: (cmd: { constructor: { name: string }; input: unknown }) => {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        return Promise.resolve({});
      },
    } as unknown as BedrockAgentCoreClient;
    return { client, sent };
  }

  test('finalizes the auth session on the data plane with userId + sessionUri', async () => {
    const { client, sent } = fakeDataClient();
    await completeResourceTokenAuth(
      { region: 'us-east-1', dataClient: client },
      'u-1',
      'urn:ietf:params:oauth:request_uri:ABC123',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('CompleteResourceTokenAuthCommand');
    expect(sent[0].input).toEqual({
      userIdentifier: { userId: 'u-1' },
      sessionUri: 'urn:ietf:params:oauth:request_uri:ABC123',
    });
  });
});

describe('waitForTargetReady', () => {
  test('polls past CREATE_PENDING_AUTH until READY', async () => {
    const { client } = fakeClient({
      GetGatewayTargetCommand: [
        { status: 'CREATE_PENDING_AUTH' },
        { status: 'CREATE_PENDING_AUTH' },
        { status: 'READY' },
      ],
    });
    const res = await waitForTargetReady({ region: 'us-east-1', client }, 'gw-1', 't-1', { intervalMs: 1, maxAttempts: 5 });
    expect(res.status).toBe('READY');
  });

  test('returns FAILED with reasons', async () => {
    const { client } = fakeClient({
      GetGatewayTargetCommand: { status: 'FAILED', statusReasons: ['bad grant'] },
    });
    const res = await waitForTargetReady({ region: 'us-east-1', client }, 'gw-1', 't-1', { intervalMs: 1, maxAttempts: 2 });
    expect(res.status).toBe('FAILED');
    expect(res.statusReasons).toEqual(['bad grant']);
  });
});
