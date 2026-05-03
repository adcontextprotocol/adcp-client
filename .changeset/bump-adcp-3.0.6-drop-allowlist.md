---
"@adcp/sdk": patch
---

Bump pinned AdCP version from 3.0.5 to 3.0.6, drain the worked-example storyboard allowlist, and close three round-trip gaps surfaced while running end-to-end against the new fixtures.

**Spec sync.** AdCP 3.0.6 ships two upstream fixture fixes that close the last storyboard gaps for the worked guaranteed example:

- `adcontextprotocol/adcp#3989` — `media_buy_seller/inventory_list_targeting` adds `sandbox: true` to all 5 account blocks. SDK side: `createMediaBuyStore` auto-echo (PR #1424).
- `adcontextprotocol/adcp#3990` — `sales_guaranteed/create_media_buy` uses `task_completion.media_buy_id` for `context_outputs.path`. SDK side: runner's `task_completion.<path>` prefix (PR #1426).

`#1416` (NOT_CANCELLABLE) closed in Phase 4 (`assertMediaBuyTransition` wired into the guaranteed adapter's update path).

**SDK fixes for the round-trip.** Surfacing 3.0.6's new wire shape against `hello_seller_adapter_guaranteed` exposed three latent SDK gaps:

1. `tasks_get` registered only under the underscore name. The buyer-side `TaskExecutor.getTaskStatus` calls the spec's slash form `tasks/get` via `ProtocolClient.callTool`. The framework now registers the tool under both `tasks/get` (spec) and `tasks_get` (legacy snake_case alias) so MCP buyers using the spec name reach the handler. Fixes the `tasks/get poll timed out` failure on every guaranteed HITL flow.
2. `tasks_get` input schema accepted only `{account_id}` and rejected the natural-key `{brand, operator, sandbox}` arm — same shape gap that bit `comply_test_controller` in Phase 2. Schema is now the full canonical `AccountReference` (either arm passes; resolvers narrow at dispatch). Top-level `.strict()` preserved.
3. `AgentClient` (the public client returned by `multiClient.agent(id)`) didn't expose its underlying `TaskExecutor`. The storyboard runner's `pollTaskCompletion` accesses `client.executor`, which silently returned `undefined` on `AgentClient`, so `canPoll` was always false and the runner fell back to webhook-only racing — which times out for fixtures whose `push_notification_config.url` doesn't address a runner-controlled webhook. Added an `@internal` `executor` getter on `AgentClient` that proxies to the wrapped `SingleAgentClient.executor`.

**Hello seller-guaranteed adapter** (worked example, end-to-end against 3.0.6 fixtures):

- `accounts.resolve(undefined, ctx)` — auth-derived fallback. The framework calls this for tools without an explicit account ref (most notably `tasks/get`); without it, the framework's tenant boundary on tasks/get refuses every poll. The example returns the production singleton account so HITL polling resolves to the same account the original create stamped on the task.
- `taskRegistry` hoisted out of the `serve()` factory. A fresh per-request registry would lose every submitted task between create and the buyer's first tasks/get poll.
- `createMediaBuy` HITL bypass yields to the buyer's `push_notification_config` — the spec-aligned "I expect HITL" signal. Sandbox-mode + no-push-config still bypasses for the cascade scenarios; sandbox-mode + push-config goes through HITL.
- `getMediaBuyDelivery.by_package[]` now includes `pricing_model`, `rate`, `currency` per AdCP 3.0.6's tightened required fields.

**Allowlists.**

- `hello-seller-adapter-guaranteed.test.js` — `EXPECTED_FAILURES = []`. Storyboard suite passes unfiltered against 3.0.6.
- `hello-seller-adapter-non-guaranteed.test.js` — `#1415` entry dropped (3.0.6 closes it). `#1416` entry retained with a follow-up note: the SDK helper exists but the non-guaranteed worked example hasn't been migrated to `assertMediaBuyTransition` yet.
