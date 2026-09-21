---
'@adcp/sdk': minor
---

Add a hardened buyer resolver for digest-pinned seller acceptance-policy catalogs, including schema and local reference integrity checks, explicit unresolved registry pins, product-profile classification, and capability-lifetime caching. URL credentials are now rejected by the shared SSRF-safe fetch boundary. Canonical references now reject malformed UTF-8 and duplicate JSON keys, and documents deeper than 256 JSON levels return the new `document_too_deep` error instead of being cloned.
