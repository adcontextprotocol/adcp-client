---
'@adcp/sdk': minor
---

Expose `syncAccounts`'s `beforePreparedDispatch` callback so buyers can durably bind the complete prepared tool arguments to their original idempotency key before the account write is sent. Webhook-generated arguments must remain stable for same-key retries to match the digest.
