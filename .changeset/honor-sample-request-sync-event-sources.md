---
'@adcp/client': patch
---

fix(testing): honor `step.sample_request` in storyboard `sync_event_sources` builder

The storyboard request builder for `sync_event_sources` ignored `step.sample_request` and always emitted a generated `test-source-${Date.now()}` id. Storyboards (e.g., `sales_catalog_driven`) that author a specific `event_source_id` hit the wire with the generated id on sync, while downstream `log_event` / `provide_performance_feedback` steps sent the authored id — producing `EVENT_SOURCE_NOT_FOUND` even though the handler was implemented correctly.

The builder now delegates to `step.sample_request` when present, matching the pattern used by `log_event`, `sync_catalogs`, `report_usage`, `list_creative_formats`, `get_rights`, and `sync_governance`.
