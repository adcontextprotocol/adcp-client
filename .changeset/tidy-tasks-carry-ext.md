---
'@adcp/sdk': minor
---

Add optional `TaskHandoffOptions.ext` and `TaskRecord.ext` so adopters can attach a vendor-namespaced `ext` object to the submitted task envelope and have it projected on `get_task_status`, `tasks_get` and `list_tasks` reads.
