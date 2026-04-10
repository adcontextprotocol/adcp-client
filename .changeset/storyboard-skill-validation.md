---
"@adcp/client": minor
---

Storyboard infrastructure and skill validation for all 16 remaining storyboards

- Fix response-unwrapper `_message` stripping for union schema validation (Zod v4 compatibility)
- Fix `expect_error` handling for `schema_validation` reversed_dates step
- Add `requires_tool` to governance storyboard steps that need seller tools
- Add request builders for governance, content standards, brand rights, SI tools
- Add context extractors for `create_content_standards`, `get_rights`, `acquire_rights`
- Register missing response schemas: `create_content_standards`, `update_content_standards`, `validate_property_delivery`
- Add task-map entries: `check_governance`, `create_content_standards`, `update_content_standards`, `get_account_financials`, `log_event`
- Fix campaign governance YAML sample_requests to match current schemas
- Fix content standards YAML sample_requests (scope, artifact, records fields)
- Sync PLATFORM_STORYBOARDS with storyboard platform_types declarations
- New test: storyboard-completeness.test.js (structural validation for all bundled storyboards)
- New skills: build-governance-agent, build-si-agent, build-brand-rights-agent
- Updated skills: build-seller-agent (error responses), build-creative-agent (asset shapes)
