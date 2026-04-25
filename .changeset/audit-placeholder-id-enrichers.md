---
'@adcp/client': patch
---

Audit storyboard request-builder enrichers for placeholder-id clobber
pattern (closes #989).

**Findings from the 12-site audit:**

`get_content_standards` keeps `'unknown'` — `standards_id` is required
by `GetContentStandardsRequestSchema` (no `.optional()`), so returning
`{}` would violate the schema round-trip invariant. The `'unknown'`
placeholder correctly triggers a clean NOT_FOUND when context lacks a
real id, surfacing the authoring gap. This differs from `get_media_buys`
(fixed in #983/#988) where `media_buy_ids` is optional.

All other `'unknown'` placeholders in mutating writes (`update_media_buy`,
`calibrate_content`, `check_governance`, `update_content_standards`,
`validate_content_delivery`, `acquire_rights`, `update_rights`,
`creative_approval`, `si_send_message`, `si_terminate_session`) are
correct: they produce a clean NOT_FOUND, surfacing "wire context_outputs
from the create step."

**Code change:** Four mutating-write enrichers used `'test-creative'` as
the creative/artifact-id fallback. Unlike `'unknown'`, `'test-creative'`
could be silently accepted by a pre-seeded test agent, masking an
authoring error. Standardised all four to `'unknown'` for consistency:

- `report_usage` — `creative_id`
- `calibrate_content` — `artifact_id`
- `validate_content_delivery` — `artifact_id`
- `creative_approval` — `creative_id`

**Tests:** Added 3 unit tests for `get_content_standards` to
`test/lib/request-builder.test.js` (unknown fallback, context injection,
fixture wins).
