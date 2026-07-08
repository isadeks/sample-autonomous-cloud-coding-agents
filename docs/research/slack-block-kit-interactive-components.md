# Slack Block Kit interactive components — findings note

**Issue:** ABCA-663 (sub-issue of ABCA-659 "slack parity with linear")
**Date:** 2026-07-08
**Purpose:** Verify that the Slack Block Kit components required for the multi-repo context / repo-picker UI exist and behave as assumed. Documents exact payload schemas, constraints, and design adjustments needed before implementation (sub-issue #3).

---

## Summary

All four required component types exist and are confirmed supported:

| Component | Supported | Key constraint |
|---|---|---|
| `static_select` element | ✅ | Max 100 options; option text ≤75 chars, value ≤150 chars |
| `button` in `actions` block | ✅ | Both URL-link and `action_id` callback styles work |
| Modal views (`views.open`) | ✅ | Requires `trigger_id` (3-second window); max 100 blocks, title ≤24 chars |
| Ephemeral messages with Block Kit | ✅ | Fully support `blocks`; cannot be updated via `chat.update` |

---

## 1. `static_select` element

### Complete field schema

```typescript
interface StaticSelectElement {
  type: 'static_select';
  action_id?: string;           // max 255 chars; used to route in block_actions
  placeholder?: PlainText;      // max 150 chars on .text
  options?: Option[];           // EITHER options OR option_groups; max 100 entries
  option_groups?: OptionGroup[];
  initial_option?: Option;      // pre-selected option (must match an item in options)
  confirm?: ConfirmDialog;
  focus_on_load?: boolean;      // auto-focus; only one per view
}

interface Option {
  text: PlainText;              // max 75 chars (VISIBLE LABEL)
  value: string;                // max 150 chars (MACHINE KEY — this is what arrives in the payload)
  description?: PlainText;      // max 75 chars
}
```

### Constraints summary

| Constraint | Limit |
|---|---|
| Max options (flat `options` array) | **100** |
| Max option groups (`option_groups`) | **100** groups |
| Option `text` (label) max | **75 characters** |
| Option `value` (key) max | **150 characters** |
| `placeholder` text max | **150 characters** |
| `action_id` max | **255 characters** |

For a repo picker with org/repo names, 75-char labels and 150-char values are well within typical bounds. Workspaces with >100 repos will need either `option_groups` (grouped by owner) or a filtered/paginated approach (external_select instead of static_select).

### Surface compatibility

`static_select` works inside:
- `actions` block → sends `block_actions` payload immediately on selection
- `section` block (as `accessory`) → sends `block_actions` immediately
- `input` block inside a modal → value collected on `view_submission` (no immediate callback unless `dispatch_action: true`)

---

## 2. Button element

### Complete field schema

```typescript
interface ButtonElement {
  type: 'button';
  text: PlainText;              // max 75 chars; ~30 chars visible in UI
  action_id?: string;           // max 255 chars
  url?: string;                 // max 3000 chars; opens browser AND still sends block_actions
  value?: string;               // max 2000 chars; included in block_actions payload
  style?: 'primary' | 'danger';
  confirm?: ConfirmDialog;
  accessibility_label?: string; // max 75 chars
}
```

### Key behaviours

- **`action_id`-only button** (no `url`): clicking sends a `block_actions` payload with `type: "button"`, `action_id`, `value`, and `block_id`.
- **`url` button** (e.g. current "View PR" button): opens the URL in the browser AND still sends a `block_actions` payload — the app must acknowledge with HTTP 200.
- The existing `dangerButton` pattern in `slack-blocks.ts` (with `confirm` dialog) is correct and reusable for destructive actions.

### Current usage in this codebase

`slack-blocks.ts` already defines `LinkButtonElement` and `ActionButtonElement` types and exports `ActionsBlock`. The Cancel button in `sessionStartedMessage` uses `dangerButton()` with `action_id: "cancel_task:<task_id>"`.

---

## 3. Modal views

### Opening a modal

Requires a **`trigger_id`** from an interaction event. The `trigger_id` expires **3 seconds** after Slack delivers the interaction to your endpoint.

```
POST https://slack.com/api/views.open
{
  "trigger_id": "<from interaction payload>",
  "view": { ... }
}
```

Trigger IDs are present in:
- Slash command payloads (the `trigger_id` field in `SlackCommandPayload`)
- `block_actions` payloads (from any button/select interaction)
- Global shortcuts and message shortcuts

### View object fields

```typescript
interface ModalView {
  type: 'modal';
  title: PlainText;             // max 24 chars — tight!
  blocks: SlackBlock[];         // max 100 blocks
  submit?: PlainText;           // max 24 chars; required when input blocks present
  close?: PlainText;            // max 24 chars; Cancel button label
  callback_id?: string;         // max 255 chars; used to route view_submission
  private_metadata?: string;    // max 3000 chars; opaque string returned in submission
  clear_on_close?: boolean;
  notify_on_close?: boolean;    // if true, sends view_closed payload on Cancel
  submit_disabled?: boolean;
}
```

### `view_submission` payload

When the user clicks Submit, your endpoint receives:

```json
{
  "type": "view_submission",
  "team": { "id": "T...", "domain": "..." },
  "user": { "id": "U...", "username": "..." },
  "view": {
    "id": "V...",
    "type": "modal",
    "callback_id": "repo_picker_setup",
    "private_metadata": "{ \"team_id\": \"T...\", \"user_id\": \"U...\" }",
    "state": {
      "values": {
        "<block_id>": {
          "<action_id>": {
            "type": "static_select",
            "selected_option": {
              "text": { "type": "plain_text", "text": "owner/repo" },
              "value": "owner/repo"
            }
          }
        }
      }
    }
  }
}
```

`state.values` is a two-level dict: `block_id → action_id → { type, selected_option | value | ... }`.

### Response actions

Your endpoint must respond within **3 seconds**:

| Response body | Effect |
|---|---|
| `{}` (empty) | Close modal |
| `{ "response_action": "errors", "errors": { "<block_id>": "msg" } }` | Show validation errors |
| `{ "response_action": "update", "view": { ... } }` | Replace current view |
| `{ "response_action": "clear" }` | Close entire modal stack |

### Critical constraint: trigger_id window

**Current architecture problem:** `slack-commands.ts` immediately async-invokes the processor Lambda via `Event` (fire-and-forget). The `trigger_id` from the slash command payload is forwarded in the event, but by the time the processor Lambda starts executing, the 3-second window is likely expired.

**Design adjustment needed:** For `/bgagent setup`, either:
1. Open the modal **synchronously in `slack-commands.ts`** (call `views.open` before responding), and use the Lambda response to populate the view dynamically — feasible within 3 seconds.
2. Don't use a modal for the initial command response; instead send an ephemeral message with a "Pick repo" button that opens the modal on click (the button click generates a fresh `trigger_id`).

Option 2 is lower-risk and more resilient to Lambda cold starts.

---

## 4. Ephemeral messages

Sent via `chat.postEphemeral`. Only visible to one user.

### Key properties

- **Fully support Block Kit `blocks`** including `static_select` and `button` elements with `action_id` callbacks.
- Interactions from ephemeral messages generate **`block_actions` payloads** (verified by docs). However, `response_url` is **not included** in the `block_actions` payload when the source is ephemeral.
- **Cannot be updated** via `chat.update` — `chat.postEphemeral` returns a `message_ts` but it's not a real database timestamp.
- **Not persistent** — vanishes when the user's session ends or on app restart.
- Delivery not guaranteed if the user is offline.

### Sending an ephemeral message with blocks

```json
POST chat.postEphemeral
{
  "channel": "C...",
  "user": "U...",
  "text": "Choose a repo to configure",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "Select a default repo for this channel:" }
    },
    {
      "type": "actions",
      "block_id": "repo_picker_actions",
      "elements": [
        {
          "type": "static_select",
          "action_id": "select_default_repo",
          "placeholder": { "type": "plain_text", "text": "Pick a repo..." },
          "options": [
            { "text": { "type": "plain_text", "text": "org/repo-a" }, "value": "org/repo-a" },
            { "text": { "type": "plain_text", "text": "org/repo-b" }, "value": "org/repo-b" }
          ]
        }
      ]
    }
  ]
}
```

---

## 5. Interaction callback routing through `slack-interactions.ts`

### Current handler

The existing `slack-interactions.ts` only handles `block_actions` with `action_id.startsWith('cancel_task:')`. The `SlackInteractionPayload` interface is narrow.

### What needs extending

```typescript
// Current (narrow)
interface SlackInteractionPayload {
  readonly type: string;   // only "block_actions" handled
  readonly user: { ... };
  readonly actions?: ReadonlyArray<{
    readonly action_id: string;
    readonly block_id: string;
    readonly value?: string;
    // ⚠️  Missing: selected_option for static_select
  }>;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly channel?: { readonly id: string };
  // ⚠️  Missing: view (for modal-origin block_actions)
}
```

**For repo-picker implementation, the interface needs:**

```typescript
interface SlackInteractionPayload {
  readonly type: 'block_actions' | 'view_submission' | 'view_closed';
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  // For block_actions:
  readonly actions?: ReadonlyArray<{
    readonly action_id: string;
    readonly block_id: string;
    readonly value?: string;
    readonly selected_option?: {         // present for static_select actions
      readonly text: { readonly type: string; readonly text: string };
      readonly value: string;
    };
    readonly action_ts?: string;
  }>;
  readonly response_url?: string;        // optional — absent for modal-origin actions and ephemeral sources
  readonly trigger_id?: string;          // use to open a follow-up modal
  readonly channel?: { readonly id: string };
  readonly view?: {                      // present for modal-origin block_actions and view_submission
    readonly id: string;
    readonly callback_id?: string;
    readonly private_metadata?: string;
    readonly state?: {
      readonly values: Record<string, Record<string, {
        readonly type: string;
        readonly selected_option?: { readonly text: { type: string; text: string }; value: string };
        readonly value?: string;         // plain_text_input
      }>>;
    };
  };
}
```

### Routing pattern

```typescript
if (payload.type === 'block_actions' && payload.actions) {
  for (const action of payload.actions) {
    if (action.action_id.startsWith('cancel_task:')) {
      await handleCancelAction(payload, action.action_id);
    } else if (action.action_id === 'select_default_repo') {
      await handleRepoSelected(payload, action);
    }
  }
} else if (payload.type === 'view_submission') {
  if (payload.view?.callback_id === 'repo_picker_setup') {
    await handleSetupModalSubmission(payload);
  }
}
```

Both `block_actions` and `view_submission` arrive at the same endpoint (`POST /v1/slack/interactions`) — Slack sends all interaction types there.

---

## 6. Design adjustments for sub-issue #3

### A. Repo picker UI — recommended approach

1. **Trigger:** `/bgagent setup` slash command → immediately respond with ephemeral message containing a `static_select` of onboarded repos (populated from the blueprints/onboarding DynamoDB table). Respond within 3 seconds.
2. **On selection:** `block_actions` payload arrives at `slack-interactions.ts`. Handler reads `action.selected_option.value` → saves channel default repo to `SLACK_CHANNEL_MAPPING_TABLE`.
3. **Confirmation:** Post another ephemeral: "✅ Default repo set to `org/repo`".

This avoids the `trigger_id` timeout problem entirely (no modal needed for simple single-select).

### B. If a modal IS needed (multi-step setup)

- Open the modal **synchronously** inside `slack-commands.ts` (before returning HTTP 200) using the `trigger_id` from the slash command payload.
- Store any state that the modal submission handler needs in `private_metadata` (JSON string, max 3000 chars) — team_id, channel_id, user_id.
- Route `view_submission` in `slack-interactions.ts` by `payload.view.callback_id`.

### C. Option count vs. workspace scale

`static_select` supports max 100 options. If a workspace has >100 onboarded repos, use `option_groups` (group by org/owner) — up to 100 groups, each with its own options array. If even that's insufficient, switch to `external_select` (Slack calls back to your app to populate options dynamically).

### D. Ephemeral message limitations

- The ephemeral carrying the repo picker cannot be updated or replaced via API.
- After the user selects a repo, post a NEW ephemeral as confirmation and let the picker ephemeral stay (it just becomes inert — no action buttons remain active after one use).
- Don't rely on `response_url` from the `block_actions` payload for ephemeral-origin actions — it won't be present.

### E. `slack-blocks.ts` extension

Add types for:
- `StaticSelectElement` (including `options`, `option_groups`, `initial_option`, `placeholder`)
- `OptionObject` and `OptionGroupObject`
- Update `SlackBlock` union to include `InputBlock` for modal use

### F. `slack-api.ts` extension

Add a `slackFetchWithResult<T>` helper (or extend `slackFetch`) that returns the parsed response body — needed for `views.open` to get the view ID back.

---

## 7. References

- Block elements reference: https://docs.slack.dev/reference/block-kit/block-elements
- block_actions payload: https://docs.slack.dev/reference/interaction-payloads/block_actions-payload
- Modals surface: https://docs.slack.dev/surfaces/modals
- chat.postEphemeral: https://docs.slack.dev/reference/methods/chat.postEphemeral
- views.open: https://docs.slack.dev/reference/methods/views.open
