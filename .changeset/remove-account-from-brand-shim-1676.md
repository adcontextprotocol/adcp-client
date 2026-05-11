---
"@adcp/sdk": minor
---

Remove deprecated `account_from_brand` shim in `normalizeRequestParams` (#1676).

The shim silently fabricated `account.operator = brand.domain` when a `create_media_buy` call omitted `account`. This was semantically wrong for any caller with a buying-side intermediary, and caused compliance badges to certify requests with invented data rather than caller-supplied account semantics. With AdCP 3.0 GA (April 2026) sunsetting v2 support, the back-compat rationale no longer applies.

**Behavior change (two cases):**
1. `create_media_buy` with `brand.domain` but no `account` — previously fabricated `{ brand, operator: brand.domain }` (wrong for non-direct topologies); now throws `ValidationError`.
2. `create_media_buy` with neither `account` nor `brand` — previously fell through to seller-side schema rejection; now throws `ValidationError` client-side.

`create_media_buy` calls that omit `account` now throw `ValidationError` (exported as `ADCPValidationError`) with field `account`. Use `list_accounts` to discover an existing `account_id`, or `sync_accounts` to register a natural-key account (implicit-account sellers only).
