---
'@adcp/sdk': minor
---

Align signature verification with the AdCP 3.3 agent-resolution algorithm. Match canonical agent URLs, discover webhook keys from capability-selected operator records, and accept publisher-pinned webhook keys only when the agent JWKS also publishes the same public key. Pins apply to every publisher in the verifier's own media-buy record and are refreshed before rejection.

`BrandJsonJwksResolver` adds an optional `agentUrl`. Existing type/id/brand configurations infer a unique onboarding URL, then confirm the agent's capabilities-selected operator record and canonical match before accepting keys. Ambiguous or unconfirmed mappings fail closed. Canonical operator verification covers every portfolio collection; legacy `brandId` and redirect-depth settings apply only to onboarding. Existing JWKS option types remain accepted. Standalone resolvers require opting into `legacyWebhookFallback` for 3.x webhooks; `SingleAgentClient` enables it by default and permits disabling it. See `docs/migration-agent-resolution-3.3.md` for canonical identity and governance replay/revocation index updates.

Add per-request governance buyer identity and expose the exact selected operator record on verified signed requests. Explicit receiver account-authorization requirements remain enforced separately from origin binding.
