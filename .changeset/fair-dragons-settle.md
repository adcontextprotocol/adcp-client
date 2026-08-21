---
'@adcp/sdk': major
---

Harden legacy media-buy continuation dispatch, durable settlement, task correlation, replay-loss reporting, and projection validation across AdCP 3.0–3.2.

This is a breaking prerelease correction. `RequestProposalsResponse` now exposes the complete `products_available` and `legacy_create` branch types instead of collapsing them to `{}`. Callers using legacy sellers that do not return a stable context ID must now configure `legacyPurchaseSellerSessionScope` from authenticated, restart-stable seller-session identity before issuing continuations.

Custom durable `webhookRegistrationStore` implementations must implement `markRequiresDurableSettlement` so mutation callbacks remain fail-closed across restarts and replicas.

Recordless legacy HMAC webhook fallback is now limited to explicitly read-only tools. Mutations, unknown extensions, and `get_products` callbacks require live registration provenance.
