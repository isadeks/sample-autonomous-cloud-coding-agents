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
import { Command } from 'commander';
import { formatJson } from '../format';

/**
 * Resolve the CLI version from the package manifest.
 *
 * The manifest lives at ``cli/package.json``, two directories above this
 * module in both the TypeScript source tree (``src/commands``) and the
 * compiled output (``lib/commands``), so ``../../package.json`` resolves
 * correctly under ts-jest and from the published ``lib`` bin alike. We read
 * it at runtime rather than importing it so the version reported always
 * matches the installed package and the compiled ``lib`` layout stays flat
 * (no ``package.json`` copied under ``rootDir``).
 */
export function getCliVersion(): string {
  const manifestPath = path.join(__dirname, '..', '..', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    version?: string;
  };
  return manifest.version ?? '0.0.0';
}

/**
 * `bgagent version [--output text|json]` — print the installed CLI version,
 * read from ``package.json``. Mirrors the root ``--version`` flag as an
 * explicit subcommand so scripts can query it uniformly (and in JSON).
 */
export function makeVersionCommand(): Command {
  return new Command('version')
    .description('Print the bgagent CLI version')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action((opts: { output: string }) => {
      const version = getCliVersion();
      if (opts.output === 'json') {
        console.log(formatJson({ version }));
        return;
      }
      console.log(version);
    });
}
