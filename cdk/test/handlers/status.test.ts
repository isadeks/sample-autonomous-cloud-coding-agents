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

// Parent spec: S1-PARENT-SPEC-1784764497 — GET /status MUST return JSON with
// keys `build` and `uptime_s`. This suite pins that contract.

import { handler } from '../../src/handlers/status';

describe('status handler (GET /status)', () => {
  test('returns 200', async () => {
    const res = await handler();
    expect(res.statusCode).toBe(200);
  });

  test('body is JSON with exactly the { build, uptime_s } shape', async () => {
    const res = await handler();

    expect(res.headers?.['Content-Type']).toBe('application/json');

    const body = JSON.parse(res.body) as Record<string, unknown>;

    // Exactly the two spec keys — no more, no less.
    expect(Object.keys(body).sort()).toEqual(['build', 'uptime_s']);
    expect(typeof body.build).toBe('string');
    expect(typeof body.uptime_s).toBe('number');
    // uptime is a non-negative, integral count of seconds.
    expect(body.uptime_s as number).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.uptime_s as number)).toBe(true);
  });

  test('build reflects the BUILD env var when set', async () => {
    const previous = process.env.BUILD;
    process.env.BUILD = 'test-build-42';
    try {
      // Re-import against the mutated env so `resolveBuild()` reads the new
      // value at request time.
      const res = await handler();
      const body = JSON.parse(res.body) as { build: string };
      expect(body.build).toBe('test-build-42');
    } finally {
      if (previous === undefined) {
        delete process.env.BUILD;
      } else {
        process.env.BUILD = previous;
      }
    }
  });

  test('build falls back to "unknown" when BUILD is unset', async () => {
    const previous = process.env.BUILD;
    delete process.env.BUILD;
    try {
      const res = await handler();
      const body = JSON.parse(res.body) as { build: string };
      expect(body.build).toBe('unknown');
    } finally {
      if (previous !== undefined) {
        process.env.BUILD = previous;
      }
    }
  });
});
