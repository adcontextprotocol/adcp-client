---
"@adcp/client": minor
---

Add JSON logging format and injectable logger pattern for production deployments.

**JSON Logging**: Configure logging via `createLogger({ format: 'json' })` to output structured JSON logs with timestamp, level, message, context, and metadata.

**Injectable Logger**: Library defaults to `{ level: 'warn' }` - warnings and errors are visible, but debug/info noise is hidden. Configure via the `logging` option:

```typescript
import { createLogger, AdCPClient } from '@adcp/client';

const client = new AdCPClient(agents, {
  logging: { level: 'debug', format: 'json' }
});
```

New exports: `ILogger`, `noopLogger`, `LogFormat`
