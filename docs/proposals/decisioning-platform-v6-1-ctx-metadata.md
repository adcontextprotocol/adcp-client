# DecisioningPlatform v6.1 — `ctx_metadata` opaque-blob round-trip

## Status

Locked. 5-expert review converged 2026-04-29 (ad-tech-protocol, security, dx, agentic-product, javascript-protocol). Ships in 6.1.0 alongside the existing 6.0 surface; additive, no breaking changes for adopters who don't return `ctx_metadata`.

## Problem

Publishers building AdCP servers carry per-resource platform-specific state — GAM `ad_unit_ids` per product, GAM `order_id` per media buy, line item ID per package, custom creative template config per creative. The AdCP wire spec doesn't model these (correctly — they're adapter-internal). Today's options for the publisher:

1. **Re-derive on every call.** Every `create_media_buy` referencing a product has to look up the product's GAM config from the publisher's own DB. Works, but every single AdCP-generated platform repeats the same boilerplate.
2. **Persist in the publisher's own DB indexed by AdCP IDs.** Reference implementation pattern (Prebid `salesagent`'s `implementation_config` JSON column on the Product model). Works, but the publisher implementation includes a side-cache the SDK could provide for free.

Yahoo asked for a buyer-side equivalent (buyer carries an opaque token between calls). Buyer-side is strictly weaker: token becomes a public contract that can't be refactored, exfiltrates platform internals into buyer LLM context windows, breaks across DSP migrations. Server-side is the right boundary.

## Pattern

The SDK ships a `CtxMetadataStore` keyed by `(account_id, kind, id)` — opaque JSON blobs the publisher attaches to any returned resource. SDK persists, strips from buyer-facing wire payloads, and re-attaches on subsequent calls referencing the same ID.

The publisher sees one canonical field name everywhere — `ctx_metadata` — both on objects they receive (SDK-attached from prior calls) and on objects they return (SDK persists). Symmetric in/out.

```ts
// Publisher returns from getProducts:
return {
  products: [
    { product_id: 'syn-abc', name: '...', ctx_metadata: { gam: { ad_unit_ids: [...] } } }
  ]
};
// SDK extracts ctx_metadata, persists by (account.id, 'product', 'syn-abc'), strips from wire.

// Buyer's next call: create_media_buy({ packages: [{ product_id: 'syn-abc' }] })
// SDK enriches the request before invoking the publisher's handler:
async createMediaBuy(req, ctx) {
  for (const pkg of req.packages) {
    // pkg.product is the fully resolved Product with ctx_metadata attached:
    const adUnits = pkg.product.ctx_metadata?.gam?.ad_unit_ids;
  }
}
```

## Locked decisions

### Wire shape

1. **Field name `ctx_metadata`** — does not collide with any AdCP 3.0 wire field (verified across `core/`, `signals/`, `creative/`, `media-buy/`, `property/`, `governance/`, `brand/` schemas). `ext` is buyer-visible vendor-namespaced; `context` is caller-echoed. Neither fits. New name correct.
2. **Reserve via non-binding spec note on `adcontextprotocol/adcp`.** Two SDKs converging on the same field name by accident is interop debt. One paragraph in the spec turns it into a convention. File before the Python SDK locks the name.
3. **All AdCP 3.0 resource schemas already declare `additionalProperties: true`** — adopting `ctx_metadata` as a top-level key is forward-compatible at the wire level. SDK accepts it from publishers without schema churn.

### Hydration shape

4. **Replace ID with hydrated object on the request, in place.** No second `hydrated` parameter (rejected — duplicates resource references in two locations, signature smell). The SDK transforms the request before invoking the publisher's handler:

   ```ts
   // Wire: { packages: [{ product_id: 'p1', impressions: 1000 }] }
   // Publisher's view (SellerCreateMediaBuyRequest):
   type SellerRequestPackage = Omit<RequestPackage, 'product_id'> & {
     product: Product & { ctx_metadata?: TCtxMeta['product'] };
     // product.product_id is on the resolved object — ID lives in one place
   };
   ```

   For requests that reference a single resource (e.g., `update_media_buy { media_buy_id }`), SDK attaches `ctx_metadata` directly on the request:

   ```ts
   // Wire: { media_buy_id: 'mb-1', packages: [...] }
   async updateMediaBuy(req, ctx) {
     const orderId = req.ctx_metadata?.gam_order_id;
     for (const pkg of req.packages) {
       const lineItemId = pkg.ctx_metadata?.gam_line_item_id;
     }
   }
   ```

5. **Symmetric on the response side.** Publisher attaches `ctx_metadata` to returned resources; SDK extracts and persists. Same field name, both directions. One concept.

