---
'@adcp/sdk': minor
---

Support AdCP 3.1.0-rc.7 schema updates, account authorization projection, scoped task-status aliases, and authorization-required detail sanitization.

Task registries now persist an `ownerScope` for buyer-visible polling isolation. Built-in registries set it for new tasks and keep legacy ownerless rows readable only through the old account-fallback scope; custom persistent registries should backfill or persist `ownerScope` before exposing `get_task_status` / `list_tasks` in shared-account multi-tenant deployments.
