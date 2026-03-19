---
"@adcp/client": patch
---

Fix `get_products` responses with non-array `products` field crashing downstream consumers. Added Zod schema validation for `get_products` responses in the response unwrapper and updated `normalizeGetProductsResponse` to convert malformed responses to AdCP error responses instead of silently passing through.
