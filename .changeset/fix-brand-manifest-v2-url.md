---
"@adcp/client": patch
---

Fix v2 brand_manifest URL: use base domain instead of /.well-known/brand.json path, which may not exist on advertiser domains and caused "brand_manifest must provide brand information" errors from v2 servers like Magnite.
