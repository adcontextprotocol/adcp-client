---
'@adcp/sdk': patch
---

Accept RFC 3339 date-times with numeric UTC offsets in generated AdCP task/core Zod schemas, matching the AdCP JSON Schema format validation. This includes Python UTC timestamps ending in `+00:00` and fractional seconds with offsets. Validation now follows the existing `ajv-formats` date-time predicate, which also accepts lowercase separators, space separators, and leap seconds.
