# Protocol Logging

## Overview

The ADCP client provides detailed wire-level logging for both MCP and A2A protocols. This feature logs the exact HTTP requests and responses being sent over the network, making it invaluable for debugging, monitoring, and understanding protocol interactions.

## Quick Start

```typescript
import { ADCPClient } from '@adcp/client';

const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true
  }
});

// All protocol requests/responses will now be logged to console
const result = await client.getProducts({ brief: 'Coffee products' });
```

## Configuration Options

### `protocolLogging`

Configure detailed protocol logging in `ADCPClientConfig`:

```typescript
interface ADCPClientConfig {
  protocolLogging?: {
    /** Enable detailed protocol logging (default: false) */
    enabled?: boolean;

    /** Log request details (default: true if enabled) */
    logRequests?: boolean;

    /** Log response details (default: true if enabled) */
    logResponses?: boolean;

    /** Log request bodies/payloads (default: true if enabled) */
    logRequestBodies?: boolean;

    /** Log response bodies/payloads (default: true if enabled) */
    logResponseBodies?: boolean;

    /** Maximum body size to log in bytes (default: 50000 / 50KB) */
    maxBodySize?: number;

    /** Redact sensitive headers from logs (default: true) */
    redactAuthHeaders?: boolean;
  };
}
```

## What Gets Logged

### MCP Protocol Requests

```javascript
[MCP Request] {
  protocol: 'mcp',
  method: 'POST',
  url: 'https://agent.example.com/mcp',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': '***REDACTED***',      // If redactAuthHeaders: true
    'x-adcp-auth': '***REDACTED***'
  },
  body: {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: 'get_products',
      arguments: {
        brief: 'Coffee products',
        promoted_offering: 'Premium beans'
      }
    },
    id: 1
  },
  timestamp: '2025-01-15T10:30:00.000Z'
}
```

### MCP Protocol Responses

```javascript
[MCP Response] {
  protocol: 'mcp',
  status: 200,
  statusText: 'OK',
  headers: {
    'content-type': 'application/json',
    'content-length': '1234'
  },
  body: {
    jsonrpc: '2.0',
    result: {
      content: [
        {
          type: 'text',
          text: '{"products": [...]}'
        }
      ]
    },
    id: 1
  },
  latency: '245ms',
  timestamp: '2025-01-15T10:30:00.245Z'
}
```

### A2A Protocol Requests

```javascript
[A2A Request] {
  protocol: 'a2a',
  method: 'POST',
  url: 'https://agent.example.com/.well-known/agent-card.json',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': '***REDACTED***',
    'x-adcp-auth': '***REDACTED***'
  },
  body: {
    message: {
      messageId: 'msg_1234567890',
      role: 'user',
      kind: 'message',
      parts: [{
        kind: 'data',
        data: {
          skill: 'get_products',
          input: {
            brief: 'Coffee products',
            promoted_offering: 'Premium beans'
          }
        }
      }]
    }
  },
  timestamp: '2025-01-15T10:30:00.000Z'
}
```

### A2A Protocol Responses

```javascript
[A2A Response] {
  protocol: 'a2a',
  status: 200,
  statusText: 'OK',
  headers: {
    'content-type': 'application/json'
  },
  body: {
    message: {
      messageId: 'msg_9876543210',
      role: 'agent',
      kind: 'message',
      parts: [{
        kind: 'data',
        data: {
          products: [...]
        }
      }]
    }
  },
  latency: '320ms',
  timestamp: '2025-01-15T10:30:00.320Z'
}
```

## Common Use Cases

### 1. Development Debugging

Enable full logging during development:

```typescript
const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: process.env.NODE_ENV === 'development',
    logRequests: true,
    logResponses: true,
    logRequestBodies: true,
    logResponseBodies: true,
    redactAuthHeaders: true // Still redact even in dev
  }
});
```

### 2. Production Monitoring

Minimal logging in production (headers only):

```typescript
const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: process.env.ENABLE_PROTOCOL_LOGGING === 'true',
    logRequests: true,
    logResponses: true,
    logRequestBodies: false,  // Don't log bodies in production
    logResponseBodies: false,
    maxBodySize: 5000,        // Small limit if bodies are logged
    redactAuthHeaders: true   // Always redact in production
  }
});
```

### 3. Debugging Specific Issues

Temporarily enable for a specific request:

```typescript
// Create a separate client instance with logging enabled
const debugClient = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    logRequestBodies: true,
    logResponseBodies: true,
    maxBodySize: 100000 // Larger limit for debugging
  }
});

// Use for specific problematic request
const result = await debugClient.createMediaBuy(params);
```

### 4. Performance Analysis

Track request latency:

```typescript
const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    logRequests: true,
    logResponses: true,
    logRequestBodies: false,
    logResponseBodies: false // Just track timing, not content
  }
});

// Response logs will include 'latency: XXXms'
```

### 5. Integration with External Logging

Use a custom log handler to send to external services:

