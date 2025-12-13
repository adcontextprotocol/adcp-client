---
"@adcp/client": minor
---

**JSON Logging**: Add `format: 'json'` option to logger for structured JSON output with timestamp, level, message, context, and metadata fields.

```typescript
import { createLogger } from '@adcp/client';

const logger = createLogger({ level: 'debug', format: 'json' });
// Output: {"timestamp":"2025-12-13T...","level":"info","message":"...","context":"...","meta":{}}
```

**Injectable Logger Interface**: New `ILogger` interface for dependency injection and `noopLogger` singleton for silent library defaults.

New exports: `ILogger`, `noopLogger`, `LogFormat`
