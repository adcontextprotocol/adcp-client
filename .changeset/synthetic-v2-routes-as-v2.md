---
'@adcp/sdk': patch
---

fix(client): route synthetic-v2 sellers through the v2 adapter instead of refusing the dispatch

`requireSupportedMajor` (called by `requireV3ForMutations: true` before every mutating task) used to throw `VersionUnsupportedError(reason: 'synthetic')` when a seller's capabilities were synthesized from `tools/list` and the synthesized version was `'v2'` (no `get_adcp_capabilities` tool present). The throw blocked legitimate buyers from calling sellers that simply hadn't implemented the v3 discovery tool.

A compliant v3 seller would declare itself via `get_adcp_capabilities`. Absence of that declaration is now read as v2: the SDK emits a one-time per-client warning (`maybeWarnSyntheticV2`) explaining the routing decision and dispatches through the v2 wire-shape adapter. Idempotency-TTL guarantees remain unknown for these sellers — BYOK retry callers should treat them as such.

Synthetic-v3 behavior is unchanged (still accepts with `maybeWarnSyntheticV3`). Real declared-v2 sellers and real-v3-missing-idempotency-TTL sellers are still refused with their respective `VersionUnsupportedError` reasons.

The `'synthetic'` member of `VersionUnsupportedReason` is retained for backwards compatibility with consumers that pattern-match on the union; no SDK call site throws it anymore.
