---
'@adcp/sdk': patch
---

Project account ID controller targets to core account references before resolution. Resolvers no longer receive the controller-only `sandbox` assertion on ID refs. Unexpected resolver failures now return a safe `SERVICE_UNAVAILABLE` error and never admit through the sandbox fallback; return `null` or throw `AccountNotFoundError` for missing accounts. The sandbox authority gate remains fail closed.
