---
"@adcp/client": major
---

**BREAKING**: Remove `auth_token_env` from `AgentConfig`. Use `auth_token` directly instead.

Before:
```typescript
{ auth_token_env: 'MY_TOKEN_ENV_VAR' }  // looked up from process.env
```

After:
```typescript
{ auth_token: process.env.MY_TOKEN_ENV_VAR }  // caller handles env lookup
```

**JSON Logging**: Configure logging via `createLogger({ format: 'json' })` to output structured JSON logs with timestamp, level, message, context, and metadata.

**Injectable Logger**: Library defaults to `{ level: 'warn' }` - warnings and errors are visible, but debug/info noise is hidden. Configure via the `logging` option:

```typescript
import { createLogger, AdCPClient } from '@adcp/client';

const client = new AdCPClient(agents, {
  logging: { level: 'debug', format: 'json' }
});
```

New exports: `ILogger`, `noopLogger`, `LogFormat`
