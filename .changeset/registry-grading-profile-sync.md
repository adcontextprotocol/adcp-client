---
'@adcp/sdk': patch
---

Sync the AAO registry OpenAPI and generated registry types for exact badge-scope grading profiles: the `selectAgentGradingProfile` operation, `selected_grading_statuses`, and the `grading_profile` badge field.

`operations['selectAgentGradingProfile']` now requires `requestBody`. The upstream spec declares seven required body fields for that compare-and-swap mutation but omits `requestBody.required: true`, which OpenAPI defaults to false, so the generated operation previously admitted a bodyless call. `scripts/generate-registry-types.ts` corrects the flag on an in-memory copy of the spec before generation and records it in the generated header; the cached spec stays byte-identical to what AAO publishes, and the entry is removed once AAO ships the fix.
