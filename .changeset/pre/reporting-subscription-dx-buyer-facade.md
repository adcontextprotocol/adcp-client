---
'@adcp/sdk': minor
---

Reporting subscriptions (experimental `media_buy.reporting_subscriptions`, AdCP 3.3): the buyer write facade and the raw `syncPrincipal` guard.

- **`client.reporting`** (`ReportingClient`, on `AgentClient` and `SingleAgentClient`) offers `subscribe`, `unsubscribe`, `replaceSubscriptions`, `listSubscriptions` and `preview`.
  - Writes are patch-shaped over the replace-shaped wire: other entries are kept byte for byte.
  - `subscription_version` is optional. It is kept for in-place changes and bumped on a semantic change.
  - `registerDestination` upserts a destination in the same write.
- **Pre-dispatch refusals.** A `ReportingSubscriptionError` with `dispatched: false` is thrown for: an implicit scope, an unregistered destination, a missing `{account_id}`, `SUBSCRIPTION_ID_CLASH`, `SUBSCRIPTION_OPERATOR_SCOPE_REQUIRED` and `SUBSCRIPTION_SELECTOR_UNMATCHED` (with `nearest`).
- **Retries and readback.** On `CONFLICT` the facade re-reads, re-merges and retries with a fresh key (3 attempts), then throws `SUBSCRIPTION_CONFLICT_EXHAUSTED`. A transport failure retries the same key and body. The readback is verified, and a mismatch throws `SUBSCRIPTION_READBACK_MISMATCH`. Names follow the Python SDK's `ReportingClient`; the preview result type is `SubscriptionPreviewResult`.
- **Raw `syncPrincipal` guard.** A raw `client.syncPrincipal` that submits `reporting_subscriptions` or `reporting_destinations` reads the principal once. It refuses, before sending, a write that would deactivate a subscription (`SUBSCRIPTION_WOULD_DEACTIVATE`) or revoke a destination (`DESTINATION_WOULD_REVOKE`) unless you pass `allowDeactivation` / `allowRevocation`. Dry runs, the lifecycle helpers and storyboard runs are not guarded.
- `guardSyncPrincipal` is exported, and `ReportingSubscriptionError` accepts a seller's wire code or a local `INVALID_REQUEST`.
