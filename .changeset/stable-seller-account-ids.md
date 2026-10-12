---
'@adcp/sdk': minor
---

Use seller-issued account IDs across account-scoped buyer requests when the seller declares `account.stable_account_id`, with `accountReferenceMode: 'natural-key'` as a compatibility override. Add opt-in detailed `resolveAccount` results and scoped registry/storage lookup by ID while preserving existing return types and legacy natural-key routing. Gate creative sync on active provisioning and require an account for strict discovery on stable-ID sellers.
