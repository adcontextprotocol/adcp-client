import { canonicalJsonSha256 } from '../utils/jcs';
import type {
  ReportingAdjustmentCheckpoint,
  ReportingAdjustmentCheckpointKey,
  ReportingCheckpoint,
  ReportingCheckpointKey,
  ReportingCheckpointStore,
  ReportingPendingConsumerStatus,
  ReportingPendingConsumerStatusKey,
  ReportingPendingConsumerStatusStore,
  ReportingPersistenceLeaseFenceV1,
} from './reconciliation';

const DEFAULT_PREFIX = 'adcp_reporting_consumer';
const MAX_JSON_BYTES = 256 * 1024;
const MAX_CHECKPOINT_BYTES = 16 * 1024;

export interface ReportingConsumerPostgresQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface ReportingChangesCheckpointKeyV1 {
  /** Stable, non-secret seller and authenticated-principal identity. Stored as a SHA-256 digest. */
  consumerScope: string;
  /** Protocol account identifier. Stored verbatim to support indexed operational lookup. */
  accountId: string;
}

export interface ReportingChangesCheckpointV1 {
  checkpoint: string;
  generation: number;
}

export interface ReportingConsumerWorkLeaseV1 extends ReportingPersistenceLeaseFenceV1 {}

export interface ReportingChangesCheckpointStoreV1 {
  get(key: ReportingChangesCheckpointKeyV1): Promise<ReportingChangesCheckpointV1 | undefined>;
  compareAndSet(
    key: ReportingChangesCheckpointKeyV1,
    expected: string | null,
    checkpoint: string,
    /** When supplied, PostgreSQL applies the cursor write only while this exact fenced lease is current. */
    lease?: ReportingConsumerWorkLeaseV1
  ): Promise<'applied' | 'unchanged' | 'conflict'>;
  /** Retire an opaque cursor the seller no longer recognizes or returns. */
  clear?(
    key: ReportingChangesCheckpointKeyV1,
    expected?: string,
    lease?: ReportingConsumerWorkLeaseV1
  ): Promise<boolean>;
}

export interface ReportingConsumerWorkLeaseStoreV1 {
  claim(input: {
    key: ReportingChangesCheckpointKeyV1;
    ownerToken: string;
    leaseMilliseconds: number;
  }): Promise<ReportingConsumerWorkLeaseV1 | null>;
  renew(lease: ReportingConsumerWorkLeaseV1, leaseMilliseconds: number): Promise<ReportingConsumerWorkLeaseV1 | null>;
  release(lease: ReportingConsumerWorkLeaseV1): Promise<boolean>;
}

export interface ReportingConsumerNotificationStoreV1 {
  isProcessed(input: {
    consumerScope: string;
    accountId: string;
    idempotencyKey: string;
    payloadSha256: string;
  }): Promise<boolean>;
  markProcessed(input: {
    consumerScope: string;
    accountId: string;
    idempotencyKey: string;
    payloadSha256: string;
  }): Promise<void>;
  pruneProcessed(options?: { retentionDays?: number; limit?: number }): Promise<number>;
}

export interface CreatePostgresReportingConsumerRuntimeOptionsV1 {
  db: ReportingConsumerPostgresQueryable;
  /** Stable deployment namespace. Never use a credential, bearer, or connection string. */
  namespace: string;
  /** Lowercase PostgreSQL identifier prefix, at most 32 bytes. */
  tablePrefix?: string;
}

export interface PostgresReportingConsumerRuntimeV1 {
  readonly checkpointStore: ReportingCheckpointStore;
  readonly pendingConsumerStatusStore: ReportingPendingConsumerStatusStore;
  readonly changesCheckpointStore: ReportingChangesCheckpointStoreV1;
  readonly workLeases: ReportingConsumerWorkLeaseStoreV1;
  readonly notifications: ReportingConsumerNotificationStoreV1;
  readonly migrations: { persistence: string; all: readonly [string] };
  probe(): Promise<void>;
}

export class ReportingConsumerPersistenceConflictError extends Error {
  override readonly name = 'ReportingConsumerPersistenceConflictError';
}

