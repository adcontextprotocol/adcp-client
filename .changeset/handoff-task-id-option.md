---
"@adcp/sdk": minor
---

feat(server): ctx.handoffToTask accepts optional task_id override

Adds `options?: { task_id?: string }` to `ctx.handoffToTask(fn, options?)`.
When `options.task_id` is set, the framework uses that exact string as the
submitted task_id instead of minting a fresh one. Validates non-empty, ≤ 128
characters. Closes #1554.

Required for the `force_create_media_buy_arm` comply_test_controller scenario,
which asserts the seller echoes the directive-supplied task_id verbatim on
the create_media_buy submitted arm.
