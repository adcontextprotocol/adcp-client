---
'@adcp/sdk': patch
---

Return schema-enforced `sync_accounts` notification event-type failures per account, as required by AdCP, instead of rejecting the whole request. Invalid accounts never reach the handler; valid siblings are processed in order, and replay retains the full original request and combined result. When `delete_missing` is true, reject every entry without dispatching the roster so invalid accounts cannot be deactivated as omitted. Other schema errors continue to use request-level validation.
