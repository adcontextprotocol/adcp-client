---
"@adcp/client": minor
---

Add compliance status APIs for buyer integration

- Added `getAgentCompliance()`, `getAgentStoryboardStatus()`, `getAgentStoryboardStatusBulk()` to RegistryClient
- Added `lookupOperator()` and `lookupPublisher()` to RegistryClient with typed responses
- RegistrySync now processes `agent.compliance_changed` feed events and emits typed `compliance_changed` events
- `AgentSearchResult` includes optional `compliance_summary` field
- `findAgents()` accepts `compliance_status` filter
- Exported new types: `AgentCompliance`, `AgentComplianceDetail`, `StoryboardStatus`, `OperatorLookupResult`, `PublisherLookupResult`, `ComplianceChangedPayload`
