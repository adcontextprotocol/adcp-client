---
'@adcp/sdk': minor
---

Add `parseMediaBuyDeliveryWebhook` for already-authenticated delivery reports (#3461). Validate the envelope and result separately at the caller's trusted AdCP release, including the 3.0 report-schema fallback, and return readable schema paths. Bare reports remain rejected by default; explicit compatibility mode returns `wireFormat: 'bare_delivery_report'` without synthesizing an envelope.

Reuse the parser for registered reporting deliveries after signature verification, with a per-call `adcpVersion` option. Add a shared `MediaBuyDeliveryReport` type and payload-only Zod schema for polled and pushed ingestion, restore required webhook row fields such as `by_package`, and expose schema-ref validators with opt-in complete diagnostics. Document that report notification type and envelope task status are independent; full polling response schemas retain their inherited required task status.

Registered reporting failures now distinguish invalid results (`webhook_result_invalid`) from invalid envelopes and unsupported payloads. Prepare reporting schema configuration before consuming signature nonces, and derive routing metadata from the trusted callback registration while preserving the seller's original envelope IDs.
