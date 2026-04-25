---
'@adcp/client': patch
---

**Document why `createAgentSignedFetch.cache` defaults to the shared `defaultCapabilityCache` (#927).** The shared default is load-bearing: `ProtocolClient` / `buildAgentSigningContext` writes the seller's `get_adcp_capabilities` response into `defaultCapabilityCache`, and the signing fetch reads from the same instance so a single priming call serves every subsequent signing decision. Passing a fresh `new CapabilityCache()` without priming it silently disables `required_for` enforcement — cold cache → `shouldSignOperation` returns `false` → required ops ship unsigned → seller rejects, with no error from the SDK side. JSDoc on the `cache` field now spells this out, plus when an explicit cache is appropriate (primed in tests, out-of-band capability discovery), plus the security framing (cached entries are public seller advertisements, not buyer secrets).

No behavior change.
