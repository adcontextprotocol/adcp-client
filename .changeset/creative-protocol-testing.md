---
'@adcp/client': minor
---

Add comprehensive creative protocol testing with testCreativeLifecycle scenario

- Implements full creative workflow testing: list_formats → sync_creatives (multi) → list_creatives (with/without snapshot) → build_creative
- Adds snapshot field validation with coverage for as_of, staleness_seconds, impressions, last_served fields
- Validates snapshot_unavailable_reason enum (SNAPSHOT_UNSUPPORTED, SNAPSHOT_TEMPORARILY_UNAVAILABLE, SNAPSHOT_PERMISSION_DENIED)
- Tests both generative mode (brand_manifest + prompt) and tag-serving mode (creative_id) for build_creative
- Extends schema-compliance.ts with creative response schema validation for list_creatives and sync_creatives
- Validates creative_id, format_id, action status, and error handling in sync responses
- Resolves issues #328, #329, #330 by ensuring creative tools are properly tested independently and schema validation is comprehensive
