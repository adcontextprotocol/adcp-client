---
'@adcp/sdk': patch
---

Pre-ship round 2: auto-hydration error contract + 6.0 migration cheatsheet.

## Auto-hydration error contract (ask #1)

Pinned the documented contract for stale/missing references in `hydrateSingleResource` JSDoc and the migration guide:

- Hydration miss does NOT cause `MEDIA_BUY_NOT_FOUND` / `PRODUCT_NOT_FOUND` etc. The framework cache is a hint, not a source-of-truth check.
- On a miss the handler runs anyway with `target[attachField]` undefined.
- Adopters who want strict existence checks implement them in the handler (with the typed error classes — `MediaBuyNotFoundError`, etc.).

New contract test in `test/server-auto-hydration-extended.test.js` pins the behavior: handler IS called on miss, framework does NOT synthesize an error response.

## 6.0 migration cheatsheet (ask #3)

`docs/migration-5.x-to-6.x.md` gains a top-level "tl;dr — five breaking changes to search-replace" table covering:

1. `Account.metadata` → `Account.ctx_metadata`
2. `@adcp/sdk/server/decisioning` → `@adcp/sdk/server`
3. `createAdcpServer` → `createAdcpServerFromPlatform` (or `@adcp/sdk/server/legacy/v5`)
4. `TMeta` → `TCtxMeta` generic param
5. `getMediaBuys` required on `SalesPlatform`

Plus a one-shot search-replace recipe block for adopters who skipped rounds 11–14 and face the cumulative diff at GA.

## Note on ask #2 (already shipped)

`resolveIdempotencyPrincipal` already takes `IdempotencyPrincipalParams` — a typed shape with `account?: { account_id?, brand?, sandbox? }` and `brand?: { domain? }` extending `Record<string, unknown>`. Adopters scoping by `params.account?.account_id` or `params.brand?.domain` get autocomplete + narrowing without a cast. See `src/lib/server/create-adcp-server.ts:681-686` and the signature at line 1230.
