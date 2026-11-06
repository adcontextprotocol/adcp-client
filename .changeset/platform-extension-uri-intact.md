---
'@adcp/sdk': patch
---

Keep `format_schema.uri` and `platform_extensions[].uri` intact in `stripLegacyCreativeIdentity`. A platform extension URI is based on its owning agent's URL, so a product that also carried a legacy `format_ids` entry for that agent came back with `[legacy creative identity]` in place of its schema URI and failed `get_products` validation, including `canonical_formats` fixture discovery (#3592). Legacy identity keys are still removed and other strings are still sanitized.
