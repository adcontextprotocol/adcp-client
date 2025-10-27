---
"@adcp/client": patch
---

Fixed MCP Accept header handling for Headers objects

The customFetch function in mcp.ts was incorrectly handling Headers objects by using object spread syntax (`{...init.headers}`), which returns an empty object for Headers instances. This caused the MCP SDK's required `Accept: application/json, text/event-stream` header to be lost.

**Changes:**
- Fixed Headers object extraction to use `forEach()` instead of object spread
- Fixed plain object extraction to use `for...in` loop with `hasOwnProperty` check
- Added comprehensive tests for Headers object handling and Accept header preservation

**Bug Timeline:**
- Bug introduced in v2.3.2 (commit 086be48)
- Exposed between v2.5.0 and v2.5.1 when SDK started passing Headers objects
- Fixed in this release

**Impact:**
- MCP protocol requests now correctly include the required Accept header
- MCP servers will no longer reject requests due to missing Accept header
