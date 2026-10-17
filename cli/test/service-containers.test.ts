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
import { CliError } from '../src/errors';
import {
  AGENT_CONTAINER_NAME,
  readServiceContainersFile,
  validateServiceContainers,
} from '../src/service-containers';

const CASES = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'contracts', 'service-containers', 'cases.json'),
  'utf-8',
)) as { cases: { name: string; config: unknown; valid?: boolean; errors?: string[] }[] };

describe('validateServiceContainers (contracts/service-containers/cases.json)', () => {
  test.each(CASES.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const errors = validateServiceContainers(c.config, AGENT_CONTAINER_NAME);
    if (c.valid) {
      expect(errors).toEqual([]);
    } else {
      for (const expected of c.errors ?? []) {
        expect(errors.join('\n')).toContain(expected);
      }
    }
  });
});

describe('readServiceContainersFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (content: string) => {
    const file = path.join(dir, 'services.json');
    fs.writeFileSync(file, content);
    return file;
  };

  test('returns a valid config', () => {
    const config = { containers: [{ name: 'redis', image: 'redis:7' }] };
    expect(readServiceContainersFile(write(JSON.stringify(config)))).toEqual(config);
  });

  test('lists every problem of an invalid config', () => {
    const file = write(JSON.stringify({ containers: [{ name: 'AgentContainer' }] }));
    expect(() => readServiceContainersFile(file)).toThrow(CliError);
    expect(() => readServiceContainersFile(file)).toThrow(/is reserved[\s\S]*image must be a non-empty string/);
  });

  test('rejects a file that is not JSON', () => {
    expect(() => readServiceContainersFile(write('containers: []'))).toThrow(/cannot read .* as JSON/);
  });
});
