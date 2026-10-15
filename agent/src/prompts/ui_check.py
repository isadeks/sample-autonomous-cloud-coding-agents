"""Agent-written UI checks (per-repo ``ui_checks_dir``).

When a repo's CI/CD deploys a preview and runs Playwright specs from the PR
against it, the agent is the one that knows what its change should look like.
This addendum asks it to write that check alongside the fix. The agent cannot
run it (no browser or server in its workspace); CI runs it on the preview and a
failure comes back through the in-session CI convergence loop like any red check.
"""

from __future__ import annotations

UI_CHECK_ADDENDUM = """

## UI check for your change (required for this repository)

This repository's CD deploys a preview of your pull request and runs the Playwright
UI checks you commit under `{ui_checks_dir}/`, with screenshots posted on the PR.
Write ONE focused check that demonstrates the user-visible effect of your change.

- File: `{ui_checks_dir}/<short-slug>.spec.ts` (Playwright Test; import only
  `@playwright/test` and files in that directory). Update the existing check if this
  task is a follow-up on the same feature.
- The preview starts EMPTY. Create the data the check needs through the app's own
  HTTP API in the test (log in with the admin account below and use its token), then
  drive the UI with `page` like a user would.
- Environment provided by CD: `PREVIEW_URL` (web base URL; also the Playwright
  `baseURL`), `PREVIEW_API_URL`, `PREVIEW_ADMIN_EMAIL`, `PREVIEW_ADMIN_PASSWORD`,
  `UI_CHECK_ASSETS` (a folder of sample JPEGs you may upload), `PREVIEW_IMPORT_DIR`
  (a folder the server can read, e.g. for external-library import paths; copy assets
  into subfolders of it), `UI_CHECK_SHOTS` (save screenshots here).
- Save 2-6 named screenshots that tell the story in order, e.g.
  `await page.screenshot({{ path: `${{process.env.UI_CHECK_SHOTS}}/01-before-delete.png` }})`.
  Names become captions: `NN-what-the-reader-sees.png`.
- Assert the behaviour the task asks for (`expect(...)`), not just that pages load.
  Keep it deterministic: wait for UI state with locators/`expect`, never fixed sleeps;
  well under 2 minutes.
- You cannot run it here (no browser or server in this workspace). Type-check what you
  can, keep it simple, and follow the repo's existing e2e conventions if it has any. If
  CI reports the UI check failing, read the error and fix the check or the code —
  whichever is wrong — and push again.
"""


def ui_check_addendum(ui_checks_dir: str) -> str:
    """The prompt section for a repo with agent-written UI checks ("" when off)."""
    d = (ui_checks_dir or "").strip().strip("/")
    if not d:
        return ""
    return UI_CHECK_ADDENDUM.format(ui_checks_dir=d)


TESTS_REQUIRED_ADDENDUM = """

## Tests (required for this repository)

Every behaviour change must come with tests in the project's OWN test suites, following
the conventions of the neighbouring tests:

- **Unit tests** next to the code you changed (look at the existing `*.spec.ts` /
  `*_test.*` files beside it and extend them, or add one in the same style).
- **An end-to-end test** in the repository's e2e suite for the user-visible behaviour, if
  the repo has one (for example `e2e/src/specs/...`), reusing its existing helpers.
- CI rejects a pull request that changes source files without changing project tests.
  Files under `.abca/` (such as the UI check above) do not count.
- e2e tests may need services you do not have here (e.g. Docker); write them carefully —
  CI runs them against a real server and reports failures back to you.
"""


def tests_required_addendum(required: bool) -> str:
    """The prompt section for a repo that requires project tests ("" when off)."""
    return TESTS_REQUIRED_ADDENDUM if required else ""
