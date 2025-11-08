---
"@adcp/client": patch
---

Fix auth token resolution bug where tokens shorter than 20 characters were treated as environment variable names. Added explicit `--auth` (direct token) and `--auth-env` (environment variable) flags to remove ambiguity.
