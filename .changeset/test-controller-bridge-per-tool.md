---
'@adcp/sdk': minor
---

feat(testing): per-tool seeded callbacks on `TestControllerBridge` for platform-proxy sellers (closes #1002)

`TestControllerBridge` previously exposed only `getSeededProducts`, leaving platform-proxy sellers (DSPs, walled gardens, retail-media networks) without a way to feed seeded fixtures into the read path of every other read tool — storyboard seeds against `seed_creative` / `seed_media_buy` were dead writes when the adapter proxied to upstream APIs.

Extends `TestControllerBridge<TAccount>` with five opt-in callbacks mirroring `getSeededProducts` (post-handler merge, sandbox + resolved-account + controller-present gating, warn-and-drop validation, never throws):

- `getSeededCreatives(ctx)` → merged into `list_creatives` (dedup by `creative_id`)
- `getSeededMediaBuys(ctx)` → merged into `get_media_buys` (dedup by `media_buy_id`)
- `getSeededAccounts(ctx)` → merged into `list_accounts` (dedup by `account_id`)
- `getSeededAccountFinancials(ctx)` → replaces `get_account_financials` envelope when seeded `account.account_id` matches the request (singleton response, replace semantics)
- `getSeededCreativeFormats(ctx)` → merged into `list_creative_formats` (dedup by canonical `format_id.agent_url|format_id.id`)

`BridgeFromSessionStoreOptions` gains matching `selectSeeded*` selectors so adopters wiring storyboards via the session-store pattern get all bridges in one helper. Per-tool callbacks are omitted from the returned bridge when no selector is provided.

Production traffic is unchanged: bridges run only on sandbox-flagged requests against a registered controller.
