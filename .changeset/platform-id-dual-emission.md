---
'@adcp/sdk': patch
---

Emit AdCP 3.3 platform identifiers under both names on `sync_event_sources` and `sync_audiences` rows. AdCP 3.3 renames the row's `seller_id` to `platform_id` and keeps `seller_id` as a deprecated alias; a 3.3 response that reports the identifier MUST carry both with identical values.

- **Seller:** whichever name a handler returns, the server sends both to callers served 3.3 or later and `seller_id` alone below 3.3, for `createAdcpServer` and `createAdcpServerFromPlatform`, including idempotent replays of responses cached before this change. Task results are stored as the seller wrote them, and every reader gets the names its release defines: `get_task_status`, `tasks_get`, completion webhooks and push settlement (bound or application-managed). That covers results an adopter completes directly through `TaskRegistry.complete()` and rows stored before this change. A new 3.3→3.2 response adapter carries `platform_id` as `seller_id`. Two different values are refused: the sync response is `INTERNAL_ERROR`, a handed-off task fails with `INTERNAL_ERROR`, `TaskRegistry.complete()` throws without storing, and push settlement rejects the result. Settlement intent fingerprints and other task types are unchanged.
- **Buyer:** new `platformIdOf(row)` (from `@adcp/sdk` and `@adcp/sdk/utils`) returns `platform_id`, else `seller_id`, so it also reads 3.2 sellers' rows.
