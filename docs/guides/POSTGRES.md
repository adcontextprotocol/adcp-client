# Postgres operations guide

How the SDK uses Postgres, what to monitor, and how to size your deployment.

## What the SDK persists

When you wire `pool` on `createAdcpServerFromPlatform`, the framework creates and uses three tables:

| Table | Purpose | Row lifetime | Growth |
|---|---|---|---|
| `adcp_idempotency` | Idempotency cache for replay-safe mutating tools | TTL-bounded (default 24h) | Bounded by request rate × 24h |
| `adcp_ctx_metadata` | Adapter-internal state round-trip cache | Lifetime of referenced resource (often months) | Bounded by your active product / media-buy / creative count |
| `adcp_decisioning_tasks` | HITL task lifecycle (submitted → working → completed/failed) | Until terminal + manual cleanup | Bounded by HITL request volume |

**Use `getAllAdcpMigrations({ taskRegistryNamespace })` only to bootstrap new framework tables.** The namespace must be stable and unique per hosted tenant. Re-running the bootstrap against an already-current schema is harmless, but it does not upgrade a populated legacy task registry. Use the explicit operator runbook below for that cutover.

If out-of-process workers will settle scoped task refs after restart, also set
`taskRegistryStorageId` on the `pool` shortcut (or `storageId` on
`createPostgresTaskRegistry`). It must be a stable, non-secret identifier that
is unique to the physical database/schema and environment. The SDK combines it
with table and namespace in the serialized handle; without it, strict worker
settlement fails closed while ordinary registry access remains compatible.

`getAllAdcpMigrations({ taskRegistryNamespace })` installs one default idempotency table. The official
`serve()` path automatically includes its canonical, server-controlled host in
every resolved idempotency principal, so multiple hosted agents remain isolated
when they share that table. Low-level integrations that do not enter through
`serve()` must create a distinct table/store per logical agent (or add an
equivalent trusted host discriminator themselves):

```ts
await pool.query(getIdempotencyMigration({ tableName: 'seller_a_idempotency' }));
await pool.query(getIdempotencyMigration({ tableName: 'seller_b_idempotency' }));

const sellerAIdempotency = createIdempotencyStore({
  backend: pgBackend(pool, { tableName: 'seller_a_idempotency' }),
});
const sellerBIdempotency = createIdempotencyStore({
  backend: pgBackend(pool, { tableName: 'seller_b_idempotency' }),
});
```

Pass the matching store as the `idempotency` option to each low-level server.
The separate tables preserve the framework's normal authenticated/session/account
principal chain without relying on untrusted request fields.

## Schema + index rationale

### `adcp_idempotency`

```sql
CREATE TABLE adcp_idempotency (
  scoped_key   TEXT PRIMARY KEY,    -- ${principal}${key}[${extraScope}]
  payload_hash TEXT NOT NULL,        -- SHA-256 of canonical request payload (RFC 8785 JCS)
  response     JSONB NOT NULL,        -- cached response envelope for replay
  expires_at   TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ,            -- physical replay-retention horizon
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_adcp_idempotency_retain_until
  ON adcp_idempotency(retain_until, expires_at);
```

- **PK on `scoped_key`** — every lookup is a primary-key seek; O(1) on B-tree.
- **Cleanup-compatible raw-column index** — cleanup uses an equivalent two-branch predicate over `retain_until` and `expires_at`, allowing this valid immutable index to assist without indexing a non-immutable `TIMESTAMPTZ + INTERVAL` expression.
- **Rolling-writer safety** — `retain_until` remains nullable. Reads and cleanup use the greater of it and `expires_at + legacyRetentionGraceSeconds`, so an older replica that updates only `expires_at` cannot make a live claim cleanup-eligible.
- **Configuration coupling** — `legacyRetentionGraceSeconds` defaults to 120 and must be at least the store's `clockSkewSeconds`. Pass the same `PgBackendOptions` to `getIdempotencyMigration()`, `pgBackend()`, and `cleanupExpiredIdempotency()` when overriding it; unsafe store/backend combinations throw at construction. When PostgreSQL is wrapped by `createLazyBackend()`, also declare that grace in the lazy-backend options so it can be checked synchronously; the resolved backend is checked again before its first operation.
- **Cleanup remains adopter-driven** — Postgres has no native TTL; run `cleanupExpiredIdempotency()` periodically.

