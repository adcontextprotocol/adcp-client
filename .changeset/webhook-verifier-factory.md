---
"@adcp/client": minor
---

Add `createWebhookVerifier` factory for secure-by-default webhook signature verification (issue #926).

`verifyWebhookSignature` requires callers to supply `replayStore` and `revocationStore` explicitly — callers who construct a new options object per request would silently receive no replay protection if stores were defaulted inside the per-call function. The new `createWebhookVerifier(options)` factory mirrors `createExpressVerifier`: stores are instantiated once at creation time and captured in closure scope, so all requests handled by the returned verifier share the same replay and revocation state. Pass an explicit shared store (Redis, Postgres, etc.) for multi-replica deployments. `verifyWebhookSignature` itself is unchanged — required stores remain required.
