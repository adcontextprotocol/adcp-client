---
"@adcp/sdk": patch
---

Strip `filters.pricing_currencies` from `get_products` requests sent to AdCP 3.0 sellers. This field is 3.1-only; 3.0 sellers return `UNSUPPORTED_FEATURE` and zero products when they receive it. The 3.0 version adapter now removes it before the request reaches the wire, so buyers using a currency filter no longer see empty product discovery against 3.0 sellers.
