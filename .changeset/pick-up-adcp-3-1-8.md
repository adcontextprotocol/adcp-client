---
'@adcp/sdk': patch
---

Upgrade the bundled AdCP protocol schemas and generated SDK surfaces to 3.1.8.

This release expands the legacy-to-canonical creative mapping registry with `display_static` and twelve observed unsuffixed display size IDs. These formats now project deterministically to canonical image declarations while preserving exact dimensions when the legacy ID carries them. There are no wire-level schema changes from AdCP 3.1.7.

It also refreshes the generated AgenticAdvertising registry client types for relationship-trust metadata, live `brand.json` diagnostics, hosted record sources, and the current resolver limits and error responses.
