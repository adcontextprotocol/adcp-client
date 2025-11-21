---
"@adcp/client": patch
---

Return raw AdCP responses from Agent class

BREAKING CHANGE: Agent class methods now return raw AdCP responses matching schemas exactly, instead of wrapping them in { success, data, error } format.

- Agent methods (e.g., createMediaBuy, updateMediaBuy) now return raw AdCP response matching discriminated union schemas
- Responses follow AdCP spec: success responses have required fields (e.g., packages, media_buy_id), error responses have errors array
- Added unwrapProtocolResponse utility to extract AdCP data from MCP/A2A protocol wrappers
- Errors are now returned as { errors: [{ code, message }] } per AdCP spec, not thrown as exceptions

Migration:
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
  console.log(result.media_buy_id);  // Direct access per schema
}
```
