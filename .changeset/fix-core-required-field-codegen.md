---
'@adcp/sdk': minor
---

Tighten generated canonical delivery-metric and postal-system authoring types to match their JSON Schemas. Code using those standalone canonical types must now provide `content_id`, `keyword`, `match_type`, `geo_level`, `geo_code`, `country`, and `system` where the protocol requires them; the generated postal-system Zod validator now enforces the same contract.

Buyer-side `GetMediaBuyDeliveryResponse` types retain response-local optional compatibility aliases for legacy sellers that omit the newer currency, package pricing, and breakdown identifier fields. Existing canonical delivery-metric exports from `@adcp/sdk/types/tools.generated` remain available as strict re-exports.
