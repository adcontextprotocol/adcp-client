---
'@adcp/sdk': patch
---

A caller pinned to AdCP 3.0 now receives each task's decision in the 3.0 `status` field. AdCP 3.1 renamed these fields off `status` without changing their values. Converting a response down to 3.0 dropped the 3.1 field and left the task status `completed` in its place. The affected fields are `check_governance` `verdict`, `report_plan_outcome` `outcome_state`, `acquire_rights` `rights_status`, and each `get_plan_audit_logs` check entry's `verdict`. A 3.0 caller could not tell `approved` from `denied`, and strict response validation rejected the response.

The 3.0 conversion now moves the decision into `status` and reports a `pre31_decision_status_moved` drift. A response that carries only the task status `completed` and no decision has that status removed, so it is never read as a decision. The conversion applies to tool responses, task polls and task webhooks.

The dispatcher now classifies a handler's outcome before the response is converted, at the server's release, where a decision is not the task status. At 3.0, a business outcome in `status` (a rejected `acquire_rights`, or a media buy whose `media_buy_status` is `rejected` or `canceled`) used to read as a failed task. Strict response validation skipped it, and its idempotency claim was released, so a retry with the same key ran the handler again. Such a response is now validated, cached and replayed with `replayed: true`, as it already was at 3.1 and later.

Fixes #3743.
