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

import * as fs from 'fs';
import * as path from 'path';
import { getCliVersion, makeVersionCommand } from '../../src/commands/version';

describe('version command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  // The version reported must match the single source of truth: the
  // package manifest. Reading it here (rather than hardcoding) keeps the
  // test correct across version bumps.
  const packageVersion = (
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'package.json'),
        'utf-8',
      ),
    ) as { version: string }
  ).version;

  beforeEach(() => {
    process.exitCode = undefined;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  test('getCliVersion returns the package.json version', () => {
    expect(getCliVersion()).toBe(packageVersion);
  });

  test('prints the plain version in text mode (default)', async () => {
    await makeVersionCommand().parseAsync(['node', 'version']);
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(packageVersion);
  });

  test('prints a JSON object with --output json', async () => {
    await makeVersionCommand().parseAsync(['node', 'version', '--output', 'json']);
    const out = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(JSON.parse(out)).toEqual({ version: packageVersion });
  });
});
