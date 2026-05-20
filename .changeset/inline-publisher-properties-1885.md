---
'@adcp/sdk': minor
---

feat(discovery): inline-resolution path for `publisher_properties` selectors (#1885 part 1)

Adopts AdCP spec PR [adcontextprotocol/adcp#4827](https://github.com/adcontextprotocol/adcp/pull/4827) ([issue #4825](https://github.com/adcontextprotocol/adcp/issues/4825)). When a parent `adagents.json`'s top-level `properties[]` carry entries with `publisher_domain` matching a `publisher_properties` selector's target domain, the SDK now satisfies the selector inline — no per-child federated fetch required for that domain.

**Resolution model:**

- `resolveAgentProperties` now fills `properties` directly for `publisher_properties` selectors that match inline.
- `cross_publisher_expanded` shrinks to only the selectors that still need a federated fetch (no inline match AND not revoked).
- `cross_publisher` preserves the raw wire shape unchanged.

**Revocation:** new optional `AdAgentsJson.revoked_publisher_domains?: string[]` field. Selectors targeting a revoked domain are dropped from BOTH inline and federated paths — federated fallback MUST NOT fire for revoked domains.

**Divergence detection:** `detectInlineFederatedDivergence(inline, federated)` reports `(publisher_domain, property_id)` pairs that resolved differently across the two paths. Per spec, federated wins; this utility produces the report for the SDK / adopter to log.

**New public exports** (from the package root):

- `resolveInlinePublisherProperties(adAgents, selectors)` — high-level helper.
- `resolveSingularInline(properties, singularSelector)` — per-selector helper for adopters wanting fine-grained federated-fallback control.
- `detectInlineFederatedDivergence(inline, federated)` — produce divergence report.
- `InlineResolutionResult`, `InlineFederatedDivergence` types.

**Backwards compatibility:** purely additive at the wire and type levels. Files that don't carry inline matches behave exactly as before — `cross_publisher_expanded` still contains the unmatched selectors. Files that don't carry `revoked_publisher_domains` behave as before. Adopters using `resolveAgentProperties` get inline resolution automatically; no caller code changes required.

**References:**

- Spec PR (inline resolution rule): [adcontextprotocol/adcp#4827](https://github.com/adcontextprotocol/adcp/pull/4827)
- Spec issue: [adcontextprotocol/adcp#4825](https://github.com/adcontextprotocol/adcp/issues/4825)
- Part 2 (`fetchAgentAuthorizationsFromDirectory`) ships separately.
