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

/**
 * Printed by ``--version`` when ``package.json`` cannot be read or carries no
 * ``version`` field. Deliberately not a plausible semver: a bug report quoting
 * ``unknown`` says "this build could not report its version", whereas a
 * fabricated ``0.0.0`` reads as a real (and wrong) answer.
 */
export const UNKNOWN_VERSION = 'unknown';

/**
 * Package manifest read at runtime instead of imported.
 *
 * ``tsconfig.json`` sets ``rootDir: "src"``, so a static
 * ``import { version } from '../../package.json'`` would place the manifest
 * outside the compilation root and fail ``tsc`` (TS6059). Reading it relative
 * to ``__dirname`` resolves to ``cli/package.json`` from both the compiled
 * entrypoint (``lib/version.js`` → ``lib/../package.json``) and from ts-jest
 * (``src/version.ts`` → ``src/../package.json``), and ``package.json`` is
 * always shipped by npm regardless of the ``files`` whitelist.
 */
export const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');

/**
 * Resolve the CLI version from ``cli/package.json``.
 *
 * Single source of truth: the manifest. Keeping a string literal in the
 * Commander setup let ``--version`` drift from the published version
 * (see issue #913), so the literal is gone.
 *
 * @param manifestPath manifest to read; defaults to this package's
 * ``package.json`` and is overridden only by tests, which need real files on
 * disk because the ``fs`` exports are not spy-able under ts-jest.
 * @returns the manifest ``version``, or {@link UNKNOWN_VERSION} when the
 * manifest is missing, unreadable, or has no usable ``version`` field.
 */
export function resolveCliVersion(manifestPath: string = PACKAGE_JSON_PATH): string {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch {
    // Degraded mode, not masking: an unreadable manifest must not stop the
    // CLI from running commands, and the caller is told the version is
    // unknown rather than handed a plausible number.
    return UNKNOWN_VERSION;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNKNOWN_VERSION;
  }

  const version = (parsed as { version?: unknown } | null)?.version;
  return typeof version === 'string' && version.length > 0 ? version : UNKNOWN_VERSION;
}
