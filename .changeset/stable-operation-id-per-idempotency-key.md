---
'@adcp/sdk': patch
---

A retry under the same `idempotency_key` now sends the same `push_notification_config`, so an AdCP 3.1+ seller replays the first response instead of answering `IDEMPOTENCY_CONFLICT` (#3693).

Sellers hash the whole request under its idempotency key, webhook registration included. The SDK minted a random operation id per call, and that id fills both `push_notification_config.operation_id` and the `{operation_id}` macro of the webhook URL, so every retry changed the hashed payload. This happened only when a webhook URL template applied to the call.

**Visible changes**

- **Deterministic operation ids for mutating calls.** When you don't pass `operationId` and the request carries an idempotency key (every mutating request; the SDK generates one when you don't), the default operation id is now `idem-` followed by 40 hex characters derived from the agent id, the task name and the key. The key itself never appears in the id or in a URL. Requests without a key keep a random UUID.
- **Deterministic webhook URLs and registrations.** The `{operation_id}` webhook URL macro, `push_notification_config.operation_id`, `onWebhookRegistration`'s `operationId`, `TaskTimeoutError.taskId` and the `operation_id` on results and `onActivity` events all carry that id. A retry under the same key reproduces them.
- **An operation id can be reused once its dispatch has finished.** Before, reusing an `operationId` within 30 seconds of the earlier task ending threw `ConfigurationError`, even for the documented retry. A same-key call while the first one is still in flight or awaiting completion on the same client still throws `ConfigurationError`; track the existing task instead. Operations held by durable settlement are still refused.
- **The `TaskOptions.operationId` docs are reversed.** They said retries should use a new id and the same `idempotency_key`. On AdCP 3.1+ that produced the conflict above. Retry with the same key, and, if you pass `operationId`, pass the same one.

`skipIdempotencyAutoInject` and `preserveGovernedPayload` calls keep a random default id.
