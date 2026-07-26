---
'@adcp/sdk': major
---

Make canonical creatives the primary SDK contract. Product discovery now drops
legacy `format_ids` by default, outbound delivery projects canonical creatives
only at a proven legacy boundary, and modern server platform handlers normalize
legacy inputs before adopter code runs. Add an explicit custom-format converter
for seller-owned legacy refs that cannot be mapped by the bundled registry.
Raw named-format utilities, response builders, v5 handler-bag types, and the
content-standards adapter now use explicit `Legacy` / `legacy` public names.
The legacy create/update/sync compatibility methods normalize custom formats
through configured converters at the same fail-closed canonical boundary.
Pre-resolved publisher/community catalog snapshots participate through exact
owner-scoped aliases, and same-client route caching survives JSON product
round trips without exposing legacy identifiers. Products with no canonical
option are omitted because canonical `format_options: []` is not schema-valid
and surface sanitized non-fatal errors in the protocol `errors[]` array. A
valid legacy format-agnostic `format_ids: []` response uses the distinct
`CANONICAL_PRODUCT_FORMATS_UNAVAILABLE` advisory rather than pretending a
catalog lookup failed.
