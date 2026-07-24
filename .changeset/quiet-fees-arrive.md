---
'@adcp/sdk': minor
---

Upgrade the bundled AdCP protocol schemas and generated SDK surfaces to 3.1.5.

Cancellation policy schemas now faithfully represent the existing documented requirement that `percent_remaining` fees include `rate` and `fixed_fee` fees include `amount`. Generated TypeScript and Zod schemas preserve these conditions as a discriminated union. This corrects the machine-readable representation rather than introducing new protocol semantics. The update also incorporates the 3.1.5 protocol documentation and compatibility metadata corrections, and verifies signed protocol bundles with Cosign during generated-file CI checks.
