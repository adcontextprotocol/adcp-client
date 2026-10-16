---
'@adcp/sdk': minor
---

Reliable Reporting: enforce AdCP's `pagination` bounds in the reporting handlers (#3213). `createReportingStatusHandler` (`get_reporting_status`) and `createReportingDeliveryHandler` (`get_media_buy_delivery` exact revision reads) accepted `pagination.max_results` up to 500, defaulted it to 100 and also read a non-AdCP `pagination.limit`, while `core/pagination-request.json` allows an integer from 1 to 100 with a default of 50. The same request could return 500 rows from a seller on this SDK and be refused by one that validates the schema.

The bounds and the default now come from the pinned release's `core/pagination-request.json`, not from literals in the handler, so a schema change carries through (and a release that defines none fails when the handler is created, not on a request). `pagination.max_results` outside the bounds or not an integer, a `pagination` that is not an object, and a `cursor` that is not a string are refused with `VALIDATION_ERROR` (`field: 'pagination.max_results'`, `'pagination'` or `'pagination.cursor'`) before any ledger read and, for exact revision reads, before a legacy revision reader is consulted. The `pagination.limit` fallback is gone.

The buyer-side walkers (`reconcileReporting`'s ledger and row walks, and `drainReportingChangesV1`) now ask for `max_results: 100`, the schema maximum, instead of relying on the seller's default, so they keep their reach and round trips against a seller that applies the schema default of 50.

This ships as a minor. It is a protocol-conformance fix to stable handlers whose signatures do not change, and the requests it refuses were already schema-invalid. It can still fail a request that used to succeed and changes the default page size, so a patch would understate it, and a major would be out of proportion to a fix that brings the handlers to what the pinned schema already requires. `docs/guides/REPORTING-STABILITY.md` puts the buyer-visible behavior under AdCP's own versioning.

**Migration note.**

- A buyer or host calling these handlers with `max_results` from 101 to 500 must send at most 100 and follow `pagination.cursor`.
- A request without `max_results` now returns pages of 50 rows or items, not 100, as the schema's default says. A consumer that assumed one page of up to 100 for a small revision should follow the cursor. `@adcp/sdk`'s own consumers send 100 explicitly.
- Remove `pagination.limit` from requests; it is not an AdCP field and is ignored.
- A custom `ReportingReconciliationClient.getMediaBuyDelivery` now receives `pagination: { max_results: 100, cursor? }`; its `pagination` parameter type gains an optional `max_results`.
