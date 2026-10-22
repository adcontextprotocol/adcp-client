---
'@adcp/sdk': minor
---

Follow-ups to AdCP version translation (adcp-client#3370):

- **Server visibility.** New `createAdcpServer({ onVersionTranslation })` callback, called each time the framework converts a request up from, or a response down to, an older buyer's release. Each event gives the tool, direction, both releases, and every removed or moved field with its JSON path. A throwing callback is logged and ignored. The `AdcpVersionTranslationEvent` type is exported from `@adcp/sdk/server`.
- **`get_task_status` results** are now converted down by their `task_type` for a buyer polling on an older release, as synchronous responses already were.
- **`sync_creatives` to a 3.1 seller.** `assignment_operations` made up only of `assign` operations is rewritten as 3.1 `assignments`, appended after any `assignments` the request already carries, with `validation_mode: 'strict'` unless the caller set a mode. This keeps 3.2's all-or-nothing behavior. `unassign` and `replace` have no 3.1 form and are still refused before sending.
- **`report_plan_outcome` to a 3.1 seller** is still refused rather than moved. 3.2 `cumulative_spend` is lifetime spend for the governed action, while 3.1 `spend` is spend in the reporting period, and the client cannot tell when the two coincide.
