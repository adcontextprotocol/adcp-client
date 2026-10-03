---
'@adcp/sdk': minor
---

Add a seller/caller-scoped buyer account registry with memoized provisioning, optional storage, account status repair, billing terms, and `auto`/`strict` account policies (#3093). The default policy remains `off` for existing callers: `resolveAccount()` keeps the 14.0 behavior of sending `sync_accounts` on every call and returning the natural key, and the memoized registry backs it only when you set `accountPolicy`, `accountStorage`, `accountRegistryScope`, or `accountRegistryMaxEntries`. Add typed buyer-setup errors and an opt-in product cache that stores cache scope and feed/pricing versions together. Preserve `resolveAccount` pending-approval behavior.
