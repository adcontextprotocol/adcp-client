# Logger Usage Guide

The AdCP Client includes a structured logger utility to provide consistent, level-based logging with contextual metadata support.

## Basic Usage

```typescript
import { logger } from '@adcp/client';

// Log at different levels
logger.debug('Detailed debugging information');
logger.info('General informational messages');
logger.warn('Warning messages for non-critical issues');
logger.error('Error messages for critical issues');
```

## Log Levels

The logger supports four log levels (in order of severity):

- `debug` - Detailed debugging information (lowest priority)
- `info` - General informational messages
- `warn` - Warning messages for non-critical issues
- `error` - Error messages for critical issues (highest priority)

## Configuration

### Environment Variables

The default logger can be configured via environment variables:

```bash
# Set minimum log level
LOG_LEVEL=debug  # or info, warn, error

# Disable logging entirely
LOG_ENABLED=false
```

### Programmatic Configuration

```typescript
import { logger } from '@adcp/client';

// Change log level at runtime
logger.configure({ level: 'warn' });

// Disable logging
logger.configure({ enabled: false });
```

## Custom Logger Instances

Create custom logger instances with specific configurations:

```typescript
import { createLogger } from '@adcp/client';

const debugLogger = createLogger({
  level: 'debug',
  enabled: true
});

debugLogger.debug('This will be logged');
debugLogger.info('This will also be logged');
```

## Context-Aware Logging

Create child loggers with contextual prefixes:

```typescript
import { logger } from '@adcp/client';

// Create a logger for MCP protocol
const mcpLogger = logger.child('MCP');
mcpLogger.info('Connected to agent');
// Output: [MCP] Connected to agent

// Create nested context
const toolLogger = mcpLogger.child('get_products');
toolLogger.debug('Calling agent');
// Output: [MCP] [get_products] Calling agent
```

## Logging with Metadata

Add structured metadata to your logs:

```typescript
import { logger } from '@adcp/client';

logger.info('Task completed', {
  taskId: 'task_123',
  duration: 1250,
  status: 'success'
});
```

## Custom Log Handlers

Implement custom log handling (e.g., for external logging services):

```typescript
import { createLogger } from '@adcp/client';

const customLogger = createLogger({
  level: 'info',
  handler: {
    debug: (msg, meta) => myLoggingService.debug(msg, meta),
    info: (msg, meta) => myLoggingService.info(msg, meta),
    warn: (msg, meta) => myLoggingService.warn(msg, meta),
    error: (msg, meta) => myLoggingService.error(msg, meta)
  }
});
```

## Best Practices

### Use Appropriate Log Levels

```typescript
// ✅ Good - Use debug for detailed tracing
logger.debug('Parsing response', { bytes: 1024 });

// ✅ Good - Use info for general flow
logger.info('Media buy created', { buyId: 'mb_123' });

// ✅ Good - Use warn for recoverable issues
logger.warn('Retry attempt 2/3', { error: err.message });

// ✅ Good - Use error for critical failures
logger.error('Failed to connect to agent', { agentId, error: err });
```

### Use Child Loggers for Context

```typescript
// ✅ Good - Create context-specific loggers
class MediaBuyService {
  private logger = logger.child('MediaBuyService');

  async create(params) {
    this.logger.info('Creating media buy', { params });
    // ...
  }
}
```

### Include Relevant Metadata

```typescript
// ✅ Good - Include useful debugging context
logger.error('Task timeout', {
  taskId: task.id,
  taskType: task.type,
  timeout: 30000,
  elapsed: 35000
});

// ❌ Bad - Missing context
logger.error('Task timeout');
```

## Migration from console.*

The logger wrapper provides a drop-in replacement for console statements:

```typescript
// Before
console.log('Agent connected');
console.error('Failed to connect:', error);
console.warn('Retry in 5s');

// After
import { logger } from '@adcp/client';

logger.info('Agent connected');
logger.error('Failed to connect', { error });
logger.warn('Retry in 5s');
```

## Internal Usage in AdCP Client

The AdCP Client uses the logger internally for protocol operations:

```typescript
// A2A protocol logging
const a2aLogger = logger.child('A2A');
a2aLogger.debug('Sending message', { skill: toolName });

// MCP protocol logging
const mcpLogger = logger.child('MCP');
mcpLogger.info('Connected via StreamableHTTP', { url });

// Circuit breaker logging
logger.warn('Circuit breaker opened', {
  agentId,
  failures: 5
});
```

## Production Recommendations

1. **Set appropriate log level**: Use `info` or `warn` in production
2. **Use custom handlers**: Send logs to external services (CloudWatch, Datadog, etc.)
3. **Include context**: Always use child loggers for component-specific logging
4. **Add metadata**: Include IDs, timestamps, and relevant debugging info
5. **Don't log sensitive data**: Never log auth tokens, PII, or secrets
