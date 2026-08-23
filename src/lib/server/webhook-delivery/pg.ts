import type { PgQueryable } from '../postgres-task-store';
import { randomUUID } from 'node:crypto';
import type {
  WebhookDeliveryKey,
  WebhookDeliveryProposal,
  WebhookDeliveryRecord,
  WebhookDeliveryStore,
} from '../webhook-emitter';
import {
  assertDeliveryKey,
  assertLeaseControls,
  assertProposal,
  assertRetentionMs,
  assertRetryAfterMs,
  assertWebhookDisposition,
  parseDeliveryRecord,
  quoteWebhookTable,
} from './common';
import type { StoredWebhookDeliverySnapshot, WebhookDeliveryRecoveryBackend, WebhookRecoveryRecord } from './recovery';

const DEFAULT_TABLE = 'adcp_webhook_deliveries';
const DEFAULT_OUTBOX_TABLE = 'adcp_webhook_outbox';

function assertPgDeploymentNamespace(
  api: string,
  tableName: string,
  defaultTableName: string,
  options: { acknowledgeIsolatedDatabase?: boolean }
): void {
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!development && tableName === defaultTableName && !options.acknowledgeIsolatedDatabase) {
    throw new Error(`${api}: production requires a deployment-unique tableName or acknowledgeIsolatedDatabase: true`);
  }
}

export interface PgWebhookDeliveryStoreOptions {
  /** Defaults to `adcp_webhook_deliveries`. */
  tableName?: string;
  /** Assert that the database/schema is dedicated to this deployment. */
  acknowledgeIsolatedDatabase?: boolean;
}

export interface PgWebhookDeliveryRecoveryOptions {
  /** Defaults to `adcp_webhook_outbox`. */
  tableName?: string;
  /** Assert that the database/schema is dedicated to this deployment. */
  acknowledgeIsolatedDatabase?: boolean;
}

