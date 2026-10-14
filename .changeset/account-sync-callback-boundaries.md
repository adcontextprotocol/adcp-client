---
'@adcp/sdk': patch
---

Await and validate keyed-account principal callbacks so asynchronous tenant identities cannot collapse into a shared scope. Protect account-sync request and dry-run intent from callback mutation across CAS retries, and isolate asynchronous diagnostic-hook failures from dispatch.
