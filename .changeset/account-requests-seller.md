---
'@adcp/sdk': minor
---

Sellers registering `request_account` (`accounts.requestAccount`) now advertise AdCP 3.3 `account.requests` on `get_adcp_capabilities`, with `request_task`, `read_task: 'list_accounts'` and the `account.requests` experimental feature id, so `client.accounts.ensure` routes to them. `capabilities.accountRequests` supplies `changeableAttributes`, `pendingActionKinds` and `eventType`. On the platform path, the new `accounts.listRequests(request, ctx)` hook serves the caller's requests as `account_requests[]` and `account_requests_pagination` on `list_accounts` when the buyer sends `include_requests`, `request_ids` or `requests_pagination`. Fixes #3575.
