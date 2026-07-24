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
