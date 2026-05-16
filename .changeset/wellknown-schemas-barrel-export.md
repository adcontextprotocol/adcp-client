---
'@adcp/sdk': patch
---

fix(sdk): re-export BrandJson and AdagentsJson types from main barrel

The `wellknown-schemas.generated.ts` module emits `BrandJson` / `AdagentsJson` (inferred types) and `BrandJsonSchema` / `AdagentsJsonSchema` (runtime Zod validators) for the brand.json and adagents.json well-known formats, but at 7.1.0–7.2.0 those exports were unreachable from `@adcp/sdk` — only `@adcp/sdk/types` and `@adcp/sdk/testing` carried them. Consumers doing `import type { BrandJson } from '@adcp/sdk'` (e.g. `adcontextprotocol/adcp` `server/src/types.ts:1`, see adcp#4604) failed with `TS2305: Module '"@adcp/sdk"' has no exported member 'BrandJson'`.

#1740 fixed this in the `src/lib/types/index.ts` sub-barrel and the main barrel picks it up transitively via `export * from './types'`. This change pins the contract explicitly at `src/lib/index.ts` so it is visible at the top-level public API surface and not dependent on the sub-barrel's wildcard re-export, plus adds a smoke test asserting both the runtime exports and the `.d.ts` type declarations resolve from `dist/lib/index.{js,d.ts}`.
