---
"@adcp/client": patch
---

Fix creative sync validation errors by correcting format field name and structure

Multiple locations in the codebase were incorrectly using `format` instead of `format_id` when creating creative assets for sync_creatives calls. This caused the AdCP agent to reject creatives with validation errors: "Input should be a valid dictionary or instance of FormatId".

**Fixed locations:**
- `src/public/index.html:8611` - Creative upload form
- `src/public/index.html:5137` - Sample creative generation
- `scripts/manual-testing/full-wonderstruck-test.ts:284` - Test script (also fixed to use proper FormatID object structure)

All creatives are now properly formatted according to the AdCP specification with the correct `format_id` field containing a FormatID object with `agent_url` and `id` properties.
