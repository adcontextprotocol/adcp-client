---
'@adcp/sdk': minor
---

Reliable Reporting: enforce AdCP's `pagination.max_results` bounds in the reporting handlers (#3213). `createReportingStatusHandler` (`get_reporting_status`) and `createReportingDeliveryHandler` (`get_media_buy_delivery` exact revision reads) accepted up to 500, defaulted to 100 and also read a non-AdCP `pagination.limit`, while `core/pagination-request.json` allows an integer from 1 to 100 with a default of 50. A request could return 500 rows from a seller on this SDK and be refused by one that validates the schema.

The bounds and the default now come from the pinned release's `core/pagination-request.json`, not from literals in the handler, so a schema change carries through. `pagination.max_results` outside the bounds (or not an integer) is refused with `VALIDATION_ERROR` and `field: 'pagination.max_results'`, before any ledger read and, for exact revision reads, before a legacy revision reader is consulted. The `pagination.limit` fallback is gone.

This ships as a minor, not a patch, because it can fail a request that used to succeed. The surface is `@experimental`, and a caller sending `max_results` of 101 to 500 was already sending a schema-invalid request, but it got a page before and gets an error now.

**Migration note.**

- A buyer or host calling these handlers with `max_results` from 101 to 500 must send at most 100 and page with the returned cursor. `@adcp/sdk`'s own consumers already send 100 or omit it.
- A request without `max_results` now returns pages of 50 rows or items, not 100, as the schema's default says. Consumers that follow `pagination.cursor` see more pages and no other difference. A consumer that assumed one page of up to 100 for a small revision should page.
- Remove any `pagination.limit` from requests; it is not an AdCP field and is ignored.
