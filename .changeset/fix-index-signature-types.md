---
"@adcp/client": patch
---

Remove spurious index signature types from generated validation schemas

The `json-schema-to-typescript` library was incorrectly generating index signature types (e.g., `{ [k: string]: unknown }`) for schemas with `oneOf` and `additionalProperties: false`. This caused validation to allow arbitrary extra fields on requests like `update_media_buy` and `provide_performance_feedback`.

Changes:
- Added `removeIndexSignatureTypes()` function to post-process generated types
- Added `update_media_buy` and `list_creatives` schemas to the validation map
- Added tests for request validation with extra fields
