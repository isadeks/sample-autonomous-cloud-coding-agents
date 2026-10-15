"""Keep shell commands from changing tests that existed before the task.

The ``modify_existing_test`` Cedar rule gates the Write/Edit tools, but an
agent can just as well rewrite a file from Bash (``python - <<EOF``, ``sed -i``,
a formatter). Matching shell text is leaky, so this guard checks the EFFECT
instead: after every Bash call it compares the protected test files (those on
the PR's base) with what they may legitimately contain, restores any change,
and tells the agent to use the Edit tool — which goes through human approval —
or to add its tests in new files.
"""

from __future__ import annotations

import os
import subprocess
from fnmatch import fnmatch

from shell import log

# Per git call; the guard runs after every Bash tool call, so it must stay fast.
_GIT_TIMEOUT_S = 30

# Paths treated as tests or test configuration. Keep in sync with the
# modify_existing_test rule in agent/policies/soft_deny.cedar (tests/test_test_guard.py checks).
TEST_PATH_GLOBS = (
    "*.spec.*",
    "*.test.*",
    "*_test.*",
    "*/test_*.py",
    "test/*",
    "tests/*",
    "*/test/*",
    "*/tests/*",
    "*/__tests__/*",
    "e2e/*",
    "*/e2e/*",
    "*e2e-spec*",
    "*vitest.config*",
    "*playwright.config*",
    "*jest.config*",
)

REVERT_NOTICE = (
    "ABCA restored {files}: changing a test that existed before this task needs a human's "
    "approval, and shell commands bypass that. If the existing test really must change, edit it "
    "with the Edit tool (that requests approval); otherwise add your tests in new files."
)


def is_test_path(rel_path: str) -> bool:
    return any(fnmatch(rel_path, pattern) for pattern in TEST_PATH_GLOBS)


class ExistingTestGuard:
    """Restores shell-made changes to tests that existed on the PR's base."""

    def __init__(self, repo_root: str, files_at_base: frozenset[str]) -> None:
        self._root = repo_root
        self._protected = frozenset(p for p in files_at_base if is_test_path(p))
        self._start = self._git("rev-parse", "HEAD").strip()
        # Content a human approved through the Edit/Write gate, by repo path.
        self._approved: dict[str, bytes | None] = {}

    @property
    def active(self) -> bool:
        return bool(self._protected and self._start)

    def record_tool_write(self, file_path: str) -> None:
        """After an Edit/Write (which passed the approval gate), accept the file's new content."""
        rel = self._relative(file_path)
        if rel in self._protected:
            self._approved[rel] = self._read(rel)

    def after_shell(self) -> list[str]:
        """Restore protected tests a shell command changed; return the restored paths."""
        if not self.active:
            return []
        changed = self._git("diff", "--name-only", self._start).splitlines()
        restored = []
        for rel in (p for p in changed if p in self._protected):
            expected = self._approved[rel] if rel in self._approved else self._at_start(rel)
            if self._read(rel) != expected:
                self._write(rel, expected)
                restored.append(rel)
        if restored:
            log(
                "POLICY",
                f"restored existing test file(s) changed from the shell: {', '.join(restored)}",
            )
        return restored

    def _git(self, *args: str) -> str:
        out = self._git_bytes(*args)
        return out.decode("utf-8", "replace") if out is not None else ""

    def _git_bytes(self, *args: str) -> bytes | None:
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=self._root,
                capture_output=True,
                timeout=_GIT_TIMEOUT_S,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            log("WARN", f"test guard: git {args[0]} failed: {type(exc).__name__}")
            return None
        return result.stdout if result.returncode == 0 else None

    def _at_start(self, rel: str) -> bytes | None:
        return self._git_bytes("show", f"{self._start}:{rel}")

    def _relative(self, file_path: str) -> str:
        full = os.path.normpath(os.path.join(self._root, file_path))
        rel = os.path.relpath(full, os.path.normpath(self._root))
        return "" if rel.startswith("..") else rel

    def _read(self, rel: str) -> bytes | None:
        path = os.path.join(self._root, rel)
        if not os.path.isfile(path):
            return None
        with open(path, "rb") as f:
            return f.read()

    def _write(self, rel: str, content: bytes | None) -> None:
        path = os.path.join(self._root, rel)
        if content is None:
            if os.path.isfile(path):
                os.remove(path)
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(content)
