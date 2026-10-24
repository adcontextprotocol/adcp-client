---
'@adcp/sdk': patch
---

Accept RFC 3339 date-times with numeric UTC offsets in all generated Zod schemas, matching the AdCP JSON Schema format validation. This includes Python UTC timestamps ending in `+00:00` and fractional seconds with offsets.