```typescript
import { logger } from '@adcp/client/utils/logger';

logger.configure({
  level: 'debug',
  handler: {
    debug: (message: string, meta?: any) => {
      // Send to DataDog, Splunk, etc.
      fetch('https://logging-service.com/api/logs', {
        method: 'POST',
        body: JSON.stringify({
          level: 'debug',
          message,
          meta,
          service: 'adcp-client',
          timestamp: new Date().toISOString()
        })
      });
    },
    info: console.log,
    warn: console.warn,
    error: console.error
  }
});

const client = new ADCPClient(agent, {
  protocolLogging: { enabled: true }
});
```

## Performance Impact

| Configuration | Overhead | Notes |
|--------------|----------|-------|
| `enabled: false` | 0ms | No logging overhead |
| `logRequests: true, logRequestBodies: false` | ~0.5ms | Minimal overhead |
| `logRequests: true, logRequestBodies: true` | ~1-2ms | Serialization overhead |
| `logResponses: true, logResponseBodies: false` | ~0.5ms | Minimal overhead |
| `logResponses: true, logResponseBodies: true` | ~2-5ms | Response cloning + serialization |
| **Full logging (all enabled)** | ~3-7ms | Total per request |

**Recommendation**: In production, keep body logging disabled or use small `maxBodySize` limits to minimize overhead.

## Security Considerations

### ⚠️ Authentication Headers

By default, authentication headers are **redacted** in logs:

```javascript
// Default behavior (redactAuthHeaders: true)
headers: {
  'Authorization': '***REDACTED***',
  'x-adcp-auth': '***REDACTED***'
}
```

**Only disable redaction in local development**:

```typescript
const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    redactAuthHeaders: false // ⚠️ DANGER: Shows actual tokens!
  }
});
```

### 🔒 Best Practices

1. **Never commit logs with real auth tokens** to version control
2. **Always redact in production** environments
3. **Rotate credentials** if they appear in logs
4. **Use short-lived tokens** to limit exposure window
5. **Monitor log access** in production logging systems

## Body Size Limits

Large request/response bodies can fill up logs. Use `maxBodySize` to truncate:

```typescript
const client = new ADCPClient(agent, {
  protocolLogging: {
    enabled: true,
    maxBodySize: 5000 // Only log first 5KB
  }
});
```

Truncated bodies will show:

```javascript
body: "{ ... first 5000 bytes ... [TRUNCATED: 15000 bytes]"
```

## Environment Variables

The logger respects these environment variables:

- `LOG_LEVEL`: Set log level (`debug`, `info`, `warn`, `error`)
- `LOG_ENABLED`: Enable/disable logging (`true`, `false`)

```bash
# Enable debug logging
export LOG_LEVEL=debug
export LOG_ENABLED=true
```

## Troubleshooting

### No logs appearing

1. Check that `enabled: true` is set
2. Verify `LOG_ENABLED=true` in environment
3. Check `LOG_LEVEL=debug` (protocol logs use debug level)
4. Verify logger is configured correctly

### Logs too verbose

1. Set `logRequestBodies: false` and `logResponseBodies: false`
2. Reduce `maxBodySize` to smaller value (e.g., 1000)
3. Filter logs in your custom handler:

```typescript
logger.configure({
  handler: {
    debug: (message: string, meta?: any) => {
      // Only log errors
      if (meta?.status >= 400) {
        console.log(message, meta);
      }
    },
    info: console.log,
    warn: console.warn,
    error: console.error
  }
});
```

### Performance issues

1. Disable body logging: `logRequestBodies: false`, `logResponseBodies: false`
2. Use smaller `maxBodySize` limits
3. Disable logging in hot paths
4. Use async logging handler to avoid blocking

## Examples

See [examples/protocol-logging.ts](../examples/protocol-logging.ts) for comprehensive examples including:

- Basic logging
- Minimal logging (headers only)
- Maximum verbosity
- Body size limits
- A2A protocol
- Custom log handlers
- Environment configuration
- Production debugging
- Log filtering

## API Reference

### Types

```typescript
interface ProtocolLoggingConfig {
  enabled?: boolean;
  logRequests?: boolean;
  logResponses?: boolean;
  logRequestBodies?: boolean;
  logResponseBodies?: boolean;
  maxBodySize?: number;
  redactAuthHeaders?: boolean;
}

interface ADCPClientConfig {
  // ... other config ...
  protocolLogging?: ProtocolLoggingConfig;
}
```

### Functions

- `ADCPClient(agent, config)` - Create client with logging config
- `logger.configure(config)` - Configure global logger
- `logger.debug(message, meta)` - Log debug message
- `logger.info(message, meta)` - Log info message
- `logger.warn(message, meta)` - Log warning
- `logger.error(message, meta)` - Log error

## See Also

- [Logger API Documentation](./logger.md)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
- [A2A Protocol Specification](https://a2a-protocol.org/)
- [ADCP Client Examples](../examples/)
