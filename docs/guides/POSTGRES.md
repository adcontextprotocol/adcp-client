# Postgres operations guide

How the SDK uses Postgres, what to monitor, and how to size your deployment.

## What the SDK persists

When you wire `pool` on `createAdcpServerFromPlatform`, the framework creates and uses three tables:

| Table | Purpose | Row lifetime | Growth |
|---|---|---|---|
| `adcp_idempotency` | Idempotency cache for replay-safe mutating tools | TTL-bounded (default 24h) | Bounded by request rate × 24h |
| `adcp_ctx_metadata` | Adapter-internal state round-trip cache | Lifetime of referenced resource (often months) | Bounded by your active product / media-buy / creative count |
| `adcp_decisioning_tasks` | HITL task lifecycle (submitted → working → completed/failed) | Until terminal + manual cleanup | Bounded by HITL request volume |

**Run `getAllAdcpMigrations()` once per database at deploy time.** Idempotent: safe to re-run on every boot.

## Schema + index rationale

### `adcp_idempotency`

```sql
CREATE TABLE adcp_idempotency (
  scoped_key   TEXT PRIMARY KEY,    -- ${principal}${key}[${extraScope}]
  payload_hash TEXT NOT NULL,        -- SHA-256 of canonical request payload (RFC 8785 JCS)
  response     JSONB NOT NULL,        -- cached response envelope for replay
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_adcp_idempotency_expires_at ON adcp_idempotency(expires_at);
```

- **PK on `scoped_key`** — every lookup is a primary-key seek; O(1) on B-tree.
- **Index on `expires_at`** — supports `cleanupExpiredIdempotency()` deletes (`WHERE expires_at < NOW()`).
- **No row-level TTL extension required** — Postgres doesn't have native TTL; cleanup is adopter-driven via the helper.

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

```sql
CREATE TABLE adcp_decisioning_tasks (
  task_id        TEXT PRIMARY KEY,
  tool           TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'submitted',
  status_message TEXT,
  result         JSONB,
  error          JSONB,
  progress       JSONB,
  has_webhook    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT adcp_decisioning_tasks_valid_status CHECK (
    status IN ('submitted', 'working', 'completed', 'failed')
  )
);
CREATE INDEX idx_adcp_decisioning_tasks_account_id ON adcp_decisioning_tasks(account_id);
CREATE INDEX idx_adcp_decisioning_tasks_status_created ON adcp_decisioning_tasks(status, created_at);
```

- **PK on `task_id`** — primary lookup path.
- **Index on `account_id`** — tenant-scoped reads (`getTaskState(taskId, expectedAccountId)` and ops queries).
- **Index on `(status, created_at)`** — "pending tasks oldest first" queue queries for cron / monitoring.
- **CHECK constraint on status** — guards against invalid transitions writing bad rows.

**Sizing.** Bounded by HITL traffic. Tasks accumulate forever unless adopter prunes — the SDK doesn't auto-delete completed tasks. Run a periodic `DELETE FROM adcp_decisioning_tasks WHERE status IN ('completed', 'failed') AND updated_at < NOW() - INTERVAL '30 days'`.

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

The framework's PG backends emit no-op SELECTs (`SELECT 1 FROM ${table} LIMIT 0`) via `probe()` to surface bad credentials at boot rather than first-mutating-request.

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

The SDK shares one Postgres database across tenants. `account_id` is included in `scoped_key` for idempotency + ctx_metadata, so cross-tenant collisions are impossible at the storage layer. For `adcp_decisioning_tasks`, the SDK relies on `accounts.resolve(ref, ctx)` returning each tenant's own Account — the registry sees `account_id` strings that should be tenant-prefixed in adopter code (e.g., `id: \`tenant_${tenantId}_${accountId}\``).

See `skills/build-decisioning-platform/advanced/MULTI-TENANT.md` for the full pattern.

## Backups + disaster recovery

The SDK doesn't manage backups. Standard guidance applies:

- **Idempotency table:** can be lost on disaster recovery — buyers retry mutating tools with the same idempotency_key, and the framework re-executes (the buyer's perspective: "my retry worked"). The cost is double-execution risk for the small window where a request landed and the response was cached but the DB was lost. Recommend point-in-time-recovery if you can; otherwise accept the risk.
- **ctx_metadata table:** also recoverable — publishers re-derive on next reference (slight cost-per-call hit, no correctness risk).
- **Task registry:** task records are needed to honor `tasks_get` polling. If you lose the task table, in-flight HITL tasks become unreachable from the buyer side. Keep this table backed up.
