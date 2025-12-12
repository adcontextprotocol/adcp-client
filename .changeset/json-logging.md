---
"@adcp/client": minor
---

Add JSON logging format for production deployments. Set `LOG_FORMAT=json` environment variable or configure via `createLogger({ format: 'json' })` to output structured JSON logs with timestamp, level, message, context, and metadata.