export function getReportingConsumerPostgresMigration(options: { tablePrefix?: string } = {}): string {
  const prefix = tablePrefix(options.tablePrefix);
  const checkpoints = quoteIdentifier(`${prefix}_checkpoints`);
  const statuses = quoteIdentifier(`${prefix}_statuses`);
  const cursors = quoteIdentifier(`${prefix}_cursors`);
  const leases = quoteIdentifier(`${prefix}_leases`);
  const notifications = quoteIdentifier(`${prefix}_notifications`);
  return `
CREATE TABLE IF NOT EXISTS ${checkpoints} (
  namespace         TEXT NOT NULL,
  key_sha256        TEXT NOT NULL,
  value_sha256      TEXT NOT NULL,
  value             JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, key_sha256),
  CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (value_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(value) = 'object')
);

CREATE TABLE IF NOT EXISTS ${statuses} (
  namespace         TEXT NOT NULL,
  key_sha256        TEXT NOT NULL,
  value_sha256      TEXT NOT NULL,
  value             JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, key_sha256),
  CHECK (key_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (value_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (jsonb_typeof(value) = 'object')
);

CREATE TABLE IF NOT EXISTS ${cursors} (
  namespace         TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  checkpoint        TEXT NOT NULL,
  generation        BIGINT NOT NULL DEFAULT 1,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, scope_key, account_id),
  CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  CHECK (generation > 0)
);

CREATE TABLE IF NOT EXISTS ${leases} (
  namespace         TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  owner_token       TEXT NOT NULL,
  generation        BIGINT NOT NULL DEFAULT 1,
  expires_at        TIMESTAMPTZ NOT NULL,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, scope_key, account_id),
  CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  CHECK (generation > 0)
);
CREATE INDEX IF NOT EXISTS ${prefix}_leases_expiry
  ON ${leases}(namespace, expires_at);

CREATE TABLE IF NOT EXISTS ${notifications} (
  namespace         TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  processed_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, scope_key, account_id, idempotency_key),
  CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  CHECK (payload_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS ${prefix}_notifications_retention
  ON ${notifications}(namespace, processed_at);
`.trim();
}

export const REPORTING_CONSUMER_POSTGRES_MIGRATION = getReportingConsumerPostgresMigration();

