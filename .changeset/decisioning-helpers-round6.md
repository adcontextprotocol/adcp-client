---
"@adcp/sdk": minor
---

Add `batchPoll`, `validationError`, `upstreamError`, and `RequestShape` helpers to `@adcp/sdk/server/decisioning`.

These lift boilerplate patterns that every v6 adopter writes identically in their adapter layer: the `pollAudienceStatuses` Map-collection loop, buyer-correctable validation error construction, upstream 5xx/rate-limit projection, and the index-signature-stripping cast for v5-era task fn back-compat.
