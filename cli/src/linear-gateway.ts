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
 * Per-workspace AgentCore Gateway provisioning for the Linear MCP.
 *
 * Federates a workspace's hosted Linear MCP (https://mcp.linear.app/mcp) behind
 * a dedicated per-workspace AgentCore Gateway so the agent connects to one
 * managed MCP endpoint and AgentCore Identity owns the OAuth token + its 24h
 * refresh — instead of the agent container holding a per-thread bearer.
 *
 * **Isolation model: one gateway per workspace.** Each onboarded workspace gets
 * its own Gateway + OAuth2 credential provider + Linear MCP target, so a task
 * for workspace A can never see workspace B's tools (isolation by construction).
 * Mirrors the existing per-workspace `bgagent-linear-oauth-<slug>` secret model.
 *
 * **Why this is spike-validated:** see docs/design/AGENTCORE_GATEWAY_MCP_SPIKE.md
 * (findings F0–F13). Key constraints baked in here:
 *  - Gateway inbound authorizer MUST be CUSTOM_JWT (AWS_IAM is rejected for 3LO).
 *    We reuse the platform's Cognito pool (config.user_pool_id / client_id) so
 *    the agent authenticates to the gateway with the JWT it already carries.
 *  - Linear OAuth is authorization-code (3LO); the target's OAuth cred config
 *    uses grantType=AUTHORIZATION_CODE with customParameters {actor:app,
 *    prompt:consent}. `actor=app` is required for Linear's app:* scopes;
 *    `prompt=consent` forces a fresh consent even for an already-installed app
 *    (in-place re-auth, no uninstall — the migration path for existing setups).
 *  - listingMode=DEFAULT (DYNAMIC is not interoperable with 3LO).
 *  - AgentCore mints a per-provider callback URL that MUST be registered on the
 *    Linear OAuth app before consent — this is a manual dashboard step (Linear's
 *    API does not expose redirect-URI management), so provisioning is a two-phase
 *    flow: create the provider → operator registers the callback → create the
 *    target → operator completes the browser consent.
 */

import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  CreateOauth2CredentialProviderCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import { CliError } from './errors';
import { LINEAR_AUTHORIZE_ENDPOINT, LINEAR_TOKEN_ENDPOINT, LINEAR_OAUTH_SCOPES } from './linear-oauth';

/** MCP endpoint for Linear's hosted server (Streamable HTTP). */
export const LINEAR_MCP_ENDPOINT = 'https://mcp.linear.app/mcp';

/**
 * OAuth scopes requested for the gateway target when `actor=app` — matches the
 * existing Linear OAuth app scopes (read/write + app-actor scopes). `actor=app`
 * (passed via customParameters) is what makes the app:* scopes valid.
 */
export const GATEWAY_LINEAR_SCOPES = LINEAR_OAUTH_SCOPES;

/**
 * OAuth scopes for the `actor=user` path. Linear rejects the app-actor scopes
 * (`app:assignable`/`app:mentionable`) in user actor mode with "The scopes
 * requested are not valid for this actor mode.", so request only read+write.
 * Used by the `--no-actor-app` diagnostic/non-app path.
 */
export const GATEWAY_LINEAR_USER_SCOPES = ['read', 'write'] as const;

/** Prefix for the per-workspace resource names so they're greppable + sortable. */
export const GATEWAY_NAME_PREFIX = 'bgagent-linear';

/**
 * Benign landing page AgentCore redirects the operator's browser to AFTER the
 * token exchange completes. This is the OAuth target's `defaultReturnUrl`, and
 * it must NOT be the provider callback URL: pointing it at the callback makes
 * the browser re-hit `/identities/oauth2/callback/<uuid>` with no code/state,
 * which returns "authorizationCode must not be null; state must not be null".
 * Linear's own site is a safe, always-reachable landing spot.
 */
export const GATEWAY_POST_AUTH_LANDING_URL = 'https://linear.app/';

/** Poll interval (ms) when waiting for a gateway/target to become ready. */
const POLL_INTERVAL_MS = 4000;
/** Max poll attempts for a gateway to reach READY (~80s at 4s). */
const GATEWAY_READY_MAX_ATTEMPTS = 20;
/** Max poll attempts for a target to leave CREATE_PENDING_AUTH (~120s at 4s). */
const TARGET_READY_MAX_ATTEMPTS = 30;

/**
 * Build the resource names for a workspace's gateway stack. Names must match
 * AgentCore's pattern ([0-9a-zA-Z][-]?){1,100}; slugs are already validated
 * [a-zA-Z0-9_-]{4,50} upstream, but underscores are not allowed in gateway
 * names, so normalize them to hyphens.
 */
export function gatewayResourceNames(slug: string): {
  gatewayName: string;
  providerName: string;
  targetName: string;
} {
  const safe = slug.replace(/_/g, '-');
  return {
    gatewayName: `${GATEWAY_NAME_PREFIX}-gw-${safe}`,
    providerName: `${GATEWAY_NAME_PREFIX}-oauth-${safe}`,
    targetName: 'linear-mcp',
  };
}

