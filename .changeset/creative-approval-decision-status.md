---
'@adcp/sdk': patch
---

`creative_approval` webhook responses no longer put an AdCP 3.0 decision in `status` (#3777).

- `legacyCreativeApprovalApproved` / `legacyCreativeApprovalRejected` / `legacyCreativeApprovalPendingReview` (and the same builders in `@adcp/sdk/server/legacy/v5`) added `status: 'approved' | 'rejected' | 'pending_review'` on top of `approval_status`. That payload is invalid on AdCP 3.1 and later, and a `rejected` creative read as a rejected task. They now emit `approval_status` and `status: 'completed'`. `approval_status` is now optional in their input, since each builder sets it.
- `projectResponseForRelease('creative_approval', body, servedAdcpVersion)` from `@adcp/sdk/adapters/version` now moves `approval_status` back to `status` for an AdCP 3.0 buyer. Before, it returned the task status `completed` and dropped the decision. The webhook request carries no `adcp_version`, so record `ctx.servedAdcpVersion` with the rights grant at `acquire_rights` and project with it.
- The brand-rights docs now name the exported builders.
