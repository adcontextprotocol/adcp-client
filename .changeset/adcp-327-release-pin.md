---
'@adcp/sdk': patch
---

Adopt the signed AdCP 3.2.7 schema and compliance bundle, including evaluator off-list rejection coverage and the 3.2.6 stabilization changes below. Relative to 3.2.6, the 3.2.7 refresh adds no wire-schema shapes and preserves maintained AdCP 3.0/3.1 compatibility. Extend the reviewed commercial-term annotation snapshot to the identical 3.2.7 contract and refresh canonical storyboard provenance to the immutable 3.2.7 release.

Evaluator off-list rejection phases are now required when an agent advertises evaluator support. A wrong acceptance or observed off-list outbound call fails conformance; an unavailable valid build fixture produces a `fixture_unsatisfied` coverage gap with no executed security credit. Hosts can provision valid inputs through `test_kit.creative_build_probes`.

CLI migration: this SDK packages the exact AdCP 3.2.7 compliance corpus. Update explicit `--compliance-version 3.2.5` or `3.2.6` flags to `3.2.7`; runs that need historical fixture bytes must retain the SDK version that packages that corpus. Maintained AdCP 3.1 and 3.0 corpora remain included.

Resolve property and collection lists from standard MCP structured or JSON text responses, preserving upstream AdCP errors. Keep task completion separate from media-buy lifecycle observations in storyboard checks. Stop injecting task status into current, unversioned, and status-free compact responses during conformance validation, while retaining explicitly declared AdCP 3.0 compatibility. Admit canonical version metadata in closed response schemas without relaxing other fields.

Prepare build tooling for exact AdCP 3.3 beta and release-candidate pins without advertising 3.3 support from stable SDK 16.

When grading AdCP 3.0 sellers, select the matching AdCP 3.0 schema version so their status-optional responses are evaluated against that release.
