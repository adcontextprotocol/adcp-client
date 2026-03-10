---
"@adcp/client": minor
---

Remove `account_resolution` field from capabilities schema. Account model is now derived entirely from `require_operator_auth`: `true` means explicit accounts (discover via `list_accounts`), `false` means implicit accounts (declare via `sync_accounts`).
