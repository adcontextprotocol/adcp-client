---
"@adcp/client": patch
---

Update sandbox account descriptions to clarify behavior by account model. Implicit accounts declare sandbox via sync_accounts with sandbox: true. Explicit accounts discover pre-existing sandbox test accounts via list_accounts. Testing framework now tries explicit sandbox discovery before falling back to natural key.
