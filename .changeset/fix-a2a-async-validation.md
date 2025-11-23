---
"@adcp/client": patch
---

Fixed A2A webhook configuration placement to match A2A SDK specification.

**Bug Fix: A2A Webhook Configuration Placement**

The A2A protocol requires webhook configuration to be placed in the top-level `configuration` object, not in skill parameters.

**Correct format per A2A SDK:**
```javascript
{
  message: { messageId, role, kind, parts: [...] },
  configuration: {
    pushNotificationConfig: { url, headers }
  }
}
```

**Previous incorrect format:**
```javascript
{
  message: {
    parts: [{
      data: {
        skill: 'toolName',
        parameters: {
          pushNotificationConfig: { url, headers }  // WRONG - not a skill parameter
        }
      }
    }]
  }
}
```

**Changes:**
- Moved `pushNotificationConfig` from skill parameters to `params.configuration` in A2A protocol handler
- MCP protocol correctly continues to use `push_notification_config` in tool arguments (per MCP spec)
- Uses generated `PushNotificationConfig` type from AdCP schema for type safety
- Fixed A2A artifact validation to check `artifactId` field per @a2a-js/sdk Artifact interface

**Documentation:**
- Added AGENTS.md section clarifying `push_notification_config` (async task status) vs `reporting_webhook` (reporting metrics)
- Both use PushNotificationConfig schema but have different purposes and placement requirements
