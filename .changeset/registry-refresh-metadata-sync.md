---
'@adcp/sdk': minor
---

Sync generated registry types with the live AgenticAdvertising.org OpenAPI, adding `AgentComplianceDetail.latest_attempt` and current AdCP release examples. Registry runtime behavior in the SDK is unchanged.

Type change: the former human-refresh fence fields on `AgentComplianceDetail.refresh_availability` (`retryable`, `scope`, `applies_to`, `code`, `notice`, `alternative_action`, `alternative_description`) and on the `refreshAgent` 503 response (`message`, `code`, `retryable`, `scope`, `applies_to`, `alternative_action`, `alternative_description`, `tracking_issue`) are now optional and `@deprecated`. This mirrors a change in the live registry API, which no longer returns them; the SDK did not remove them. Code that reads these fields as required values (for example, assigning `refresh_availability.code` or `notice` to a `string`) now needs a fallback for `undefined`. The fields will be removed from the types in the next major release.
