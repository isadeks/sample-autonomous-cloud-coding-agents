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

// Child test-shape mockup token: S1-CHILD-MOCKUP-1784764497
// Test-shape mockup for GET /status (returns { build, uptime_s }).

import type { APIGatewayProxyEvent } from 'aws-lambda';

jest.mock('ulid', () => ({ ulid: jest.fn(() => 'REQ-ULID') }));

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    body: null,
    headers: {},
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: '/v1/status',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '/status',
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
      path: '/v1/status',
      protocol: 'HTTPS',
      requestId: 'gw-req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-id',
      resourcePath: '/status',
      stage: 'v1',
    },
    ...overrides,
  };
}

describe('get-status handler', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('returns 200 with build and uptime_s keys', async () => {
    process.env.BUILD_VERSION = 'abc123';
    const { handler } = await import('../../src/handlers/get-status');

    const result = await handler(makeEvent());

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.build).toBe('abc123');
    expect(typeof body.data.uptime_s).toBe('number');
    // Only these two keys per the spec.
    expect(Object.keys(body.data).sort()).toEqual(['build', 'uptime_s']);
  });

  test('uptime_s is a non-negative integer', async () => {
    const { handler } = await import('../../src/handlers/get-status');

    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.data.uptime_s).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.data.uptime_s)).toBe(true);
  });

  test('uptime_s grows with elapsed wall-clock time since cold start', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    // First Date.now() call is the module-load cold-start capture.
    nowSpy.mockReturnValueOnce(1_000_000);
    const { handler } = await import('../../src/handlers/get-status');

    // 42 seconds later (plus a ulid() Date.now offset tolerance): the
    // handler's Date.now() read.
    nowSpy.mockReturnValue(1_000_000 + 42_000);
    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.data.uptime_s).toBe(42);
    nowSpy.mockRestore();
  });

  test('uptime_s never goes negative when the clock moves backwards', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(5_000_000);
    const { handler } = await import('../../src/handlers/get-status');

    // Clock jumps backwards after cold start.
    nowSpy.mockReturnValue(4_000_000);
    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.data.uptime_s).toBe(0);
    nowSpy.mockRestore();
  });

  test('falls back to "unknown" build when BUILD_VERSION is unset', async () => {
    delete process.env.BUILD_VERSION;
    const { handler, UNKNOWN_BUILD } = await import('../../src/handlers/get-status');

    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.data.build).toBe(UNKNOWN_BUILD);
    expect(body.data.build).toBe('unknown');
  });

  test('falls back to "unknown" build when BUILD_VERSION is empty', async () => {
    process.env.BUILD_VERSION = '';
    const { handler } = await import('../../src/handlers/get-status');

    const result = await handler(makeEvent());

    const body = JSON.parse(result.body);
    expect(body.data.build).toBe('unknown');
  });

  test('does not require authentication (works with a null authorizer)', async () => {
    const { handler } = await import('../../src/handlers/get-status');

    const event = makeEvent();
    event.requestContext.authorizer = null;
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
  });

  test('includes standard headers and X-Request-Id', async () => {
    const { handler } = await import('../../src/handlers/get-status');

    const result = await handler(makeEvent());

    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['X-Request-Id']).toBe('REQ-ULID');
  });
});
