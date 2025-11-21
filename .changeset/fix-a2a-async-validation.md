---
"@adcp/client": patch
---

Fixed A2A async task handling and webhook configuration:
- Fixed `pushNotificationConfig` placement for A2A protocol: Now correctly placed in `params.configuration.pushNotificationConfig` (per @a2a-js/sdk spec) instead of being injected into skill parameters
- Now uses generated `PushNotificationConfig` type from AdCP schema (https://adcontextprotocol.org/schemas/v1/core/push-notification-config.json) instead of inline type definitions
- Updated ProtocolResponseParser to detect nested status objects (`response.status.state`, `response.result.status.state`) used in A2A async task acknowledgments
- Fixed A2A artifact validation: Now correctly checks for `artifactId` field (per @a2a-js/sdk Artifact interface)
- Updated documentation (AGENTS.md) to clarify distinction between `push_notification_config` (async task status) and `reporting_webhook` (reporting metrics)
- Note: MCP protocol continues to use `push_notification_config` in tool arguments as per MCP spec
