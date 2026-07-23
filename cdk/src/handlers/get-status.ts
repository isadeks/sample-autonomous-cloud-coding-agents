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

// Parent API spec: S1-PARENT-SPEC-1784764497
// Per the /status API spec, this endpoint MUST return JSON with the keys
// `build` and `uptime_s`.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse, successResponse } from './shared/response';

/**
 * Fallback build identifier used when ``BUILD_VERSION`` is not injected at
 * deploy time (e.g. local invocation or a stack synthesized without the
 * env var). ``unknown`` is a stable, machine-parseable sentinel — never an
 * empty string, so callers can always rely on the ``build`` key being a
 * non-empty string.
 */
export const UNKNOWN_BUILD = 'unknown';

/**
 * Cold-start timestamp captured once at module load. Lambda reuses a warm
 * execution environment across invocations, so ``uptime_s`` measures how
 * long *this* container has been alive — a proxy for warm-vs-cold and a
 * lightweight liveness signal. Computed from module init (not
 * ``process.uptime()``) so the value is deterministic under test with a
 * mocked ``Date.now``.
 */
const COLD_START_EPOCH_MS = Date.now();

/**
 * ``GET /status`` — lightweight, unauthenticated health/liveness probe.
 *
 * Response shape (200):
 * ```
 * { data: { build: string, uptime_s: number } }
 * ```
 *
 * - ``build``    — the deployed build identifier (``BUILD_VERSION`` env
 *   var), or ``"unknown"`` when unset.
 * - ``uptime_s`` — whole seconds this execution environment has been alive
 *   since cold start (never negative).
 *
 * The handler performs no I/O and touches no downstream service, so it
 * cannot fail on a dependency; the try/catch exists only to guarantee the
 * standard ``{ error }`` envelope on the (unexpected) chance serialization
 * throws.
 */
export async function handler(_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    const build = process.env.BUILD_VERSION || UNKNOWN_BUILD;
    // Clamp at 0: a clock adjustment could in theory make "now" precede
    // the captured cold-start time; uptime is never meaningfully negative.
    const uptime_s = Math.max(0, Math.floor((Date.now() - COLD_START_EPOCH_MS) / 1000));

    return successResponse(200, { build, uptime_s }, requestId);
  } catch (err) {
    logger.error('Failed to build /status response', {
      error: err instanceof Error ? err.message : String(err),
      request_id: requestId,
    });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
