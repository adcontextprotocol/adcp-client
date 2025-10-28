---
"@adcp/client": patch
---

Fixed Zod schema generation failures and made generation errors fatal. Previously, `ts-to-zod` was failing to generate 19 schemas (including `GetProductsRequestSchema` and `GetProductsResponseSchema`) due to cross-file dependency issues. Now all 82 schemas generate successfully and failures exit with error code 1 to catch issues early.
