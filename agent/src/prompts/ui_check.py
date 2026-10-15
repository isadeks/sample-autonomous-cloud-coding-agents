"""Agent-written UI checks (per-repo ``ui_checks_dir``).

The repository's CD runs the checks committed under ``ui_checks_dir`` against a
preview of the pull request and reports the result as a CI status, which the
in-session CI convergence loop feeds back like any other red check. The check
format and the preview's environment are the repository's contract, not the
platform's: they belong in the repo's ``system_prompt_overrides``.
"""

from __future__ import annotations

UI_CHECK_ADDENDUM = """

## UI check for your change (required for this repository)

This repository's CD runs the UI checks committed under `{ui_checks_dir}/` against a
preview of your pull request and reports the result on the PR.

- Add ONE focused check under `{ui_checks_dir}/` that demonstrates the user-visible
  effect of your change, following the repository's conventions for these checks (see
  the additional instructions above and any existing checks in that directory). Update
  the existing check instead if this task follows up on the same feature.
- Assert the behaviour the task asks for, not just that pages load. Wait for UI state
  instead of sleeping for fixed times.
- If the CD provides a screenshot directory in the `UI_CHECK_SHOTS` environment
  variable, save a few named screenshots there that tell the story in order
  (`NN-what-the-reader-sees.png`).
- You may not be able to run the check in this workspace. If CI reports it failing,
  read the error, fix the check or the code (whichever is wrong) and push again.
"""


def ui_check_addendum(ui_checks_dir: str) -> str:
    """The prompt section for a repo with agent-written UI checks ("" when off)."""
    d = ui_checks_dir.strip().strip("/")
    return UI_CHECK_ADDENDUM.format(ui_checks_dir=d) if d else ""
