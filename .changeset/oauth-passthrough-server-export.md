---
'@adcp/sdk': patch
---

chore(server): re-export `createOAuthPassthroughResolver` from `@adcp/sdk/server`. Aligns with the other decisioning-platform adopter helpers (`composeMethod`, `definePlatform*`, `resolve` presets, `InMemoryImplicitAccountStore`) so adopters writing a Shape B `accounts.resolve` don't have to remember the split between root and `/server`. Root export from `@adcp/sdk` remains for backwards compatibility.
