---
'@adcp/sdk': patch
---

Fix `resolveStoryboardsForCapabilities` throwing `unknown_specialism` on the deprecated `signed-requests` specialism claim.

The 3.1 spec keeps the `signed-requests` specialism enum value for backward
compatibility (universal/signed-requests.yaml: "Agents that still advertise
`specialisms: ['signed-requests']` are graded via this universal storyboard").
But the pre-flight specialism resolver was looking for the bundle under
`specialisms/signed-requests/` and throwing — which blocked every other
storyboard from running for any agent still claiming the deprecated
specialism. The `signed_requests_specialism_deprecated` notice path (#2082)
was correctly wired in `runner.ts` but never fired because pre-flight
threw first.

Adds `DEPRECATED_SPECIALISM_UNIVERSAL_ALIASES` mapping the deprecated
specialism enum value to its universal bundle base name. When the
deprecated alias is declared AND the universal bundle is present in the
cache, resolution continues silently (the universal storyboard is already
pushed unconditionally and the deprecation notice fires from runner.ts).
Otherwise the throw is preserved — unknown specialism without a universal
fallback is still a configuration error.

Closes adcp-client#2237.
