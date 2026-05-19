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

import { execFile } from 'child_process';
import * as readline from 'readline';
import {
  BedrockAgentCoreClient,
  GetResourceOauth2TokenCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { getWorkloadAccessToken } from '../agentcore-identity';
import { ApiClient } from '../api-client';
import { loadConfig, loadCredentials } from '../config';
import { CliError } from '../errors';
import { formatJson } from '../format';
import { awaitOauthCallback, CALLBACK_URL } from '../oauth-callback-server';

/** Default label that triggers an ABCA task when applied to a Linear issue. */
const DEFAULT_LABEL_FILTER = 'bgagent';

/** Standard RFC 4122 UUID — Linear's `projects.nodes[].id` matches this shape. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Render the printable Linear OAuth app config. Standalone export so
 * `bgagent linear setup` can call it inline (Phase 2.0b setup wizard
 * Step 2 — show the user what to paste into Linear's app form).
 */
export interface LinearAppTemplateOptions {
  readonly botName?: string;
  readonly developerName?: string;
  readonly developerUrl?: string;
  readonly description?: string;
  readonly awsCallbackUrl?: string;
}

export function renderLinearAppTemplate(opts: LinearAppTemplateOptions = {}): string {
  // Defaults match the upstream sample so unmodified `bgagent linear app-template`
  // produces a usable config without forcing every operator to invent strings.
  // Operators with custom branding override via flags.
  const botName = opts.botName ?? 'bgagent[bot]';
  const developerName = opts.developerName ?? 'ABCA';
  const developerUrl = opts.developerUrl ?? 'https://github.com/aws-samples/sample-autonomous-cloud-coding-agents';
  const description = opts.description ?? 'Autonomous Background Coding Agent';
  // The AWS-hosted callback is surfaced by `aws bedrock-agentcore-control
  // create-oauth2-credential-provider` once per workspace. If unknown at
  // template-render time, print a placeholder the operator must replace.
  const awsCallback = opts.awsCallbackUrl
    ?? '<paste callbackUrl from `aws bedrock-agentcore-control create-oauth2-credential-provider`>';

  const bar = '═'.repeat(72);
  return [
    bar,
    'Linear OAuth app template',
    bar,
    '',
    'Open https://linear.app/settings/api/applications/new and paste:',
    '',
    `  Application name:    bgagent`,
    `  Developer name:      ${developerName}`,
    `  Developer URL:       ${developerUrl}`,
    `  Description:         ${description}`,
    '',
    '  Callback URLs (one per line, NO line wrapping):',
    `    ${awsCallback}`,
    '',
    `  GitHub username:     ${botName}      ← REQUIRED for actor=app`,
    '  Public:              OFF',
    '  Client credentials:  OFF',
    '  Webhooks:            ON              ← REQUIRED for actor=app',
    `    Webhook URL:       https://example.com/placeholder  ← any HTTPS URL`,
    '    (You do NOT need to subscribe to any events for the OAuth flow itself)',
    '',
    'Click Save, copy the Client ID and Client Secret, then return here.',
    '',
    'Why these specific fields:',
    '  • GitHub username with [bot] suffix gates the actor=app agent flow.',
    '    Without it, Linear surfaces a misleading "Invalid redirect_uri" error.',
    '  • Webhooks toggle must be ON for the same reason; the URL value is unused',
    '    by the OAuth dance and can be a placeholder.',
    '  • Wildcard callback URLs are not accepted by Linear; list each URL fully.',
    bar,
  ].join('\n');
}

/**
 * Validate a Linear workspace slug. AgentCore credential-provider names
 * must match `[a-zA-Z0-9_-]+`, and Linear's own `urlKey` is the same shape,
 * so we can accept it directly into the provider name.
 *
 * The 4-character lower bound is conservative: Linear's docs do not
 * publish a min length, but every workspace I've seen has ≥4. The 50-char
 * upper bound keeps the resulting `linear-oauth-<slug>` provider name
 * comfortably under AWS's 64-char limit.
 */
const SLUG_RE = /^[a-zA-Z0-9_-]{4,50}$/;

/** Linear OAuth2 endpoints — fixed across all workspaces. */
const LINEAR_AUTH_ENDPOINT = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token';
const LINEAR_ISSUER = 'https://linear.app';

export function providerNameForWorkspace(slug: string): string {
  return `linear-oauth-${slug}`;
}

/**
 * Build the AgentCore `CreateOauth2CredentialProvider` input for a Linear
 * workspace. Linear is NOT a built-in vendor (no `LinearOauth2`), so we
 * use `CustomOauth2` with explicit `authorizationServerMetadata` —
 * Linear has no `.well-known/openid-configuration` endpoint, so OAuth
 * discovery cannot be auto-resolved.
 */
export function buildLinearProviderInput(opts: {
  slug: string;
  clientId: string;
  clientSecret: string;
}): {
  name: string;
  credentialProviderVendor: 'CustomOauth2';
  oauth2ProviderConfigInput: {
    customOauth2ProviderConfig: {
      oauthDiscovery: {
        authorizationServerMetadata: {
          issuer: string;
          authorizationEndpoint: string;
          tokenEndpoint: string;
          responseTypes: string[];
        };
      };
      clientId: string;
      clientSecret: string;
    };
  };
} {
  return {
    name: providerNameForWorkspace(opts.slug),
    credentialProviderVendor: 'CustomOauth2',
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        oauthDiscovery: {
          authorizationServerMetadata: {
            issuer: LINEAR_ISSUER,
            authorizationEndpoint: LINEAR_AUTH_ENDPOINT,
            tokenEndpoint: LINEAR_TOKEN_ENDPOINT,
            responseTypes: ['code'],
          },
        },
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
      },
    },
  };
}

