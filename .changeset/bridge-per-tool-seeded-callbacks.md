---
"@adcp/sdk": minor
---

Extend `TestControllerBridge` with per-tool seeded callbacks for platform-proxy sellers.

Adds `getSeededCreatives`, `getSeededMediaBuys`, `getSeededAccounts`, `getSeededAccountFinancials`, and `getSeededCreativeFormats` to `TestControllerBridge<TAccount>`. Each callback follows the same post-handler merge pattern as the existing `getSeededProducts`: opt-in by presence, controller-gated, sandbox-only, with warn-and-drop validation on bad fixtures.

Extends `bridgeFromSessionStore` with matching `selectSeeded*` options so session-store adopters get all five bridges in one helper call.

Exports the new merge helpers (`mergeSeededCreativesIntoResponse`, `mergeSeededMediaBuysIntoResponse`, `mergeSeededAccountsIntoResponse`, `mergeSeededAccountFinancialsIntoResponse`, `mergeSeededCreativeFormatsIntoResponse`), filter helpers, and type aliases (`SeededCreative`, `SeededMediaBuy`) from `@adcp/sdk/server`.

Resolves the proxy-seller conformance gap: DSPs, walled gardens, and retail-media networks whose read path proxies an upstream API can now inject seeded fixtures into storyboard runs without live upstream OAuth or per-adapter stub code.

**Scope of verification.** A storyboard pass through this bridge proves protocol conformance against fixture data (wire shape, error envelopes, idempotency, signed-request handling, sandbox stamping). It does **not** prove the seller's adapter against the real upstream platform works — that code path is bypassed by the post-handler merge. Sellers should pair this with a live-OAuth runner pointed at a deployed sandbox URL to cover adapter health. JSDoc on `TestControllerBridge` spells out the distinction in detail.

**Adopter trust boundary.** The sandbox gate is "request carries a sandbox marker AND (resolved account is sandbox OR no account was resolved)." Adopters who deploy this to a production binding **must** configure `resolveAccount` — otherwise the request-signal check is the only line of defense. Multi-tenant isolation is the adopter's job: callbacks receive `ctx.account` and must key their fixture store on it; the SDK does no defensive cross-check. Both warnings now appear in the `TestControllerBridge` top-of-file JSDoc.

**Pagination & count bookkeeping.** Merge helpers now bump `query_summary.total_matching` (creatives) and `pagination.total_count` (media-buys, accounts, formats) by the count of genuinely-new seeded entries — collisions don't double-count. `pagination.cursor` and `has_more` are left untouched: seeded entries land on the current page, and the handler's cursor (if any) still points to its next page. Storyboards that page through list responses will no longer hit `returned > total_matching` after a merge.

**Async-envelope guard.** Each merge helper now short-circuits when the handler returned a `{status:'submitted', task_id, ...}` or `{status:'working'}` async envelope rather than the synchronous success arm. Without the guard, the merge would spread list fields into an async envelope and produce an invalid hybrid wire shape. Reference-equal return signals the dispatcher to skip the re-wrap (re-wrapping the same payload can produce a subtly different `content[].text` summary).

**Dispatcher consolidation.** The six per-tool dispatcher branches in `createAdcpServer` collapse into a single table-driven `applySeededBridge` helper, which also emits a `debug` log when the sandbox-account gate rejects a sandbox-flagged request (adopters chasing "why aren't my fixtures showing" now have a diagnostic surface).

**New export.** `SeededAccount = ListAccountsResponse['accounts'][number]` for symmetry with `SeededCreative` and `SeededMediaBuy`.