export function createPostgresReportingConsumerRuntimeV1(
  options: CreatePostgresReportingConsumerRuntimeOptionsV1
): PostgresReportingConsumerRuntimeV1 {
  if (!options?.db || typeof options.db.query !== 'function') {
    throw new TypeError('createPostgresReportingConsumerRuntimeV1 requires a PostgreSQL queryable');
  }
  assertBoundedString(options.namespace, 'namespace', 255);
  const prefix = tablePrefix(options.tablePrefix);
  const checkpoints = quoteIdentifier(`${prefix}_checkpoints`);
  const statuses = quoteIdentifier(`${prefix}_statuses`);
  const cursors = quoteIdentifier(`${prefix}_cursors`);
  const leases = quoteIdentifier(`${prefix}_leases`);
  const notifications = quoteIdentifier(`${prefix}_notifications`);
  const namespace = options.namespace;

  const checkpointStore: ReportingCheckpointStore = {
    async get(key) {
      const keySha = checkpointKey(key);
      const result = await query<{ value: ReportingCheckpoint }>(
        'read receipt checkpoint',
        `SELECT value FROM ${checkpoints} WHERE namespace = $1 AND key_sha256 = $2`,
        [namespace, keySha]
      );
      return result.rows[0] ? structuredClone(result.rows[0].value) : undefined;
    },
    async put(key, checkpoint) {
      const keySha = checkpointKey(key);
      const value = jsonObject(checkpoint, 'reporting checkpoint');
      const valueSha = canonicalJsonSha256(value);
      const result = await query<{ value_sha256: string }>(
        'write receipt checkpoint',
        `INSERT INTO ${checkpoints} (namespace, key_sha256, value_sha256, value)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (namespace, key_sha256) DO UPDATE SET
           value_sha256 = ${checkpoints}.value_sha256
         RETURNING value_sha256`,
        [namespace, keySha, valueSha, JSON.stringify(value)]
      );
      if (result.rows[0]?.value_sha256 !== valueSha) {
        throw new ReportingConsumerPersistenceConflictError(
          'A different receipt checkpoint already owns this immutable reporting revision and destination'
        );
      }
    },
    async getAdjustment(key) {
      const keySha = adjustmentCheckpointKey(key);
      const result = await query<{ value: ReportingAdjustmentCheckpoint }>(
        'read adjustment receipt checkpoint',
        `SELECT value FROM ${checkpoints} WHERE namespace = $1 AND key_sha256 = $2`,
        [namespace, keySha]
      );
      return result.rows[0] ? structuredClone(result.rows[0].value) : undefined;
    },
    async putAdjustment(key, checkpoint) {
      const keySha = adjustmentCheckpointKey(key);
      const value = jsonObject(checkpoint, 'reporting adjustment checkpoint');
      const valueSha = canonicalJsonSha256(value);
      const result = await query<{ value_sha256: string }>(
        'write adjustment receipt checkpoint',
        `INSERT INTO ${checkpoints} (namespace, key_sha256, value_sha256, value)
         VALUES ($1,$2,$3,$4::jsonb)
         ON CONFLICT (namespace, key_sha256) DO UPDATE SET
           value_sha256 = ${checkpoints}.value_sha256
         RETURNING value_sha256`,
        [namespace, keySha, valueSha, JSON.stringify(value)]
      );
      if (result.rows[0]?.value_sha256 !== valueSha) {
        throw new ReportingConsumerPersistenceConflictError(
          'A different adjustment checkpoint already owns this immutable reporting correction'
        );
      }
    },
  };

  const pendingConsumerStatusStore: ReportingPendingConsumerStatusStore = {
    async get(key) {
      const keySha = pendingStatusKey(key);
      const result = await query<{ value: ReportingPendingConsumerStatus }>(
        'read pending consumer status',
        `SELECT value FROM ${statuses} WHERE namespace = $1 AND key_sha256 = $2`,
        [namespace, keySha]
      );
      return result.rows[0] ? structuredClone(result.rows[0].value) : undefined;
    },
    async put(key, pending, lease) {
      const keySha = pendingStatusKey(key);
      const scopeKey = consumerScopeKey(key.consumerScope);
      const accountId = accountKey(key.accountId);
      const fence = lease ? leaseFence(lease, scopeKey, accountId) : undefined;
      const value = jsonObject(pending, 'pending consumer status');
      const valueSha = canonicalJsonSha256(value);
      const result = await query(
        'write pending consumer status',
        `WITH current_lease AS MATERIALIZED (
           SELECT 1 FROM ${leases}
            WHERE $5::text IS NOT NULL
              AND namespace = $1 AND scope_key = $7 AND account_id = $8
              AND owner_token = $5 AND generation = $6 AND expires_at > clock_timestamp()
            FOR UPDATE
         )
         INSERT INTO ${statuses} (namespace, key_sha256, value_sha256, value)
         SELECT $1,$2,$3,$4::jsonb
          WHERE $5::text IS NULL OR EXISTS (SELECT 1 FROM current_lease)
         ON CONFLICT (namespace, key_sha256) DO UPDATE SET
           value_sha256 = EXCLUDED.value_sha256,
           value = EXCLUDED.value,
           changed_at = clock_timestamp()
         RETURNING key_sha256`,
        [
          namespace,
          keySha,
          valueSha,
          JSON.stringify(value),
          fence?.ownerToken ?? null,
          fence?.generation ?? null,
          scopeKey,
          accountId,
        ]
      );
      if (result.rowCount !== 1) {
        throw new ReportingConsumerPersistenceConflictError('The pending consumer status lease is no longer current');
      }
    },
    async clear(key, expected, lease) {
      const scopeKey = consumerScopeKey(key.consumerScope);
      const accountId = accountKey(key.accountId);
      const fence = lease ? leaseFence(lease, scopeKey, accountId) : undefined;
      const valueSha = expected ? canonicalJsonSha256(jsonObject(expected, 'pending consumer status')) : null;
      await query(
        'clear pending consumer status',
        `WITH current_lease AS MATERIALIZED (
           SELECT 1 FROM ${leases}
            WHERE $4::text IS NOT NULL
              AND namespace = $1 AND scope_key = $6 AND account_id = $7
              AND owner_token = $4 AND generation = $5 AND expires_at > clock_timestamp()
            FOR UPDATE
         )
         DELETE FROM ${statuses}
          WHERE namespace = $1 AND key_sha256 = $2
            AND ($3::text IS NULL OR value_sha256 = $3)
            AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM current_lease))`,
        [
          namespace,
          pendingStatusKey(key),
          valueSha,
          fence?.ownerToken ?? null,
          fence?.generation ?? null,
          scopeKey,
          accountId,
        ]
      );
    },
  };

  const changesCheckpointStore: ReportingChangesCheckpointStoreV1 = {
    async get(key) {
      const scopeKey = consumerScopeKey(key.consumerScope);
      const accountId = accountKey(key.accountId);
      const result = await query<{ checkpoint: string; generation: string }>(
        'read changes checkpoint',
        `SELECT checkpoint, generation::text AS generation FROM ${cursors}
          WHERE namespace = $1 AND scope_key = $2 AND account_id = $3`,
        [namespace, scopeKey, accountId]
      );
      const row = result.rows[0];
      return row ? { checkpoint: row.checkpoint, generation: safeGeneration(row.generation) } : undefined;
    },
    async compareAndSet(key, expected, checkpoint, lease) {
      const scopeKey = consumerScopeKey(key.consumerScope);
      const accountId = accountKey(key.accountId);
      const fence = lease ? leaseFence(lease, scopeKey, accountId) : undefined;
      assertCheckpoint(checkpoint);
      if (expected !== null) assertCheckpoint(expected);
      const result =
        expected === null
          ? await query<{ generation: string }>(
              'initialize changes checkpoint',
              `WITH current_lease AS MATERIALIZED (
                 SELECT 1 FROM ${leases}
                  WHERE $5::text IS NOT NULL
                    AND namespace = $1 AND scope_key = $2 AND account_id = $3
                    AND owner_token = $5 AND generation = $6 AND expires_at > clock_timestamp()
                  FOR UPDATE
               )
               INSERT INTO ${cursors} (namespace, scope_key, account_id, checkpoint)
               SELECT $1,$2,$3,$4
                WHERE $5::text IS NULL OR EXISTS (SELECT 1 FROM current_lease)
               ON CONFLICT (namespace, scope_key, account_id) DO NOTHING
               RETURNING generation::text AS generation`,
              [namespace, scopeKey, accountId, checkpoint, fence?.ownerToken ?? null, fence?.generation ?? null]
            )
          : await query<{ generation: string }>(
              'advance changes checkpoint',
              `WITH current_lease AS MATERIALIZED (
                 SELECT 1 FROM ${leases}
                  WHERE $6::text IS NOT NULL
                    AND namespace = $1 AND scope_key = $2 AND account_id = $3
                    AND owner_token = $6 AND generation = $7 AND expires_at > clock_timestamp()
                  FOR UPDATE
               )
               UPDATE ${cursors} SET
                 checkpoint = $4,
                 generation = CASE WHEN checkpoint = $4 THEN generation ELSE generation + 1 END,
                 changed_at = CASE WHEN checkpoint = $4 THEN changed_at ELSE clock_timestamp() END
               WHERE namespace = $1 AND scope_key = $2 AND account_id = $3 AND checkpoint = $5
                 AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM current_lease))
               RETURNING generation::text AS generation`,
              [
                namespace,
                scopeKey,
                accountId,
                checkpoint,
                expected,
                fence?.ownerToken ?? null,
                fence?.generation ?? null,
              ]
            );
      if (result.rowCount !== 1) return 'conflict';
      return expected === checkpoint ? 'unchanged' : 'applied';
    },
    async clear(key, expected, lease) {
      const scopeKey = consumerScopeKey(key.consumerScope);
      const accountId = accountKey(key.accountId);
      const fence = lease ? leaseFence(lease, scopeKey, accountId) : undefined;
      if (expected !== undefined) assertCheckpoint(expected);
      const result = await query(
        'clear changes checkpoint',
        `WITH current_lease AS MATERIALIZED (
           SELECT 1 FROM ${leases}
            WHERE $5::text IS NOT NULL
              AND namespace = $1 AND scope_key = $2 AND account_id = $3
              AND owner_token = $5 AND generation = $6 AND expires_at > clock_timestamp()
            FOR UPDATE
         )
         DELETE FROM ${cursors}
          WHERE namespace = $1 AND scope_key = $2 AND account_id = $3
            AND ($4::text IS NULL OR checkpoint = $4)
            AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM current_lease))`,
        [namespace, scopeKey, accountId, expected ?? null, fence?.ownerToken ?? null, fence?.generation ?? null]
      );
      return (result.rowCount ?? 0) > 0;
    },
  };

  const workLeases: ReportingConsumerWorkLeaseStoreV1 = {
    async claim(input) {
      const scopeKey = consumerScopeKey(input.key.consumerScope);
      const accountId = accountKey(input.key.accountId);
      assertOwner(input.ownerToken);
      assertLeaseMilliseconds(input.leaseMilliseconds);
      const result = await query<{ generation: string; expires_at: Date }>(
        'claim consumer work lease',
        `INSERT INTO ${leases} (namespace, scope_key, account_id, owner_token, generation, expires_at)
         VALUES ($1,$2,$3,$4,1,clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond'))
         ON CONFLICT (namespace, scope_key, account_id) DO UPDATE SET
           owner_token = EXCLUDED.owner_token,
           generation = ${leases}.generation + 1,
           expires_at = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond'),
           changed_at = clock_timestamp()
         WHERE ${leases}.expires_at <= clock_timestamp()
         RETURNING generation::text AS generation, expires_at`,
        [namespace, scopeKey, accountId, input.ownerToken, input.leaseMilliseconds]
      );
      const row = result.rows[0];
      return row
        ? {
            scopeKey: `${scopeKey}:${accountId}`,
            ownerToken: input.ownerToken,
            generation: safeGeneration(row.generation),
            expiresAt: row.expires_at.toISOString(),
          }
        : null;
    },
    async renew(lease, leaseMilliseconds) {
      const { scopeKey, accountId } = splitLeaseScope(lease.scopeKey);
      assertOwner(lease.ownerToken);
      safeGeneration(lease.generation);
      assertLeaseMilliseconds(leaseMilliseconds);
      const result = await query<{ expires_at: Date }>(
        'renew consumer work lease',
        `UPDATE ${leases}
            SET expires_at = clock_timestamp() + ($6::bigint * INTERVAL '1 millisecond'),
                changed_at = clock_timestamp()
          WHERE namespace = $1 AND scope_key = $2 AND account_id = $3
            AND owner_token = $4 AND generation = $5 AND expires_at > clock_timestamp()
         RETURNING expires_at`,
        [namespace, scopeKey, accountId, lease.ownerToken, lease.generation, leaseMilliseconds]
      );
      return result.rows[0] ? { ...lease, expiresAt: result.rows[0].expires_at.toISOString() } : null;
    },
    async release(lease) {
      const { scopeKey, accountId } = splitLeaseScope(lease.scopeKey);
      assertOwner(lease.ownerToken);
      safeGeneration(lease.generation);
      const result = await query(
        'release consumer work lease',
        `UPDATE ${leases}
            SET expires_at = clock_timestamp(), changed_at = clock_timestamp()
          WHERE namespace = $1 AND scope_key = $2 AND account_id = $3
            AND owner_token = $4 AND generation = $5
            AND expires_at > clock_timestamp()`,
        [namespace, scopeKey, accountId, lease.ownerToken, lease.generation]
      );
      return result.rowCount === 1;
    },
  };

  const notificationStore: ReportingConsumerNotificationStoreV1 = {
    async isProcessed(input) {
      const values = notificationIdentity(input);
      const result = await query<{ payload_sha256: string }>(
        'read processed notification',
        `SELECT payload_sha256 FROM ${notifications}
          WHERE namespace = $1 AND scope_key = $2 AND account_id = $3 AND idempotency_key = $4`,
        [namespace, values.scopeKey, values.accountId, values.idempotencyKey]
      );
      const existing = result.rows[0]?.payload_sha256;
      if (existing !== undefined && existing !== values.payloadSha256) {
        throw new ReportingConsumerPersistenceConflictError(
          'Reporting notification idempotency identity names different content'
        );
      }
      return existing !== undefined;
    },
    async markProcessed(input) {
      const values = notificationIdentity(input);
      const result = await query<{ payload_sha256: string }>(
        'mark processed notification',
        `INSERT INTO ${notifications}
           (namespace, scope_key, account_id, idempotency_key, payload_sha256)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (namespace, scope_key, account_id, idempotency_key) DO UPDATE SET
           payload_sha256 = ${notifications}.payload_sha256
         RETURNING payload_sha256`,
        [namespace, values.scopeKey, values.accountId, values.idempotencyKey, values.payloadSha256]
      );
      if (result.rows[0]?.payload_sha256 !== values.payloadSha256) {
        throw new ReportingConsumerPersistenceConflictError(
          'Reporting notification idempotency identity names different content'
        );
      }
    },
    async pruneProcessed(pruneOptions = {}) {
      const retentionDays = pruneOptions.retentionDays ?? 90;
      const limit = pruneOptions.limit ?? 1_000;
      if (!Number.isSafeInteger(retentionDays) || retentionDays < 30 || retentionDays > 3_650) {
        throw new TypeError('retentionDays must be an integer from 30 through 3650');
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new TypeError('limit must be an integer from 1 through 10000');
      }
      const result = await query(
        'prune processed notifications',
        `WITH expired AS (
           SELECT ctid FROM ${notifications}
            WHERE namespace = $1
              AND processed_at < clock_timestamp() - ($2::integer * INTERVAL '1 day')
            ORDER BY processed_at FOR UPDATE SKIP LOCKED LIMIT $3
         )
         DELETE FROM ${notifications} target USING expired WHERE target.ctid = expired.ctid`,
        [namespace, retentionDays, limit]
      );
      return result.rowCount ?? 0;
    },
  };

  async function query<Row extends Record<string, unknown> = Record<string, unknown>>(
    operation: string,
    text: string,
    values?: unknown[]
  ) {
    try {
      return await options.db.query<Row>(text, values);
    } catch (cause) {
      throw new Error(`PostgreSQL reporting consumer ${operation} failed`, { cause });
    }
  }

  const migration = getReportingConsumerPostgresMigration({ tablePrefix: prefix });
  return {
    checkpointStore,
    pendingConsumerStatusStore,
    changesCheckpointStore,
    workLeases,
    notifications: notificationStore,
    migrations: { persistence: migration, all: [migration] },
    async probe() {
      await query('persistence probe', `SELECT namespace, key_sha256, value_sha256, value FROM ${checkpoints} LIMIT 0`);
      await query('status probe', `SELECT namespace, key_sha256, value_sha256, value FROM ${statuses} LIMIT 0`);
      await query(
        'cursor probe',
        `SELECT namespace, scope_key, account_id, checkpoint, generation FROM ${cursors} LIMIT 0`
      );
      await query(
        'lease probe',
        `SELECT namespace, scope_key, account_id, owner_token, generation FROM ${leases} LIMIT 0`
      );
      await query(
        'notification probe',
        `SELECT namespace, scope_key, account_id, idempotency_key, payload_sha256 FROM ${notifications} LIMIT 0`
      );
    },
  };
}