export interface RegisterWorkspaceResult {
  /** AWS-hosted callback URL — paste into Linear app's Callback URLs field. */
  readonly callbackUrl: string;
  /** AgentCore credential provider name (`linear-oauth-<slug>`). */
  readonly providerName: string;
  /** Whether the provider was newly created vs. already existed. */
  readonly created: boolean;
}

/**
 * Register a Linear workspace as an AgentCore OAuth2 credential provider,
 * idempotently. If a provider with the derived name already exists, fetch
 * its callbackUrl and return that — re-running setup mid-flow shouldn't
 * fail. The control-plane SDK's update API doesn't accept clientSecret
 * rotation in the same call shape, so re-running with NEW secrets is a
 * `delete + recreate` flow handled by `add-workspace --rotate` (#67),
 * not here.
 *
 * Throws CliError with remediation hints for AccessDenied (most common
 * misconfiguration) and ValidationException (caller bug — slug shape, etc).
 */
export async function registerLinearWorkspace(
  client: BedrockAgentCoreControlClient,
  opts: { slug: string; clientId: string; clientSecret: string },
): Promise<RegisterWorkspaceResult> {
  const providerName = providerNameForWorkspace(opts.slug);
  const input = buildLinearProviderInput(opts);

  try {
    const response = await client.send(new CreateOauth2CredentialProviderCommand(input));
    if (!response.callbackUrl) {
      throw new CliError(
        `AgentCore created provider '${providerName}' but returned no callbackUrl. `
        + `This is unexpected; check the AWS console manually.`,
      );
    }
    return { callbackUrl: response.callbackUrl, providerName, created: true };
  } catch (err) {
    // AWS surfaces "already exists" as ValidationException (NOT ConflictException
    // as one would expect from CFN/REST conventions). The error class is shared
    // with caller bugs like bad slug shape, so we detect by message-substring
    // match rather than the class name. Verified via smoke test 2026-05-19.
    if (err instanceof Error && /already exists/i.test(err.message)) {
      const existing = await client.send(new GetOauth2CredentialProviderCommand({ name: providerName }));
      if (!existing.callbackUrl) {
        throw new CliError(
          `Provider '${providerName}' exists but has no callbackUrl. `
          + `Delete and re-register: \`aws bedrock-agentcore-control delete-oauth2-credential-provider --name ${providerName}\``,
        );
      }
      return { callbackUrl: existing.callbackUrl, providerName, created: false };
    }
    if (err instanceof Error && err.name === 'AccessDeniedException') {
      throw new CliError(
        `Cannot create OAuth2 credential provider: ${err.message}. `
        + `Confirm your AWS principal has 'bedrock-agentcore:CreateOauth2CredentialProvider' `
        + `(usually requires admin / stack-deploy credentials, not the bgagent-CLI Cognito user).`,
      );
    }
    throw err;
  }
}

/**
 * Linear OAuth scopes for the `actor=app` agent flow. Verified via the
 * 2.0b spike — `admin` is incompatible with `actor=app`, so we deliberately
 * exclude it. `app:assignable` + `app:mentionable` are required to surface
 * as a Linear Agent in workspace settings.
 */
export const LINEAR_OAUTH_SCOPES = ['read', 'write', 'app:assignable', 'app:mentionable'] as const;

/**
 * Maximum time to poll for the OAuth access token after the browser
 * callback fires. AgentCore's server-side ceiling is 600s; we add a
 * small buffer to surface the timeout client-side first with a clearer
 * remediation message.
 */
const OAUTH_POLL_TIMEOUT_MS = 600_000;
const OAUTH_POLL_INTERVAL_MS = 5_000;

export interface InitiateOauthDanceArgs {
  readonly workloadAccessToken: string;
  readonly providerName: string;
  readonly returnUrl?: string;
}

