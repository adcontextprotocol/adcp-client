# Specialism: sales-social

Companion to [`../SKILL.md`](../SKILL.md). The SKILL.md baseline applies; this file covers only the deltas for `sales-social`.

Storyboard: `social_platform` (category `sales_social`, track `audiences`).

**`sales-social` is additive, not a replacement.** The storyboard's own metadata declares `interaction_model: media_buy_seller` with `capabilities: [sells_media, accepts_briefs, supports_non_guaranteed]` and lists Snap, Meta, TikTok, and Pinterest as example agents — all of which have product catalogs (ad formats, placements, audience offerings as products) AND accept media buys (campaigns with flights, budgets, ad sets). The storyboard only exercises the audience / catalog / native-creative / events / financials leg because the baseline buyer-flow is covered by `sales-non-guaranteed` (or `sales-guaranteed`). Claim BOTH specialisms and implement the full surface.

**Baseline tools still apply** — implement the full 11-tool [baseline surface](#the-baseline-what-every-sales--agent-must-implement). Highlights for social specifically:

- `get_products` — return your platform's ad formats, placements, and audience-targeting products
- `create_media_buy` — accept campaigns (ad sets / flights) with budgets, targeting, and package structure
- `update_media_buy`, `get_media_buys`, `get_media_buy_delivery` — campaign lifecycle and reporting
- `list_creative_formats`, `sync_creatives`, `list_creatives` — creative management

**Additional tools `sales-social` requires** (beyond baseline):

- `sync_accounts` with `account_scope`, `payment_terms`, `setup` fields — advertiser onboarding with identity verification setup_url when pending
- `list_accounts` with brand filter — buyers listing their accounts on your platform
- `sync_audiences` → returns `{ audiences: [{ audience_id, name, status: 'active', action: 'created' }] }` — buyer pushes audience segment definitions for platform match
- `sync_creatives` for platform-native assemblies with `{ creative_id, action, status: 'pending_review' }` — image + headline + description slots assembled into the native unit
- `log_event` → returns `{ events: [{ event_id, status: 'accepted' }] }` — server-side conversion events for attribution / optimization
- `get_account_financials` → returns `{ account, financials: { currency, current_spend, remaining_balance, payment_status } }` — prepaid-balance monitoring typical of walled gardens

**Method mapping in `createAdcpServerFromPlatform`:** every `sales-social` tool maps to a typed method on the platform object — no manual handler-bag grouping required:

| Wire tool | Platform field | Method |
|---|---|---|
| `sync_audiences` | `audiences` (`AudiencePlatform<TCtxMeta>`) | `audiences.syncAudiences` |
| `log_event` | `sales` (`SalesPlatform<TCtxMeta>`) | `sales.logEvent` |
| `sync_event_sources` | `sales` | `sales.syncEventSources` |
| `get_account_financials` | `accounts` (`AccountStore<TCtxMeta>`) | `accounts.getAccountFinancials` |
| `sync_accounts` | `accounts` | `accounts.upsert` |

(`sync_catalogs` → `sales.syncCatalogs` is only needed if you also claim `sales-catalog-driven` / `sales-retail-media` for DPA support.)

Declare `TCtxMeta` once as your advertiser-metadata shape (e.g., `interface SocialMeta { advertiserId: string; pixelId: string }`) on `DecisioningPlatform<Config, SocialMeta>` and every handler's `ctx.account.ctx_metadata` is fully typed — no casts needed.

When building inline with object literals, wrap both sub-objects with typed helpers to preserve typed `req` parameters in handler bodies:

```ts
createAdcpServerFromPlatform({
  capabilities: { specialisms: ['sales-social', 'sales-non-guaranteed', 'audience-sync'] as const, ... },
  accounts: { resolve: async (ref) => ..., upsert: async (refs) => ..., getAccountFinancials: async (req, ctx) => ... },
  sales: defineSalesPlatform<SocialMeta>({
    getProducts: async (req, ctx) => ...,  // req: GetProductsRequest ✓
    syncEventSources: async (req, ctx) => { const sources = req.event_sources ?? []; ... },
    logEvent: async (req, ctx) => ...,
    // ... other sales methods
  }),
  audiences: defineAudiencePlatform<SocialMeta>({
    syncAudiences: async (audiences, ctx) => { /* audiences: Audience[] ✓ */ },
    pollAudienceStatuses: async (ids, ctx) => ...,
  }),
}, opts);
```

**Don't** rip out `get_products` or `create_media_buy` when adding `sales-social` — you need them. The failure mode from doing so: buyers who discover your agent via `get_adcp_capabilities` expecting a media-buy seller hit immediate compliance failures when every baseline storyboard fails with "tool not registered," and your entire `sales-non-guaranteed` bundle regresses to 0/N passing.

**`log_event` projection onto walled-garden CAPIs.** Meta Conversions API, Snap CAPI, TikTok Events API, and similar surfaces require three projections that AdCP's wire shape doesn't carry verbatim: `event_type` → `event_name`, ISO 8601 `event_time` → UNIX seconds, and a hashed-identifier (`email_sha256` / `phone_sha256` / `external_id_sha256`) in `user_data`. See [SHAPE-GOTCHAS.md § 6](../../SHAPE-GOTCHAS.md#6-log_event-projection-for-walled-garden-capis) for the patterns. The `examples/hello_seller_adapter_sales_social.ts` reference adapter codifies all three; `createTranslationMap` (#1285) handles buyer→upstream id mapping when the buyer carries identifiers that need translation to upstream pixel-source / pixel-event-source ids.
