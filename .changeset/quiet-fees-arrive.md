---
'@adcp/sdk': minor
---

Upgrade the bundled AdCP protocol schemas and generated SDK surfaces to 3.1.5.

Cancellation policy schemas now faithfully represent the existing documented requirement that `percent_remaining` fees include `rate` and `fixed_fee` fees include `amount`. Generated TypeScript and Zod schemas preserve these conditions as a discriminated union.

This intentionally ships as a minor SDK update because it corrects the machine-readable representation rather than introducing new protocol semantics: conformant payloads remain unchanged. TypeScript code that constructed nonconformant fee variants without the documented value field will require a targeted update, and the runtime Zod schema now rejects those variants.

The update also incorporates the 3.1.5 protocol documentation and compatibility metadata corrections, and verifies signed protocol bundles with Cosign during generated-file CI checks.
