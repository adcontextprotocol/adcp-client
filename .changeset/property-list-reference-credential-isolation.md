---
'@adcp/sdk': minor
---

Implement the property-list reference credential-isolation compliance check over MCP. Use a fresh token-only session for complete pagination, cross-list read denial, and mutation denial, with schema validation and redacted evidence. Recognize the property_list_reference_runner requirement and report it unmet for A2A. Redact issued auth_token credentials throughout runner reports.
