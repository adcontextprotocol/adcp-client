---
'@adcp/sdk': patch
---

`adaptCreateMediaBuyRequestForV2` now derives `buyer_ref` (top-level + per-package) from the v3 `idempotency_key`, fixing v2.5 wire-validation failures for v3 buyers calling v2 sellers (adcontextprotocol/adcp-client#1115).

v2.5's `create_media_buy` schema requires `buyer_ref` top-level and per-package as the buyer's reference for THIS media buy. v3 doesn't model `buyer_ref` directly, but `idempotency_key` carries the same client-controlled-unique-identity contract. Reusing it preserves the seller-side dedupe contract on replays — the same v3 input always produces the same v2.5 `buyer_ref` values.

Derivation precedence:

- **Top-level `buyer_ref`**: caller-supplied wins → else `idempotency_key` → else omitted (v3 pre-send validation should already have rejected the missing required field; on warn-mode passthrough the v2.5 validator surfaces it).
- **Per-package `buyer_ref`**: caller-supplied wins → else `package.idempotency_key` → else `${parent_buyer_ref}-${index}`. Position-based composition is stable across replays of the same package list.

`adaptPackageRequestForV2` gains an optional second argument `PackageAdapterContext` (`{ parentBuyerRef?, index? }`) so callers threading per-package derivation supply the parent's reference + index. Backward-compatible: the existing single-argument signature continues to work for callers that don't need derivation (e.g., the existing `update_media_buy` adapter, which passes packages by `package_id`).

Conformance state: the v2.5 adapter-conformance test suite (added in #1121) flips `create_media_buy` from a known-drift `expected_failures` fixture to a passing fixture. Future regressions surface as test failures.
