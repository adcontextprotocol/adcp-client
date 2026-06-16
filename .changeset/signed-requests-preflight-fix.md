---
'@adcp/sdk': patch
---

Unblock 3.1 `signed-requests` adopters. Two coupled fixes; the runner-side fix alone leaves adopters stuck on the boot guard, and vice versa (per #2237 triage).

**1. Pre-flight `resolveStoryboardsForCapabilities` (`compliance.ts`).**
`resolveStoryboardsForCapabilities` was throwing `unknown_specialism` on the
deprecated `signed-requests` claim because the bundle lives under
`universal/signed-requests.yaml`, not `specialisms/signed-requests/`. That
blocked every other storyboard from running and prevented the
`signed_requests_specialism_deprecated` notice (#2082) from ever firing.

Adds `DEPRECATED_SPECIALISM_UNIVERSAL_ALIASES` mapping the deprecated
specialism enum value to its universal bundle base name. When the deprecated
alias is declared AND the universal bundle is present in the cache,
resolution continues silently (the universal storyboard is pushed
unconditionally and the deprecation notice fires from runner.ts).
Otherwise the throw is preserved — unknown specialism without a universal
fallback is still a configuration error.

**2. Boot guard `createAdcpServer` (`create-adcp-server.ts`).**
The previous guard required the deprecated `signed-requests` specialism claim
whenever `signedRequests` was configured, contradicting the universal
storyboard's "drop the now-redundant specialism claim and rely solely on
`request_signing.supported: true`" guidance. Widens the guard to accept
either discovery surface: the canonical 3.1+ form
(`capabilities.request_signing.supported: true`, no deprecated claim) or
the back-compat form (`specialisms: ['signed-requests']`). Still rejects
the "config present, nothing advertised" case so buyers can't be left
unable to discover the signing requirement. JSDoc on `SignedRequestsConfig`
updated to document both paths.

Closes #2237.
