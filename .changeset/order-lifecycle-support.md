---
"@adcp/client": minor
---

Support order lifecycle management from AdCP spec.

- Cancellation fields on media buys and packages (`canceled`, `canceled_at`, `canceled_by`, `cancellation_reason`)
- `confirmed_at` timestamp on create and get responses
- `revision` for optimistic concurrency on create, get, and update
- `valid_actions` on responses so agents know permitted operations per state
- `include_history` parameter and revision history on `get_media_buys`
- Per-package `creative_deadline` for mixed-channel orders
- 6 new error codes: `INVALID_STATE`, `NOT_CANCELLABLE`, `MEDIA_BUY_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `VALIDATION_ERROR`, `BUDGET_EXCEEDED`
- `CanceledBy` enum type (`buyer` | `seller`)
- Updated governance middleware for upstream schema changes (`governance_context` now opaque string, `buyer_campaign_ref` removed from governance requests)
