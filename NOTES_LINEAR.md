# NOTES_LINEAR.md

`cli/src/commands/linear.ts` builds the `bgagent linear` Commander sub-command tree that operators use to wire a Linear workspace into ABCA.

- `app-template` — prints the field values to paste into Linear's OAuth app form (bot name must end in `[bot]` for `actor=app`).
- `webhook-info` — prints the stack's `/linear/webhook` URL and the Linear webhook settings to use.
- `setup <slug>` — full OAuth wizard: reads CloudFormation outputs, prompts for client id/secret, runs the PKCE browser flow via a localhost callback, stores the token bundle in a per-workspace Secrets Manager secret, writes the workspace registry row (incl. team keys), resolves/preserves the webhook signing secret, and runs the self-link picker.
- `add-workspace <slug>` — same flow for an additional workspace, reusing the existing OAuth app credentials and refusing duplicate registry rows.
- `update-webhook-secret <slug>` — swaps just the signing secret in an existing bundle, no OAuth re-run.
- `invite-user <slug>` / `link <code>` — two-party handshake mapping a Linear user to a platform (Cognito) user via a 24h `pending#<code>` row.
- `onboard-project <uuid>` — maps a Linear project to a GitHub repo with a trigger label and optional auto-decomposition caps.
- `list-projects` — lists Linear projects (with full UUIDs) across installed workspaces.

Supporting helpers: `openBrowser`, `promptLine`, `upsertOauthSecret`, `isWebhookSecretConfigured`, `findReusableOauthAppCredentials`, `getStackOutput`, `extractCognitoSub`, and Linear GraphQL queries for identity, team keys and workspace members.
