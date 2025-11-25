---
"@adcp/client": minor
---

fix: treat working/input-required as valid intermediate states and extract A2A webhook payloads

- `working` status now returns immediately with `status: 'working'` instead of polling and timing out
- `input-required` status returns valid result instead of throwing `InputRequiredError` when no handler provided
- Made `success=true` consistent for all intermediate states (working, submitted, input-required, deferred)
- Added `taskType` parameter to `handleWebhook` for all client classes (SingleAgentClient, AgentClient, ADCPMultiAgentClient)
- `handleWebhook` now extracts ADCP response from raw A2A task payloads (artifacts[0].parts[].data where kind === 'data')
- Handlers now receive unwrapped ADCP responses instead of raw A2A protocol structure
