---
'@adcp/sdk': patch
---

fix(schemas): keep `@adcp/sdk/schemas/browser` type declarations browser-safe

Type-checking a browser app against `@adcp/sdk/schemas/browser` (or `@adcp/sdk/schemas`) no longer loads the SDK's root barrel, signing stack, `@types/node`, or Node-only packages such as `redis`, `undici` and `ajv`. Previously `LegacyGetProductsRequestSchema`, `GetProductsRequestSchema` and the strict `SyncCreatives*` validators named their types through Node-only modules, which added hundreds of declaration files to `tsc` and, with `skipLibCheck: false`, failed with `Cannot find module '@opentelemetry/api'` or missing `express` types. The browser entry's declarations now depend only on browser-safe SDK modules and `zod`, and a test guards that for `@adcp/sdk/schemas/browser` and `@adcp/sdk/media-buy/actions`.

Declaration emit for `SyncCreativesItemSchema.extend(...)` and `SyncCreativesSuccessStrictSchema.extend(...)` no longer fails with TS7056. `CanonicalGetProductsRequest` is now exported as a type from both schema entries, so adopters can emit declarations for schemas built from `GetProductsRequestSchema.extend(...)`. Runtime JavaScript and existing import paths are unchanged. Fixes #3635.
