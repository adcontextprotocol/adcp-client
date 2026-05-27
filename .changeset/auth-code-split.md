---
'@adcp/sdk': minor
---

Document the AdCP 3.1 `AUTH_MISSING` / `AUTH_INVALID` split while keeping deprecated `AuthRequiredError` wire-compatible with `AUTH_REQUIRED`. The decisioning runtime also refreshes once on `AUTH_MISSING` when `AccountStore.refreshToken` is configured, attaching the refreshed upstream token to a request-local account clone before retrying.
