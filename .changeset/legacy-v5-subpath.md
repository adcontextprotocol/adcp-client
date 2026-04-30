---
'@adcp/sdk': minor
---

feat(server): `@adcp/sdk/server/legacy/v5` subpath for the v5 handler-bag constructor. Adopters mid-migration or pinning to v5 long-term (custom `tools[]`, `mergeSeam`, `preTransport` middleware) import `createAdcpServer` from the subpath; new code keeps reaching for `createAdcpServerFromPlatform` from `@adcp/sdk/server`. Top-level re-export keeps working with its existing `@deprecated` JSDoc tag.

Closes #1081.
