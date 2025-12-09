---
'@adcp/client': minor
---

Add detailed protocol logging for MCP and A2A requests

Adds comprehensive wire-level logging for both MCP and A2A protocol requests. This allows debugging of exact HTTP requests/responses being sent over the network.

**Features:**

- Added `protocolLogging` configuration to ADCPClient and TaskExecutor
- Implemented detailed logging in both MCP and A2A protocol handlers
- Custom fetch wrappers intercept and log requests/responses
- Includes request/response headers, bodies, latency tracking
- Authentication headers are redacted by default for security
- Configurable logging options: requests, responses, bodies, max body size, auth redaction

**Configuration:**

```typescript
const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    logRequests: true,
    logResponses: true,
    logRequestBodies: true,
    logResponseBodies: true,
    maxBodySize: 50000,
    redactAuthHeaders: true,
  },
});
```

**Documentation:**

- Added comprehensive protocol logging guide
- Included 9 usage examples
- Added test file demonstrating the feature
