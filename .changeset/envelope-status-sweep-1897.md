---
'@adcp/sdk': patch
---

fix(server): stamp v3 envelope `status: "completed"` on every sync wire response at the dispatch chokepoint

`createAdcpServer`'s handler dispatcher now stamps the v3 protocol envelope's required `status: "completed"` field at the `finalize()` chokepoint, immediately before context/version injection. Closes the SDK-wide gap audit-missed in #1895 (which fixed only `get_adcp_capabilities`): `projectSync` returns `mapResult(result)` verbatim and 19 `*Response` helpers (`productsResponse`, `listAccountsResponse`, `listCreativeFormatsResponse`, `performanceFeedbackResponse`, `buildCreativeResponse`, `deliveryResponse`, `getMediaBuysResponse`, `listCreativesResponse`, `previewCreativeResponse`, `creativeDeliveryResponse`, `syncCreativesResponse`, `getSignalsResponse`, `activateSignalResponse`, `listPropertyListsResponse`, `listCollectionListsResponse`, `listContentStandardsResponse`, `getPlanAuditLogsResponse`, `reportUsageResponse`, plus `genericResponse` for the ~30 governance / SI / brand tools without a dedicated builder) all built `structuredContent: toStructuredContent(data)` with no envelope status. The storyboard step `v3_envelope_integrity/no_legacy_status_fields` only asserts on `get_adcp_capabilities` today; @kapoost's one-tool failure masked a SDK-wide gap that would have lit up the moment the assertion generalised.

Centralised at `finalize()` rather than per-helper so:

- The seam is single — every framework-registered tool inherits envelope conformance whether wrapped through `productsResponse`, `mediaBuyResponse`, `genericResponse`, the test-controller bridge's `wrap(merged)` rewrites, or future helpers added without remembering to stamp.
- The MediaBuyStatus/TaskStatus collision on `CreateMediaBuySuccess.status` / `UpdateMediaBuySuccess.status` / `cancelMediaBuyResponse`'s hard-coded `status: 'canceled'` is preserved verbatim: the chokepoint only stamps when `structuredContent.status` is missing, so a buy returning `status: 'active'` (valid `MediaBuyStatus`, not a valid `TaskStatus`) ships unchanged. The spec-level ambiguity at the same top-level key is filed for adcp.
- Error envelopes (`isError: true`) are skipped — their status semantics (`failed` / `rejected`) belong to the adcp_error path, not this seam.

Submitted envelopes (HITL handoff) keep their handler-set `status: 'submitted'`. Auto-registered `get_adcp_capabilities` continues to stamp via `capabilitiesResponse` directly (it bypasses `finalize()`); both layers reinforce.

Tracks adcp-client#1897. Sibling to adcontextprotocol/adcp#4877 (spec contract) and #1895 (narrow `get_adcp_capabilities` fix).
