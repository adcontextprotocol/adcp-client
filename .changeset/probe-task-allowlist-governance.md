---
"@adcp/sdk": patch
---

Widen `PROBE_TASK_ALLOWLIST` to include governance specialism read-only tools (`list_property_lists`, `list_collection_lists`, `list_content_standards`), fixing `security_baseline` grade failures for agents that expose only governance endpoints.
