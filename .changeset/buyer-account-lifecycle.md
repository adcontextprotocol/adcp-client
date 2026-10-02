---
'@adcp/sdk': minor
---

Add a seller/caller-scoped buyer account registry with memoized provisioning, optional storage, account status repair, billing terms, and `auto`/`strict` account policies (#3093). The default policy remains `off` for existing callers. Add typed buyer-setup errors and an opt-in product cache that stores cache scope and feed/pricing versions together. Preserve `resolveAccount` pending-approval behavior.
