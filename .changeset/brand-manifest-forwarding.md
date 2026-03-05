---
"@adcp/client": patch
---

Preserve brand_manifest through request normalization so agents that require it receive it. The normalizer now derives brand from brand_manifest without deleting it.
