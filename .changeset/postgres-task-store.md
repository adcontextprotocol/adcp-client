---
"@adcp/client": minor
---

Added PostgresTaskStore for distributed MCP servers. Replaces InMemoryTaskStore when running multiple server instances behind a load balancer, storing tasks in a shared PostgreSQL table. Includes MCP_TASKS_MIGRATION SQL constant and cleanupExpiredTasks() utility.
