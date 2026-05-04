---
"@adcp/sdk": patch
---

Adds `list_property_lists`, `list_collection_lists`, and `list_content_standards` to the `PROBE_TASK_ALLOWLIST` in the storyboard runner. These governance read-only tools have all-optional request parameters and satisfy the three allowlist criteria (auth-required, read-only, accept empty body), so adopters running per-specialism governance tenants can now declare them as `test_kit.auth.probe_task` without the runner rejecting the kit.

`get_brand_identity` and `get_rights` are intentionally excluded: both have required fields (`brand_id` and `query`/`uses` respectively), so an empty-body probe would receive a schema-validation 400 before the auth layer runs, causing `security_baseline` to misreport auth failures.
