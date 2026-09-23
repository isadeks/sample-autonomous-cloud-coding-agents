#!/usr/bin/env node
// LAYER 3 of the structural git-config isolation (#855): refuse.
//
// Fails if the SHARED `.git/config` contains a `core.worktree` entry or a
// `[user]` section — the two fingerprints a leaked test fixture leaves behind
// when the test process inherited a GIT_DIR (which git exports to hooks in a
// linked worktree, i.e. every `prek` pre-push run from `.worktrees/`).
//
// Why BOTH hook stages, per the issue:
//   * pre-commit  — catches it BEFORE a mis-attributed commit is created. A
//                   repo-local `[user]` ALWAYS shadows ~/.gitconfig; global
//                   identity is not a backstop, so the commit would land as
//                   whatever the fixture wrote.
//   * pre-push    — catches whatever the hook-run test suite just wrote, since
//                   the leak happens DURING the pre-push test run itself.
//
// Why `core.worktree` is the more dangerous of the two: in a non-bare repo it
// redirects the primary checkout. `git status` reports a foreign branch, real
// untracked files vanish from the listing, and `git checkout --` / `git revert`
// operate on the OTHER tree and still exit 0 — a revert can appear to succeed
// while changing nothing.
//
// Resolution uses `--git-common-dir`, never `--show-toplevel`: `core.worktree`
// changes what the latter returns, so an already-polluted repo would make this
// check compute a path that does not exist and report "clean" — the pollution
// would disable its own detector.
//
// Run: node scripts/check-git-config-clean.mjs   (via `mise run check:git-config-clean`)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Section headers may be `[user]` or the subsection form `[user "x"]`; `git
// config` writes the former, but accept both so a hand-edit cannot slip past.
const USER_SECTION = /^\s*\[\s*user\b/im;
// Matches `worktree = ...` inside [core] — and the one-line `[core] worktree=`
// form git itself never writes but accepts.
const CORE_WORKTREE = /^\s*worktree\s*=/im;

/** Absolute path of the shared .git/config, or null when not in a repo. */
function sharedConfigPath() {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return common ? join(common, 'config') : null;
  } catch {
    return null; // not a git repo (tarball export, CI checkout without .git)
  }
}

/** Split an INI-ish git config into `{ name, lines }` sections. */
function sections(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]\s]+)/.exec(line);
    if (header) {
      current = { name: header[1].toLowerCase(), lines: [line] };
      out.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

export function findViolations(text) {
  const violations = [];
  for (const section of sections(text)) {
    if (section.name === 'user') {
      violations.push({
        kind: 'user-section',
        detail: section.lines.filter((l) => l.trim()).join('\n'),
      });
    }
    if (section.name === 'core') {
      for (const line of section.lines.slice(1)) {
        if (CORE_WORKTREE.test(line)) {
          violations.push({ kind: 'core.worktree', detail: line.trim() });
        }
      }
    }
    // One-line `[core] worktree = x` form.
    if (section.name === 'core' && CORE_WORKTREE.test(section.lines[0].replace(/^\s*\[[^\]]*\]/, ''))) {
      violations.push({ kind: 'core.worktree', detail: section.lines[0].trim() });
    }
  }
  // Belt-and-suspenders for a `[user]` header this parser somehow missed.
  if (USER_SECTION.test(text) && !violations.some((v) => v.kind === 'user-section')) {
    violations.push({ kind: 'user-section', detail: '[user]' });
  }
  return violations;
}

export function main() {
  const path = sharedConfigPath();
  if (path === null || !existsSync(path)) {
    console.log('check:git-config-clean — not a git checkout, nothing to check.');
    return 0;
  }

  const violations = findViolations(readFileSync(path, 'utf8'));
  if (violations.length === 0) {
    console.log(`check:git-config-clean — OK (${path} has no core.worktree and no [user] section).`);
    return 0;
  }

  console.error(`\n✖ ${path} was polluted by a leaked git fixture (#855):\n`);
  for (const v of violations) {
    console.error(`  ${v.kind}:`);
    for (const line of v.detail.split('\n')) console.error(`    ${line.trim()}`);
  }
  console.error(
    '\nWhy this is blocking:\n' +
      '  core.worktree  — in a non-bare repo this REDIRECTS the primary checkout. `git status`\n' +
      '                   reports a foreign branch and `git checkout --` / `git revert` operate on\n' +
      '                   the other tree while still exiting 0.\n' +
      '  [user]         — a repo-local identity ALWAYS shadows ~/.gitconfig, so every commit made\n' +
      '                   from here is mis-attributed.\n' +
      '\nRemedy (copy-paste):\n' +
      (violations.some((v) => v.kind === 'core.worktree')
        ? `  git config --file ${path} --unset-all core.worktree\n`
        : '') +
      (violations.some((v) => v.kind === 'user-section')
        ? `  git config --file ${path} --remove-section user\n`
        : '') +
      '\nThen fix the fixture that wrote it: build its subprocess environment with\n' +
      '`tests.git_isolation.isolated_git_env(<tmp repo>)` (agent/tests/git_isolation.py).\n',
  );
  return 1;
}

// Only act as a CLI when executed directly, so the checks above stay unit-testable.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
