# Wonderstruck MCP Endpoint Diagnosis

## Issue
ADCPClient fails to connect to Wonderstruck MCP endpoint with error:
```
Failed to discover MCP endpoint. Tried:
  1. https://wonderstruck.sales-agent.scope3.com/mcp
  2. https://wonderstruck.sales-agent.scope3.com/mcp/mcp
Neither responded to MCP protocol.
```

## Root Cause
The Wonderstruck MCP server has **strict header requirements** that differ from standard MCP implementations:

### Working Request
```bash
curl -X POST \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "x-adcp-auth: <TOKEN>" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1.0.0"},"capabilities":{}},"id":1}' \
  https://wonderstruck.sales-agent.scope3.com/mcp
```

**Response:**
```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"experimental":{},"prompts":{"listChanged":true},"resources":{"subscribe":false,"listChanged":true},"tools":{"listChanged":true}},"serverInfo":{"name":"AdCPSalesAgent","version":"1.13.1"}}}
```

✅ **Server IS working and returns valid MCP response**

### Failed Requests

**1. Missing Accept header:**
```bash
curl -s https://wonderstruck.sales-agent.scope3.com/mcp
```
**Error:** `Not Acceptable: Client must accept text/event-stream`

**2. Only text/event-stream Accept header:**
```bash
curl -s -H "Accept: text/event-stream" https://wonderstruck.sales-agent.scope3.com/mcp
```
**Error:** `Bad Request: Missing session ID`

**3. POST with only text/event-stream Accept:**
```bash
curl -X POST -H "Accept: text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize",...}' https://wonderstruck.sales-agent.scope3.com/mcp
```
**Error:** `Not Acceptable: Client must accept both application/json and text/event-stream`

## Server Requirements

The Wonderstruck server requires:
1. ✅ **Accept header**: MUST include both `application/json` AND `text/event-stream`
2. ✅ **Content-Type**: `application/json` for POST requests
3. ✅ **Authentication**: `x-adcp-auth` header with valid token
4. ✅ **SSE format**: Server responds with Server-Sent Events (`event: message\ndata: {...}`)

## MCP SDK Issue

The `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` may not be setting the correct `Accept` headers.

### Current ADCPClient Code (src/lib/core/ADCPClient.ts:177-180)
```typescript
const transport = new StreamableHTTPClientTransport(
  new URL(url),
  customFetch ? { fetch: customFetch } : {}
);
```

### Possible Solutions

**Option 1: Pass custom fetch with headers**
```typescript
const customFetch = async (input: any, init?: any) => {
  const headers = {
    ...init?.headers,
    'Accept': 'application/json, text/event-stream',
    'Authorization': `Bearer ${authToken}`,
    'x-adcp-auth': authToken
  };
  return fetch(input, { ...init, headers });
};

const transport = new StreamableHTTPClientTransport(
  new URL(url),
  { fetch: customFetch }
);
```

**Option 2: Use requestInit parameter**
Check if `StreamableHTTPClientTransport` accepts a `requestInit` parameter like:
```typescript
const transport = new StreamableHTTPClientTransport(
  new URL(url),
  {
    fetch: customFetch,
    requestInit: {
      headers: {
        'Accept': 'application/json, text/event-stream'
      }
    }
  }
);
```

## Server Information
- **Server Name**: AdCPSalesAgent
- **Version**: 1.13.1
- **Protocol Version**: 2024-11-05
- **Capabilities**: experimental, prompts, resources, tools
- **URL**: https://wonderstruck.sales-agent.scope3.com/mcp

## Recommendations for Maintainers

1. **Immediate**: Update ADCPClient to ensure `Accept: application/json, text/event-stream` is sent in all MCP requests
2. **Verify**: Test with official MCP SDK to ensure header compatibility
3. **Consider**: Whether Wonderstruck's strict header requirements are MCP spec-compliant (may need to relax server validation)
4. **Alternative**: Use Test Agent (A2A) at `https://test-agent.adcontextprotocol.org` which is working correctly

## Testing

### Test with curl (working)
```bash
# Replace <TOKEN> with actual token
curl -X POST \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "x-adcp-auth: <TOKEN>" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"AdCP-Client","version":"1.0.0"},"capabilities":{}},"id":1}' \
  https://wonderstruck.sales-agent.scope3.com/mcp
```

Expected response format:
```
event: message
data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

---

**Date**: 2025-10-26
**Tested By**: Claude Code
**Status**: Server is functional, client needs header fix
