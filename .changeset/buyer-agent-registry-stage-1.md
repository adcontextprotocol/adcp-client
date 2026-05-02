---
'@adcp/sdk': minor
---

feat(server): BuyerAgentRegistry — Phase 1 Stage 1 (types + factories)

Phase 1 Stage 1 of #1269: durable buyer-agent identity surface, ships in 3.0.x with no wire-emission.

Adds `BuyerAgent`, `BuyerAgentRegistry`, `AdcpCredential`, `BuyerAgentStatus`, and `BuyerAgentBillingMode` exported from `@adcp/sdk/server`. Three factory functions encode the implementer posture at construction:

- `BuyerAgentRegistry.signingOnly({ resolveByAgentUrl })` — production target. Bearer/API-key/OAuth credentials resolve to `null`; only `kind: 'http_sig'` credentials route through `resolveByAgentUrl`.
- `BuyerAgentRegistry.bearerOnly({ resolveByCredential })` — pre-trust beta. All credentials route through the adopter's mapping; signed credentials are not pre-filtered.
- `BuyerAgentRegistry.mixed({ resolveByAgentUrl, resolveByCredential })` — transition posture. `kind: 'http_sig'` routes to `resolveByAgentUrl`; bearer/OAuth/api-key routes to `resolveByCredential`. Signed path is preferred when both are present.

`BuyerAgent` carries `readonly` fields for `agent_url`, `display_name`, `status`, set-valued `billing_capabilities`, optional `default_account_terms`, optional `allowed_brands`, and optional `aliases` (rotation grace-period reservation, no special framework behavior in v1).

This stage adds the types and factory functions only. Framework integration (resolve seam, `ctx.agent` threading), the `ResolvedAuthInfo` migration shim, status enforcement, multi-credential conflict resolution, credential redaction, and the caching decorator land in subsequent stages of #1269.

Phase 2 (#1292) — framework-level `billing_capability` enforcement and emission of the `BILLING_NOT_PERMITTED_FOR_AGENT` / `BILLING_NOT_SUPPORTED` codes registered in adcontextprotocol/adcp#3831 — is gated on the SDK's 3.1 cutover.