export interface OauthDanceInitiateResult {
  readonly authorizationUrl: string;
  readonly sessionUri: string;
}

/**
 * Kick off the OAuth dance: ask AgentCore for an authorization URL +
 * sessionUri so we can drive the user's browser to Linear's consent
 * screen. The returned `sessionUri` is opaque (urn:ietf:params:oauth:
 * request_uri:...) — pass it back to `pollForOauthAccessToken` after
 * the browser callback fires.
 *
 * `customParameters: { actor: 'app' }` is the magic that makes Linear
 * present the Agent install variant of consent. Verified to propagate
 * to Linear's authorize URL via the 2.0b spike.
 */
export async function initiateOauthDance(
  client: BedrockAgentCoreClient,
  args: InitiateOauthDanceArgs,
): Promise<OauthDanceInitiateResult> {
  const response = await client.send(new GetResourceOauth2TokenCommand({
    workloadIdentityToken: args.workloadAccessToken,
    resourceCredentialProviderName: args.providerName,
    scopes: [...LINEAR_OAUTH_SCOPES],
    oauth2Flow: 'USER_FEDERATION',
    resourceOauth2ReturnUrl: args.returnUrl ?? CALLBACK_URL,
    customParameters: { actor: 'app' },
  }));
  if (response.accessToken) {
    // Cached token returned — caller should detect this via the missing
    // authorizationUrl and skip the browser/poll dance.
    throw new CliError(
      `AgentCore returned a cached access token instead of an authorization URL. `
      + `This usually means the workspace is already authorized; pass --force-reauth to re-run consent.`,
    );
  }
  if (!response.authorizationUrl || !response.sessionUri) {
    throw new CliError(
      `AgentCore did not return an authorization URL. Response keys: `
      + `${Object.keys(response).join(', ')}`,
    );
  }
  return {
    authorizationUrl: response.authorizationUrl,
    sessionUri: response.sessionUri,
  };
}

