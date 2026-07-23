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

// Parent spec: S1-PARENT-SPEC-1784764497
// Per that spec, GET /status MUST return JSON with keys `build` and `uptime_s`.

import type { APIGatewayProxyResult } from 'aws-lambda';

const COMMON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

/**
 * The build identifier of the currently deployed artifact. Sourced from the
 * `BUILD` environment variable (injected at deploy time), falling back to
 * `'unknown'` so the endpoint always answers with a well-formed shape.
 */
function resolveBuild(): string {
  return process.env.BUILD ?? 'unknown';
}

/**
 * Process boot timestamp (ms since epoch), captured at module load so
 * `uptime_s` reflects how long this Lambda execution environment has been
 * warm rather than the age of a single request.
 */
const START_TIME_MS = Date.now();

/**
 * The status/health payload contract mandated by the parent spec
 * (S1-PARENT-SPEC-1784764497): exactly the keys `build` and `uptime_s`.
 */
export interface StatusResponse {
  /** Deployed build identifier. */
  build: string;
  /** Seconds this execution environment has been up, floored to an integer. */
  uptime_s: number;
}

/**
 * GET /status — lightweight, unauthenticated liveness/build probe.
 *
 * Returns HTTP 200 with a JSON body of `{ build, uptime_s }` as required by
 * parent spec S1-PARENT-SPEC-1784764497. The body is intentionally NOT wrapped
 * in the `{ data }` envelope used by the authenticated `/v1/*` API surface —
 * health probes and load balancers expect the fields at the top level.
 */
export async function handler(): Promise<APIGatewayProxyResult> {
  const body: StatusResponse = {
    build: resolveBuild(),
    uptime_s: Math.floor((Date.now() - START_TIME_MS) / 1000),
  };

  return {
    statusCode: 200,
    headers: { ...COMMON_HEADERS },
    body: JSON.stringify(body),
  };
}
