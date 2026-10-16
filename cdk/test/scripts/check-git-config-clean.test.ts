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

/**
 * Tests for `scripts/check-git-config-clean.mjs` — LAYER 3 of the structural
 * git-fixture isolation (#855).
 *
 * WHY THESE EXIST: this is a GATE, and a gate whose rejection pattern silently
 * stops matching becomes a no-op that still prints "OK". The only way to trust it
 * is to make it fail on purpose, so every test below asserts a real non-zero exit
 * with the expected report.
 *
 * HOW: the script is a CLI that resolves the config via `git rev-parse
 * --git-common-dir`, so it is exercised the way it really runs — spawned with its
 * cwd inside a throwaway repo built in a temp dir. That covers the real resolution
 * path rather than a re-implementation of it, and means the real `.git/config` of
 * this checkout is never read (let alone written).
 *
 * WHY THIS LIVES UNDER `cdk/test/` for a ROOT-level script: there is no test tree
 * at the repo root, and `scripts/` is a monorepo-CI area (AGENTS.md routing table,
 * "Monorepo CI / tasks" row). `cdk/` is the only workspace whose Jest runner can
 * reach `../../scripts`, so this mirrors the deliberate placement already used by
 * `check-constants-sync.test.ts`.
 *
 * Every `git` invocation here passes an env with the GIT_* location vars dropped —
 * the same containment the Python side gets from `tests.git_isolation` — so these
 * tests cannot themselves become the fifth recurrence of the bug they guard.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-git-config-clean.mjs');

/** Mirrors GIT_LOCATION_VARS in agent/tests/git_isolation.py. */
const GIT_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * An environment in which git cannot escape `home`.
 *
 * Dropping the location vars FIRST is load-bearing: an inherited GIT_DIR overrides
 * repository discovery outright, so it defeats cwd, HOME and the GIT_CONFIG_* pins
 * simultaneously — `git init` in the temp dir would re-init THIS repo.
 */
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of GIT_LOCATION_VARS) delete env[v];
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-test'),
    GIT_CONFIG_SYSTEM: os.devnull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'ABCA Test',
    GIT_AUTHOR_EMAIL: 'abca-test@example.invalid',
    GIT_COMMITTER_NAME: 'ABCA Test',
    GIT_COMMITTER_EMAIL: 'abca-test@example.invalid',
  };
}

interface RunResult {
  readonly status: number;
  readonly output: string;
}

/** Build a throwaway repo, let `mutate` write its config, then run the gate in it. */
function runInRepo(mutate: (repo: string, configPath: string) => void): RunResult & { configPath: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-git-config-clean-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo, env: isolatedEnv(repo) });
    const configPath = path.join(repo, '.git', 'config');
    mutate(repo, configPath);
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: repo,
      env: isolatedEnv(repo),
      encoding: 'utf8',
    });
    return {
      status: r.status ?? -1,
      output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      configPath,
    };
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

/** Append raw text to the repo's config (covers hand-edited shapes git never writes). */
function appendConfig(configPath: string, text: string): void {
  fs.appendFileSync(configPath, text);
}

