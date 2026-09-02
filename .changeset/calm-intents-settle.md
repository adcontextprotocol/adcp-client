---
'@adcp/sdk': minor
---

Add a durable PostgreSQL task-settlement intent queue for atomically recording application outcomes before SDK task and webhook settlement. The queue provides immutable scoped bindings, caller-owned transaction participation, leased and fenced recovery, bounded retries and dead letters, payload sanitization, startup probing, and an explicit idempotent settlement callback.