**Sizing.** With a 24h default TTL: row count ≈ `requests_per_second × 86400 × write_proportion`. At 10 req/s of mutating traffic, ~864K rows steady-state. JSONB response payloads are typically 1-5KB; expect ~5GB table size at that volume.

### `adcp_ctx_metadata`

```sql
CREATE TABLE adcp_ctx_metadata (
  scoped_key TEXT PRIMARY KEY,    -- ${account_id}${kind}${id}
  value      JSONB NOT NULL,       -- publisher-attached blob + SDK-cached wire resource
  expires_at TIMESTAMPTZ,           -- optional; most rows never expire
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_adcp_ctx_metadata_expires_at
  ON adcp_ctx_metadata(expires_at)
  WHERE expires_at IS NOT NULL;
```

- **PK on `scoped_key`** — same fast lookup. `bulkGet` uses `WHERE scoped_key = ANY($1::text[])` (single param, no expansion).
- **Partial index on `expires_at WHERE NOT NULL`** — most rows have no TTL (lifetime of media buy / product can be months); the partial index avoids indexing the common no-TTL case.
- **Last-write-wins upsert** — `INSERT ... ON CONFLICT (scoped_key) DO UPDATE`. No JSONB partial merge by design.

**Sizing.** Bounded by `active_products × tenants` for product entries plus `active_media_buys × tenants` for media-buy entries. At 1000 products × 100 tenants = 100K rows steady-state. JSONB values are typically <16KB (cap enforced at write time). Expect ~1-2GB at that scale.

**Cleanup is adopter-driven.** No auto-eviction. Run `cleanupExpiredCtxMetadata(pool)` periodically (hourly) for adopters using row-level `expires_at`. For products/media-buys with no TTL, prune via your own `DELETE FROM adcp_ctx_metadata WHERE scoped_key LIKE 'acct_X%' AND <your-business-condition>` — the framework doesn't model "this resource is done."

### `adcp_decisioning_tasks`

This bootstrap DDL is returned by `getDecisioningTaskRegistryBootstrap()` (exported from `@adcp/sdk/server`). Run it while provisioning a new/empty database, using the same stable trusted namespace passed to the registry. Pass `{ tableName: 'your_tasks', namespace: taskRegistryNamespace }` to override the default table name. Use `getAllAdcpMigrations({ taskRegistryNamespace })` from `@adcp/sdk/server` when provisioning all three SDK tables at once. The deprecated `getDecisioningTaskRegistryMigration()` now throws so a populated legacy table cannot appear successfully migrated; choose bootstrap or the phased upgrade explicitly.

```sql
CREATE TABLE adcp_decisioning_tasks (
  registry_namespace TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  tool           TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  owner_scope    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'submitted',
  status_message TEXT,
  result         JSONB,
  error          JSONB,
  progress       JSONB,
  has_webhook    BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_delivery TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adcp_decisioning_tasks_valid_status CHECK (
    status IN (
      'submitted', 'working', 'input-required', 'completed', 'canceled',
      'failed', 'rejected', 'auth-required', 'unknown'
    )
  ),
  CONSTRAINT adcp_decisioning_tasks_valid_webhook_delivery CHECK (
    webhook_delivery IS NULL OR webhook_delivery IN ('framework', 'external')
  ),
  PRIMARY KEY (registry_namespace, account_id, owner_scope, task_id)
);
CREATE INDEX idx_adcp_decisioning_tasks_account_id ON adcp_decisioning_tasks(account_id);
CREATE INDEX idx_adcp_decisioning_tasks_status_created ON adcp_decisioning_tasks(status, created_at);
```

The status constraint admits all nine AdCP `TaskStatus` values. Built-in registries write `submitted`, `working`, `completed`, `failed`, and the business-decision terminal state `rejected`; custom registries can persist the remaining spec states.

