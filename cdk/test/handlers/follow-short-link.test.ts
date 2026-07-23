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
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
  ConditionalCheckFailedException: class extends Error {},
}));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
}));

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

process.env.SHORT_LINK_TABLE_NAME = 'ShortLinks';

import { handler } from '../../src/handlers/follow-short-link';

const LINK_RECORD = {
  code: 'abc1234',
  long_url: 'https://example.com/destination',
  created_at: '2026-07-23T10:30:00Z',
};

function makeEvent(code: string | null, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: `/${code ?? ''}`,
    pathParameters: code === null ? null : { code },
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/{code}',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      authorizer: null,
      httpMethod: 'GET',
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
      path: `/${code ?? ''}`,
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/{code}',
      stage: 'prod',
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ Item: LINK_RECORD });
});

describe('follow-short-link handler', () => {
  test('redirects to the original URL on a hit', async () => {
    const result = await handler(makeEvent('abc1234'));

    expect(result.statusCode).toBe(302);
    expect(result.headers?.Location).toBe('https://example.com/destination');
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    expect(result.body).toBe('');

    // Lookup uses the code as the key.
    const getArg = mockSend.mock.calls[0][0];
    expect(getArg._type).toBe('Get');
    expect(getArg.input.TableName).toBe('ShortLinks');
    expect(getArg.input.Key).toEqual({ code: 'abc1234' });
  });

  test('returns 404 when the code is unknown', async () => {
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await handler(makeEvent('unknwn0'));

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body).error.code).toBe('SHORT_LINK_NOT_FOUND');
  });

  test('returns 400 when the code path parameter is missing', async () => {
    const result = await handler(makeEvent(null));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 400 for a malformed code (path traversal)', async () => {
    const result = await handler(makeEvent('../etc'));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    // Rejected before storage is touched.
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 400 for a code with disallowed characters', async () => {
    const result = await handler(makeEvent('bad code!'));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error.code).toBe('VALIDATION_ERROR');
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('returns 500 on a DynamoDB error', async () => {
    mockSend.mockRejectedValueOnce(new Error('DB failure'));
    const result = await handler(makeEvent('abc1234'));

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error.code).toBe('INTERNAL_ERROR');
  });

  test('includes the request id header on a redirect', async () => {
    const result = await handler(makeEvent('abc1234'));
    expect(result.headers?.['X-Request-Id']).toBe('REQ-ULID');
  });
});
