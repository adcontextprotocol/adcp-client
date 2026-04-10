---
"@adcp/client": minor
---

Fix SSE transport fallback, schema validation, and compliance testing detection

- Track successful StreamableHTTP connections and skip SSE fallback on reconnection (prevents 405 errors on POST-only servers)
- Add async response variants (Working, Submitted, InputRequired) to create_media_buy and update_media_buy validation schemas
- Improve union schema error messages with field-level detail instead of generic "Invalid input"
- Auto-augment declared capabilities with tool-derived protocols (comply_test_controller → compliance_testing)
- Fix brand_rights storyboard sample_requests to match protocol schemas (brand_id, rights_id, context flow)
- Consolidate ResponseValidator schema map with canonical TOOL_RESPONSE_SCHEMAS
