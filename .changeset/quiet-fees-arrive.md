---
'@adcp/sdk': major
---

Upgrade the bundled AdCP protocol schemas and generated SDK surfaces to 3.1.5.

Cancellation policies now require `rate` for `percent_remaining` fees and `amount` for `fixed_fee` fees. Generated TypeScript and Zod schemas preserve these conditional requirements as a discriminated union. Existing TypeScript callers constructing these fee variants must supply the corresponding value field. The update also incorporates the 3.1.5 protocol documentation and compatibility metadata corrections, and verifies signed protocol bundles with Cosign during generated-file CI checks.
