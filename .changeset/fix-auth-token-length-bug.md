---
'@adcp/client': patch
---

Fixed authentication bug where tokens shorter than 20 characters were incorrectly treated as environment variable names. The `auth_token_env` field now always contains the actual token value. For environment variable expansion, use shell substitution (e.g., `--auth $MY_TOKEN`).
