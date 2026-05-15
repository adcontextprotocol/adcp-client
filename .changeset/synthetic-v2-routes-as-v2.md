---
'@adcp/sdk': minor
---

fix(client): route synthetic-v2 sellers through the v2 adapter; expose `isSyntheticV2()` for retry policies

`requireSupportedMajor` (called by `requireV3ForMutations: true` before every mutating task) used to throw `VersionUnsupportedError(reason: 'synthetic')` when a seller's capabilities were synthesized from `tools/list` and the synthesized version was `'v2'` (no `get_adcp_capabilities` tool present). The throw blocked legitimate buyers from calling sellers that simply hadn't implemented the v3 discovery tool.

A compliant v3 seller would declare itself via `get_adcp_capabilities`. Absence of that declaration is now read as v2: the SDK emits a one-time per-client warning (`maybeWarnSyntheticV2`) explaining the routing decision and dispatches through the v2 wire-shape adapter.

New public method `SingleAgentClient.isSyntheticV2()` returns `true` when the seller's capabilities were synthesized and the version was inferred as v2. Retry frameworks should branch on this to tighten attempt caps and backoff for sellers whose idempotency-TTL guarantee can't be derived from declared capabilities. Adopters who need a hard "definitely-v3" gate can validate `(await client.getCapabilities())._synthetic === false` directly.

Synthetic-v3 behavior is unchanged (still accepts with `maybeWarnSyntheticV3`). Real declared-v2 sellers and real-v3-missing-idempotency-TTL sellers are still refused with their respective `VersionUnsupportedError` reasons. The `'synthetic'` member of `VersionUnsupportedReason` is retained for downstream consumers that construct the error; no SDK call site emits it.
