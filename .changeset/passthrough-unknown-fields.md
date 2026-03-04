---
"@adcp/client": minor
---

Generated Zod object schemas now use `.passthrough()` so unknown fields from agent responses are preserved instead of stripped. Consumers who receive catalog items or other objects with platform-specific extra fields no longer lose those fields after validation.
