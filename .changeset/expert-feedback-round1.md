---
'@adcp/sdk': minor
---

Round-1 expert feedback on 6.0 close-out: hydration safety + tenant security + skill phase-2 partial.

## Hydration safety (security + protocol experts)

- `hydrateSingleResource` and `hydratePackagesWithProducts` now attach the hydrated field as **non-enumerable** so accidental serialization (`JSON.stringify(req)`, spread `{...req}`, `Object.entries(req)`) does NOT carry the publisher's `ctx_metadata` blob into request-side audit / log sinks. Direct property access (`req.media_buy.ctx_metadata`) still works.
- Hydrated objects carry a non-enumerable `__adcp_hydrated__: true` marker so middleware and handler authors can disambiguate "publisher passed it" from "framework attached it".
- New leak-prevention test asserts `JSON.stringify` and `Object.keys` do not surface hydrated fields.

## TenantRegistry security (security expert mediums)

- **Per-alias JWKS validation**: `runValidation` now hits every URL in `agentUrls[]` independently. Aliases share the signing key but had no separate brand.json check before — DNS hijack on an alias could serve responses no buyer can verify. First permanent failure short-circuits and disables the tenant.
- **Register-time collision check**: `register()` rejects when a tenant's `(host, pathPrefix)` route overlaps with an already-registered tenant. Without this two tenants could silently claim the same alias; the first-inserted would win, dependent on Map iteration order.
- **`TenantStatus.agentUrls`**: status now exposes the full URL list (not just canonical) so ops dashboards can detect aliases and distinguish multi-URL tenants from single-URL ones.

## Seller skill phase-2 partial (DX + product + prompt-engineer)

- Five v5 code blocks in `skills/build-seller-agent/SKILL.md` now carry `> **LEGACY (v5)**` blockquote prefixes flagging the inconsistency between the v6 canonical opening example and the deeper v5 examples that #1088 phase 2 will migrate. The Implementation worked example (line 866 — the highest-LLM-target deep block per prompt-engineer review) gets a stronger callout pointing scaffolders at the v6 skeleton.
- `createAdcpServer`'s top-level JSDoc adds `@see` breadcrumbs pointing at `createAdcpServerFromPlatform` and the `@adcp/sdk/server/legacy/v5` subpath.

Closes round-1 expert feedback. Refs #1086 #1087 #1088.
