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

import type { APIGatewayProxyEvent } from 'aws-lambda';

// --- Mocks ---
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

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.SHORT_LINK_TABLE_NAME = 'ShortLinks';

import { handler } from '../../src/handlers/shorten-url';

function makeEvent(body: unknown, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/shorten',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/shorten',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: null,
      httpMethod: 'POST',
      identity: {
        sourceIp: '1.2.3.4',
        userAgent: 'test/1.0',
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        user: null,
        userArn: null,
      },
      path: '/shorten',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/shorten',
      stage: 'prod',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({});
});

describe('shorten-url handler', () => {
  test('shortens a valid URL successfully', async () => {
    const result = await handler(makeEvent({ url: 'https://example.com/some/long/path?a=1' }));

    expect(result.statusCode).toBe(201);
    const body = JSON.parse(result.body);
    expect(body.data.long_url).toBe('https://example.com/some/long/path?a=1');
    expect(typeof body.data.code).toBe('string');
    expect(body.data.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(body.data.created_at).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('writes a Put with a conditional expression guarding code uniqueness', async () => {
    await handler(makeEvent({ url: 'https://example.com/' }));

    const putArg = mockSend.mock.calls[0][0];
    expect(putArg._type).toBe('Put');
    expect(putArg.input.TableName).toBe('ShortLinks');
    expect(putArg.input.ConditionExpression).toBe('attribute_not_exists(code)');
    expect(putArg.input.Item.long_url).toBe('https://example.com/');
  });

  test('retries on a code collision then succeeds', async () => {
    mockSend
      .mockRejectedValueOnce(new MockConditionalCheckFailedException())
      .mockResolvedValueOnce({});

    const result = await handler(makeEvent({ url: 'https://example.com/' }));

    expect(result.statusCode).toBe(201);
    expect(mockSend).toHaveBeenCalledTimes(2);
    // Codes on the two attempts should differ (regenerated on collision).
    const first = mockSend.mock.calls[0][0].input.Item.code;
    const second = mockSend.mock.calls[1][0].input.Item.code;
    expect(first).not.toBe(second);
  });

  test('returns 400 when body is not valid JSON', async () => {
    const result = await handler(makeEvent('{not json'));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 400 when body is missing', async () => {
    const result = await handler(makeEvent(undefined));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 when url field is absent', async () => {
    const result = await handler(makeEvent({}));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 400 for a non-http(s) URL', async () => {
    const result = await handler(makeEvent({ url: 'ftp://example.com/file' }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for a syntactically invalid URL', async () => {
    const result = await handler(makeEvent({ url: 'not a url' }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for a non-string url', async () => {
    const result = await handler(makeEvent({ url: 12345 }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 400 for a URL exceeding the length limit', async () => {
    const longUrl = `https://example.com/${'a'.repeat(2100)}`;
    const result = await handler(makeEvent({ url: longUrl }));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
  });

  test('returns 500 when DynamoDB fails with a non-collision error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DB failure'));
    const result = await handler(makeEvent({ url: 'https://example.com/' }));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });

  test('includes standard headers', async () => {
    const result = await handler(makeEvent({ url: 'https://example.com/' }));

    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['X-Request-Id']).toBe('REQ-ULID');
  });
});