export function getWebhookDeliveryMigration(options: PgWebhookDeliveryStoreOptions = {}): string {
  const raw = options.tableName ?? DEFAULT_TABLE;
  const table = quoteWebhookTable(raw);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  publisher_scope     TEXT NOT NULL,
  tenant_scope        TEXT NOT NULL,
  delivery_id         TEXT NOT NULL,
  status              TEXT NOT NULL,
  idempotency_key     TEXT,
  payload_fingerprint TEXT,
  first_attempt_at    TIMESTAMPTZ,
  retain_until        TIMESTAMPTZ,
  PRIMARY KEY (publisher_scope, tenant_scope, delivery_id),
  CONSTRAINT ${raw}_valid_status CHECK (status IN ('bound', 'retired')),
  CONSTRAINT ${raw}_bound_fields CHECK (
    status = 'retired' OR
    (idempotency_key IS NOT NULL AND payload_fingerprint IS NOT NULL AND
     first_attempt_at IS NOT NULL AND retain_until IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_${raw}_retain_until
  ON ${table}(retain_until) WHERE status = 'bound';
`.trim();
}

export const WEBHOOK_DELIVERY_MIGRATION = getWebhookDeliveryMigration();

export function getWebhookDeliveryRecoveryMigration(options: PgWebhookDeliveryRecoveryOptions = {}): string {
  const raw = options.tableName ?? DEFAULT_OUTBOX_TABLE;
  const table = quoteWebhookTable(raw);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  publisher_scope     TEXT NOT NULL,
  tenant_scope        TEXT NOT NULL,
  delivery_id         TEXT NOT NULL,
  snapshot            JSONB NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  storage_fingerprint  TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending',
  disposition         TEXT,
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner         TEXT,
  lease_claim_id      TEXT,
  lease_version       BIGINT NOT NULL DEFAULT 0,
  lease_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at          TIMESTAMPTZ,
  PRIMARY KEY (publisher_scope, tenant_scope, delivery_id),
  CONSTRAINT ${raw}_valid_state CHECK (state IN ('pending', 'settled')),
  CONSTRAINT ${raw}_valid_disposition CHECK (disposition IS NULL OR disposition IN ('delivered', 'terminal'))
);

CREATE INDEX IF NOT EXISTS idx_${raw}_pending
  ON ${table}(next_attempt_at, lease_expires_at) WHERE state = 'pending';
`.trim();
}

export const WEBHOOK_DELIVERY_RECOVERY_MIGRATION = getWebhookDeliveryRecoveryMigration();

/** PostgreSQL implementation of the immutable publisher delivery binding. */
export function pgWebhookDeliveryStore(
  db: PgQueryable,
  options: PgWebhookDeliveryStoreOptions = {}
): WebhookDeliveryStore & { probe(): Promise<void> } {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const table = quoteWebhookTable(tableName);
  assertPgDeploymentNamespace('pgWebhookDeliveryStore', tableName, DEFAULT_TABLE, options);

  async function query(operation: string, text: string, values?: unknown[]) {
    try {
      return await db.query(text, values);
    } catch (cause) {
      throw new Error(`pgWebhookDeliveryStore.${operation}: database operation failed`, { cause });
    }
  }

  return {
    durability: 'durable',
    async probe(): Promise<void> {
      try {
        await db.query(
          `SELECT publisher_scope, tenant_scope, delivery_id, status, idempotency_key,
                  payload_fingerprint, first_attempt_at, retain_until FROM ${table} LIMIT 0`
        );
      } catch (cause) {
        throw new Error(
          `webhook delivery store probe failed: cannot reach the "${tableName}" table. Run getWebhookDeliveryMigration() before serving.`,
          { cause }
        );
      }
    },
    async claim(
      key: Readonly<WebhookDeliveryKey>,
      proposed: Readonly<WebhookDeliveryProposal>,
      retentionMs: number
    ): Promise<WebhookDeliveryRecord> {
      assertDeliveryKey(key);
      assertProposal(proposed);
      assertRetentionMs(retentionMs);
      // One upsert is the transaction boundary. ON CONFLICT locks the row;
      // existing immutable fields never change. The backend clock decides
      // both the initial horizon and the one-way transition to a tombstone.
      const result = await query(
        'claim',
        `INSERT INTO ${table} (
           publisher_scope, tenant_scope, delivery_id, status,
           idempotency_key, payload_fingerprint, first_attempt_at, retain_until
         ) VALUES ($1, $2, $3, 'bound', $4, $5, clock_timestamp(),
                   clock_timestamp() + ($6::bigint * INTERVAL '1 millisecond'))
         ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO UPDATE SET
           status = CASE
             WHEN ${table}.status = 'bound' AND ${table}.retain_until < clock_timestamp()
               THEN 'retired'
             ELSE ${table}.status
           END
         RETURNING status, idempotency_key, payload_fingerprint,
                   FLOOR(EXTRACT(EPOCH FROM first_attempt_at) * 1000)::bigint AS first_attempt_at_ms,
                   FLOOR(EXTRACT(EPOCH FROM retain_until) * 1000)::bigint AS retain_until_ms`,
        [
          key.publisherScope,
          key.tenantScope,
          key.deliveryId,
          proposed.idempotencyKey,
          proposed.payloadFingerprint,
          retentionMs,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error('pgWebhookDeliveryStore.claim: database returned no delivery record');
      if (row.status === 'retired') return { status: 'retired' };
      return parseDeliveryRecord(
        {
          status: row.status,
          idempotencyKey: row.idempotency_key,
          payloadFingerprint: row.payload_fingerprint,
          firstAttemptAtMs: Number(row.first_attempt_at_ms),
          retainUntilMs: Number(row.retain_until_ms),
        },
        'pgWebhookDeliveryStore'
      );
    },
  };
}

/** PostgreSQL durable outbox with atomic, fenced recovery leases. */
export function pgWebhookDeliveryRecoveryBackend(
  db: PgQueryable,
  options: PgWebhookDeliveryRecoveryOptions = {}
): WebhookDeliveryRecoveryBackend {
  const tableName = options.tableName ?? DEFAULT_OUTBOX_TABLE;
  const table = quoteWebhookTable(tableName);
  assertPgDeploymentNamespace('pgWebhookDeliveryRecoveryBackend', tableName, DEFAULT_OUTBOX_TABLE, options);

  async function query(operation: string, text: string, values?: unknown[]) {
    try {
      return await db.query(text, values);
    } catch (cause) {
      throw new Error(`pgWebhookDeliveryRecoveryBackend.${operation}: database operation failed`, { cause });
    }
  }

  return {
    durability: 'durable',
    async probe(): Promise<void> {
      try {
        await db.query(
          `SELECT publisher_scope, tenant_scope, delivery_id, snapshot, snapshot_fingerprint,
                  storage_fingerprint, state, disposition, attempt_count, next_attempt_at, lease_owner,
                  lease_claim_id, lease_version, lease_expires_at FROM ${table} LIMIT 0`
        );
      } catch (cause) {
        throw new Error(
          `webhook recovery probe failed: cannot reach the "${tableName}" table. Run getWebhookDeliveryRecoveryMigration() before serving.`,
          { cause }
        );
      }
    },
    async checkpoint(key, snapshot, snapshotFingerprint, storageFingerprint, initialLease) {
      assertDeliveryKey(key);
      assertLeaseControls(initialLease.ownerToken, initialLease.leaseMs);
      const leaseClaimId = randomUUID();
      const result = await query(
        'checkpoint',
        `WITH backend_clock AS MATERIALIZED (SELECT clock_timestamp() AS now_at)
         INSERT INTO ${table} (
           publisher_scope, tenant_scope, delivery_id, snapshot, snapshot_fingerprint,
           storage_fingerprint, lease_owner, lease_claim_id, lease_version, lease_expires_at, attempt_count
         ) SELECT $1, $2, $3, $4::jsonb, $5, $6, $7, $9, 1,
                  backend_clock.now_at + ($8::bigint * INTERVAL '1 millisecond'), 1
           FROM backend_clock
         ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO UPDATE SET
           (lease_owner, lease_claim_id, lease_version, lease_expires_at, attempt_count) = (
             SELECT
               CASE WHEN decision.acquire THEN $7 ELSE ${table}.lease_owner END,
               CASE WHEN decision.acquire THEN $9 ELSE ${table}.lease_claim_id END,
               CASE WHEN decision.acquire THEN ${table}.lease_version + 1 ELSE ${table}.lease_version END,
               CASE WHEN decision.acquire
                 THEN decision.now_at + ($8::bigint * INTERVAL '1 millisecond')
                 ELSE ${table}.lease_expires_at END,
               CASE WHEN decision.acquire THEN ${table}.attempt_count + 1 ELSE ${table}.attempt_count END
             FROM (
               SELECT backend_clock.now_at,
                 ${table}.snapshot_fingerprint = $5 AND ${table}.state = 'pending'
                 AND (${table}.lease_expires_at IS NULL OR ${table}.lease_expires_at < backend_clock.now_at)
                   AS acquire
               FROM backend_clock
             ) AS decision
           )
         RETURNING snapshot, snapshot_fingerprint, storage_fingerprint, state, attempt_count, (xmax = 0) AS inserted,
           FLOOR(EXTRACT(EPOCH FROM next_attempt_at) * 1000)::bigint AS next_attempt_at_ms,
           lease_owner, lease_claim_id, lease_version,
           FLOOR(EXTRACT(EPOCH FROM lease_expires_at) * 1000)::bigint AS lease_expires_at_ms`,
        [
          key.publisherScope,
          key.tenantScope,
          key.deliveryId,
          JSON.stringify(snapshot),
          snapshotFingerprint,
          storageFingerprint,
          initialLease.ownerToken,
          initialLease.leaseMs,
          leaseClaimId,
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error('pgWebhookDeliveryRecoveryBackend.checkpoint: database returned no row');
      if (row.snapshot_fingerprint !== snapshotFingerprint) return { result: 'conflict' };
      if (row.state === 'settled') return { result: 'duplicate', settled: true };
      const ownsLease = row.lease_claim_id === leaseClaimId;
      return {
        result: row.inserted === true ? 'inserted' : 'duplicate',
        ...(ownsLease && {
          lease: rowToRecoveryRecord({
            ...row,
            publisher_scope: key.publisherScope,
            tenant_scope: key.tenantScope,
            delivery_id: key.deliveryId,
            snapshot_fingerprint: snapshotFingerprint,
          }),
        }),
      };
    },
    async settle(key, disposition): Promise<void> {
      assertDeliveryKey(key);
      assertWebhookDisposition(disposition);
      await query(
        'settle',
        `UPDATE ${table} SET state = 'settled', disposition = $4, snapshot = '{}'::jsonb,
           settled_at = clock_timestamp(), lease_owner = NULL, lease_claim_id = NULL, lease_expires_at = NULL
         WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
           AND (state = 'settled' OR lease_owner IS NULL OR lease_expires_at < clock_timestamp())`,
        [key.publisherScope, key.tenantScope, key.deliveryId, disposition]
      );
    },
    async claimPending({ ownerToken, leaseMs, limit }): Promise<WebhookRecoveryRecord[]> {
      assertLeaseControls(ownerToken, leaseMs, limit);
      const result = await query(
        'claimPending',
        `WITH candidates AS (
           SELECT publisher_scope, tenant_scope, delivery_id
           FROM ${table}
           WHERE state = 'pending'
             AND next_attempt_at <= clock_timestamp()
             AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
           ORDER BY next_attempt_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         UPDATE ${table} AS outbox SET
           lease_owner = $1,
           lease_claim_id = NULL,
           lease_version = outbox.lease_version + 1,
           lease_expires_at = clock_timestamp() + ($2::bigint * INTERVAL '1 millisecond'),
           attempt_count = outbox.attempt_count + 1
         FROM candidates
         WHERE outbox.publisher_scope = candidates.publisher_scope
           AND outbox.tenant_scope = candidates.tenant_scope
           AND outbox.delivery_id = candidates.delivery_id
         RETURNING outbox.publisher_scope, outbox.tenant_scope, outbox.delivery_id,
           outbox.snapshot, outbox.snapshot_fingerprint, outbox.attempt_count,
           outbox.storage_fingerprint,
           FLOOR(EXTRACT(EPOCH FROM outbox.next_attempt_at) * 1000)::bigint AS next_attempt_at_ms,
           outbox.lease_owner, outbox.lease_version,
           FLOOR(EXTRACT(EPOCH FROM outbox.lease_expires_at) * 1000)::bigint AS lease_expires_at_ms`,
        [ownerToken, leaseMs, limit]
      );
      return result.rows.map(rowToRecoveryRecord);
    },
    async renew(lease, leaseMs): Promise<number | null> {
      assertDeliveryKey(lease.key);
      assertLeaseControls(lease.leaseOwner, leaseMs);
      const result = await query(
        'renew',
        `UPDATE ${table} SET lease_expires_at = clock_timestamp() + ($6::bigint * INTERVAL '1 millisecond')
         WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
           AND state = 'pending' AND lease_owner = $4 AND lease_version = $5
           AND lease_expires_at >= clock_timestamp()
         RETURNING FLOOR(EXTRACT(EPOCH FROM lease_expires_at) * 1000)::bigint AS lease_expires_at_ms`,
        [
          lease.key.publisherScope,
          lease.key.tenantScope,
          lease.key.deliveryId,
          lease.leaseOwner,
          lease.leaseVersion,
          leaseMs,
        ]
      );
      return result.rows[0] ? Number(result.rows[0].lease_expires_at_ms) : null;
    },
    async release(lease, retryAfterMs): Promise<boolean> {
      assertDeliveryKey(lease.key);
      assertLeaseControls(lease.leaseOwner, 1);
      assertRetryAfterMs(retryAfterMs);
      const result = await query(
        'release',
        `UPDATE ${table} SET lease_owner = NULL, lease_claim_id = NULL, lease_expires_at = NULL,
           next_attempt_at = clock_timestamp() + ($6::bigint * INTERVAL '1 millisecond')
         WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
           AND state = 'pending' AND lease_owner = $4 AND lease_version = $5
           AND lease_expires_at >= clock_timestamp()
         RETURNING delivery_id`,
        [
          lease.key.publisherScope,
          lease.key.tenantScope,
          lease.key.deliveryId,
          lease.leaseOwner,
          lease.leaseVersion,
          retryAfterMs,
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },
    async settleLease(lease, disposition): Promise<boolean> {
      assertDeliveryKey(lease.key);
      assertLeaseControls(lease.leaseOwner, 1);
      assertWebhookDisposition(disposition);
      const result = await query(
        'settleLease',
        `UPDATE ${table} SET state = 'settled', disposition = $6, snapshot = '{}'::jsonb, settled_at = clock_timestamp(),
           lease_owner = NULL, lease_claim_id = NULL, lease_expires_at = NULL
         WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3
           AND state = 'pending' AND lease_owner = $4 AND lease_version = $5
           AND lease_expires_at >= clock_timestamp()
         RETURNING delivery_id`,
        [
          lease.key.publisherScope,
          lease.key.tenantScope,
          lease.key.deliveryId,
          lease.leaseOwner,
          lease.leaseVersion,
          disposition,
        ]
      );
      return (result.rowCount ?? 0) === 1;
    },
  };
}

function rowToRecoveryRecord(row: Record<string, unknown>): WebhookRecoveryRecord {
  const snapshot = row.snapshot as StoredWebhookDeliverySnapshot;
  if (!snapshot || typeof snapshot !== 'object') throw new Error('pgWebhookDeliveryRecoveryBackend: corrupt snapshot');
  return {
    key: {
      publisherScope: String(row.publisher_scope),
      tenantScope: String(row.tenant_scope),
      deliveryId: String(row.delivery_id),
    },
    snapshot,
    snapshotFingerprint: String(row.snapshot_fingerprint),
    storageFingerprint: String(row.storage_fingerprint),
    attemptCount: Number(row.attempt_count),
    nextAttemptAtMs: Number(row.next_attempt_at_ms),
    leaseOwner: String(row.lease_owner),
    leaseVersion: Number(row.lease_version),
    leaseExpiresAtMs: Number(row.lease_expires_at_ms),
  };
}
