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

import {
  FALLBACK_DEFAULT_BRANCH,
  resolveRepoDefaultBranch,
} from '../../../src/handlers/shared/orchestration-default-branch';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function okFetch(defaultBranch: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ default_branch: defaultBranch }),
  })) as unknown as typeof fetch;
}

describe('resolveRepoDefaultBranch (ABCA-687)', () => {
  test('returns the repo default branch from the GitHub API', async () => {
    const branch = await resolveRepoDefaultBranch({
      repo: 'acme/site', token: 'tok', fetchImpl: okFetch('linear-vercel'),
    });
    expect(branch).toBe('linear-vercel');
  });

  test('calls the GitHub repos endpoint with the token header', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true, status: 200, json: async () => ({ default_branch: 'trunk' }),
    })) as unknown as jest.MockedFunction<typeof fetch>;
    await resolveRepoDefaultBranch({ repo: 'acme/site', token: 'tok', fetchImpl });
    const [url, init] = (fetchImpl as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/acme/site');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('token tok');
  });

  test('falls back to main when no token is provided', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const branch = await resolveRepoDefaultBranch({ repo: 'acme/site', fetchImpl });
    expect(branch).toBe(FALLBACK_DEFAULT_BRANCH);
    expect(fetchImpl).not.toHaveBeenCalled(); // never hits the network without a token
  });

  test('falls back to main on a malformed repo string', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    const branch = await resolveRepoDefaultBranch({ repo: 'no-slash', token: 'tok', fetchImpl });
    expect(branch).toBe(FALLBACK_DEFAULT_BRANCH);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('falls back to main on a non-OK GitHub response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    const branch = await resolveRepoDefaultBranch({ repo: 'acme/site', token: 'tok', fetchImpl });
    expect(branch).toBe(FALLBACK_DEFAULT_BRANCH);
  });

  test('falls back to main when default_branch is missing from the response', async () => {
    const branch = await resolveRepoDefaultBranch({ repo: 'acme/site', token: 'tok', fetchImpl: okFetch(undefined) });
    expect(branch).toBe(FALLBACK_DEFAULT_BRANCH);
  });

  test('falls back to main when fetch throws (unreachable / timeout)', async () => {
    const fetchImpl = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const branch = await resolveRepoDefaultBranch({ repo: 'acme/site', token: 'tok', fetchImpl });
    expect(branch).toBe(FALLBACK_DEFAULT_BRANCH);
  });
});
