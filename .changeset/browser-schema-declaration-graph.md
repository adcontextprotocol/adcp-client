---
'@adcp/sdk': patch
---

fix(schemas): keep `@adcp/sdk/schemas/browser` type declarations inside browser-safe modules

The emitted declarations for `GetProductsRequestSchema`, `LegacyGetProductsRequestSchema` and the strict `sync_creatives` validators named nested generated types through the root `@adcp/sdk` barrel, so type-checking a browser app against `@adcp/sdk/schemas/browser` loaded the signing stack and, when installed, about 500 `redis` / `@redis/*` declaration files. Those schemas now carry explicit types that reference the generated schema module, and `CanonicalGetProductsRequest` is declared in a leaf module (still exported from the same public paths). The browser entry's declaration graph drops from roughly 680 files to 13, with `zod` as its only external package. A new test resolves `@adcp/sdk/schemas/browser` and `@adcp/sdk/media-buy/actions` through TypeScript's ESM and CommonJS resolution and fails if either reaches the root barrel, `signing/`, `server/`, or any package other than `zod`. Runtime JavaScript is unchanged. Fixes #3635.
