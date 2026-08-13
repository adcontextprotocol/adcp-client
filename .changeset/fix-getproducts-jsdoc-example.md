---
"@adcp/sdk": patch
---

docs(sdk): fix getProducts JSDoc examples to use schema-valid requests

All `getProducts` JSDoc examples now include the required `buying_mode` field and omit `promoted_offering`, which is not a defined field on `GetProductsRequest`. Affected files: `SingleAgentClient`, `AgentClient`, and `testing/test-helpers`.
