---
'@adcp/sdk': minor
---

Align signature verification with the AdCP 3.3 agent-resolution algorithm. Match canonical agent URLs, discover webhook keys from capability-selected operator records, and accept publisher-pinned webhook keys only when the agent JWKS also publishes the same public key. Pins apply to every publisher in the verifier's own media-buy record and are refreshed before rejection.

`BrandJsonJwksResolver` adds an optional `agentUrl`. Existing type/id/brand configurations infer a unique onboarding URL, then confirm the agent's capabilities-selected operator record and canonical match before accepting keys. Ambiguous or unconfirmed mappings fail closed. Canonical operator verification covers every portfolio collection; legacy `brandId` and redirect-depth settings apply only to onboarding. Existing JWKS option types remain accepted. `BrandJsonJwksResolver` and `SingleAgentClient` enable `legacyWebhookFallback` by default for 3.x webhooks and permit disabling it. A2A standalone integrations must specify `protocol: 'a2a'`. Cross-domain onboarding must agree with capabilities, and legacy webhook discovery requires the agent-origin well-known record. These security corrections ship as a minor release while preserving existing constructor signatures. See `docs/migration-agent-resolution-3.3.md` for cache bounds, canonical identity and governance replay/revocation index updates.

Add per-request governance buyer identity and expose the exact selected operator record on verified signed requests. Explicit receiver account-authorization requirements remain enforced separately from origin binding.

`HttpsJwksResolver` now throttles failed initial fetches and failed refreshes using its configured cooldown, and rejects non-finite or negative cache options. Governance enforces a minimum 30-second cooldown and refuses keys at or past cache expiry. Brand resolver configuration errors fail at construction, before onboarding fetches.