- **Composite PK on registry namespace, account, owner, and task ID** — prevents task identifiers from crossing hosted-tenant, account, or authenticated-principal boundaries.
- **Index on `account_id`** — tenant-scoped operational queries.
- **Index on `(status, created_at)`** — "pending tasks oldest first" queue queries for cron / monitoring.
- **CHECK constraint on status** — guards against invalid status writes while preserving the full AdCP enum.
- **CHECK constraint on webhook delivery** — records whether a push task is framework- or adopter-owned.

**Sizing.** Bounded by HITL traffic. Tasks accumulate forever unless adopter prunes — the SDK doesn't auto-delete completed tasks. Run a periodic `DELETE FROM adcp_decisioning_tasks WHERE status IN ('completed', 'failed', 'rejected') AND updated_at < NOW() - INTERVAL '30 days'`.

### Widening the status CHECK on an existing scoped table

Existing tables bootstrapped by earlier SDK versions reject `rejected` rows. Before deploying `reject()` or `rejectScopedPushTask()`, run the idempotent operator migration once against the same table:

```ts
await pool.query(getDecisioningTaskRegistryStatusWidenV61Migration({
  tableName: 'adcp_decisioning_tasks',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
}));
```

The helper replaces only the named status CHECK with the full nine-value enum; it does not rewrite rows. It uses a transaction-scoped advisory lock plus bounded lock and statement timeouts, and is safe to rerun after a successful or interrupted attempt. `ALTER TABLE` needs an `ACCESS EXCLUSIVE` lock, so run it outside application boot during a brief maintenance window: it can block reads and writers until commit, and it fails rather than waiting indefinitely when `lockTimeoutMs` elapses.

### Adding external webhook ownership to an existing task table

Before enabling `externallyManagedTaskWebhooks` for a populated registry, run the idempotent owner-column migration during a maintenance window:

```ts
await pool.query(getDecisioningTaskRegistryWebhookDeliveryV14Migration({
  tableName: 'adcp_decisioning_tasks',
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
}));
```

It adds `webhook_delivery` if absent and replaces its named CHECK constraint. The built-in registry advertises `webhookDeliveryVersion: 1`; custom registries must advertise the same explicit contract and durably retain `webhookDelivery: 'external'` in `create()` before an externally owned push handoff is accepted.

### Upgrading a populated pre-scope task table

