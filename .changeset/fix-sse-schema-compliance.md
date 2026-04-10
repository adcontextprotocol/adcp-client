---
"@adcp/client": minor
---

Fix SSE transport fallback, schema validation, and compliance testing detection

- Track successful StreamableHTTP connections and skip SSE fallback on reconnection (prevents 405 errors on POST-only servers)
- Improve union schema error messages with field-level detail instead of generic "Invalid input"
- Consolidate ResponseValidator to use canonical TOOL_RESPONSE_SCHEMAS map
- Auto-augment declared capabilities when comply_test_controller is present but compliance_testing protocol is not declared
- Fix brand_rights storyboard sample_requests to match protocol schemas (brand_id, rights_id, context flow)
