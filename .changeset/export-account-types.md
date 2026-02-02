---
"@adcp/client": patch
---

Export Account domain types from main entry point

- `Account` - billing account interface
- `ListAccountsRequest` - request params for listing accounts
- `ListAccountsResponse` - response payload with accounts array

The types existed in tools.generated.ts but weren't explicitly exported from @adcp/client.
