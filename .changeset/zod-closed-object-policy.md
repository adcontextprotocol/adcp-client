---
'@adcp/sdk': patch
---

Document the 17.x policy for exported Zod schemas of objects that AdCP 3.3 keeps closed (#3679). Most of them are `.passthrough()` in 17.0, so they accept unknown keys that the published schema rejects; the SDK's JSON Schema validation already rejects those keys. A 17.x minor may make these schemas `.strict()` wherever AdCP 3.3 keeps the object closed, while objects AdCP leaves open stay `.passthrough()`. Don't rely on Zod accepting a vendor key in a closed object such as `commercial_terms` or a metric `qualifier`: put extensions in `ext`. See "Unknown keys and closed objects" in `docs/ZOD-SCHEMAS.md`. No code changes.
