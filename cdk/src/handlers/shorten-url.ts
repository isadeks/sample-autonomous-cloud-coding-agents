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
import { ErrorCode, errorResponse, successResponse } from './shared/response';
import { isValidLongUrl, MAX_LONG_URL_LENGTH, storeShortLink } from './shared/shortener-store';
import { parseBody } from './shared/validation';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.SHORT_LINK_TABLE_NAME!;

/** Request body for `POST /shorten`. */
interface ShortenRequest {
  /** The long URL to shorten. */
  readonly url?: unknown;
}

/**
 * POST /shorten — Accept a long URL and return its short code.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = ulid();

  try {
    // 1. Parse request body
    const body = parseBody<ShortenRequest>(event.body);
    if (!body) {
      return errorResponse(400, ErrorCode.VALIDATION_ERROR, 'Request body must be valid JSON.', requestId);
    }

    // 2. Validate the long URL
    if (!isValidLongUrl(body.url)) {
      return errorResponse(
        400,
        ErrorCode.VALIDATION_ERROR,
        `Field 'url' must be a valid http(s) URL no longer than ${MAX_LONG_URL_LENGTH} characters.`,
        requestId,
      );
    }

    // 3. Persist under a freshly generated short code
    const record = await storeShortLink(ddb, TABLE_NAME, body.url);

    logger.info('Short link created', { code: record.code, request_id: requestId });

    return successResponse(201, {
      code: record.code,
      long_url: record.long_url,
      created_at: record.created_at,
    }, requestId);
  } catch (err) {
    logger.error('Failed to shorten URL', { error: String(err), request_id: requestId });
    return errorResponse(500, ErrorCode.INTERNAL_ERROR, 'Internal server error.', requestId);
  }
}
