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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { ulid } from 'ulid';
import { logger } from './shared/logger';
import { ErrorCode, errorResponse } from './shared/response';
import { isValidShortCode, lookupShortLink } from './shared/shortener-store';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.SHORT_LINK_TABLE_NAME!;

/**
 * GET /{code} — Resolve a short code and redirect to the original long URL.
 *
 * Returns a 302 with a `Location` header on a hit. Unknown or malformed codes
 * yield a JSON error envelope (404 / 400 respectively) rather than a redirect.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Extract the short code from the path
    const code = event.pathParameters?.code;
    if (!code) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Missing code path parameter.', requestId);
    }

    // 2. Reject malformed codes before touching storage
    if (!isValidShortCode(code)) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Invalid short code format.', requestId);
    }

    // 3. Look up the original URL
    const record = await lookupShortLink(ddb, TABLE_NAME, code);
    if (!record) {
      return errorResponse(404, ErrorCode.SHORT_LINK_NOT_FOUND, `Short link '${code}' not found.`, requestId);
    }

    // 4. Redirect to the original URL
    logger.info('Short link resolved', { code, request_id: requestId });
    return {
      statusCode: 302,
      headers: {
        'Location': record.long_url,
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
      },
      body: '',
    };
  } catch (err) {
    logger.error('Failed to resolve short link', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
