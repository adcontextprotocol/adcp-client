---
'@adcp/sdk': patch
---

feat(decisioning): extend multi-id truncation dev-mode warn to `listCreatives`, `getCreativeDelivery`, and `getSignals`. Closes #1410.

The warn shipped in 6.7 for `getMediaBuyDelivery` and `getMediaBuys` (`media_buy_ids[]`); the same `<id_field>[0]`-truncation hazard applies to every read-by-id surface. The extension fires when adopters' platforms return fewer rows than the buyer's `creative_ids[]` / `signal_ids[]` filter requested, with the same gates: silent in `NODE_ENV=production`, suppressible via `ADCP_SUPPRESS_MULTI_ID_WARN=1`, no-op when the id-array filter is omitted (paginated-list mode).

Wired at four new dispatch sites in `from-platform.ts`:

- `listCreatives` — both the sales-side dispatch (when `SalesPlatform` provides it) and the creative-side ad-server dispatch.
- `getCreativeDelivery` — creative-side ad-server only.
- `getSignals` — note `signal_ids` is `SignalID[]` (`{source, data_provider_domain, id}` objects), not bare strings; the helper compares on length only so the element type is irrelevant.

The helper signature gains a typed `idFieldName` parameter so the warn message names the right id field (`media_buy_ids` / `creative_ids` / `signal_ids`); the existing two call sites pass `'media_buy_ids'` explicitly.

Sync / upsert surfaces (`syncCreatives`, `syncCatalogs`, `syncPlans`) remain out of scope per the issue carve-out — those have a different shape where pass-through is the obvious pattern and "did all rows roundtrip?" isn't a clean question.

The 6 existing tests in `test/server-decisioning-multi-id-truncation-warn.test.js` still pass; one new test pins the `getSignals` wiring (the distinctive `SignalID[]` object-array shape).
