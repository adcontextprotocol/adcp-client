---
'@adcp/sdk': patch
---

Deprecate schema re-exports from the root package and `@adcp/sdk/types` in favor of the dedicated `@adcp/sdk/schemas` subpath. This keeps backwards compatibility while documenting lower-footprint import paths for large TypeScript monorepos.