export interface PollForOauthTokenArgs {
  readonly workloadAccessToken: string;
  readonly providerName: string;
  readonly sessionUri: string;
  readonly returnUrl?: string;
  /** Override the default poll timeout/interval — tests pass tight values. */
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

/**
 * Poll AgentCore until the OAuth access token is available. Repeatedly
 * calls `getResourceOauth2Token` with the captured `sessionUri`; the
 * response will switch from `{ authorizationUrl, sessionUri, sessionStatus:
 * 'IN_PROGRESS' }` to `{ accessToken, ... }` once AWS finishes the
 * code-exchange behind the browser callback.
 *
 * Returns the access token (raw, no `Bearer ` prefix). Throws on
 * timeout or `sessionStatus: FAILED`.
 */
export async function pollForOauthAccessToken(
  client: BedrockAgentCoreClient,
  args: PollForOauthTokenArgs,
): Promise<string> {
  const timeoutMs = args.timeoutMs ?? OAUTH_POLL_TIMEOUT_MS;
  const intervalMs = args.intervalMs ?? OAUTH_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await client.send(new GetResourceOauth2TokenCommand({
      workloadIdentityToken: args.workloadAccessToken,
      resourceCredentialProviderName: args.providerName,
      scopes: [...LINEAR_OAUTH_SCOPES],
      oauth2Flow: 'USER_FEDERATION',
      sessionUri: args.sessionUri,
      resourceOauth2ReturnUrl: args.returnUrl ?? CALLBACK_URL,
    }));

    if (response.accessToken) {
      return response.accessToken;
    }
    if (response.sessionStatus === 'FAILED') {
      throw new CliError(
        `OAuth flow failed at the AgentCore Identity layer (sessionStatus=FAILED). `
        + `Common causes: Linear rejected the consent (e.g. user clicked Cancel), `
        + `or the OAuth app's clientId/clientSecret stored in AgentCore don't match `
        + `the Linear app. Re-check via \`bgagent linear oauth-register-workspace\`.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new CliError(
    `Timed out waiting ${Math.round(timeoutMs / 1000)}s for OAuth access token. `
    + `If the browser callback fired but the poll never completed, check CloudWatch logs `
    + `for the credential provider name '${args.providerName}'.`,
  );
}

/**
 * Open `url` in the user's default browser. Returns true on best-effort
 * success, false if no opener is available (e.g. headless SSH session) so
 * callers can fall back to printing the URL.
 *
 * Uses `child_process.execFile` directly rather than a dependency like
 * `open` — no need for a 200-line module to spawn one shell command.
 */
export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let opener: { cmd: string; args: string[] };
    if (process.platform === 'darwin') {
      opener = { cmd: 'open', args: [url] };
    } else if (process.platform === 'win32') {
      // `start` is a cmd.exe builtin; URLs need empty title arg + escaping.
      opener = { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    } else {
      opener = { cmd: 'xdg-open', args: [url] };
    }
    execFile(opener.cmd, opener.args, (err) => {
      resolve(!err);
    });
  });
}

/**
 * Check whether the LinearWebhookSecret already holds a real Linear
 * signing secret (vs CDK's autogenerated placeholder). Used to decide
 * whether to prompt for the webhook secret on subsequent setup runs.
 *
 * Linear's webhook signing secrets start with `lin_wh_` — the placeholder
 * is a CDK-generated random JSON-encoded string that doesn't match.
 *
 * Returns true if a real secret is stored, false otherwise (including
 * any error fetching — best-effort; a re-prompt is harmless).
 */
export async function isWebhookSecretConfigured(
  client: SecretsManagerClient,
  secretArn: string,
): Promise<boolean> {
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = result.SecretString;
    return typeof value === 'string' && value.startsWith('lin_wh_');
  } catch {
    return false;
  }
}

export function makeLinearCommand(): Command {
  const linear = new Command('linear')
    .description('Manage Linear integration');

  linear.addCommand(
    new Command('app-template')
      .description('Print the field values to paste into Linear\'s OAuth app form')
      .option('--bot-name <name>', 'GitHub username for actor=app (must end with [bot])')
      .option('--developer-name <name>', 'Developer name shown on Linear\'s consent screen')
      .option('--developer-url <url>', 'Developer URL shown on Linear\'s consent screen')
      .option('--description <text>', 'App description shown on Linear\'s consent screen')
      .option('--aws-callback-url <url>', 'AWS-hosted callback URL from create-oauth2-credential-provider')
      .action((opts) => {
        if (opts.botName && !/\[bot\]$/.test(opts.botName)) {
          console.error(
            `Error: --bot-name must end with the literal "[bot]" suffix `
            + `(Linear requires this for actor=app). Got: ${opts.botName}`,
          );
          process.exit(1);
        }
        console.log(renderLinearAppTemplate({
          botName: opts.botName,
          developerName: opts.developerName,
          developerUrl: opts.developerUrl,
          description: opts.description,
          awsCallbackUrl: opts.awsCallbackUrl,
        }));
      }),
  );

  linear.addCommand(
    new Command('oauth-register-workspace')
      .description('Register a Linear workspace as an AgentCore OAuth2 credential provider')
      .argument('<slug>', 'Linear workspace urlKey (e.g. "acme" from linear.app/acme/...)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--client-id <id>', 'Linear OAuth app Client ID (else prompted)')
      .option('--client-secret <secret>', 'Linear OAuth app Client Secret (else prompted; prefer interactive)')
      .action(async (slug: string, opts) => {
        if (!SLUG_RE.test(slug)) {
          throw new CliError(
            `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
            + `This is the Linear urlKey, e.g. 'acme' from linear.app/acme/...`,
          );
        }
        const config = loadConfig();
        const region = opts.region ?? config.region;

        const clientId = opts.clientId ?? await promptSecret('Linear Client ID: ');
        if (!clientId) {
          throw new CliError('Client ID is required.');
        }
        const clientSecret = opts.clientSecret ?? await promptSecret('Linear Client Secret: ');
        if (!clientSecret) {
          throw new CliError('Client Secret is required.');
        }

        const client = new BedrockAgentCoreControlClient({ region });
        const result = await registerLinearWorkspace(client, { slug, clientId, clientSecret });

        if (result.created) {
          console.log(`✓ Created credential provider '${result.providerName}'`);
        } else {
          console.log(`✓ Provider '${result.providerName}' already exists — re-using it`);
        }
        console.log();
        console.log('Paste this URL into the Linear OAuth app\'s Callback URLs field');
        console.log('(on a single line — line wraps create two malformed entries):');
        console.log();
        console.log(`  ${result.callbackUrl}`);
        console.log();
        console.log(`Once Linear's app is configured, run:`);
        console.log(`  bgagent linear setup ${slug}`);
      }),
  );

  linear.addCommand(
    new Command('link')
      .description('Link your Linear account using a verification code')
      .argument('<code>', 'Verification code from Linear')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (code: string, opts) => {
        const client = new ApiClient();
        const result = await client.linearLink(code);

        if (opts.output === 'json') {
          console.log(formatJson(result));
        } else {
          console.log('Linear account linked successfully.');
          console.log(`  Workspace: ${result.linear_workspace_id}`);
          console.log(`  User:      ${result.linear_user_id}`);
          console.log(`  Linked at: ${result.linked_at}`);
        }
      }),
  );

  linear.addCommand(
    new Command('setup')
      .description('Authorize a Linear workspace via OAuth (Phase 2.0b)')
      .argument('<slug>', 'Linear workspace urlKey (must already be registered with `bgagent linear oauth-register-workspace`)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--no-browser', 'Print the authorization URL instead of opening a browser (for SSH/headless)')
      .option('--rotate-webhook-secret', 'Re-prompt for the webhook signing secret even if one is already configured')
      .action(async (slug: string, opts) => {
        if (!SLUG_RE.test(slug)) {
          throw new CliError(
            `Invalid workspace slug '${slug}'. Must be 4-50 chars matching [a-zA-Z0-9_-]. `
            + `Run \`bgagent linear oauth-register-workspace\` first.`,
          );
        }
        const config = loadConfig();
        const region = opts.region || config.region;
        const stackName = opts.stackName;

        // ─── Stack outputs ─────────────────────────────────────────────
        const [
          workloadName,
          workspaceRegistryTable,
          userMappingTable,
          webhookSecretArn,
        ] = await Promise.all([
          getStackOutput(region, stackName, 'CliWorkloadIdentityName'),
          getStackOutput(region, stackName, 'LinearWorkspaceRegistryTableName'),
          getStackOutput(region, stackName, 'LinearUserMappingTableName'),
          getStackOutput(region, stackName, 'LinearWebhookSecretArn'),
        ]);

        const missing: string[] = [];
        if (!workloadName) missing.push('CliWorkloadIdentityName');
        if (!workspaceRegistryTable) missing.push('LinearWorkspaceRegistryTableName');
        if (!userMappingTable) missing.push('LinearUserMappingTableName');
        if (!webhookSecretArn) missing.push('LinearWebhookSecretArn');
        if (missing.length > 0) {
          throw new CliError(
            `Stack '${stackName}' is missing outputs ${missing.join(', ')}. `
            + `Re-deploy with the 2.0b CDK changes (mise //cdk:deploy).`,
          );
        }

        // ─── Resolve caller identity ──────────────────────────────────
        const creds = loadCredentials();
        if (!creds?.id_token) {
          throw new CliError('Not authenticated — run `bgagent login` first.');
        }
        let cognitoSub: string;
        try {
          cognitoSub = extractCognitoSub();
        } catch (err) {
          throw new CliError(
            `Could not read Cognito sub from cached id_token: ${err instanceof Error ? err.message : String(err)}. `
            + `Run \`bgagent login\` to refresh credentials.`,
          );
        }

        const providerName = providerNameForWorkspace(slug);

        console.log(`bgagent linear setup — workspace '${slug}'`);
        console.log(`  provider: ${providerName}`);
        console.log(`  region:   ${region}`);
        console.log();

        // ─── Step 1: Workload access token ─────────────────────────────
        process.stdout.write('  → Minting workload access token...');
        const wat = await getWorkloadAccessToken({
          region,
          workloadName: workloadName!,
          userId: cognitoSub,
        });
        console.log(' ✓');

        // ─── Step 2: Initiate OAuth dance ──────────────────────────────
        process.stdout.write('  → Requesting Linear authorization URL...');
        const acClient = new BedrockAgentCoreClient({ region });
        const initiated = await initiateOauthDance(acClient, {
          workloadAccessToken: wat,
          providerName,
        });
        console.log(' ✓');

        // ─── Step 3: Run callback server + open browser in parallel ────
        // Server starts listening BEFORE we open the browser so we don't
        // miss the redirect. The dance: (a) start server; (b) open URL;
        // (c) await server; (d) poll for token.
        const callbackPromise = awaitOauthCallback();

        if (opts.browser !== false) {
          const opened = await openBrowser(initiated.authorizationUrl);
          if (opened) {
            console.log('  → Opened your browser to the Linear consent screen.');
            console.log('    (Your browser will warn about a self-signed cert on the localhost callback — click through.)');
          } else {
            console.log('  → Could not open browser automatically. Open this URL manually:');
            console.log(`    ${initiated.authorizationUrl}`);
          }
        } else {
          console.log('  → --no-browser: open this URL manually:');
          console.log(`    ${initiated.authorizationUrl}`);
        }

        process.stdout.write('  → Waiting for browser callback...');
        const callback = await callbackPromise;
        console.log(' ✓');

        // ─── Step 4: Poll for access token ─────────────────────────────
        process.stdout.write('  → Exchanging session for access token...');
        const accessToken = await pollForOauthAccessToken(acClient, {
          workloadAccessToken: wat,
          providerName,
          sessionUri: callback.sessionId,
        });
        console.log(' ✓');

        // ─── Step 5: Fetch workspace identity ──────────────────────────
        // Bearer-prefixed for OAuth tokens; PAK flow used the bare
        // `lin_api_…` value (which Linear also accepts as Authorization).
        process.stdout.write('  → Querying Linear viewer + organization...');
        const identity = await queryLinearIdentity(`Bearer ${accessToken}`);
        if (!identity) {
          throw new CliError(
            `OAuth token works against AgentCore but Linear's viewer query rejected it. `
            + `This is unexpected — re-run setup with \`--force-reauth\` (planned) or check `
            + `Linear app's GitHub username has [bot] suffix.`,
          );
        }
        console.log(` ✓ (${identity.organization.name ?? identity.organization.urlKey ?? identity.organization.id})`);

        if (identity.organization.urlKey && identity.organization.urlKey !== slug) {
          console.log(
            `  ⚠ Slug '${slug}' does not match Linear's urlKey '${identity.organization.urlKey}'. `
            + `This still works but the registry row will store '${slug}' as the canonical key. `
            + `If you intended a different workspace, delete the credential provider and start over.`,
          );
        }

        // ─── Step 6: Persist registry + user-mapping rows ──────────────
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
        const now = new Date().toISOString();

        await ddb.send(new PutCommand({
          TableName: workspaceRegistryTable!,
          Item: {
            linear_workspace_id: identity.organization.id,
            workspace_slug: slug,
            provider_name: providerName,
            installed_by_platform_user_id: cognitoSub,
            installed_at: now,
            updated_at: now,
            status: 'active',
          },
        }));
        console.log(`  ✓ Recorded workspace in registry`);

        await ddb.send(new PutCommand({
          TableName: userMappingTable!,
          Item: {
            linear_identity: `${identity.organization.id}#${identity.viewer.id}`,
            platform_user_id: cognitoSub,
            linear_workspace_id: identity.organization.id,
            linear_user_id: identity.viewer.id,
            linked_at: now,
            status: 'active',
            link_method: 'auto_setup_oauth',
          },
        }));
        const adminLabel = identity.viewer.name ?? identity.viewer.email ?? identity.viewer.id;
        console.log(`  ✓ Linked Linear user ${adminLabel} → platform user`);

        // ─── Step 7: Webhook signing secret (workspace-independent) ────
        const sm = new SecretsManagerClient({ region });
        const alreadyConfigured = await isWebhookSecretConfigured(sm, webhookSecretArn!);

        if (alreadyConfigured && !opts.rotateWebhookSecret) {
          console.log('  ✓ Webhook signing secret already configured (use --rotate-webhook-secret to update)');
        } else {
          const apiBaseUrl = config.api_url.replace(/\/+$/, '');
          console.log();
          console.log('  Webhook signing secret needed.');
          console.log('  In Linear → Settings → API → Webhooks, create a webhook pointing at:');
          console.log(`    ${apiBaseUrl}/linear/webhook`);
          console.log('  Subscribe to: Issues. Copy the signing secret from the webhook detail page.');
          console.log();
          const webhookSecret = await promptSecret('Webhook signing secret (lin_wh_…): ');
          if (!webhookSecret) {
            throw new CliError('Webhook signing secret is required.');
          }
          if (!webhookSecret.startsWith('lin_wh_')) {
            throw new CliError(
              `Webhook signing secrets start with 'lin_wh_'. Got something different — re-check the Linear webhook detail page.`,
            );
          }
          await sm.send(new PutSecretValueCommand({
            SecretId: webhookSecretArn!,
            SecretString: webhookSecret,
          }));
          console.log('  ✓ Stored webhook signing secret');
        }

        // ─── Done ──────────────────────────────────────────────────────
        console.log();
        console.log('✅ Setup complete.');
        console.log();
        console.log('Next steps:');
        console.log('  1. Onboard a Linear project to a GitHub repo:');
        console.log('       bgagent linear onboard-project <linear-project-id> --repo owner/repo');
        console.log('  2. Add the `bgagent` label to a Linear issue in a mapped project.');
      }),
  );

  linear.addCommand(
    new Command('onboard-project')
      .description('Map a Linear project to a GitHub repository (admin IAM required)')
      .argument('<linear-project-id>', 'Linear project UUID')
      .requiredOption('--repo <owner/repo>', 'GitHub repository the mapped project should route tasks to')
      .option('--label <label>', `Label that triggers a task (default: ${DEFAULT_LABEL_FILTER})`, DEFAULT_LABEL_FILTER)
      .option('--team-id <id>', 'Optional Linear team UUID for the project (stored for debug)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .action(async (projectId: string, opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const tableName = await getStackOutput(region, opts.stackName, 'LinearProjectMappingTableName');
        if (!tableName) {
          console.error('Could not find LinearProjectMappingTableName in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) {
          console.error(`Invalid --repo value: ${opts.repo}. Expected owner/repo.`);
          process.exit(1);
        }

        if (!UUID_RE.test(projectId)) {
          console.error(`Invalid Linear project UUID: ${projectId}`);
          console.error('');
          console.error('Linear project URLs contain a *truncated* UUID. The real UUID is a full 36-character');
          console.error('UUID (e.g. a680cae8-704c-4e64-92ac-0c80346d1aad). Run:');
          console.error('');
          console.error('  bgagent linear list-projects');
          console.error('');
          console.error('to see the full UUID for each project in your workspace.');
          process.exit(1);
        }

        const now = new Date().toISOString();
        const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: {
            linear_project_id: projectId,
            repo: opts.repo,
            label_filter: opts.label,
            ...(opts.teamId && { team_id: opts.teamId }),
            status: 'active',
            onboarded_at: now,
            updated_at: now,
          },
        }));

        console.log(`✓ Mapped Linear project ${projectId} → ${opts.repo}`);
        console.log(`  Trigger label: ${opts.label}`);
        if (opts.teamId) {
          console.log(`  Team: ${opts.teamId}`);
        }
      }),
  );

  linear.addCommand(
    new Command('list-projects')
      .description('List Linear projects visible to the stored API token (with full UUIDs)')
      .option('--region <region>', 'AWS region (defaults to configured region)')
      .option('--stack-name <name>', 'CloudFormation stack name', 'backgroundagent-dev')
      .option('--output <format>', 'Output format (text or json)', 'text')
      .action(async (opts) => {
        const config = loadConfig();
        const region = opts.region || config.region;

        const apiTokenSecretArn = await getStackOutput(region, opts.stackName, 'LinearApiTokenSecretArn');
        if (!apiTokenSecretArn) {
          console.error('Could not find LinearApiTokenSecretArn in stack outputs. Deploy the stack first.');
          process.exit(1);
        }

        const sm = new SecretsManagerClient({ region });
        const secret = await sm.send(new GetSecretValueCommand({ SecretId: apiTokenSecretArn }));
        const apiToken = secret.SecretString;
        if (!apiToken || apiToken === ' ') {
          console.error('Linear API token is not populated. Run `bgagent linear setup` first.');
          process.exit(1);
        }

        let projects: Array<{ id: string; name: string; teams?: { nodes?: Array<{ id: string; name: string }> } }>;
        try {
          const res = await fetch('https://api.linear.app/graphql', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': apiToken,
            },
            body: JSON.stringify({
              query: '{ projects { nodes { id name teams { nodes { id name } } } } }',
            }),
          });
          if (!res.ok) {
            throw new Error(`Linear API returned ${res.status}`);
          }
          const body = await res.json() as { data?: { projects?: { nodes?: typeof projects } } };
          projects = body.data?.projects?.nodes ?? [];
        } catch (err) {
          console.error(`Failed to fetch Linear projects: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        if (opts.output === 'json') {
          console.log(formatJson(projects));
          return;
        }

        if (projects.length === 0) {
          console.log('No Linear projects visible to the stored API token.');
          return;
        }

        console.log(`Found ${projects.length} Linear project(s):\n`);
        for (const p of projects) {
          const team = p.teams?.nodes?.[0];
          console.log(`  ${p.name}`);
          console.log(`    id:   ${p.id}`);
          if (team) {
            console.log(`    team: ${team.name} (${team.id})`);
          }
          console.log('');
        }
        console.log('Onboard with:');
        console.log('  bgagent linear onboard-project <id> --repo owner/repo [--label abca]');
      }),
  );

  return linear;
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

function promptSecret(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    process.stderr.write(label);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();

      let value = '';

      const onData = (chunk: Buffer) => {
        const str = chunk.toString();
        for (const char of str) {
          if (char === '\n' || char === '\r') {
            cleanup();
            process.stderr.write('\n');
            resolve(value.trim());
            return;
          } else if (char === '\u0003') {
            cleanup();
            process.stderr.write('\n');
            reject(new Error('Cancelled.'));
            return;
          } else if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              process.stderr.write('\b \b');
            }
          } else {
            value += char;
            process.stderr.write('*');
          }
        }
      };

      const cleanup = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
      };

      process.stdin.on('data', onData);
    } else {
      rl.once('line', (line) => {
        rl.close();
        resolve(line.trim());
      });
      rl.once('close', () => reject(new Error('No input provided.')));
    }
  });
}

// ─── Auto-link ───────────────────────────────────────────────────────────────

interface LinearViewer {
  readonly id: string;
  readonly name?: string;
  readonly email?: string;
}

interface LinearOrganization {
  readonly id: string;
  readonly name?: string;
  /** Linear urlKey, e.g. "acme" — Phase 2.0b: used as the workspace slug. */
  readonly urlKey?: string;
}

/**
 * Query the Linear `viewer` + `organization` GraphQL fields with whatever
 * Authorization header the caller hands us. Used both by the legacy
 * PAK-era auto-link (header value = bare `lin_api_…` token) and the
 * Phase 2.0b OAuth dance (header value = `Bearer <oauth-token>`).
 *
 * Returns null on any failure so callers can fall back to a warning
 * without blowing up the higher-level flow.
 */
async function queryLinearIdentity(
  authorizationHeader: string,
): Promise<{ viewer: LinearViewer; organization: LinearOrganization } | null> {
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorizationHeader,
      },
      body: JSON.stringify({
        query: '{ viewer { id name email } organization { id name urlKey } }',
      }),
    });
    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status}`);
    }
    const body = await res.json() as { data?: { viewer?: LinearViewer; organization?: LinearOrganization } };
    if (!body.data?.viewer?.id || !body.data.organization?.id) {
      throw new Error('Linear API response missing viewer.id or organization.id');
    }
    return { viewer: body.data.viewer, organization: body.data.organization };
  } catch (err) {
    console.log(`  ⚠ Could not query Linear identity: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Query `viewer` + `organization` on the Linear API and write an active
 * LinearUserMapping row binding the token owner to the Cognito user running
 * the CLI. Skips gracefully on any failure — the admin can still link manually.
 *
 * Exported for test. Not part of the public CLI surface.
 */
export async function autoLinkTokenOwner(args: {
  region: string;
  apiToken: string;
  userMappingTable: string;
}): Promise<void> {
  let viewer: LinearViewer;
  let organization: LinearOrganization;
  try {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': args.apiToken,
      },
      body: JSON.stringify({
        query: '{ viewer { id name email } organization { id name } }',
      }),
    });
    if (!res.ok) {
      throw new Error(`Linear API returned ${res.status}`);
    }
    const body = await res.json() as { data?: { viewer?: LinearViewer; organization?: LinearOrganization } };
    if (!body.data?.viewer?.id || !body.data.organization?.id) {
      throw new Error('Linear API response missing viewer.id or organization.id');
    }
    viewer = body.data.viewer;
    organization = body.data.organization;
  } catch (err) {
    console.log(`  ⚠ Could not auto-link token owner: ${err instanceof Error ? err.message : String(err)}`);
    console.log('    The Linear API token is stored, but you are not yet linked as a platform user.');
    console.log('    Workarounds:');
    console.log('      • Re-run `bgagent linear setup` once Linear API is reachable (most common — transient failures).');
    console.log('      • If the failure persists, an admin can insert your linked identity directly into the');
    console.log(`        ${args.userMappingTable} DynamoDB table (linear_identity = "<workspaceId>#<viewerId>",`);
    console.log('        platform_user_id = your Cognito sub). See docs/guides/LINEAR_SETUP_GUIDE.md.');
    console.log('    `bgagent linear link <code>` is a v3 feature that requires Linear OAuth bot install (not in v1).');
    return;
  }

  let cognitoSub: string;
  try {
    cognitoSub = extractCognitoSub();
  } catch (err) {
    console.log(`  ⚠ Could not resolve your platform user (${err instanceof Error ? err.message : String(err)}).`);
    console.log('    Run `bgagent login`, then re-run `bgagent linear setup` to finish auto-linking.');
    return;
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: args.region }));
  await ddb.send(new PutCommand({
    TableName: args.userMappingTable,
    Item: {
      linear_identity: `${organization.id}#${viewer.id}`,
      platform_user_id: cognitoSub,
      linear_workspace_id: organization.id,
      linear_user_id: viewer.id,
      linked_at: new Date().toISOString(),
      status: 'active',
      link_method: 'auto_setup',
    },
  }));

  const label = viewer.name ?? viewer.email ?? viewer.id;
  console.log(`  ✓ Linked Linear user ${label} (${organization.name ?? organization.id}) → platform user ${cognitoSub}`);
}

function extractCognitoSub(): string {
  const creds = loadCredentials();
  if (!creds?.id_token) {
    throw new Error('not authenticated — run `bgagent login`');
  }
  const parts = creds.id_token.split('.');
  if (parts.length !== 3) {
    throw new Error('malformed id_token in ~/.bgagent/credentials.json');
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { sub?: string };
  if (!payload.sub) {
    throw new Error('id_token missing `sub` claim');
  }
  return payload.sub;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  try {
    const cfn = new CloudFormationClient({ region });
    const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const outputs = result.Stacks?.[0]?.Outputs ?? [];
    const output = outputs.find((o) => o.OutputKey === outputKey);
    return output?.OutputValue ?? null;
  } catch (err) {
    // Mirror cli/src/commands/slack.ts: swallow "stack does not exist" as null,
    // surface auth/other errors.
    const name = (err as Error)?.name ?? '';
    const message = (err as Error)?.message ?? '';
    if (name === 'ValidationError' && /does not exist/i.test(message)) {
      return null;
    }
    throw err;
  }
}
