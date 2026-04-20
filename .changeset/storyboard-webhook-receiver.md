---
'@adcp/client': minor
---

Storyboard runner: outbound-webhook conformance grading (adcontextprotocol/adcp#2426, matching the spec shape from adcontextprotocol/adcp#2431).

**Storyboard runtime:**
- `runStoryboard` / `runStoryboardStep` accept a `webhook_receiver` option that binds an ephemeral HTTP listener (loopback-mock mode default; `proxy_url` mode accepts an operator-supplied public base). The receiver mints per-step URLs under `/step/<step_id>/<operation_id>` and exposes `{{runner.webhook_base}}` / `{{runner.webhook_url:<step_id>}}` substitutions so storyboards inject them into `push_notification_config.url`. Downstream filters pick up the same operation_id via `{{prior_step.<step_id>.operation_id}}`.
- Three new pseudo-tasks (step `task` values, not validation checks):
  - **`expect_webhook`** — asserts a matching delivery arrived carrying a well-formed `idempotency_key` (pattern `^[A-Za-z0-9_.:-]{16,255}$`). Optional `expect_max_deliveries_per_logical_event` caps distinct logical events in the window — catches publishers that re-execute on replay under a fresh key.
  - **`expect_webhook_retry_keys_stable`** — configures the receiver to reject the first N deliveries with a configurable 5xx, then asserts every observed delivery carries the byte-identical `idempotency_key`. Fails with `insufficient_retries`, `idempotency_key_rotated`, or `idempotency_key_format_changed`.
  - **`expect_webhook_signature_valid`** — delegates to the new RFC 9421 webhook verifier. Grades `not_applicable` when `webhook_signing` is not configured on runStoryboard options.
- `requires_contract` on any webhook-assertion step grades `not_applicable` when the contract id is not listed in `options.contracts` — lets cross-cutting storyboards (e.g. idempotency) reference webhook assertions without forcing every runner to host a receiver.

**RFC 9421 webhook signing:**
- `verifyWebhookSignature` in `@adcp/client/signing/server` — 14-step verifier checklist per `docs/building/implementation/security.mdx#verifier-checklist-for-webhooks`. Tag `adcp/webhook-signing/v1`, mandatory covered components `@method`, `@target-uri`, `@authority`, `content-type`, `content-digest`, key purpose `adcp_use: "webhook-signing"`. Throws `WebhookSignatureError` with a specific `webhook_signature_*` code.
- `signWebhook` in `@adcp/client/signing/client` — companion signer for publishers emitting conformant webhooks.
- `WEBHOOK_SIGNING_TAG` and `WEBHOOK_MANDATORY_COMPONENTS` constants exported from both sub-barrels.

**Test coverage:** 25 new tests across `test/lib/storyboard-webhook-receiver.test.js` and `test/lib/storyboard-webhook-signature.test.js` covering per-step routing, retry-replay policy, runner-variable substitution, every expect_webhook* error code, and a full E2E flow with a signing publisher.
