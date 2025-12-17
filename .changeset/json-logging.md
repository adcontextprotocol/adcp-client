---
"@adcp/client": minor
---

**JSON Logging**: Add `format: 'json'` option to logger for structured JSON output with timestamp, level, message, context, and metadata fields.

```typescript
import { createLogger, SingleAgentClient } from '@adcp/client';

// Create a logger with JSON format for production
const logger = createLogger({ level: 'debug', format: 'json' });

// Pass logger to client for structured logging of task execution
const client = new SingleAgentClient(agentConfig, { logger });
// Output: {"timestamp":"2025-12-13T...","level":"info","message":"Task completed: get_products","context":"TaskExecutor","meta":{"taskId":"...","responseTimeMs":123}}
```

**Injectable Logger Interface**: New `ILogger` interface for dependency injection and `noopLogger` singleton for silent library defaults.

New exports: `ILogger`, `noopLogger`, `LogFormat`
