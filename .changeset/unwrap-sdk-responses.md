---
"@adcp/client": minor
---

Clean up SDK public API and improve response handling

IMPROVEMENTS:

1. Agent class methods now return raw AdCP responses matching schemas exactly
2. Removed internal implementation details from public API exports
3. Added response utilities: unwrapProtocolResponse, isAdcpError, isAdcpSuccess

## What Changed

**Low-level Agent class** now returns raw AdCP responses matching the protocol specification:
- Success responses have required fields per schema (packages, media_buy_id, buyer_ref)
- Error responses follow discriminated union: `{ errors: [{ code, message }] }`
- Errors returned as values, not thrown as exceptions

**High-level clients unchanged** - ADCPMultiAgentClient, AgentClient, and SingleAgentClient still return `TaskResult<T>` with status-based patterns. No migration needed for standard usage.

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

## Migration Guide (Only if using low-level Agent class directly)

**Most users don't need to migrate** - if you're using ADCPMultiAgentClient, AgentClient, or SingleAgentClient, no changes needed.

### If using Agent class directly:
```javascript
// Before:
const agent = new Agent(config, client);
const result = await agent.createMediaBuy({...});
if (result.success) {
  console.log(result.data.media_buy_id);
}

// After:
const agent = new Agent(config, client);
const result = await agent.createMediaBuy({...});
if (result.errors) {
  console.error('Failed:', result.errors);
} else {
  console.log(result.media_buy_id, result.buyer_ref);
}
```

### Removed Internal Exports
If you were importing `ProtocolClient`, `CircuitBreaker`, or other internal utilities, use the public Agent class instead.
