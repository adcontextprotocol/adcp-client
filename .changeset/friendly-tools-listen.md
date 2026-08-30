---
'@adcp/sdk': patch
---

Keep legacy `get_products` responses usable when a canonical catalog also contains formats that have no legacy representation. The server now omits only unrepresentable products and reports their projection diagnostics in `errors[]` instead of failing the entire catalog response.
