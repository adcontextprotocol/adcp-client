---
'@adcp/sdk': patch
---

Add `@adcp/sdk/schemas/browser` for validating AdCP objects in browser widgets and dashboards. The ESM and CommonJS entry points export the generated Zod schemas and portable get-products request, bidding-policy, budget-allocation, and strict sync-creatives validators without importing Node built-ins. Shared validators preserve the Node entry's behavior, including the canonical and legacy get-products selectors. The existing `@adcp/sdk/schemas` entry retains its JSON Schema loading and tool registration APIs.
