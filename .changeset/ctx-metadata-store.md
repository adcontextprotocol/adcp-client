---
'@adcp/sdk': minor
---

Ship `ctx_metadata` opaque-blob round-trip for adapter-internal state. Publishers attach platform-specific blobs (GAM `ad_unit_ids` per product, `gam_order_id` per media_buy, line_item_id per package) to any returned resource via `ctx.ctxMetadata.set('product', id, value)`; the framework persists by `(account.id, kind, id)` and threads back into the publisher's request context on subsequent calls referencing the same resource ID.

`@adcp/sdk/server` adds:
- `createCtxMetadataStore({ backend })` — store with 16KB blob cap (`CTX_METADATA_TOO_LARGE`), 30-day max TTL, hard-fail on null/undefined `account_id`.
- `memoryCtxMetadataStore()` — single-process default (boot warns when `NODE_ENV=production` arrives in a follow-up; today the precedent matches `memoryBackend` for idempotency).
- `pgCtxMetadataStore(pool)` + `getCtxMetadataMigration()` + `cleanupExpiredCtxMetadata(pool)` — cluster path mirroring the idempotency PG layout. Composite PK on `scoped_key` flattened from `(account_id, kind, id)`; `bulkGet` uses `ANY($1::text[])` (no IN-list expansion).
- `stripCtxMetadata` / `WireShape<T>` — runtime + compile-time defense; closes the leak surface for adopters who include the field in handler returns.
- `ctx.ctxMetadata` accessor on `RequestContext` — auto-bound to `ctx.account.id`. Methods: `get(kind, id)`, `bulkGet(refs)`, `set(kind, id, value, ttl?)`, `delete(kind, id)`, plus per-kind shortcuts (`product(id)`, `mediaBuy(id)`, `package(id)`, `creative(id)`, `audience(id)`, `signal(id)`).
- Retrieved blobs carry a non-enumerable `[ADCP_INTERNAL_TAG]: true` symbol — won't survive `JSON.stringify`, automatic defense against accidental serialization in error envelopes / log lines.
- `createAdcpServerFromPlatform({ ctxMetadata })` opt — pass the store; framework threads the per-account accessor into every handler's `ctx.ctxMetadata`.

Closes the gap LLM-generated platforms hit when re-deriving per-product GAM config on every `create_media_buy`. Designed against Prebid `salesagent`'s `implementation_config` pattern — ship the SDK-side cache so adopters don't have to write the side-DB themselves.

The downstream-discoverability layer (replace `product_id` with hydrated `product: Product & { ctx_metadata }` in `SellerCreateMediaBuyRequest`) lands in 6.2 — design captured in `docs/proposals/decisioning-platform-v6-1-ctx-metadata.md`. 6.1 ships the store + ctx accessor; 6.2 will replace the request-shape ID with the resolved object so LLMs see ctx_metadata in the function signature, not via a side accessor.

Backed by 5-expert review (ad-tech-protocol, security, dx, agentic-product, javascript-protocol). Field name `ctx_metadata` confirmed not colliding with any AdCP 3.0 wire field; spec note to be filed on `adcontextprotocol/adcp` reserving the convention before Python SDK locks the name.
