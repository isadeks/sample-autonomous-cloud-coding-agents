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

const mockSend = jest.fn();

class MockConditionalCheckFailedException extends Error {
  constructor() {
    super('conditional check failed');
    this.name = 'ConditionalCheckFailedException';
  }
}

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  ConditionalCheckFailedException: MockConditionalCheckFailedException,
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
}));

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  generateShortCode,
  isValidLongUrl,
  isValidShortCode,
  lookupShortLink,
  MAX_LONG_URL_LENGTH,
  SHORT_CODE_LENGTH,
  storeShortLink,
} from '../../../src/handlers/shared/shortener-store';

const ddb = { send: mockSend } as unknown as DynamoDBDocumentClient;

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({});
});

describe('generateShortCode', () => {
  test('produces a base62 code of the configured length', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateShortCode();
      expect(code).toHaveLength(SHORT_CODE_LENGTH);
      expect(code).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  test('produces distinct codes across calls', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateShortCode()));
    // Collisions across 50 random 7-char base62 codes are astronomically unlikely.
    expect(codes.size).toBe(50);
  });
});

describe('isValidShortCode', () => {
  test.each(['abc1234', 'A', '0', 'aZ09'])('accepts base62 code %p', (code) => {
    expect(isValidShortCode(code)).toBe(true);
  });

  test.each(['', '../etc', 'has space', 'has/slash', 'a'.repeat(33), 'bad!', 'em—dash'])(
    'rejects malformed code %p',
    (code) => {
      expect(isValidShortCode(code)).toBe(false);
    },
  );
});

describe('isValidLongUrl', () => {
  test.each([
    'https://example.com',
    'http://example.com/path?q=1#frag',
    'https://sub.example.co.uk/a/b/c',
  ])('accepts valid URL %p', (url) => {
    expect(isValidLongUrl(url)).toBe(true);
  });

  test.each([
    '',
    'not a url',
    'ftp://example.com',
    'javascript:alert(1)',
    'example.com',
    'mailto:me@example.com',
  ])('rejects invalid URL %p', (url) => {
    expect(isValidLongUrl(url)).toBe(false);
  });

  test('rejects non-string input', () => {
    expect(isValidLongUrl(42)).toBe(false);
    expect(isValidLongUrl(null)).toBe(false);
    expect(isValidLongUrl(undefined)).toBe(false);
    expect(isValidLongUrl({})).toBe(false);
  });

  test('rejects a URL exceeding the length cap', () => {
    expect(isValidLongUrl(`https://example.com/${'a'.repeat(MAX_LONG_URL_LENGTH)}`)).toBe(false);
  });
});

describe('storeShortLink', () => {
  test('stores the URL and returns the record', async () => {
    const record = await storeShortLink(ddb, 'ShortLinks', 'https://example.com/');

    expect(record.long_url).toBe('https://example.com/');
    expect(record.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(record.created_at).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const putArg = mockSend.mock.calls[0][0];
    expect(putArg.input.ConditionExpression).toBe('attribute_not_exists(code)');
  });

  test('retries on collision, generating a fresh code each attempt', async () => {
    mockSend
      .mockRejectedValueOnce(new MockConditionalCheckFailedException())
      .mockRejectedValueOnce(new MockConditionalCheckFailedException())
      .mockResolvedValueOnce({});

    const record = await storeShortLink(ddb, 'ShortLinks', 'https://example.com/');

    expect(record).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  test('gives up after the retry budget of repeated collisions', async () => {
    mockSend.mockRejectedValue(new MockConditionalCheckFailedException());

    await expect(storeShortLink(ddb, 'ShortLinks', 'https://example.com/')).rejects.toThrow(
      /unique short code/,
    );
  });

  test('propagates non-collision errors immediately', async () => {
    mockSend.mockRejectedValueOnce(new Error('boom'));

    await expect(storeShortLink(ddb, 'ShortLinks', 'https://example.com/')).rejects.toThrow('boom');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('lookupShortLink', () => {
  test('returns the record on a hit', async () => {
    const item = { code: 'abc1234', long_url: 'https://example.com/', created_at: 'now' };
    mockSend.mockResolvedValueOnce({ Item: item });

    const record = await lookupShortLink(ddb, 'ShortLinks', 'abc1234');

    expect(record).toEqual(item);
    const getArg = mockSend.mock.calls[0][0];
    expect(getArg.input.Key).toEqual({ code: 'abc1234' });
  });

  test('returns null when the code is unknown', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });

    const record = await lookupShortLink(ddb, 'ShortLinks', 'missing');

    expect(record).toBeNull();
  });
});