/** OIDC discovery URL for the platform's Cognito user pool. */
export function cognitoDiscoveryUrl(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/openid-configuration`;
}

export interface GatewayClientDeps {
  readonly region: string;
  /** Control-plane client; injectable for tests, defaults to a real client. */
  readonly client?: BedrockAgentCoreControlClient;
  /** Data-plane client (CompleteResourceTokenAuth); injectable for tests. */
  readonly dataClient?: BedrockAgentCoreClient;
}

function makeClient(deps: GatewayClientDeps): BedrockAgentCoreControlClient {
  return deps.client ?? new BedrockAgentCoreControlClient({ region: deps.region });
}

/**
 * Phase 1 — create the workspace's OAuth2 credential provider (CustomOauth2,
 * pointed at Linear) and its Gateway (CUSTOM_JWT inbound). Returns the provider
 * callback URL the operator must register on the Linear OAuth app, plus the
 * gateway id/url. Does NOT create the target yet — that needs the callback
 * registered first (Phase 2).
 */
export interface ProvisionPhase1Input {
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Gateway service role ARN (from the stack; grants the vault/secret perms). */
  readonly gatewayRoleArn: string;
  /** Platform Cognito pool for CUSTOM_JWT inbound. */
  readonly userPoolId: string;
  /** Platform Cognito app client id — allowed audience/client for the JWT. */
  readonly cognitoClientId: string;
}

export interface ProvisionPhase1Output {
  readonly providerArn: string;
  readonly providerSecretArn: string;
  /** The per-provider callback URL to register on the Linear OAuth app. */
  readonly callbackUrl: string;
  readonly gatewayId: string;
  readonly gatewayUrl: string;
}

export async function provisionGatewayPhase1(
  deps: GatewayClientDeps,
  input: ProvisionPhase1Input,
): Promise<ProvisionPhase1Output> {
  const client = makeClient(deps);
  const names = gatewayResourceNames(input.slug);

  // ── OAuth2 credential provider (CustomOauth2 → Linear) ──
  const provider = await client.send(new CreateOauth2CredentialProviderCommand({
    name: names.providerName,
    credentialProviderVendor: 'CustomOauth2',
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        oauthDiscovery: {
          authorizationServerMetadata: {
            issuer: 'https://linear.app',
            authorizationEndpoint: LINEAR_AUTHORIZE_ENDPOINT,
            tokenEndpoint: LINEAR_TOKEN_ENDPOINT,
            responseTypes: ['code'],
          },
        },
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      },
    },
  }));
  const providerArn = provider.credentialProviderArn;
  const callbackUrl = provider.callbackUrl;
  const providerSecretArn = provider.clientSecretArn?.secretArn;
  if (!providerArn || !callbackUrl) {
    throw new CliError(
      `AgentCore did not return a credentialProviderArn/callbackUrl for '${names.providerName}'. `
      + 'Cannot proceed with gateway provisioning.',
    );
  }

  // ── Gateway (CUSTOM_JWT inbound, reusing the platform Cognito pool) ──
  const gateway = await client.send(new CreateGatewayCommand({
    name: names.gatewayName,
    roleArn: input.gatewayRoleArn,
    protocolType: 'MCP',
    authorizerType: 'CUSTOM_JWT',
    authorizerConfiguration: {
      customJWTAuthorizer: {
        discoveryUrl: cognitoDiscoveryUrl(deps.region, input.userPoolId),
        allowedClients: [input.cognitoClientId],
      },
    },
  }));
  const gatewayId = gateway.gatewayId;
  const gatewayUrl = gateway.gatewayUrl;
  if (!gatewayId || !gatewayUrl) {
    throw new CliError(
      `AgentCore did not return a gatewayId/gatewayUrl for '${names.gatewayName}'.`,
    );
  }

  return { providerArn, providerSecretArn: providerSecretArn ?? '', callbackUrl, gatewayId, gatewayUrl };
}

/**
 * Phase 2 — create the Linear MCP target on the gateway with the 3LO
 * (authorization-code) OAuth config. Returns the authorization URL the operator
 * must open to consent (target lands in CREATE_PENDING_AUTH until consent
 * completes). Assumes the provider's callback (from Phase 1) is now registered
 * on the Linear OAuth app.
 */
export interface ProvisionPhase2Input {
  readonly slug: string;
  readonly gatewayId: string;
  readonly providerArn: string;
  /**
   * Benign landing page AgentCore redirects the browser to AFTER the token
   * exchange (the target's `defaultReturnUrl`). MUST NOT be the provider
   * callback URL — see {@link GATEWAY_POST_AUTH_LANDING_URL}. Defaults to that
   * landing URL when omitted.
   */
  readonly returnUrl?: string;
  readonly actorApp?: boolean;
}

export interface ProvisionPhase2Output {
  readonly targetId: string;
  readonly status: string;
  /** Present when status is CREATE_PENDING_AUTH — the consent URL to open. */
  readonly authorizationUrl?: string;
  readonly userId?: string;
}

export async function provisionGatewayPhase2(
  deps: GatewayClientDeps,
  input: ProvisionPhase2Input,
): Promise<ProvisionPhase2Output> {
  const client = makeClient(deps);
  const names = gatewayResourceNames(input.slug);
  const useActorApp = input.actorApp !== false;

  // customParameters flow through to Linear's /oauth/authorize:
  //  - actor=app: required for Linear's app:* scopes (the agent acts as the app,
  //    matching ABCA's existing actor=app model).
  //  - prompt=consent: force a fresh consent + code even if the app is already
  //    installed on the workspace — this is what lets an existing workspace
  //    re-authorize IN PLACE (no uninstall/reinstall). Migration path.
  const customParameters: Record<string, string> = { prompt: 'consent' };
  if (useActorApp) customParameters.actor = 'app';

  // Scopes must match the actor mode: the app:* scopes are only valid with
  // actor=app; requesting them in user mode makes Linear reject the consent
  // ("scopes not valid for this actor mode").
  const scopes = useActorApp
    ? [...GATEWAY_LINEAR_SCOPES]
    : [...GATEWAY_LINEAR_USER_SCOPES];

  const target = await client.send(new CreateGatewayTargetCommand({
    gatewayIdentifier: input.gatewayId,
    name: names.targetName,
    targetConfiguration: {
      mcp: {
        mcpServer: {
          endpoint: LINEAR_MCP_ENDPOINT,
          listingMode: 'DEFAULT',
        },
      },
    },
    credentialProviderConfigurations: [
      {
        credentialProviderType: 'OAUTH',
        credentialProvider: {
          oauthCredentialProvider: {
            providerArn: input.providerArn,
            scopes,
            grantType: 'AUTHORIZATION_CODE',
            defaultReturnUrl: input.returnUrl ?? GATEWAY_POST_AUTH_LANDING_URL,
            customParameters,
          },
        },
      },
    ],
  }));

  const targetId = target.targetId;
  if (!targetId) {
    throw new CliError(`AgentCore did not return a targetId for the Linear target on '${names.gatewayName}'.`);
  }
  const oauth2 = target.authorizationData?.oauth2;
  return {
    targetId,
    status: target.status ?? 'UNKNOWN',
    authorizationUrl: oauth2?.authorizationUrl,
    userId: oauth2?.userId,
  };
}

/** Poll a target until it leaves CREATE_PENDING_AUTH (READY or FAILED). */
export async function waitForTargetReady(
  deps: GatewayClientDeps,
  gatewayId: string,
  targetId: string,
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<{ status: string; statusReasons?: string[] }> {
  const client = makeClient(deps);
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? TARGET_READY_MAX_ATTEMPTS;
  for (let i = 0; i < maxAttempts; i++) {
    const t = await client.send(new GetGatewayTargetCommand({
      gatewayIdentifier: gatewayId,
      targetId,
    }));
    const status = t.status ?? 'UNKNOWN';
    if (status === 'READY' || status === 'FAILED') {
      return { status, statusReasons: t.statusReasons };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { status: 'CREATE_PENDING_AUTH', statusReasons: ['Timed out waiting for authorization to complete.'] };
}

/** Poll a gateway until READY. */
export async function waitForGatewayReady(
  deps: GatewayClientDeps,
  gatewayId: string,
  opts: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<string> {
  const client = makeClient(deps);
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? GATEWAY_READY_MAX_ATTEMPTS;
  for (let i = 0; i < maxAttempts; i++) {
    const g = await client.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
    if (g.status === 'READY') return 'READY';
    if (g.status === 'FAILED') return 'FAILED';
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return 'CREATING';
}

/**
 * Extract the OAuth2 PAR session URI from a target's authorization URL. The
 * `authorizationUrl` returned by CreateGatewayTarget carries the session as a
 * `request_uri=urn:ietf:params:oauth:request_uri:<handle>` query param; this is
 * the exact `sessionUri` {@link completeResourceTokenAuth} needs to finalize.
 */
export function sessionUriFromAuthorizationUrl(authorizationUrl: string): string | undefined {
  try {
    const requestUri = new URL(authorizationUrl).searchParams.get('request_uri');
    return requestUri ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finalize the browser consent by confirming the auth session on the DATA
 * plane. **This call is mandatory** — the OAuth callback does NOT auto-complete
 * the token vault, so without it the target sits in CREATE_PENDING_AUTH until it
 * times out to FAILED. Live-verified 2026-07-20: one call flips the target
 * CREATE_PENDING_AUTH → CREATING → READY in ~15s.
 *
 * @param userId       the `authorizationData.oauth2.userId` from Phase 2.
 * @param sessionUri   the PAR `request_uri` from the authorization URL — see
 *                     {@link sessionUriFromAuthorizationUrl}.
 */
export async function completeResourceTokenAuth(
  deps: GatewayClientDeps,
  userId: string,
  sessionUri: string,
): Promise<void> {
  const client = deps.dataClient ?? new BedrockAgentCoreClient({ region: deps.region });
  await client.send(new CompleteResourceTokenAuthCommand({
    userIdentifier: { userId },
    sessionUri,
  }));
}
