---
"@adcp/client": major
---

Clean up SDK public API and return raw AdCP responses

BREAKING CHANGES:

1. Agent class methods now return raw AdCP responses matching schemas exactly
2. Removed internal implementation details from public API exports

## Response Format Changes

Agent methods (e.g., createMediaBuy, updateMediaBuy) now return raw AdCP
responses following discriminated union patterns instead of wrapped format.

- Success responses have required fields per schema (packages, media_buy_id)
- Error responses have errors array: { errors: [{ code, message }] }
- Errors returned as values, not thrown as exceptions
- Added unwrapProtocolResponse utility for protocol wrapper extraction

## API Export Cleanup

Removed internal utilities that were never meant for public use:

- Low-level protocol clients (ProtocolClient, callA2ATool, callMCPTool)
- Internal utilities (CircuitBreaker, getCircuitBreaker, generateUUID)
- Duplicate exports (NewAgentCollection)

Public API now includes only user-facing features:
- All Zod schemas (for runtime validation, forms)
- Auth utilities (getAuthToken, createAdCPHeaders, etc.)
- Validation utilities (validateAgentUrl, validateAdCPResponse)
- Response utilities (unwrapProtocolResponse, isAdcpError, isAdcpSuccess)

## Migration Guide

### Response Format
```javascript
// Before:
const result = await agent.createMediaBuy({...});
if (result.success) {
  console.log(result.data.media_buy_id);
} else {
  console.error(result.error);
}

// After:
const result = await agent.createMediaBuy({...});
if (result.errors) {
  console.error('Failed:', result.errors);
} else {
  console.log(result.media_buy_id);
}
```

### Removed Exports
If you were using internal protocol clients, use Agent class instead:
```javascript
// Before (internal API):
import { ProtocolClient } from '@adcp/client';
const response = await ProtocolClient.callTool(config, 'create_media_buy', params);

// After (public API):
import { Agent } from '@adcp/client';
const agent = new Agent(config, client);
const response = await agent.createMediaBuy(params);
```