6. **`ctx.ctxMetadata.product(id)` accessor is the rare escape hatch**, not the primary path. For cross-resource lookups where the request doesn't reference the target (e.g., `getMediaBuyDelivery` wanting per-package state when packages aren't filter inputs).

### Type system

7. **Opt-in typed generic via `DecisioningPlatform<TConfig, TMeta, TCtxMeta>`** and `RequestContext<TAccount, TCtxMeta>`. Default `TCtxMeta = DefaultCtxMeta` where every kind defaults to `unknown`. Adopters who specify slot types get autocomplete and type-narrowing through the request shape:

   ```ts
   class GamPlatform implements DecisioningPlatform<GamConfig, GamMeta, {
     product: { gam: { ad_unit_ids: string[]; targeting_keys: Record<string, string[]> } };
     media_buy: { gam_order_id: string };
     package: { gam_line_item_id: string };
   }> { ... }
   ```

8. **Wire-strip via `WireShape<T>` type AND runtime shallow-walk**, not either. Compile-time `Omit<T, 'ctx_metadata'>` catches the common case; runtime walk catches custom-handler escape hatches and HITL task return values that re-introduce the field at runtime. **Single chokepoint** in `from-platform.ts` dispatch — strip runs *before* the idempotency cache write so replays don't leak.

### Storage

9. **Backends:** `memoryCtxMetadataStore()` (default) + `pgCtxMetadataStore(db)` (cluster) — mirror `src/lib/server/idempotency/backends/` exactly. `getCtxMetadataMigration()` DDL helper, `probe()` boot-time readiness check.

10. **Composite key flattened to `scoped_key TEXT PRIMARY KEY`** as `${accountId}${kind}${id}` — same trick the idempotency store uses. Postgres TEXT rejects NUL; U+001F separator is rejected by ID-shape allowlist.

11. **`account_id` hard-fail on null/undefined/empty.** No-account tools (`provide_performance_feedback`, `list_creative_formats`) cannot use `ctx_metadata`. Falling back to a sentinel (`'undefined'`, `''`) collapses tenants A and B both writing `(undefined, 'product', 'syn-abc')` into a cross-tenant leak. Hard-fail is the right answer; document it in JSDoc on the relevant handlers.

12. **`bulkGet` via `WHERE scoped_key = ANY($1::text[])`** (single param, no SQL expansion, no parameter-count limit). Don't expand `IN ($1, $2, ...)` dynamically.

13. **Last-write-wins upsert.** `INSERT ... ON CONFLICT DO UPDATE`. No JSONB partial merge — publishers treat `ctx_metadata` as opaque blobs they own end-to-end; partial merges silently corrupt platform-internal structures the SDK can't validate.

14. **`expires_at` optional, NO auto-eviction.** A media buy lifetime can be months; auto-evicting would be a bug, not a feature. Cap TTL at 30 days max to prevent unbounded retention drift. Cleanup is adopter-driven via `cleanupExpiredCtxMetadata(db)` helper, mirroring `cleanupExpiredIdempotency`.

### Safety

15. **16KB default blob size cap** at the `set()` boundary, returned as `CTX_METADATA_TOO_LARGE` with `recovery: 'terminal'`. Memory backend with no cap is a single-node DoS vector; Postgres JSONB performance dies at scale before disk does. Cap is per-`set()`, byte-counted on serialized JSON.

16. **Resource-id write guard.** When a handler attaches `ctx_metadata` to a resource in a read response (e.g., `getMediaBuys` returning a buy with `ctx_metadata` for ops-created buys SDK never saw), SDK only persists for IDs that appear in the response itself. A buggy or malicious handler attaching `ctx_metadata` keyed by an ID outside the response is dropped with a logger warning. Intra-tenant write-anywhere defense.

17. **Symbol tag `__adcp_internal: true` on retrieved blobs.** Symbols don't survive `JSON.stringify`, so an accidental `JSON.stringify(meta)` in error envelopes / log lines / agent-card payloads silently elides the blob. Defense-in-depth against LLM-context leaks (publisher reads stale `ctx_metadata`, throws, framework auto-serializes, blob ends up in the buyer's LLM prompt history).

18. **Memory backend in production: WARN at boot.** Asymmetric blast radius vs idempotency: silent ctx_metadata loss after rolling restart can run for weeks producing "package not found" errors on every API call. Idempotency precedent (no warn) is wrong for this surface. Gate via `NODE_ENV` allowlist `{test,development}` skip; ack via `ADCP_ALLOW_MEMORY_CTX_METADATA=1`.

