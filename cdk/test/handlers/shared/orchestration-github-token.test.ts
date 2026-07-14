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

const loadRepoConfigMock = jest.fn();
const resolveGitHubTokenMock = jest.fn();

jest.mock('../../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...args: unknown[]) => loadRepoConfigMock(...args),
}));
jest.mock('../../../src/handlers/shared/context-hydration', () => ({
  resolveGitHubToken: (...args: unknown[]) => resolveGitHubTokenMock(...args),
}));
jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { resolveRepoGithubToken } from '../../../src/handlers/shared/orchestration-github-token';

describe('resolveRepoGithubToken (ABCA-687)', () => {
  const OLD_ENV = process.env.GITHUB_TOKEN_SECRET_ARN;
  beforeEach(() => {
    loadRepoConfigMock.mockReset();
    resolveGitHubTokenMock.mockReset();
    delete process.env.GITHUB_TOKEN_SECRET_ARN;
  });
  afterAll(() => {
    if (OLD_ENV === undefined) delete process.env.GITHUB_TOKEN_SECRET_ARN;
    else process.env.GITHUB_TOKEN_SECRET_ARN = OLD_ENV;
  });

  test('resolves via the per-repo blueprint secret ARN', async () => {
    loadRepoConfigMock.mockResolvedValue({ github_token_secret_arn: 'arn:repo-secret' });
    resolveGitHubTokenMock.mockResolvedValue('ghp_repo');
    const token = await resolveRepoGithubToken('o/r');
    expect(token).toBe('ghp_repo');
    expect(resolveGitHubTokenMock).toHaveBeenCalledWith('arn:repo-secret');
  });

  test('falls back to the platform-default env secret when the repo has none', async () => {
    process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:platform-secret';
    loadRepoConfigMock.mockResolvedValue({});
    resolveGitHubTokenMock.mockResolvedValue('ghp_platform');
    const token = await resolveRepoGithubToken('o/r');
    expect(token).toBe('ghp_platform');
    expect(resolveGitHubTokenMock).toHaveBeenCalledWith('arn:platform-secret');
  });

  test('returns undefined when no secret is configured anywhere', async () => {
    loadRepoConfigMock.mockResolvedValue(null);
    const token = await resolveRepoGithubToken('o/r');
    expect(token).toBeUndefined();
    expect(resolveGitHubTokenMock).not.toHaveBeenCalled();
  });

  test('uses the platform default when the repo config read throws (never throws itself)', async () => {
    process.env.GITHUB_TOKEN_SECRET_ARN = 'arn:platform-secret';
    loadRepoConfigMock.mockRejectedValue(new Error('DDB down'));
    resolveGitHubTokenMock.mockResolvedValue('ghp_platform');
    const token = await resolveRepoGithubToken('o/r');
    expect(token).toBe('ghp_platform');
  });

  test('returns undefined (never throws) when the secret is unreadable', async () => {
    loadRepoConfigMock.mockResolvedValue({ github_token_secret_arn: 'arn:repo-secret' });
    resolveGitHubTokenMock.mockRejectedValue(new Error('AccessDenied'));
    const token = await resolveRepoGithubToken('o/r');
    expect(token).toBeUndefined();
  });
});
