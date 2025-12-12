---
"@adcp/client": minor
---

Add JSON logging format and injectable logger pattern for production deployments.

**JSON Logging**: Set `LOG_FORMAT=json` environment variable or configure via `createLogger({ format: 'json' })` to output structured JSON logs with timestamp, level, message, context, and metadata.

**Injectable Logger**: Library is now silent by default. Inject your own logger via config to see internal diagnostics:

```typescript
import { createLogger, AdCPClient } from '@adcp/client';

const client = new AdCPClient(agents, {
  logger: createLogger({ level: 'debug', format: 'json' })
});
```

New exports: `ILogger`, `noopLogger`, `LogFormat`
