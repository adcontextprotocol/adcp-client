---
'@adcp/sdk': minor
---

Ship Option B auto-hydration: SDK pre-fetches `Product` objects (with `ctx_metadata` attached) and exposes them on `req.packages[i].product` for `createMediaBuy`. Make `getMediaBuys` required on `SalesPlatform` (with merge-seam fallback).

**Auto-hydration substrate:**
- `CtxMetadataEntry` extended with optional `resource` field (SDK-attached wire object) alongside `value` (publisher-attached blob).
- Two new framework-only store methods: `setEntry(account, kind, id, entry)` writes both fields atomically; `setResource(account, kind, id, resource, publisherCtxMetadata?)` updates the resource while preserving the publisher's prior `value` (so adopter `ctx.ctxMetadata.set()` is never clobbered by auto-store).
- `getEntry` / `bulkGetEntries` framework-only readers return both fields for the dispatch hydration path.

**Dispatch wiring:**
- After `getProducts` returns, framework iterates `result.products` and persists each Product's wire shape (minus `ctx_metadata`) as the `resource` field, with the publisher's `ctx_metadata` (when present) as the `value` field. Failures are logged + swallowed — auto-store never breaks a successful response.
- Before `createMediaBuy` invokes the publisher, framework walks `req.packages`, bulkGets each `product_id`, and attaches `pkg.product = { ...resource, ctx_metadata: value }` so the publisher reads `pkg.product.format_ids` / `pkg.product.ctx_metadata?.gam?.ad_unit_ids` directly. Falls back gracefully when the SDK has no record (publisher uses its own DB).
- After `getMediaBuys` returns, framework auto-stores each `media_buy` shape so subsequent `updateMediaBuy` can hydrate them.

**`getMediaBuys` made required:**
- Type-level required on `SalesPlatform` — every seller needs to support reading back what they created. Idempotent retries depend on it; the 6.2 patch-decomposition redesign needs single-id reads as foundation.
- Runtime keeps the merge-seam fallback path: legacy adopters wiring `getMediaBuys` via `opts.mediaBuy.getMediaBuys` continue to work; framework's platform-derived handler is omitted at runtime when the platform method is absent.

**Skill update:**
- `skills/build-decisioning-platform/SKILL.md` example updated: 6 functions (was 5), `createMediaBuy` reads `pkg.product.ctx_metadata?.gam?.ad_unit_ids` directly (no separate lookup), `getMediaBuys` shown as required with the full wire shape including `total_budget` (closes Emma round 2 failure cluster).

**Tests:**
- `test/server-auto-hydration.test.js`: 4 tests covering round-trip via `createMediaBuy`, no-store fallback, unseen-product fallback, `getMediaBuys` auto-store path.
- 195 total tests passing across the focused suite.

Closes Emma matrix v18 round 2 cascading failures from `update_media_buy` returning `SERVICE_UNAVAILABLE` and `get_media_buys` shape errors.
