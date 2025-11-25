---
"@adcp/client": patch
---

Fix Zod schema validation to accept null values for all optional fields. Updated the schema generator to apply `.nullish()` globally to all optional schema fields, allowing both `null` and `undefined` values where TypeScript types permit.
