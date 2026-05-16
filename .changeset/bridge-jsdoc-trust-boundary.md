---
'@adcp/sdk': patch
---

docs(bridge): name `resolveAccount` as the trust boundary + multi-tenant keying as adopter responsibility

Adds two paragraphs to the top-of-file JSDoc on `src/lib/server/test-controller-bridge.ts`:

- **Scope of verification.** A storyboard pass through this bridge proves protocol conformance against fixture data — wire shape, error envelopes, idempotency, signed-request handling, sandbox stamping. It does **not** prove the seller's adapter against the real upstream platform works; that code path is bypassed by the post-handler merge. Sellers should pair this with a live-OAuth sandbox-runner to cover adapter health. Cross-references the runner-visible-bridge-marker ask at adcp-client#1775.

- **Adopter responsibilities.** Names two patterns the SDK can't enforce: (1) `resolveAccount` is the trust boundary — production bindings MUST configure it or the request-signal check (`account.sandbox === true` OR `context.sandbox === true`) is the only line of defense, because the dispatcher gate falls through to permissive when `ctx.account === undefined`; (2) multi-tenant keying is the adopter's job — callbacks must key their fixture store on `ctx.account` and the SDK does no defensive cross-check between fixture-entry account IDs and the resolved `ctx.account`.

No code change. Security-review-driven (4 of 4 experts during PR #1754 post-merge review flagged the missing public-surface warning).
