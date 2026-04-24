---
"@adcp/client": patch
---

Runner hint detector now recognizes the `adcp_error` (singular object) response envelope — what the canonical `adcpError()` SDK helper emits — alongside the `errors[]` (plural array) shape it already handled. Closes adcp-client#907. Surfaced during dogfood: agents built on the helper (the recommended pattern) were silently missing `context_value_rejected` hints because the detector only read `errors[]`. Also accepts `adcp_error: [...]` defensively. When both shapes are present in one response, the plural `errors[]` wins (spec-canonical).
