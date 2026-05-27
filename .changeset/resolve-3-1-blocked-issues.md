---
'@adcp/sdk': minor
---

Adopt several SDK-side follow-ups unblocked by the AdCP 3.1 schema cache.

- Preserve explicit `conversion_tracking.supported_targets` declarations without inventing a default; omitted values mean only target-less event goals are guaranteed.
- Allow `supported_optimization_metrics` to derive from a static `productCatalog`.
- Treat `sponsored-intelligence` as a first-class specialism in compile-time and runtime platform validation, and update the SI example/skill docs.
- Align upstream-recorder `RecordedCall` output with the cached 3.1 `query_upstream_traffic` schema, including raw/digest attestation metadata, payload length, and digest-mode identifier proofs.
- Honor storyboard `required_any_of_tools` gates with `requirement_unmet` skips and skip-cause aggregation.

**BREAKING**:

- `RecordedCall` is now a raw/digest discriminated union for the 3.1 `query_upstream_traffic` response. Raw calls carry `payload` and `payload_length`; digest calls carry `payload_digest_sha256`, `payload_length`, and optional `identifier_match_proofs`. Consumers that assumed `RecordedCall.payload` was always present, or that construct `RecordedCall` literals, need to handle the branch-specific fields.
- `validatePlatform` now rejects `specialisms: ['sponsored-intelligence']` unless the platform provides the `sponsoredIntelligence` implementation required by that specialism. Adapters that previously advertised the specialism without dispatch support must either add the platform field or stop advertising the specialism.
