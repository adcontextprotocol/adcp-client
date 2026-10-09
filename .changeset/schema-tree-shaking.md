---
'@adcp/sdk': patch
---

Make generated Zod schemas individually tree-shakeable by marking their complete initializers pure. Browser consumers importing a single validator from `@adcp/sdk/schemas/browser` now retain only its dependencies. Portable cross-field validators, canonical and legacy get-products behavior, and existing ESM/CommonJS/type exports are preserved.
