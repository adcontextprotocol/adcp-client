---
"@adcp/client": patch
---

Fix schema validation for v2 pricing options in get_products responses

When servers return v2-style pricing options (rate, is_fixed, price_guidance.floor), schema validation now normalizes them to v3 format (fixed_price, floor_price) before validation. This ensures v2 server responses pass validation against v3 schemas.
