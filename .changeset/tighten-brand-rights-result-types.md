---
'@adcp/client': minor
---

fix(server): tighten handler return types so schema drift fails `tsc`

Two related tightenings close #727 (B).

**1. `AdcpToolMap` brand rights results.** `acquire_rights`,
`get_rights`, and `get_brand_identity` had `result: Record<string,
unknown>` — a stale scaffold from before the response types were
code-generated. Replaced with the proper generated types:

- `acquire_rights` → `AcquireRightsAcquired | AcquireRightsPendingApproval | AcquireRightsRejected`
- `get_rights` → `GetRightsSuccess`
- `get_brand_identity` → `GetBrandIdentitySuccess`

**2. `DomainHandler` return type.** The handler return union
previously included `| Record<string, unknown>` as a general escape
hatch, so any handler could return any shape. Sparse returns like
`{ rights_id, status: 'acquired' }` passed `tsc` and only failed at
wire-level validation. Handler return type is now just
`AdcpToolMap[K]['result'] | McpToolResponse`, so drift fails at
compile time. `adcpError(...)` still works — it returns
`McpToolResponse`.

**Migration.** If a handler returns a plain object literal without
spelling out the full success shape, `tsc` will now flag the drift
with an error like:

```
Type '{ products: [{ product_id: 'p1' }] }' is not assignable to type
'McpToolResponse | GetProductsResponse'.
  Property 'reporting_capabilities' is missing in type
  '{ product_id: 'p1' }' but required in type 'Product'.
```

Two ways to fix:

- Fill in the missing required fields to match the AdCP schema (what
  the wire-level validator would have demanded anyway). Use
  `DEFAULT_REPORTING_CAPABILITIES` for `Product.reporting_capabilities`
  if you don't have seller-specific reporting policy yet.
- If you genuinely need a loose return (e.g. a test fixture), wrap
  with a response builder — `productsResponse({ ... })`,
  `acquireRightsResponse({ ... })`, etc. The builders accept typed
  inputs so the drift surfaces there instead of silently passing
  through.

**Reference agents.** `test-agents/seller-agent.ts` now uses
`DEFAULT_REPORTING_CAPABILITIES` on each product (the old code had
a "Use plain objects instead of Product type" comment whose premise
was wrong — `reporting_capabilities` is required, not optional).
`test-agents/seller-agent-signed-mcp.ts` had a latent bug:
`createMediaBuy` was reading `pkg.package_id` from the request, but
`PackageRequest` has no such field — buyers send `buyer_ref` and
the seller mints `package_id` per spec. The handler now mints
`crypto.randomUUID()` like a real seller would.
