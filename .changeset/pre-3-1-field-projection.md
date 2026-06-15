---
'@adcp/sdk': minor
---

feat: strip AdCP 3.1-only request fields when the negotiated target is pre-3.1

`BrandReference` is a closed object (`additionalProperties: false`) in every AdCP version. The 3.1 inline override `brand_kit_override` was added in AdCP 3.1 and does not exist in the 3.0 schema — 3.0 sellers reject requests carrying it. `industries` and `data_subject_contestation` are declared in AdCP 3.0 GA and are accepted by 3.0 sellers; they are left on the wire. Separately, the `get_products` discovery webhook (`push_notification_config`, a 3.1 feature) caused the SDK to throw for pre-3.1 clients.

The client now omits 3.1-only fields when the negotiated target is pre-3.1 (the client is pinned below 3.1, or the seller does not advertise 3.1 via `get_adcp_capabilities`), degrading gracefully:

- `brand_kit_override` is stripped from outbound brand references on `create_media_buy`, `sync_accounts`, and `get_products`; identity fields (`domain`, `brand_id`) and 3.0 fields (`industries`, `data_subject_contestation`) are preserved.
- The auto-injected `get_products` discovery webhook is skipped (results are polled via `tasks/get`) instead of throwing. An explicit caller-supplied `push_notification_config` on a pre-3.1 client still throws (unchanged).
- Both are surfaced as `debug_logs` drift entries (`pre31_brand_fields_stripped`, `pre31_webhook_degraded`) so the drops are visible and not silent.

The brand strip is keyed on `shouldOmit31Fields(clientVersion, sellerCapabilities)` — correct for 3.0-pinned callers today and per-seller when a caller pins to 3.1. The webhook suppression is keyed on the client pin only (`isPre31AdcpVersion`), since suppression runs before `detectServerVersion` populates seller caps.
