---
'@adcp/sdk': minor
---

Sync generated registry types with the live AgenticAdvertising.org OpenAPI, adding `AgentComplianceDetail.latest_attempt` and current AdCP release examples. The registry no longer sends the former human-refresh fence fields on `refresh_availability` or the `refreshAgent` 503 response (`code`, `retryable`, `scope`, `applies_to`, and related remediation metadata); the 503 response now uses the standard registry `Error` shape. For SDK 14 type compatibility, those fields remain as optional `@deprecated` properties and will be removed in the next major release. Registry runtime behavior is unchanged.
