---
'@adcp/sdk': minor
---

Two TenantRegistry refinements surfaced by training-agent v6 spike:

- **`TenantConfig.jwksUrl`** (F8) — explicit override for the JWKS fetch URL when a single host serves multiple agents under path prefixes (e.g., `https://shared.example.com/api/training-agent/{signals,sales,creative}`). The default validator's `new URL('/.well-known/brand.json', agentUrl)` resolution collapses every sub-routed agent onto host root, conflating their brand identities. Setting `jwksUrl` lets sub-routed deployments point each tenant at its own brand.json. Spec convention is host-root, so the override is only needed for sub-routed multi-tenant hosts; standard single-brand-per-host deployments keep working unchanged. `JwksValidator.validate` signature gains the optional `jwksUrl` argument so custom validators can read it too.
- **`autoValidate: false` footgun guard** (F7) — `createTenantRegistry({ autoValidate: false })` now emits a one-shot `console.warn` at construction explaining that tenants will stay in `'pending'` health and `resolveByRequest` will refuse all traffic until the operator calls `recheck()` for each tenant. Previous behavior was silent — developers reaching for the flag expecting "skip the validation cost" got "block all traffic" with no signal. JSDoc tightened to call out the intent (tests driving validation manually).