19. **Redact `ctx_metadata.*` paths from default framework logger.** Adopters can override per-key for debugging; default is redacted.

### Universality

20. **Apply across ALL specialisms**, not just sales:
    - `SalesPlatform` — products, media_buys, packages
    - `CreativeBuilderPlatform` — creatives (build → refine workflow especially benefits)
    - `CreativeAdServerPlatform` — creatives
    - `AudiencePlatform` — audience segments
    - `SignalsPlatform` — signals
    - `BrandRightsPlatform` — rights grants
    - `GovernancePlatform` — property lists, collection lists, content standards

21. **Read-response set semantics replaces a separate "external metadata" admin API.** Publishers can attach `ctx_metadata` to any returned resource — including resources SDK never minted (ops-created buys surfaced via `getMediaBuys`). SDK persists from the read response; subsequent calls referencing those IDs get hydration. No separate `provideExternalCtxMetadata(buyId, value)` admin surface required.

## Implementation files

| File | Purpose |
|---|---|
| `src/lib/server/ctx-metadata/store.ts` | `CtxMetadataStore` interface, `createCtxMetadataStore()`, ID/account validation, 16KB cap |
| `src/lib/server/ctx-metadata/backends/memory.ts` | `memoryCtxMetadataStore()` |
| `src/lib/server/ctx-metadata/backends/pg.ts` | `pgCtxMetadataStore(db)`, `getCtxMetadataMigration()`, `cleanupExpiredCtxMetadata(db)` |
| `src/lib/server/ctx-metadata/wire-shape.ts` | `WireShape<T>` type + `stripCtxMetadata()` shallow-walk runtime defense |
| `src/lib/server/decisioning/runtime/from-platform.ts` | Hydrate-attach + persist + strip threading per method (single chokepoint) |
| `src/lib/server/decisioning/specialisms/sales.ts` | `SellerCreateMediaBuyRequest` etc. via `TCtxMeta` generic |
| `src/lib/server/decisioning/specialisms/creative-builder.ts` | refine workflow ctx_metadata wiring |
| `src/lib/server/decisioning/context.ts` | `RequestContext<TAccount, TCtxMeta>` widening + `ctxMetadata` accessor |
| `src/lib/server/decisioning/platform.ts` | `DecisioningPlatform<TConfig, TMeta, TCtxMeta>` widening |

## Testing matrix

- Round-trip across all 6 resource kinds (sales × {product, media_buy, package}, creative-builder × creative, audience, signal)
- TTL bounded at 30 days; >30d throws at `set()`
- Cross-tenant isolation: tenant A and tenant B both writing `(account_id, 'product', 'syn-abc')` produce two distinct rows, never returned to the wrong account
- Strip-on-wire: assert `ctx_metadata` never appears in MCP `structuredContent`, A2A `DataPart.data`, comply-test-controller responses, or idempotency cache replays — at any nesting level (top-level, package, creative, audience)
- 16KB cap → `CTX_METADATA_TOO_LARGE` (byte count on serialized JSON)
- `account_id` null/undefined/empty hard-fail
- Resource-id write guard: handler attaches `ctx_metadata` keyed by ID not in response → drop + warn
- Memory backend boot warn at `NODE_ENV=production` && missing ack env var
- Symbol-tag survives normalize-errors path: blob inadvertently passed to error details serializes as `{}` not full content

## Out of scope (deferred to 6.2)

- **Patch decomposition into atomic verbs for `update_media_buy`** — file as separate issue. Read-before-mutate diff against `getMediaBuy(buyId)` → SDK calls atomic `addPackage` / `removePackage` / `updatePackage`. Requires required `getMediaBuy(id)` primitive (not in 6.1 — error code discipline + ctx_metadata covers most storyboard failures without it).

- **`getMediaBuy(id)` as a required SalesPlatform method** — coupled to the patch-decomposition work above. Stays optional in 6.1.

## Migration

`@adcp/sdk` 6.0 → 6.1 is additive. Adopters who don't return `ctx_metadata` see no behavior change. Adopters who want to use it:

1. Wire a store: `const ctxMetadata = pgCtxMetadataStore(pool);` (or `memoryCtxMetadataStore()` for dev)
2. Pass to `createAdcpServerFromPlatform`: `{ platform, ctxMetadata }`
3. Run `getCtxMetadataMigration()` from bootstrap (Postgres only)
4. Attach `ctx_metadata` to resources in your handler returns; read it from incoming `req.product.ctx_metadata` / `req.ctx_metadata` / etc.

Optional: declare `TCtxMeta` slots on your `DecisioningPlatform` implementation for typed access.
