---
"@adcp/client": minor
---

Expose account management capabilities from get_adcp_capabilities response

The `AdcpCapabilities` type now includes an `account` field (type `AccountCapabilities`) populated when the seller declares account management settings in their capabilities response. Fields include:
- `requireOperatorAuth` — whether per-operator authentication is required
- `authorizationEndpoint` — OAuth endpoint for operator auth
- `supportedBilling` — billing models the seller supports
- `defaultBilling` — default billing when omitted from sync_accounts
- `requiredForProducts` — whether an account is required before calling get_products
