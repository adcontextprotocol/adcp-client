---
'@adcp/sdk': minor
---

Bump AdCP schema pin to 3.1.2 and regenerate types.

- **Delivery metrics accept `null` for "not applicable" video-only fields.** `DeliveryMetricsSchema.completion_rate` and `quartile_data` now accept `null` alongside their existing type, and `get_media_buy_delivery`'s `aggregated_totals.completion_rate` gets the same loosening. Sellers running non-video inventory (display, audio-only, DOOH-without-video) legitimately return `null` as the "not applicable" signal. The `[0, 1]` bound still applies to non-null `completion_rate` values, and the type stays narrowed to `null` (no strings/arrays). The loosening propagates to every `get_media_buy_delivery` `totals` / `by_package` row via the shared schema.
- **`ActivateSignalRequest.governance_context`** — new optional field carried in the 3.1.2 schema for signal-activation governance flows.
