"""Per-repo requirements appended to writable workflows' system prompts."""

from __future__ import annotations

TESTS_REQUIRED_ADDENDUM = """

## Tests (required for this repository)

This repository requires every behaviour change to come with tests in the project's
own test suites, following the conventions of the neighbouring tests:

- **Unit tests** next to the code you changed: extend the existing test file beside it,
  or add one in the same style.
- **An end-to-end test** in the repository's e2e suite for the user-visible behaviour,
  if the repository has one, reusing its existing helpers.
- If an e2e test needs services this workspace does not have, write it carefully and
  rely on CI to run it; failures are reported back to you.
"""
