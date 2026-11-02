---
'@adcp/sdk': minor
---

Sellers registering `request_account` (`accounts.requestAccount`) now advertise AdCP 3.3 `account.requests` on `get_adcp_capabilities`, with `request_task`, `read_task: 'list_accounts'` and the `account.requests` experimental feature id, so `client.accounts.ensure` routes to them. `capabilities.accountRequests` supplies `changeableAttributes`, `pendingActionKinds` and `eventType`. On the platform path, the new `accounts.listRequests(request, ctx)` hook serves the caller's requests as `account_requests[]` and `account_requests_pagination` on `list_accounts` when the buyer sends `include_requests`, `request_ids` or `requests_pagination`. `Account.revision` is now served on `list_accounts`, so buyers can read the revision a change is based on. Fixes #3575.

**Behavior change for 3.3 beta adopters:** a seller that registers `request_account` must declare who bills, because `account.requests` lives in the account capability block, whose schema requires `supported_billing`. A server that registers it without one is now refused at construction. Fix: add `capabilities: { account: { supportedBilling: ['agent'] } }` to `createAdcpServer`, or `capabilities.supportedBillings` on the platform path, with your actual billing model. The SDK never fills in this claim for you.
