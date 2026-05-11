---
"@adcp/sdk": minor
---

feat(client): add `issues[]` as first-class field on `AdcpErrorInfo` (per core/error.json 3.0 GA)

`AdcpErrorInfo` now carries `issues?: AdcpValidationIssue[]`, populated from the seller's
`VALIDATION_ERROR` envelope when present. Previously the `issues[]` array landed in the
free-form `details` field, forcing consumers to read `details.validation_errors` as a
convention rather than a typed API.

Each `AdcpValidationIssue` carries `pointer` (RFC 6901 JSON Pointer to the offending field),
`message` (human-readable), `keyword` (JSON Schema keyword: `'required'`, `'type'`, `'enum'`,
etc. — the key field for LLM self-correction), and optional `schemaPath`. Only items that
satisfy the required-field shape are forwarded; malformed wire items are silently dropped.

`ExtractedAdcpError` (returned by `extractAdcpErrorFromMcp` / `extractAdcpErrorFromTransport`)
also gains `issues?: AdcpValidationIssue[]` for callers using the transport-level helpers
directly. `AdcpValidationIssue` is exported from the package root.

Closes #1694.
