---
"@adcp/sdk": patch
---

Use `DEFAULT_REPORTING_CAPABILITIES` in decisioning-platform worked examples and SKILL.md quickstart. Updates `broadcast-tv`, `mock-seller`, and `programmatic` examples to import and reference the exported constant rather than hand-rolling `reporting_capabilities` inline. Adds the constant to the `build-decisioning-platform` imports cheat sheet and `getProducts` product literal so codegen agents produce schema-valid products on first try.
