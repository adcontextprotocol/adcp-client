---
'@adcp/sdk': patch
---

Include `operation_id` in SDK-injected task webhook registrations for AdCP 3.1 sellers, which already define this field and require it in webhook payloads. Remote MCP, in-process MCP, and A2A registrations use the caller's `operationId` or generate a UUID and return it from request preparation, matching the existing 3.2 behavior. Preserve the older registration shapes for AdCP 3.0 and v2 sellers.
