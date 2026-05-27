---
'@adcp/sdk': minor
---

Adopt several SDK-side follow-ups unblocked by the AdCP 3.1 schema cache.

- Preserve explicit `conversion_tracking.supported_targets` declarations without inventing a default; omitted values mean only target-less event goals are guaranteed.
- Allow `supported_optimization_metrics` to derive from a static `productCatalog`.
- Treat `sponsored-intelligence` as a first-class specialism in compile-time and runtime platform validation, and update the SI example/skill docs.
- Align upstream-recorder `RecordedCall` output with the cached 3.1 `query_upstream_traffic` schema, including raw/digest attestation metadata, payload length, and digest-mode identifier proofs.
- Honor storyboard `required_any_of_tools` gates with `requirement_unmet` skips and skip-cause aggregation.