describe('check-git-config-clean (#855 layer 3)', () => {
  describe('rejects a polluted config', () => {
    it('fails on core.worktree and prints the copy-pasteable unset remedy', () => {
      const { status, output, configPath } = runInRepo((repo, cfg) => {
        appendConfig(cfg, `\tworktree = ${path.join(repo, 'elsewhere')}\n`);
      });

      expect(status).toBe(1);
      expect(output).toContain('core.worktree');
      // The remedy must name the resolved file, so it can be pasted as-is.
      expect(output).toContain(`git config --file ${configPath} --unset-all core.worktree`);
      // And explain WHY it is blocking — a redirected primary checkout is the
      // failure that makes `git revert` appear to succeed while changing nothing.
      expect(output).toContain('REDIRECTS the primary checkout');
    });

    it('fails on a [user] section and prints the remove-section remedy', () => {
      const { status, output, configPath } = runInRepo((_repo, cfg) => {
        appendConfig(cfg, '[user]\n\tname = t\n\temail = t@t\n');
      });

      expect(status).toBe(1);
      expect(output).toContain('user-section');
      expect(output).toContain(`git config --file ${configPath} --remove-section user`);
      // A repo-local identity ALWAYS shadows ~/.gitconfig — global identity is
      // not a backstop, which is the part people get wrong.
      expect(output).toContain('shadows ~/.gitconfig');
    });

    it('reports BOTH remedies when the config carries both fingerprints', () => {
      const { status, output, configPath } = runInRepo((repo, cfg) => {
        appendConfig(cfg, `\tworktree = ${path.join(repo, 'elsewhere')}\n[user]\n\tname = t\n`);
      });

      expect(status).toBe(1);
      expect(output).toContain('--unset-all core.worktree');
      expect(output).toContain('--remove-section user');
      expect(output).toContain(configPath);
    });

    it('points at the fix, not just the symptom', () => {
      const { status, output } = runInRepo((_repo, cfg) => {
        appendConfig(cfg, '[user]\n\temail = t@t\n');
      });

      expect(status).toBe(1);
      // Without this the developer un-does the damage and the fixture re-does it
      // on the next pre-push run.
      expect(output).toContain('isolated_git_env');
      expect(output).toContain('agent/tests/git_isolation.py');
    });

    it('catches a [user "sub"] subsection form too', () => {
      // `git config` writes the bare `[user]` header, but accept the subsection
      // form so a hand-edit cannot slip past the gate.
      const { status, output } = runInRepo((_repo, cfg) => {
        appendConfig(cfg, '[user "work"]\n\temail = t@t\n');
      });

      expect(status).toBe(1);
      expect(output).toContain('user-section');
    });
  });

  describe('accepts a clean config', () => {
    it('passes on a freshly-initialised repo', () => {
      const { status, output } = runInRepo(() => {
        /* leave the config exactly as `git init` wrote it */
      });

      expect(status).toBe(0);
      expect(output).toContain('OK');
    });

    it('does not mistake a [remote]/[branch] config for pollution', () => {
      // The realistic shape of this repository's own config: remotes, a branch,
      // a credential helper. None of it is a violation, and a false positive here
      // would block every commit in the repo.
      const { status } = runInRepo((_repo, cfg) => {
        appendConfig(
          cfg,
          '[remote "origin"]\n\turl = https://example.invalid/r.git\n' +
            '\tfetch = +refs/heads/*:refs/remotes/origin/*\n' +
            '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n' +
            '[credential]\n\thelper = !gh auth git-credential\n',
        );
      });

      expect(status).toBe(0);
    });

    it('does not flag a `worktree` key that belongs to another section', () => {
      // Only `core.worktree` redirects the checkout. A same-named key under an
      // unrelated section must not redden the gate.
      const { status } = runInRepo((_repo, cfg) => {
        appendConfig(cfg, '[submodule "x"]\n\tworktree = /somewhere\n');
      });

      expect(status).toBe(0);
    });
  });

  describe('is safe to run anywhere', () => {
    it('exits 0 with an explanatory line outside a git repository', () => {
      // Tarball exports and `.git`-less CI checkouts must not fail the build; the
      // gate has nothing to check there. Fail-open is correct ONLY for this case.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abca-no-repo-'));
      try {
        const r = spawnSync(process.execPath, [SCRIPT], {
          cwd: dir,
          // GIT_CEILING_DIRECTORIES stops discovery from walking up out of the
          // temp dir into whatever repo may contain TMPDIR.
          env: { ...isolatedEnv(dir), GIT_CEILING_DIRECTORIES: path.dirname(dir) },
          encoding: 'utf8',
        });
        expect(r.status).toBe(0);
        expect(`${r.stdout}${r.stderr}`).toContain('not a git checkout');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
