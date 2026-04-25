---
"@adcp/client": minor
---

feat(server): PostgresTaskStore.createTask accepts optional caller-supplied taskId

Compliance storyboard controller scenarios (`force_create_media_buy_arm`,
`force_task_completion`) need to inject buyer-supplied task IDs for storyboard
determinism. `PostgresTaskStore.createTask` now accepts an optional `taskId`
field on its first argument: when supplied, the ID is used verbatim; when
omitted, a random hex ID is generated as before. Throws if the supplied ID is
empty, longer than 128 characters, or already exists (the collision is detected
via PG uniqueness constraint, not a pre-check race).

**Caveats and follow-ups:**
- `InMemoryTaskStore` (re-exported from the upstream MCP SDK) does NOT honor
  caller-supplied `taskId` — sellers running without `DATABASE_URL` (e.g., test
  paths) get random IDs even when one is supplied. Filing an upstream MCP SDK
  issue to add `taskId?: string` to `CreateTaskOptions` so both stores can honor
  it cleanly is the right durable fix; this PR is the Postgres-only shim until
  upstream lands.
- The `task_id` namespace on `PostgresTaskStore` is process-global today (no
  tenant scoping in the schema). Callers using caller-supplied IDs are
  responsible for namespace isolation. A future migration to a composite
  `(tenant_id, task_id)` key would close this for production use.
- The storyboard runner does not yet send caller-supplied IDs through to the
  controller tool's input schema. That wiring (runner → tool input → task
  store) is a separate change tracked in the parent issue.
