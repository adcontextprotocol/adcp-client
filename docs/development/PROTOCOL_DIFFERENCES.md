# Protocol Differences: MCP vs A2A

This document explains the key differences between the Model Context Protocol (MCP) and Agent-to-Agent (A2A) protocols, and how the AdCP client library handles these differences transparently.

## Overview

The AdCP client library supports two protocols for communicating with advertising agents:

- **MCP (Model Context Protocol)**: A lightweight protocol for tool invocation
- **A2A (Agent-to-Agent Protocol)**: A richer protocol supporting complex multi-part responses

## Response Structure Differences

### MCP Response Structure

MCP responses typically have a simple structure with data in `structuredContent`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"products\": [...]}"
    }
  ],
  "structuredContent": {
    "products": [
      {
        "product_id": "...",
        "name": "..."
      }
    ]
  }
}
```

**Key characteristics:**
- Simple, flat structure
- Data in `structuredContent` field
- May also have text content with JSON
- Single response per call

### A2A Response Structure

A2A responses use a more complex artifact-based structure:

```json
{
  "result": {
    "artifacts": [
      {
        "artifactId": "skill_result_1",
        "name": "get_products_result",
        "parts": [
          {
            "kind": "data",
            "data": {
              "products": [
                {
                  "product_id": "...",
                  "name": "..."
                }
              ]
            }
          }
        ]
      }
    ]
  }
}
```

**Key characteristics:**
- Nested artifact structure
- Data wrapped in `result.artifacts[].parts[].data`
- Supports multiple artifacts
- Can include different part types (data, files, images, text)
- Designed for rich, multi-modal responses

## How the Library Handles Differences

The `TaskExecutor.extractResponseData()` method automatically detects and extracts data from both protocol formats:

```typescript
private extractResponseData(response: any): any {
  // MCP: Extract from structuredContent
  if (response?.structuredContent) {
    return response.structuredContent;
  }

  // A2A: Extract from artifact structure
  if (response?.result?.artifacts) {
    return response.result.artifacts[0].parts[0].data;
  }

  // Fallback to raw response
  return response;
}
```

**This means your application code doesn't need to know which protocol is being used!**

```typescript
// Works with both MCP and A2A
const result = await client.getProducts({
  brief: "...",
  promoted_offering: "..."
});

// result.data will contain the products regardless of protocol
console.log(result.data.products);
```

## Protocol Capabilities Comparison

| Feature | MCP | A2A |
|---------|-----|-----|
| Basic tool invocation | ✅ | ✅ |
| Structured data responses | ✅ | ✅ |
| Multiple artifacts | ❌ | ✅ |
| File attachments | ❌ | ✅ |
| Multi-modal content | Limited | ✅ |
| Streaming responses | Via SSE | Via artifacts |
| Task status tracking | Limited | ✅ (working/submitted) |
| Authentication | Header-based | Bearer token |

## Parameter Differences

### Parameters That Vary by Protocol

Some tool parameters work differently or may not be supported by all agent implementations:

#### `adcp_version`

- **get_products**: ✅ Supported by both protocols
- **list_creative_formats**: ❌ **Not supported** by current agent implementations (despite being in spec)
- **list_creatives**: ✅ Supported by both protocols

**Lesson learned**: Always test against real agents, not just TypeScript types.

### Authentication

**MCP**:
```typescript
// Auth via custom header
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: {
      'x-adcp-auth': authToken
    }
  }
});
```

**A2A**:
```typescript
// Auth via Bearer token
const client = await A2AClient.fromCardUrl(cardUrl, {
  fetchImpl: (url, options) => fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${authToken}`,
      ...options.headers
    }
  })
});
```

## Error Handling

### MCP Errors

MCP returns errors in the response content:

```json
{
  "content": [{
    "type": "text",
    "text": "Error: ..."
  }],
  "isError": true
}
```

### A2A Errors

A2A returns JSON-RPC formatted errors:

```json
{
  "error": {
    "code": -32603,
    "message": "Internal server error"
  },
  "jsonrpc": "2.0",
  "id": 1
}
```

The library detects both formats and throws appropriate errors.

## Debug Logging

The library now includes debug logging to help track protocol-specific behavior:

```typescript
// Debug logs show which extraction path was taken
{
  type: 'info',
  message: 'Extracting data from A2A artifact structure',
  details: {
    artifactCount: 1,
    partCount: 1,
    dataKeys: ['products', 'message']
  }
}
```

These logs appear in the `debug_logs` array of task results.

## Best Practices

### 1. Don't Assume Protocol-Specific Behavior

```typescript
// ❌ Bad: Assuming A2A structure
const products = response.result.artifacts[0].parts[0].data.products;

// ✅ Good: Use the library's extraction
const result = await client.getProducts(params);
const products = result.data.products;
```

### 2. Check Response Success, Not Protocol

```typescript
// ✅ Works for both protocols
if (result.success) {
  const products = result.data.products;
} else {
  console.error(result.error);
}
```

### 3. Use Protocol-Agnostic Error Handling

```typescript
try {
  const result = await client.getProducts(params);
  // Handle success
} catch (error) {
  // Library throws standardized errors for both protocols
  console.error(error.message);
}
```

### 4. Test Against Real Agents

Parameter support can vary between:
- The AdCP specification
- Your TypeScript types
- Actual agent implementations

Always verify with real agent testing, not just type checking.

## When to Choose Which Protocol

### Use MCP When:
- You need simple request/response
- You're building a tool for LLM integration
- You want lightweight JSON-RPC calls
- Your responses are primarily structured data

### Use A2A When:
- You need to return files or rich media
- You want to support multiple response artifacts
- You need task management (submitted/working states)
- You're building agent-to-agent integrations

## Future Considerations

### Upcoming Features

Both protocols are evolving:

- **MCP**: Adding support for sampling and resource management
- **A2A**: Enhancing task lifecycle management and streaming

The AdCP library will continue to abstract these differences while exposing new capabilities through a unified API.

### Multi-Protocol Support

Some applications may want to support both protocols simultaneously:

```typescript
// Library handles both automatically
const agents = [
  { id: 'mcp-agent', protocol: 'mcp', agent_uri: '...' },
  { id: 'a2a-agent', protocol: 'a2a', agent_uri: '...' }
];

const client = new ADCPMultiAgentClient(agents);

// Results from both protocols in the same format
const results = await client.getProducts(params);
results.forEach(result => {
  console.log(result.data.products); // Works regardless of protocol
});
```

## Debugging Tips

### Enable Debug Logs

```typescript
const result = await client.getProducts(params);
console.log('Debug logs:', result.debug_logs);
```

Look for messages like:
- `"Extracting data from MCP structuredContent"` - MCP path
- `"Extracting data from A2A artifact structure"` - A2A path
- `"A2A artifacts found but no data extracted"` - Possible A2A issue

### Common Issues

1. **Empty responses despite successful call**: Check debug logs to see if extraction failed
2. **"adcp_version not supported"**: Remove parameter for that specific tool
3. **Authentication failures**: Verify token format matches protocol (header vs Bearer)

## Additional Resources

- [MCP Specification](https://spec.modelcontextprotocol.io)
- [A2A Protocol Documentation](https://github.com/AgentProtocol/A2A)
- [AdCP Specification](https://github.com/adcontextprotocol/adcp)
