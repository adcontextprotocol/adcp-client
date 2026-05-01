---
'@adcp/sdk': patch
---

Fix `adaptSyncCreativesRequestForV2` to pass the role-keyed `assets` manifest through unchanged.

PR #1118 introduced a flatten step that extracted the first role's asset from the manifest and passed it as a flat payload (`{ asset_type, url, … }`). This was incorrect: the v2.5 `creative-asset.json` schema declares `assets` using `patternProperties` keyed by role string — the same manifest shape v3 uses — so the flat output failed v2.5 schema validation on every field. The adapter now passes `assets` through verbatim, and the `sync_creatives` conformance fixture in `adapter-v2-5-conformance.test.js` has been updated from an `expected_failures` pin to a standard passing assertion.
