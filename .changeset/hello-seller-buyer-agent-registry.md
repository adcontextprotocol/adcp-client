---
'@adcp/sdk': patch
---

docs(example): wire BuyerAgentRegistry into hello_seller_adapter_signal_marketplace

Every seller needs a buyer-agent registry. Updated the worked reference adapter at `examples/hello_seller_adapter_signal_marketplace.ts` to demonstrate the Phase 1 surface (#1269) end-to-end so adopters cloning the example get the full identity story by default rather than a partial scaffold.

Added:
- An in-memory `ONBOARDING_LEDGER` (replaces with a Postgres-backed query in production) keyed by `credential.key_id` (the sha256 hash prefix `verifyApiKey` stamps).
- `BuyerAgentRegistry.cached(BuyerAgentRegistry.bearerOnly({...}))` wired to the platform's `agentRegistry` field — framework runs `resolve()` once per request, status enforcement (`suspended` / `blocked` → 403) fires before any handler.
- Demonstration site in `accounts.resolve` showing where adopters route tenant resolution against `ctx.agent` (operator-vs-agent gating, allowed_brands cross-checks).

Test additions to `test/examples/hello-seller-adapter-signal-marketplace.test.js`:
- Gate 4 asserts unknown api-key tokens are rejected at the auth layer before the registry runs (locks the auth-before-registry order).

The existing three gates (strict typecheck, storyboard pass, façade traffic) still pass — the registry wiring is implicitly exercised by every storyboard step that authenticates.
