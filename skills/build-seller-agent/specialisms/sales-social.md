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
- `sync_catalogs` → product catalog push for dynamic product ads (Meta DPA, Snap Dynamic Ads, TikTok Dynamic Showcase). The storyboard's catalog-item macros (`{SKU}`, `{GTIN}`) resolve per-impression at render time.
- `sync_creatives` for platform-native assemblies with `{ creative_id, action, status: 'pending_review' }` — image + headline + description slots assembled into the native unit
- `log_event` → returns `{ events: [{ event_id, status: 'accepted' }] }` — server-side conversion events for attribution / optimization
- `get_account_financials` → returns `{ account, financials: { currency, current_spend, remaining_balance, payment_status } }` — prepaid-balance monitoring typical of walled gardens

**Handler grouping in `createAdcpServer`:** `sync_audiences`, `sync_catalogs`, and `log_event` live under `eventTracking`, NOT `mediaBuy`. `get_account_financials` and `sync_accounts` live under `accounts`. Baseline `get_products`/`create_media_buy`/etc. stay under `mediaBuy`.

**Don't** rip out `get_products` or `create_media_buy` when adding `sales-social` — you need them. The failure mode from doing so: buyers who discover your agent via `get_adcp_capabilities` expecting a media-buy seller hit immediate compliance failures when every baseline storyboard fails with "tool not registered," and your entire `sales-non-guaranteed` bundle regresses to 0/N passing.