function notificationIdentity(input: {
  consumerScope: string;
  accountId: string;
  idempotencyKey: string;
  payloadSha256: string;
}): {
  scopeKey: string;
  accountId: string;
  idempotencyKey: string;
  payloadSha256: string;
} {
  const scopeKey = consumerScopeKey(input.consumerScope);
  const accountId = accountKey(input.accountId);
  assertBoundedString(input.idempotencyKey, 'notification idempotencyKey', 255);
  if (input.idempotencyKey.length < 16 || !/^[A-Za-z0-9_.:-]+$/.test(input.idempotencyKey)) {
    throw new TypeError('notification idempotencyKey is invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(input.payloadSha256)) {
    throw new TypeError('notification payloadSha256 is invalid');
  }
  return { scopeKey, accountId, idempotencyKey: input.idempotencyKey, payloadSha256: input.payloadSha256 };
}

function checkpointKey(key: ReportingCheckpointKey): string {
  assertBoundedString(key.consumerScope, 'consumerScope', 4_096);
  assertBoundedString(key.accountId, 'accountId', 512);
  assertBoundedString(key.reportingObligationId, 'reportingObligationId', 512);
  assertBoundedString(key.reportingRevisionId, 'reportingRevisionId', 512);
  assertBoundedString(key.reportingMaterializationId, 'reportingMaterializationId', 512);
  assertBoundedString(key.destinationRef, 'destinationRef', 2_048);
  if (key.contextFingerprint !== undefined) {
    assertBoundedString(key.contextFingerprint, 'contextFingerprint', 128);
  }
  return canonicalJsonSha256(key);
}

function adjustmentCheckpointKey(key: ReportingAdjustmentCheckpointKey): string {
  assertBoundedString(key.consumerScope, 'consumerScope', 4_096);
  assertBoundedString(key.accountId, 'accountId', 512);
  assertBoundedString(key.reportingAdjustmentId, 'reportingAdjustmentId', 512);
  assertBoundedString(key.adjustsReportingRevisionId, 'adjustsReportingRevisionId', 512);
  if (key.supersedesReportingReceiptId !== undefined) {
    assertBoundedString(key.supersedesReportingReceiptId, 'supersedesReportingReceiptId', 512);
  }
  if (key.contextFingerprint !== undefined) {
    assertBoundedString(key.contextFingerprint, 'contextFingerprint', 128);
  }
  return canonicalJsonSha256(key);
}

function pendingStatusKey(key: ReportingPendingConsumerStatusKey): string {
  assertBoundedString(key.consumerScope, 'consumerScope', 4_096);
  assertBoundedString(key.accountId, 'accountId', 512);
  assertBoundedString(key.deliveryConfigId, 'deliveryConfigId', 512);
  safeGeneration(key.deliveryConfigVersion);
  assertBoundedString(key.reportDefinitionId, 'reportDefinitionId', 512);
  assertBoundedString(key.periodStart, 'periodStart', 128);
  assertBoundedString(key.periodEnd, 'periodEnd', 128);
  return canonicalJsonSha256(key);
}

function consumerScopeKey(scope: string): string {
  assertBoundedString(scope, 'consumerScope', 4_096);
  return canonicalJsonSha256({ scope });
}

function accountKey(accountId: string): string {
  assertBoundedString(accountId, 'accountId', 512);
  return accountId;
}

function jsonObject<T extends object>(value: T, name: string): T {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_JSON_BYTES) {
    throw new RangeError(`${name} exceeds ${MAX_JSON_BYTES} bytes`);
  }
  const parsed = JSON.parse(encoded) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${name} must be a JSON object`);
  }
  return parsed as T;
}

function assertCheckpoint(value: string): void {
  assertBoundedString(value, 'changes checkpoint', MAX_CHECKPOINT_BYTES);
}

function assertOwner(value: string): void {
  assertBoundedString(value, 'ownerToken', 255);
  if (value.length < 8) throw new TypeError('ownerToken must contain at least 8 characters');
}

function assertLeaseMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new TypeError('leaseMilliseconds must be an integer from 1000 through 300000');
  }
}

function safeGeneration(value: string | number): number {
  const generation = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Reporting consumer generation is invalid');
  return generation;
}

function splitLeaseScope(value: string): { scopeKey: string; accountId: string } {
  const separator = value.indexOf(':');
  const scopeKey = value.slice(0, separator);
  const accountId = value.slice(separator + 1);
  if (separator !== 64 || !/^[a-f0-9]{64}$/.test(scopeKey) || accountId.length === 0) {
    throw new TypeError('Reporting consumer work lease scope is invalid');
  }
  accountKey(accountId);
  return { scopeKey, accountId };
}

function leaseFence(
  lease: ReportingConsumerWorkLeaseV1,
  expectedScopeKey: string,
  expectedAccountId: string
): { ownerToken: string; generation: number } {
  const { scopeKey, accountId } = splitLeaseScope(lease.scopeKey);
  assertOwner(lease.ownerToken);
  const generation = safeGeneration(lease.generation);
  if (scopeKey !== expectedScopeKey || accountId !== expectedAccountId) {
    throw new TypeError('Reporting consumer work lease does not match the checkpoint partition');
  }
  return { ownerToken: lease.ownerToken, generation };
}

function tablePrefix(value: string | undefined): string {
  const prefix = value ?? DEFAULT_PREFIX;
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix) || Buffer.byteLength(prefix, 'utf8') > 32) {
    throw new TypeError('tablePrefix must be a lowercase PostgreSQL identifier of at most 32 bytes');
  }
  return prefix;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value) || Buffer.byteLength(value, 'utf8') > 63) {
    throw new TypeError('Derived reporting consumer table name is invalid');
  }
  return `"${value}"`;
}

function assertBoundedString(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${name} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL`);
  }
}
