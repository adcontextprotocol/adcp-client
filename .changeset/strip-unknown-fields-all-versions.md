---
"@adcp/client": patch
---

Fix schema-based field stripping to apply for all server versions, not just v3. Fields like idempotency_key and ext that are not declared in the remote server's tool schema are now stripped before sending, preventing validation errors on servers that don't accept them.
