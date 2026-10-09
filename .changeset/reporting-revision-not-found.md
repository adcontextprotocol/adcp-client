---
'@adcp/sdk': patch
---

Fix exact `get_media_buy_delivery` reads in `createReportingDeliveryHandler` returning `SERVICE_UNAVAILABLE` (transient, retry) for references that will never resolve. An unknown, unauthorized, row-expired or compacted `reporting_revision_id`, and a tampered or unusable pagination cursor, now return the same nondisclosing `REFERENCE_NOT_FOUND` with `field: "reporting_revision_id"`, so buyers stop retrying and the response never reveals whether a revision exists for another account. A missing `reporting_revision_id` is now a `VALIDATION_ERROR`. Integrity failures on a retained revision (missing or corrupt rows, row count that disagrees with the committed binding) still return `SERVICE_UNAVAILABLE`.
