---
'@adcp/sdk': minor
---

Expose the AdCP 3.2 `error.buyer_reason` sub-object on the client-facing error surfaces.

- `AdcpErrorInfo.buyer_reason` and `ExtractedAdcpError.buyer_reason` now carry the buyer-safe `{ code, message }` when the producer populated it. `buildExtracted`, `extractAdcpErrorInfo`, and `extractAdcpErrorFromMcp` / `extractAdcpErrorFromTransport` all forward it; partial payloads (missing `code` or `message`, empty strings, non-object values) are dropped rather than surfaced as half-typed values a caller might render to a buyer.
- `AdcpStructuredError.buyer_reason` and `AdcpError` constructor option added so seller-side adopters can throw a coarse top-level code with a specific buyer-actionable classification. `adcpError()` (via `AdcpErrorOptions`) now accepts and emits `buyer_reason`; the framework's sync-throw projection (`projectThrownAdcpError`) and the two-layer error dispatcher (`sanitizePayloadError`, `PAYLOAD_ERROR_FIELDS`) both carry the field through to the wire. `BuyerRetryPolicy` overrides receive the field on the `error` argument and can key retry decisions on `error.buyer_reason?.code`; the default policy is unchanged — routing on `buyer_reason` is opt-in via override.
- `NormalizedError` and `normalizeError()` (`@adcp/sdk/server`) now carry `buyer_reason` too, so adopters projecting per-row batch errors through `normalizeErrors()` (`sync_creatives`, `sync_audiences`, `sync_accounts`, `report_usage`, `acquire_rights`) don't silently lose the field between their row objects and the wire.
- The `IDEMPOTENCY_CONFLICT` / `IDEMPOTENCY_IN_FLIGHT` envelope allowlists still strip `buyer_reason` — those wire-shape-restricted codes intentionally never carry a buyer-actionable classification.
