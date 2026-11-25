---
'@adcp/sdk': patch
---

`creative_approval` webhook responses no longer put an AdCP 3.0 decision in `status` (#3777).

- `legacyCreativeApprovalApproved` / `legacyCreativeApprovalRejected` / `legacyCreativeApprovalPendingReview` (and the same builders in `@adcp/sdk/server/legacy/v5`) added `status: 'approved' | 'rejected' | 'pending_review'` on top of `approval_status`. That payload is invalid on AdCP 3.1 and later, and a `rejected` creative read as a rejected task. They now emit `approval_status` and `status: 'completed'`. `approval_status` is now optional in their input, since each builder sets it.
- `projectResponseForRelease('creative_approval', body, release)` from `@adcp/sdk/adapters/version` now gives an AdCP 3.0 buyer the decision in `status`. Before, it returned the task status `completed` and dropped the decision. A body without a decision, such as the error arm, loses `status` at 3.0, where that arm forbids it. Take `release` from the request's `adcp_version`. A 3.0 buyer sends none, so fall back to `ctx.servedAdcpVersion` recorded with the rights grant at `acquire_rights`.
- The brand-rights docs now name the exported builders.