Do not run primary-key replacement in application startup. Generate the phased
`getDecisioningTaskRegistryScopeV1Upgrade({ namespace })` plan and follow
[`migration-task-registry-scoping.md`](../migration-task-registry-scoping.md#populated-postgresql-upgrade).
The runbook covers preflight queries, old/new deployment order, bounded lock and
statement timeouts, concurrent index construction, the brief locking cutover,
interruption recovery, ambiguous tenant ownership, and rollback limits.

## Connection pool sizing

The SDK shares one `pg.Pool` across all three tables. Pool size guidance:

| Workload | Recommended pool size |
|---|---|
| Single-process, light traffic (<10 req/s) | 10 connections |
| Single-process, moderate traffic (10-100 req/s) | 25 connections |
| Multi-process / cluster | `cpu_cores × 2` per process, capped at Postgres `max_connections / process_count - safety_margin` |
| Multi-tenant (TenantRegistry) | Same as cluster — pool is shared across tenants in a process |

Each request does at most 2 PG queries (idempotency check + write). HITL requests add 1-2 task-table queries. Idempotency replay hits a single SELECT — minimal pool pressure.

**`pg.Pool` error handling.** Always attach a process-level error handler to avoid Node crashes on idle-client disconnects:

```ts
pool.on('error', (err) => console.error('pg pool error', err));
```

The idempotency and context-metadata PG backends expose zero-row shape probes via
`probe()` to surface bad credentials and stale migrations at boot rather than on
the first mutating request. The idempotency probe names every runtime-required
column, including `retain_until`; a reachable table with an older column shape
therefore fails readiness instead of advertising idempotency that cannot be
persisted. Run the decisioning task-registry migration plan's `verifySql` during
deployment; `TaskRegistry` does not expose a boot-time probe.

## Statement timeout

Recommend a 5s `statement_timeout` on the connection role used by the SDK. Framework queries are bounded:

- Idempotency: PK seek; <5ms
- ctx_metadata `bulkGet`: PK array seek; <20ms for 100 ids
- Task registry: PK + filter; <10ms

A 5s budget is far above any framework operation; it catches a bloated table or a runaway query without aborting normal traffic.

```sql
ALTER ROLE adcp_app SET statement_timeout = '5s';
```

## Vacuum + autovacuum

Idempotency table churns hard (24h TTL → daily turnover). Default autovacuum settings are usually fine, but if you observe bloat:

```sql
ALTER TABLE adcp_idempotency SET (
  autovacuum_vacuum_scale_factor = 0.05,    -- vacuum at 5% dead rows (default 0.2)
  autovacuum_analyze_scale_factor = 0.05
);
```

`adcp_ctx_metadata` and `adcp_decisioning_tasks` have lower update churn — defaults are fine.

## Monitoring

Metrics to track:

- **Row counts** per table (alert on growth beyond expected sizing)
- **Index hit rate** (should be >99% on PK lookups)
- **Cleanup query duration** (`cleanupExpiredIdempotency`, `cleanupExpiredCtxMetadata`)
- **Connection pool saturation** — `pool.totalCount`, `pool.idleCount`, `pool.waitingCount`
- **Slow query log** — anything >100ms is suspicious

```sql
-- Row counts
SELECT 'idempotency' AS t, COUNT(*) FROM adcp_idempotency
UNION ALL SELECT 'ctx_metadata', COUNT(*) FROM adcp_ctx_metadata
UNION ALL SELECT 'tasks', COUNT(*) FROM adcp_decisioning_tasks;

-- Idempotency expiration distribution (next 24h cleanup target)
SELECT date_trunc('hour', expires_at) AS hour, COUNT(*) FROM adcp_idempotency
GROUP BY 1 ORDER BY 1;
```

## Cleanup cron

Recommended cleanup helpers (run hourly):

```ts
import { cleanupExpiredIdempotency } from '@adcp/sdk/server';
import { cleanupExpiredCtxMetadata } from '@adcp/sdk/server';

setInterval(async () => {
  const idempCount = await cleanupExpiredIdempotency(pool);
  const ctxCount = await cleanupExpiredCtxMetadata(pool);
  log.info({ idempCount, ctxCount }, 'adcp cleanup');
}, 60 * 60 * 1000); // hourly
```

For `adcp_decisioning_tasks`, write your own cleanup (the SDK doesn't ship one because retention policy is adopter-specific):

```ts
async function cleanupOldTasks() {
  await pool.query(
    `DELETE FROM adcp_decisioning_tasks WHERE status IN ('completed', 'failed') AND updated_at < NOW() - INTERVAL '30 days'`
  );
}
```

## Multi-tenant deployments (TenantRegistry)

The SDK shares one Postgres database across tenants. `account_id` is included in `scoped_key` for idempotency + ctx_metadata, so cross-tenant collisions are impossible at the storage layer within one logical agent. `serve()` additionally scopes idempotency by canonical host for multi-host agents; direct transports must apply the per-agent-table recipe above. For `adcp_decisioning_tasks`, the SDK relies on `accounts.resolve(ref, ctx)` returning each tenant's own Account — the registry sees `account_id` strings that should be tenant-prefixed in adopter code (e.g., `id: \`tenant_${tenantId}_${accountId}\``).

The `tasks_get` wire handler enforces the `account_id` boundary before returning any task record, so adopters do not need to add additional authorization checks in platform code.

See `skills/build-decisioning-platform/advanced/MULTI-TENANT.md` for the full pattern.

## Backups + disaster recovery

The SDK doesn't manage backups. Standard guidance applies:

- **Idempotency table:** can be lost on disaster recovery — buyers retry mutating tools with the same idempotency_key, and the framework re-executes (the buyer's perspective: "my retry worked"). The cost is double-execution risk for the small window where a request landed and the response was cached but the DB was lost. Recommend point-in-time-recovery if you can; otherwise accept the risk.
- **ctx_metadata table:** also recoverable — publishers re-derive on next reference (slight cost-per-call hit, no correctness risk).
- **Task registry:** task records are needed to honor `tasks_get` polling. If you lose the task table, in-flight HITL tasks become unreachable from the buyer side. Keep this table backed up.
