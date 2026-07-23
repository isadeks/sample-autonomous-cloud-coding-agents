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

import * as crypto from 'crypto';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Storage layer for the URL shortener. Encapsulates the DynamoDB access the
 * `POST /shorten` and `GET /{code}` handlers share so the request handlers
 * stay thin. The table is keyed on `code` (partition key); each item maps a
 * generated short code back to the original long URL.
 */

/** Base62 alphabet used for generated short codes. */
const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Length of a newly generated short code. */
export const SHORT_CODE_LENGTH = 7;
/** Number of collision retries before giving up on code generation. */
const MAX_GENERATE_ATTEMPTS = 5;
/** Longest accepted long URL (guards against oversized items). */
export const MAX_LONG_URL_LENGTH = 2048;
/** Short codes are base62 and bounded so lookups reject obvious garbage early. */
const SHORT_CODE_PATTERN = /^[0-9A-Za-z]{1,32}$/;

/** A stored short-link record. */
export interface ShortLinkRecord {
  /** The short code (partition key). */
  readonly code: string;
  /** The original long URL. */
  readonly long_url: string;
  /** ISO-8601 creation timestamp. */
  readonly created_at: string;
}

/**
 * Generate a random base62 short code of {@link SHORT_CODE_LENGTH} characters.
 * Uses `crypto.randomBytes` (via rejection-free modulo over the 62-char
 * alphabet; bias is negligible for a 256-value byte over 62 symbols and codes
 * are not security tokens).
 * @returns a freshly generated short code.
 */
export function generateShortCode(): string {
  const bytes = crypto.randomBytes(SHORT_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < SHORT_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Validate a candidate short code (base62, 1-32 chars). Rejects empty strings,
 * path separators, and other characters a generated code can never contain.
 * @param code - the candidate short code.
 * @returns true if the shape is a plausible short code.
 */
export function isValidShortCode(code: string): boolean {
  return typeof code === 'string' && SHORT_CODE_PATTERN.test(code);
}

/**
 * Validate a long URL: must parse as an absolute `http`/`https` URL and stay
 * within {@link MAX_LONG_URL_LENGTH}.
 * @param url - the candidate long URL.
 * @returns true if the URL is acceptable to shorten.
 */
export function isValidLongUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_LONG_URL_LENGTH) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Persist a long URL under a freshly generated short code, retrying on the
 * (astronomically unlikely) event of a code collision.
 * @param ddb - the DynamoDB document client.
 * @param tableName - the short-link table name.
 * @param longUrl - the validated long URL to store.
 * @returns the stored record.
 * @throws if a unique code cannot be generated within the retry budget, or on
 *   an underlying DynamoDB error.
 */
export async function storeShortLink(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  longUrl: string,
): Promise<ShortLinkRecord> {
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const record: ShortLinkRecord = {
      code: generateShortCode(),
      long_url: longUrl,
      created_at: new Date().toISOString(),
    };
    try {
      await ddb.send(new PutCommand({
        TableName: tableName,
        Item: record,
        ConditionExpression: 'attribute_not_exists(code)',
      }));
      return record;
    } catch (err) {
      // A collision means the code already exists — retry with a new code.
      // Any other error is a real failure and propagates to the handler.
      if (err instanceof ConditionalCheckFailedException) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Failed to generate a unique short code after ${MAX_GENERATE_ATTEMPTS} attempts`);
}

/**
 * Look up the long URL for a short code.
 * @param ddb - the DynamoDB document client.
 * @param tableName - the short-link table name.
 * @param code - the short code to resolve.
 * @returns the stored record, or null if the code is unknown.
 */
export async function lookupShortLink(
  ddb: DynamoDBDocumentClient,
  tableName: string,
  code: string,
): Promise<ShortLinkRecord | null> {
  const result = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { code },
  }));
  return (result.Item as ShortLinkRecord | undefined) ?? null;
}
