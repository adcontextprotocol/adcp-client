---
'@adcp/sdk': minor
---

Support AdCP 3.1.0-rc.7 schema updates, account authorization projection, scoped task-status aliases, and authorization-required detail sanitization.

Task registries now persist an `ownerScope` for buyer-visible polling isolation. Built-in registries set it for new tasks and keep legacy ownerless rows readable only through the old account-fallback scope; custom persistent registries should backfill or persist `ownerScope` before exposing `get_task_status` / `list_tasks` in shared-account multi-tenant deployments.

The server also tightens error handling around task polling and typed error arms. Registry-resolution failures in `tasks_get` now return `SERVICE_UNAVAILABLE` instead of warning and falling through, malformed handler-returned `errors[]` entries now fail closed as `VALIDATION_ERROR`, and standard-code error envelopes are projected through the safe-field allowlist so adopter-supplied top-level extras are not echoed on the wire.
