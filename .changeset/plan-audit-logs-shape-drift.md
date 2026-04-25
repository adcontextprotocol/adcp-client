---
'@adcp/client': minor
---

feat(testing,server): shape-drift hint + response helper for `get_plan_audit_logs`

The storyboard runner's `LIST_WRAPPER_TOOLS` table now covers `get_plan_audit_logs`, so a handler that returns a bare `[{plan_id, …}]` array instead of `{ plans: [...] }` gets the targeted hint (`Use getPlanAuditLogsResponse() from @adcp/client/server`) alongside the AJV error.

`getPlanAuditLogsResponse(data, summary?)` is now exported from `@adcp/client/server` and `@adcp/client`, mirroring the existing list-tool helpers (`listPropertyListsResponse`, `listContentStandardsResponse`, …).

Note: the wrapper key is `plans`, not `logs` as issue #856's body claimed. Verified against `schemas/cache/3.0.0/governance/get-plan-audit-logs-response.json` and `tools.generated.ts:11542` — audit entries are bundled under each `plans[].entries[]` record. Closes #856.
