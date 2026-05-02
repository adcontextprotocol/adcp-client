---
'@adcp/sdk': minor
---

feat(server): enforce documented `accounts.resolution: 'implicit'` refusal of inline `account_id` references. Previously aspirational — the docstring at `AccountStore.resolution` claimed the framework would refuse, but enforcement wasn't wired. The framework now emits `AdcpError('INVALID_REQUEST', { field: 'account.account_id' })` before reaching the adopter's `accounts.resolve` when an `'implicit'`-resolution platform receives an `{ account_id: ... }` reference. The brand+operator union arm is permitted (used during the initial `sync_accounts` flow). Adopters no longer need to reimplement the same `if (ref?.account_id) return null` branch in every Shape A platform.

Same change additionally improves the dispatcher's `resolveAccount` / `resolveAccountFromAuth` error projection: thrown `AdcpError` instances now propagate verbatim to the wire envelope (matching the existing tool-handler unwrap), instead of being coerced to `SERVICE_UNAVAILABLE`. Generic exceptions still map to `SERVICE_UNAVAILABLE` to keep upstream-leak protection intact. Closes #1364.
