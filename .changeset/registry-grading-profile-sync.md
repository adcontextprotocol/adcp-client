---
'@adcp/sdk': major
---

Sync the AAO registry OpenAPI and generated registry types for exact badge-scope grading profiles: the `selectAgentGradingProfile` operation, `selected_grading_statuses`, and the `grading_profile` badge field.

**Breaking:** `grading_profile` is now a required property of `VerificationBadge`, which is reachable from the package-root `AgentComplianceDetail` through `verified_badges`. Code that constructs a badge literal -- a test fixture, a mock registry response -- no longer compiles without it (`TS2741`). Reading badges is unaffected. The upstream AAO spec lists `grading_profile` in that schema's `required` set, so the generated type is faithful to the published contract and is not relaxed to optional; add the field, or read the badge through the generated type rather than restating it. `selected_grading_statuses` is additive and optional.

`operations['selectAgentGradingProfile']` now requires `requestBody`. The upstream spec declares seven required body fields for that compare-and-swap mutation but omits `requestBody.required: true`, which OpenAPI defaults to false, so the generated operation previously admitted a bodyless call. `scripts/generate-registry-types.ts` corrects the flag on an in-memory copy of the spec before generation and records it in the generated header; the cached spec stays byte-identical to what AAO publishes, and the entry is removed once AAO ships the fix.
