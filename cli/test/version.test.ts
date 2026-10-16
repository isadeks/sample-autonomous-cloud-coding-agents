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
import * as os from 'os';
import * as path from 'path';
import { PACKAGE_JSON_PATH, resolveCliVersion, UNKNOWN_VERSION } from '../src/version';

const PACKAGE_JSON = path.join(__dirname, '..', 'package.json');

/**
 * ``--version`` used to print the literal ``'0.0.0'`` hardcoded in
 * ``src/bin/bgagent.ts``, a second copy of the manifest version that silently
 * drifted from it (issue #913). These tests pin the single-source-of-truth
 * behaviour so the literal cannot come back.
 */
describe('resolveCliVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-version-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a throwaway manifest and return its path. */
  const writeManifest = (contents: string): string => {
    const target = path.join(tmpDir, 'package.json');
    fs.writeFileSync(target, contents);
    return target;
  };

  it('defaults to this package manifest and returns its version', () => {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };

    // Guards the actual bug: the reported version must track the manifest,
    // whatever the manifest happens to say — no second copy of the string.
    expect(resolveCliVersion()).toBe(manifest.version);
    expect(PACKAGE_JSON_PATH).toBe(PACKAGE_JSON);
  });

  it('reads the version from the manifest rather than a literal', () => {
    // A version the source has never contained: only a real read can produce it.
    expect(resolveCliVersion(writeManifest('{"version":"1.2.3-rc.4"}'))).toBe('1.2.3-rc.4');
  });

  it('reports "unknown" when the manifest cannot be read', () => {
    expect(resolveCliVersion(path.join(tmpDir, 'absent', 'package.json'))).toBe(UNKNOWN_VERSION);
  });

  it('reports "unknown" when the manifest is not valid JSON', () => {
    expect(resolveCliVersion(writeManifest('{ not json'))).toBe(UNKNOWN_VERSION);
  });

  it.each([
    ['no version field', '{}'],
    ['empty version', '{"version":""}'],
    ['non-string version', '{"version":1}'],
    ['null manifest', 'null'],
  ])('reports "unknown" when the manifest has %s', (_label, contents) => {
    expect(resolveCliVersion(writeManifest(contents))).toBe(UNKNOWN_VERSION);
  });
});

describe('bgagent --version wiring', () => {
  it('registers the resolved version on the program, not a literal', () => {
    // The entrypoint guards execution behind ``require.main === module``, so
    // importing it is side-effect free and the Commander program is not built
    // for inspection. Assert on the source instead: no version string literal
    // may reappear next to ``.version(``.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'bin', 'bgagent.ts'), 'utf8');

    expect(source).toContain('.version(resolveCliVersion())');
    expect(source).not.toMatch(/\.version\(\s*['"`]/);
  });
});
