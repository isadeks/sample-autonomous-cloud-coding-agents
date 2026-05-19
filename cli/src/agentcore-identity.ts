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

import {
  BedrockAgentCoreClient,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { CliError } from './errors';

/**
 * The AgentCore *runtime* workload identity (auto-created when the runtime
 * is provisioned) is locked to its service — calling
 * `GetWorkloadAccessTokenForUserId` against it returns
 * `ValidationException: WorkloadIdentity is linked to a service`.
 *
 * The CLI flow needs its own workload identity, named at deploy time and
 * surfaced via stack output. This is the convention the rest of 2.0b uses.
 */
export const DEFAULT_CLI_WORKLOAD_NAME = 'bgagent-cli';

export interface WorkloadAccessTokenRequest {
  readonly region: string;
  readonly workloadName: string;
  /** Cognito `sub` claim of the bgagent-CLI user. */
  readonly userId: string;
}

/**
 * Retrieve a workload access token (WAT) for the calling user. The WAT is
 * the credential that authorises subsequent
 * `BedrockAgentCoreClient.getResourceOauth2Token(...)` calls during the
 * Linear OAuth dance.
 *
 * The CLI runs OUTSIDE AgentCore Runtime, so the in-container ContextVar
 * trick from 2.0a does NOT apply. This call goes to the data-plane API
 * directly with the caller's AWS credentials (resolved by the SDK's default
 * provider chain), and AWS scopes the resulting token to
 * `(workloadName, userId)`.
 *
 * Throws CliError with a remediation hint for two common failures:
 * - `AccessDeniedException` — the user's AWS principal lacks
 *   `bedrock-agentcore:GetWorkloadAccessTokenForUserId` on the workload
 *   identity. Usually means the `bgagent-cli` workload doesn't exist yet
 *   or wasn't allowlisted to the IAM principal running the CLI.
 * - `ValidationException: WorkloadIdentity is linked to a service` — the
 *   caller passed a workload name that points at a runtime workload (not
 *   the CLI workload). Documented as a footgun in the 2.0b spike.
 */
export async function getWorkloadAccessToken(
  request: WorkloadAccessTokenRequest,
): Promise<string> {
  const client = new BedrockAgentCoreClient({ region: request.region });
  try {
    const response = await client.send(
      new GetWorkloadAccessTokenForUserIdCommand({
        workloadName: request.workloadName,
        userId: request.userId,
      }),
    );
    if (!response.workloadAccessToken) {
      // Defensive: SDK shape allows undefined but a successful response
      // always populates it. Surface the corner case explicitly so we
      // don't pass `undefined` to downstream OAuth calls.
      throw new CliError('AgentCore returned an empty workload access token.');
    }
    return response.workloadAccessToken;
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'ValidationException' && /linked to a service/.test(err.message)) {
        throw new CliError(
          `Workload identity '${request.workloadName}' is linked to a service and cannot mint user-scoped tokens. `
          + `This usually means the CLI is misconfigured to use a runtime workload identity. `
          + `Verify the stack output 'CliWorkloadIdentityName' or override with --workload-name.`,
        );
      }
      if (err.name === 'AccessDeniedException' || err.name === 'ResourceNotFoundException') {
        throw new CliError(
          `Cannot retrieve a workload access token: ${err.message}. `
          + `Confirm: (1) the stack is deployed with 2.0b CLI workload identity; `
          + `(2) your AWS credentials have 'bedrock-agentcore:GetWorkloadAccessTokenForUserId' `
          + `on the '${request.workloadName}' workload; (3) you've run 'bgagent login' so the CLI knows your Cognito sub.`,
        );
      }
    }
    throw err;
  }
}

/**
 * Decode the Cognito ID token to extract the `sub` claim. The CLI uses
 * the sub as the `userId` for AgentCore Identity calls so tokens are
 * scoped to individual platform users.
 *
 * Token validation (signature, expiry, audience) is API Gateway's job;
 * this helper only parses the payload, treating the local credentials
 * file as a trusted source.
 */
export function decodeCognitoSub(idToken: string): string {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new CliError('Cached id_token is not a valid JWT (expected 3 segments).');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch (err) {
    throw new CliError(
      `Failed to decode JWT payload: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new CliError('Cached id_token has no `sub` claim.');
  }
  return sub;
}
