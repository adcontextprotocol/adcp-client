---
'@adcp/sdk': patch
---

`createAdcpServer` and `createAdcpServerFromPlatform` now convert errors and task results that the framework builds itself to the release a caller is served, as DR-0024 requires. Before, a caller pinned below the server's release could receive fields its release does not define. Examples are AdCP 3.3's `error.mutation_outcome` on a 3.2 caller, and 3.2's `error.buyer_reason` on a 3.1 caller.

- **Errors.** Every error is converted against `core/error.json`, one release step at a time, with the same schema diff that task responses get. That covers the envelope `adcp_error` and each `errors[]` item, whether the framework built it (validation, version, idempotency, account and refusal errors) or a handler returned or threw it. The conversion runs before the two-layer mirror, so both layers agree. Declared-input rejections and the `tasks_get` polling tool get it too.
- **Error-classified responses.** A handler's `errors[]` arm, and any response whose `status` is `failed`, `rejected` or `canceled`, now go through the same response conversion as successful responses. Before, they skipped it.
- **Task polls.** `get_task_status` and `tasks_get` now convert the stored `result` of failed and rejected tasks, not only completed ones. They also convert a failed task's `error` summary.
- **Task webhooks.** The terminal task webhook's `result` is converted from the server's release to the release the originating request was served. That covers completed and rejected results, and the `errors[]` of a failed task.
- **`mutation_outcome` on `errors[]`.** At the server's release, a handler's standard-code `errors[]` item and the `errors[]` the framework mirrors from `adcp_error` now keep `mutation_outcome`. Before, both dropped it, so the two error layers disagreed.
- **Reporting.** Every removal is reported to `onVersionTranslation`, and in task webhooks to the logger, as `version_downgrade_fields_dropped` drift.

Responses to callers at the server's release are unchanged.
