# Slack Block Kit interactive components — research findings (ABCA-663)

Research for the multi-repo context system repo-picker UI (parent: ABCA-659, sub-issue #3).

---

## 1. Component catalogue

### 1.1 `static_select` element

**What it is:** A dropdown menu with a predefined list of options plus type-ahead filtering.

**Fields:**

| Field | Type | Required | Constraint |
|---|---|---|---|
| `type` | `"static_select"` | ✅ | — |
| `action_id` | string | ❌ | max 255 chars |
| `options` | Option[] | ✅ (one of) | max 100 options |
| `option_groups` | OptionGroup[] | ✅ (one of) | max 100 groups |
| `initial_option` | Option | ❌ | must match an item in `options`/`option_groups` |
| `confirm` | ConfirmDialog | ❌ | — |
| `focus_on_load` | boolean | ❌ | defaults `false` |
| `placeholder` | plain_text | ❌ | max 150 chars |

- Exactly one of `options` or `option_groups` required (not both).
- Each `option` has `text` (plain_text, max 75 chars) and `value` (string, max 75 chars); options may also carry a `description` (plain_text, max 75 chars).
- **100-option hard limit is the most important design constraint for repo-picker.** If a workspace has >100 repos, either pagination/filtering or an `external_select` (search-as-you-type) should be used instead.
- Usable in `section` (as `accessory`), `actions`, and `input` blocks.
- In an `input` block, value is exposed in `state.values` at view submission time.
- In an `actions` block, each selection fires a `block_actions` payload immediately.

**Option JSON shape:**
```json
{
  "text": { "type": "plain_text", "text": "owner/repo" },
  "value": "owner/repo"
}
```

---

### 1.2 Button element (in `actions` block)

**What it is:** An interactive clickable button; triggers a `block_actions` payload on click.

**Fields:**

| Field | Type | Required | Constraint |
|---|---|---|---|
| `type` | `"button"` | ✅ | — |
| `text` | plain_text | ✅ | max 75 chars; visible truncation around 30 chars |
| `action_id` | string | ❌ | max 255 chars; should be unique within the block |
| `url` | string | ❌ | max 3000 chars; opens URL in browser; still fires payload |
| `value` | string | ❌ | max 2000 chars; delivered in interaction payload |
| `style` | `"primary"` \| `"danger"` | ❌ | `primary`=green; `danger`=red; omit for default |
| `confirm` | ConfirmDialog | ❌ | — |
| `accessibility_label` | string | ❌ | max 75 chars; overrides `text` for screen readers |

- Must be inside a `section` (as `accessory`) or `actions` block.
- **Codebase already uses this pattern** — see `ActionButtonElement` and `dangerButton()` in `cdk/src/handlers/shared/slack-blocks.ts`.
- The existing `cancel_task:{task_id}` routing convention in `slack-interactions.ts` (prefix-encoded action_id) is sound and extensible for new actions.

---

### 1.3 `actions` block

**What it is:** A horizontal row of interactive elements.

**Fields:**

| Field | Type | Required | Constraint |
|---|---|---|---|
| `type` | `"actions"` | ✅ | — |
| `elements` | Element[] | ✅ | **max 25 elements per block** |
| `block_id` | string | ❌ | max 255 chars |

- Supports: buttons, select menus (including `static_select`), overflow menus, date pickers.
- Existing `actions()` helper in `slack-blocks.ts` wraps this correctly.
- For the repo-picker, a `static_select` alongside a "Confirm" button fits in a single `actions` block.

---

### 1.4 Modal views

**What it is:** A full-screen dialog opened with `views.open`; used for multi-step or form-style interactions.

**Opening a modal:**
- Requires a `trigger_id` from a preceding interaction payload (button click, slash command with `trigger_id`).
- `trigger_id` **expires in 3 seconds** — must call `views.open` before the window closes.
- `trigger_id` is single-use (`exchanged_trigger_id` error if reused).

**`views.open` required parameters:**
- `token` (bot token with `chat:write` scope)
- `trigger_id` (from interaction payload)
- `view` (view payload object)

**View payload object fields:**

| Field | Type | Required | Constraint |
|---|---|---|---|
| `type` | `"modal"` | ✅ | — |
| `title` | plain_text | ✅ | **max 24 chars** |
| `blocks` | Block[] | ✅ | **max 100 blocks** |
| `submit` | plain_text | ❌* | required if any `input` blocks present |
| `close` | plain_text | ❌ | max 24 chars |
| `callback_id` | string | ❌ | max 255 chars; used to route submissions |
| `private_metadata` | string | ❌ | **max 3000 chars**; not shown to user; good for passing context (e.g. `team_id`, `user_id`) |
| `clear_on_close` | boolean | ❌ | clears the modal stack on close |
| `notify_on_close` | boolean | ❌ | sends `view_closed` payload to app |
| `external_id` | string | ❌ | max 255 chars; must be unique per team |

*At most **3 modals** can be stacked (pushed) simultaneously.

**`view_submission` payload** (fires when user clicks Submit):
```json
{
  "type": "view_submission",
  "team": { "id": "T9TK3CUKW", "domain": "example" },
  "user": { "id": "UA8RXUSPL", "username": "jtorrance" },
  "view": {
    "id": "VNM522E2U8",
    "type": "modal",
    "callback_id": "repo_picker_setup",
    "private_metadata": "{\"team_id\":\"T9TK3CUKW\",\"user_id\":\"UA8RXUSPL\"}",
    "state": {
      "values": {
        "repo_select_block": {
          "repo_select_action": {
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

- `state.values` is keyed `[block_id][action_id]`.
- For `static_select` in an `input` block, the selected value is at `.selected_option.value`.
- Respond to `view_submission` within **3 seconds** with HTTP 200.
- To close the modal: respond `{ "response_action": "clear" }`.
- To show a validation error inline: respond `{ "response_action": "errors", "errors": { "block_id": "Error text" } }`.

**`view_closed` payload** (fires when user dismisses modal, requires `notify_on_close: true`):
```json
{
  "type": "view_closed",
  "team": { ... },
  "user": { ... },
  "view": { "id": "...", "callback_id": "repo_picker_setup", ... },
  "is_cleared": false
}
```

---

### 1.5 Ephemeral messages

**What they are:** Messages visible only to a specific user; delivered via `chat.postEphemeral` or via `response_url` with `"response_type": "ephemeral"`.

**`chat.postEphemeral` parameters:**

| Parameter | Required | Notes |
|---|---|---|
| `channel` | ✅ | Channel/DM where message appears |
| `user` | ✅ | Recipient user ID; must be a member of the channel |
| `text` | ❌* | Fallback when `blocks` used |
| `blocks` | ❌* | Block Kit blocks for rich formatting |
| `thread_ts` | ❌ | Post in thread |

*At least one of `text` or `blocks` required.

**Key constraints:**
- Max **4,000 bytes** per message.
- Max **100 attachments** per message.
- **Cannot be updated** with `chat.update` (unlike regular messages).
- Delivery is **not guaranteed** — user must be active in Slack and a member of the channel.
- Messages vanish after session closure; do not persist across app reloads.
- **Block Kit and interactive components (buttons, selects) are fully supported** in ephemeral messages.

**`response_url` (existing pattern in codebase):**
The existing `postToResponseUrl()` in `slack-interactions.ts` already sets `"response_type": "ephemeral"` — this is the correct pattern for inline interaction feedback.

---

## 2. Interaction callback routing through `slack-interactions.ts`

### Current handler structure

```
POST /v1/slack/interactions
  ↓ parse URL-encoded `payload` field
  ↓ verify Slack signing secret
  ↓ route on payload.type
     "block_actions"  → iterate payload.actions[], dispatch on action_id
     (other types)    → silently 200
```

### `block_actions` payload shape (delivered to interactions endpoint)

```json
{
  "type": "block_actions",
  "trigger_id": "12321423423.333649436676.d8c1bb837935619ccad0f624c448ffb3",
  "user": { "id": "UA8RXUSPL", "username": "jtorrance", "team_id": "T9TK3CUKW" },
  "team": { "id": "T9TK3CUKW", "domain": "example" },
  "api_app_id": "AABA1ABCD",
  "channel": { "id": "CBR2V3XEX", "name": "review-updates" },
  "response_url": "https://hooks.slack.com/actions/...",
  "actions": [
    {
      "type": "button",
      "action_id": "cancel_task:abc123",
      "block_id": "=qXel",
      "value": "click_me_123",
      "action_ts": "1548426417.840180"
    }
  ]
}
```

For a `static_select` action in an `actions` block, the action item shape is:
```json
{
  "type": "static_select",
  "action_id": "repo_select_action",
  "block_id": "repo_select_block",
  "selected_option": {
    "text": { "type": "plain_text", "text": "owner/repo" },
    "value": "owner/repo"
  },
  "action_ts": "1548426417.840180"
}
```

**Important:** The current `SlackInteractionPayload` interface in `slack-interactions.ts` has a partial `actions` type:
```typescript
actions?: ReadonlyArray<{
  readonly action_id: string;
  readonly block_id: string;
  readonly value?: string;   // ← button-only; absent for static_select
}>
```
For `static_select`, the selected value is in `selected_option.value`, not in `value`. **The interface must be extended to support static_select callbacks.**

### `view_submission` payloads

These arrive at the **same interactions endpoint** but with `payload.type === "view_submission"`. The current handler only handles `"block_actions"` and silently ignores everything else. A new branch is needed:

```typescript
if (payload.type === 'view_submission') {
  await handleViewSubmission(payload);
}
```

Routing is via `payload.view.callback_id`. The `trigger_id` in the submission payload can open a follow-up modal if needed.

---

## 3. Design adjustments for sub-issue #3

### 3.1 Repo-picker approach: modal with `input` block + `static_select`

**Recommended pattern for `/bgagent setup`:**
1. Slash command handler calls `lambdaClient.send(InvokeCommand(...))` (as today) to the processor asynchronously.
2. The processor **cannot** open a modal — it doesn't have the `trigger_id` and the 3-second window will have expired.
3. **The slash command acknowledger (slack-commands.ts) must use `trigger_id` directly** to open the modal, and respond with an empty body (HTTP 200 `{}`) or a `response_type: "ephemeral"` text if opening the modal fails.
4. The modal uses `input` blocks with a `static_select` element for repo selection.
5. On submit, `view_submission` arrives at the interactions endpoint with `callback_id: "setup_repo_picker"` and `state.values` containing the selected repo.

**Alternative — actions block (immediate callback, no submit button):**
A `static_select` in an `actions` block fires a `block_actions` payload on every option change, with no submit button required. Simpler flow but no form-level validation. Good for a single-field selection posted as an ephemeral message.

### 3.2 `trigger_id` timing constraint

The `trigger_id` in the slash command payload is forwarded inside the `SlackCommandPayload` struct. The Lambda acknowledger currently async-invokes the processor and returns an ack text — this means the processor **never receives the trigger_id in time**. To open modals:
- The slash command handler itself must call `views.open` synchronously before returning, OR
- Extract `trigger_id` from the payload and include it in the Lambda invocation, then the processor must call `views.open` within 3 seconds of the original slash command (practically impossible for cold-start Lambda).

**Recommendation:** The slash command handler directly opens the modal for `setup` subcommand before async-invoking the processor for any background work.

### 3.3 Extending `SlackInteractionPayload` for static_select

Add `selected_option` to the action item type in `slack-interactions.ts`:
```typescript
actions?: ReadonlyArray<{
  readonly action_id: string;
  readonly block_id: string;
  readonly value?: string;                     // button value
  readonly selected_option?: {                 // static_select
    readonly text: { readonly type: 'plain_text'; readonly text: string };
    readonly value: string;
  };
  readonly type?: string;                      // 'button' | 'static_select' | ...
}>
```

### 3.4 Adding `view_submission` handling

The interactions handler must be extended with:
```typescript
interface ViewSubmissionPayload {
  readonly type: 'view_submission';
  readonly user: { readonly id: string; readonly username: string; readonly team_id: string };
  readonly view: {
    readonly id: string;
    readonly callback_id: string;
    readonly private_metadata: string;
    readonly state: {
      readonly values: Record<string, Record<string, {
        readonly type: string;
        readonly selected_option?: { readonly value: string };
        readonly value?: string;
      }>>;
    };
  };
  readonly trigger_id: string;
}
```

Route by `callback_id` to separate handlers (e.g. `handleSetupSubmission`, `handleRepoPicker`).

### 3.5 Repo limit

- 100-option hard limit per `static_select`.
- If multi-repo workspaces regularly exceed 100 repos, use `external_select` (type-ahead search backed by a `/slack/options` endpoint) instead.
- For an MVP with a user-scoped allowlist, 100 should be sufficient — document the limit.

### 3.6 Ephemeral messages for setup flow

- Use `chat.postEphemeral` (or `response_url` with `"response_type": "ephemeral"`) for all setup flow feedback.
- Block Kit buttons and `static_select` work in ephemeral messages.
- **Cannot update ephemeral messages** with `chat.update` — if you need to replace a message, post a new ephemeral (or use `response_url` with `replace_original: true`).
- The existing `postToResponseUrl(responseUrl, text)` helper correctly uses `"response_type": "ephemeral"` — extend it to accept blocks for richer content.

### 3.7 Scope requirements for modals

Opening modals requires no additional OAuth scope beyond what's already granted for interactive components. The `trigger_id` comes from any interaction (slash command, button click, menu selection). No new Lambda or endpoint is required — `views.open` is a direct `fetch` call from within the interaction handler or command handler.

---

## 4. Summary table

| Component | Supported | Fires at `slack-interactions.ts` | Payload type | Key constraint |
|---|---|---|---|---|
| `static_select` (actions block) | ✅ | ✅ immediately on selection | `block_actions` | 100 options max; `selected_option.value` not `value` |
| `static_select` (input block, in modal) | ✅ | ✅ on modal submit | `view_submission` | state.values keyed `[block_id][action_id]` |
| Button (actions block) | ✅ | ✅ on click | `block_actions` | 75 char label; prefix-encode action_id for routing |
| Modal (`views.open`) | ✅ | ✅ on submit | `view_submission` | trigger_id expires in 3 s; title ≤24 chars; ≤100 blocks; ≤3 stacked views |
| Ephemeral messages | ✅ | n/a | n/a | Cannot be `chat.update`'d; blocks supported; delivery not guaranteed |

---

## 5. Files to change for implementation (sub-issue #3)

| File | Change needed |
|---|---|
| `cdk/src/handlers/slack-commands.ts` | For `setup` subcommand: call `views.open` directly using `trigger_id` from slash payload before async-invoking processor |
| `cdk/src/handlers/slack-interactions.ts` | Add `selected_option` to action type; add `view_submission` branch with `callback_id` routing; add `ViewSubmissionPayload` interface |
| `cdk/src/handlers/shared/slack-blocks.ts` | Add `StaticSelectElement` type, `inputBlock()` helper, modal view builder function |
| `cdk/src/handlers/slack-command-processor.ts` | Add `setup` subcommand handler for any async post-submission logic |

No new Lambda functions, CDK stacks, or IAM changes required for the interaction routing.
