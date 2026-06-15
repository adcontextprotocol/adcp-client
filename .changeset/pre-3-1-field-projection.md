---
'@adcp/sdk': minor
---

feat: strip AdCP 3.1-only request fields when the negotiated target is pre-3.1

Sellers on AdCP 3.0 reject requests carrying 3.1-only fields. `BrandReference` is a closed object (`additionalProperties: false`) in every version, so the 3.1 inline overrides (`brand_kit_override`, `industries`, `data_subject_contestation`) are rejected by 3.0 sellers on `create_media_buy`, `sync_accounts`, and `get_products`. Separately, the `get_products` discovery webhook (`push_notification_config`, a 3.1 feature) caused the SDK to throw for pre-3.1 clients.

The client now omits these 3.1-only fields when the negotiated target is pre-3.1 (the client is pinned below 3.1, or the seller does not advertise 3.1 via `get_adcp_capabilities`), degrading gracefully:

- The outbound brand reference is reduced to its identity fields (`domain`, `brand_id`); the seller resolves the inline-override subset from `brand.json`.
- The auto-injected `get_products` discovery webhook is skipped (results are polled via `tasks/get`) instead of throwing. An explicit caller-supplied `push_notification_config` on a pre-3.1 client still throws (unchanged).
- Both are surfaced as `debug_logs` drift entries (warn, not silent drop).

The decision is keyed on `shouldOmit31Fields(clientVersion, sellerCapabilities)`, so it is correct for 3.0-pinned callers today and becomes per-seller automatically when a caller pins to 3.1.
