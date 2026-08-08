---
'@adcp/sdk': patch
---

Include migration guides in the published package so README links work for installed consumers.

Add `mergeSeedProductLegacy` to `@adcp/sdk/testing` as an explicit typed entry point for raw legacy product fixtures. It delegates to the existing product seed merge behavior and preserves the input subtype.
