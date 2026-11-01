---
'@adcp/reporting-storage': patch
---

The production service refuses `subscriptions.principal` without `notifications` with a message naming the fix. `@adcp/sdk` now lets development storage omit it; PostgreSQL storage still needs a delivering runtime.
