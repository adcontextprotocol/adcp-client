---
"@adcp/client": patch
---

Fixed critical A2A protocol implementation bugs for async task handling and webhook configuration.

**Critical Bug Fix #1: A2A Async Status Detection**

Main branch cannot detect A2A async task acknowledgments, causing async tasks to fail or behave incorrectly.

A2A uses nested status format: `{ status: { state: "working" } }` or `{ result: { status: { state: "working" } } }`

Main branch only checks flat `response.status`, missing nested formats entirely. This causes:
- "working" responses treated as completed, triggering premature validation failures
- "submitted" responses not detected, webhook setup never happens
- Tasks fail with schema validation errors instead of waiting for completion

**Fix:** Added nested status detection in ProtocolResponseParser:
- Detects `response.status.state` for async acknowledgments
- Detects `response.result.status.state` for artifact responses
- Routes async responses to `waitForWorkingCompletion()` or `setupSubmittedTask()` instead of validation
- Schema validation only runs when tasks actually complete

**Critical Bug Fix #2: A2A Webhook Configuration Placement**

Main branch would place `pushNotificationConfig` in skill parameters, violating A2A SDK spec.

A2A requires: `{ message: {...}, configuration: { pushNotificationConfig: {...} } }`
Main would send: `{ message: { parts: [{ data: { skill, parameters: { pushNotificationConfig } } }] } }`

**Fix:** Correctly places webhook config in `params.configuration.pushNotificationConfig` per @a2a-js/sdk spec
- Without this, webhook notifications for async A2A tasks would not work at all
- MCP protocol continues to use `push_notification_config` in tool arguments (correct per MCP spec)

**Type Safety Improvement:**
- Uses generated `PushNotificationConfig` type from AdCP schema instead of inline definitions
- Ensures alignment with https://adcontextprotocol.org/schemas/v1/core/push-notification-config.json

**Validation Fix:**
- Fixed A2A artifact validation to check `artifactId` field per @a2a-js/sdk Artifact interface
- Main incorrectly checked for non-existent `name` field

**Documentation:**
- Added AGENTS.md section clarifying `push_notification_config` (async task status) vs `reporting_webhook` (reporting metrics)
- Both use PushNotificationConfig schema but have different purposes and placement requirements
