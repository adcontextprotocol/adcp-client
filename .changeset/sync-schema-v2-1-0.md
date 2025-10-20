---
"@adcp/client": patch
---

Sync with AdCP v2.1.0 schema updates for build_creative and preview_creative

- Add support for creative namespace in schema sync script
- Generate TypeScript types for build_creative and preview_creative tools
- Update creative testing UI to handle new schema structure:
  - Support output_format_ids array (was output_format_id singular)
  - Handle new preview response with previews[].renders[] structure
  - Display multiple renders with dimensions and roles for companion ads

Schema changes from v2.0.0:
- Formats now have renders array with role and structured dimensions
- Preview responses: outputs → renders, output_id → render_id, output_role → role
- Removed format_id and hints fields from preview renders
