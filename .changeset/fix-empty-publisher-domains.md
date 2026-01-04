---
"@adcp/client": patch
---

Fix validation error when agents return empty publisher_domains array

The JSON Schema defines `minItems: 1` for publisher_domains, which caused validation to fail when agents returned empty arrays. This is a common scenario when an agent isn't authorized for any publishers yet.

The fix relaxes the generated TypeScript types and Zod schemas to accept empty arrays by:
- Removing `minItems` constraints during TypeScript type generation
- Converting tuple patterns (`z.tuple([]).rest()`) to arrays (`z.array()`) in Zod schema generation

This change improves interoperability with real-world agents that may return empty arrays for optional array fields.

