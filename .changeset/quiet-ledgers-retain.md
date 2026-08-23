---
'@adcp/sdk': major
---

Define a seven-day minimum retention and pruning contract for established-proposal completion tombstones, and allow production webhook publishers to bind trusted tenant scope after emitter construction.

Production servers that previously relied on the implicit `single-tenant` webhook namespace must now configure `webhooks.tenantScope` or resolve trusted account, session, or authentication scope for each request. Unscoped production emission fails before durable checkpointing or network delivery.
