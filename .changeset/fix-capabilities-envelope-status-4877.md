---
'@adcp/sdk': patch
---

fix(server): emit envelope `status: "completed"` on all v5 sync response helpers

Extends the fix originally scoped to `capabilitiesResponse` (#4877) across the full non-collision surface. 19 additional `*Response` helpers in `src/lib/server/responses.ts` were building `structuredContent: toStructuredContent(data)` with no envelope-level status, producing the same `v3_envelope_integrity/no_legacy_status_fields` conformance failure on every tool they serve.

Fixed helpers: `productsResponse`, `deliveryResponse`, `listAccountsResponse`, `listCreativeFormatsResponse`, `getMediaBuysResponse`, `performanceFeedbackResponse`, `buildCreativeResponse`, `previewCreativeResponse`, `creativeDeliveryResponse`, `listCreativesResponse`, `listPropertyListsResponse`, `listCollectionListsResponse`, `listContentStandardsResponse`, `getPlanAuditLogsResponse`, `syncCreativesResponse`, `getSignalsResponse`, `activateSignalResponse`, `cancelMediaBuyResponse`, `reportUsageResponse`.

`mediaBuyResponse` and `updateMediaBuyResponse` are intentionally excluded — their `MediaBuyStatus.status` payload field collides with the envelope `status` field; those are blocked on adcontextprotocol/adcp#4876 (spec-side disambiguation).

Fixes adcontextprotocol/adcp#4877 (original `get_adcp_capabilities` gap). Refs adcontextprotocol/adcp-client#1897 (full surface audit). Reported by @kapoost (`@adcp/sdk@7.7.0`, adcontextprotocol/adcp#4832).
