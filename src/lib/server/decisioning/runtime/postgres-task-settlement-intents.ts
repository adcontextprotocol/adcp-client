/**
 * Durable PostgreSQL queue for application-owned task settlement intents.
 *
 * `createPostgresTaskSettlementCoordinator()` makes the task transition and
 * terminal webhook checkpoint atomic. This queue protects the boundary before
 * that call: an application may commit a human approval or provider outcome
 * and then die before it asks the SDK to settle the AdCP task.
 */

import { randomUUID } from 'node:crypto';
import { canonicalJsonSha256 } from '../../../utils/jcs';
import { assertWellFormedUnicode } from '../../../utils/well-formed-unicode';
import { sanitizeStructuredAdcpError } from '../../errors';
import type { AdcpStructuredError } from '../async-outcome';
import type { PgQueryable } from './postgres-task-registry';
import { sanitizeTaskResultForWire, type ScopedTaskRef } from './task-registry';

const DEFAULT_TABLE = 'adcp_task_settlement_intents';
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const VALID_NAMESPACE = /^[A-Za-z0-9_.:-]{1,255}$/;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Default conflict-retention window after an intent is acknowledged. */
export const TASK_SETTLEMENT_INTENT_IDEMPOTENCY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_RECOVERY = {
  batchSize: 25,
  leaseMs: 45_000,
  retryAfterMs: 30_000,
  maxRetryAfterMs: 15 * 60_000,
  maxAttempts: 12,
} as const;

/** Complete, serializable task handle required by the durable intent queue. */
export interface DurableTaskSettlementRef extends ScopedTaskRef {
  registryId: string;
  ownerScope: string;
}

export type TaskSettlementIntent =
  | { taskRef: DurableTaskSettlementRef; action: 'complete'; result: unknown }
  | { taskRef: DurableTaskSettlementRef; action: 'fail'; error: AdcpStructuredError; result?: unknown };

export interface TaskSettlementIntentCheckpoint extends DurableTaskSettlementRef {
  queueNamespace: string;
  intentFingerprint: string;
}

export interface TaskSettlementIntentRecoveryContext {
  attemptCount: number;
  /** Extend this claim by the configured lease duration. Returns false if fencing ownership was lost. */
  extendLease(): Promise<boolean>;
}

export interface TaskSettlementIntentRecoveryMetrics {
  claimed: number;
  settled: number;
  retried: number;
  deadLettered: number;
  leaseLost: number;
}

export interface TaskSettlementIntentRecoveryErrorContext {
  attemptCount: number;
  taskRef: DurableTaskSettlementRef;
  action: TaskSettlementIntent['action'];
  disposition: 'retry' | 'dead_letter' | 'lease_lost';
}

export interface RecoverTaskSettlementIntentsOptions {
  /**
   * Apply the exact terminal intent and return the literal `settled` only
   * after the intended state is proven. The implementation MUST be
   * idempotent because a worker can die after settlement and before ack.
   */
  settle(intent: TaskSettlementIntent, context: TaskSettlementIntentRecoveryContext): Promise<'settled'>;
  batchSize?: number;
  leaseMs?: number;
  retryAfterMs?: number;
  maxRetryAfterMs?: number;
  maxAttempts?: number;
  workerId?: string;
  /** Observability hook. Error messages are never persisted by the queue. */
  onError?(error: unknown, context: TaskSettlementIntentRecoveryErrorContext): void | Promise<void>;
}

export interface TaskSettlementIntentWriteOptions {
  /**
   * Optional active transaction client. Use this to commit the domain outcome
   * and settlement intent atomically in the same application transaction.
   */
  db?: PgQueryable;
}

export interface PruneTaskSettlementIntentAcknowledgementsOptions extends TaskSettlementIntentWriteOptions {
  /** Maximum tombstones removed by this call. Defaults to 1000; maximum 10000. */
  limit?: number;
}

export interface PostgresTaskSettlementIntentQueue {
  readonly durability: 'durable';
  enqueue(
    intent: TaskSettlementIntent,
    options?: TaskSettlementIntentWriteOptions
  ): Promise<TaskSettlementIntentCheckpoint>;
  /** Returns false when the exact checkpoint was already absent. */
  acknowledge(checkpoint: TaskSettlementIntentCheckpoint, options?: TaskSettlementIntentWriteOptions): Promise<boolean>;
  /** Remove a bounded batch of acknowledgement tombstones whose idempotency horizon elapsed. */
  pruneAcknowledged(options?: PruneTaskSettlementIntentAcknowledgementsOptions): Promise<number>;
  recover(options: RecoverTaskSettlementIntentsOptions): Promise<TaskSettlementIntentRecoveryMetrics>;
  probe(): Promise<void>;
}

export interface CreatePostgresTaskSettlementIntentQueueOptions {
  /** Pool used by recovery and by writes that do not supply a transaction. */
  db: PgQueryable;
  /** Trusted deployment or tenant namespace. */
  namespace: string;
  /** Defaults to `adcp_task_settlement_intents`. */
  tableName?: string;
  /**
   * Retain acknowledged fingerprints for this long so a conflicting terminal
   * artifact cannot rebind the same scoped task. Defaults to seven days.
   */
  idempotencyHorizonMs?: number;
}

/** An existing scoped task is already bound to a different terminal intent. */
export class TaskSettlementIntentConflictError extends Error {
  override readonly name = 'TaskSettlementIntentConflictError';
}

interface StoredPayload {
  result?: unknown;
  error?: AdcpStructuredError;
}

interface IntentAttempt {
  taskRef: DurableTaskSettlementRef;
  action: unknown;
  intentFingerprint: string;
  attemptCount: number;
}

interface ClaimedIntent extends IntentAttempt {
  kind: 'claimed';
  scopeFingerprint: string;
  leaseClaimId: string;
  leaseVersion: string;
}

interface ExhaustedIntent extends IntentAttempt {
  kind: 'dead_letter';
}

/** Bootstrap DDL for a new durable settlement-intent queue. */
export function getTaskSettlementIntentMigration(options: { tableName?: string } = {}): string {
  const table = options.tableName ?? DEFAULT_TABLE;
  assertValidTableName(table);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  queue_namespace    TEXT NOT NULL,
  registry_id        TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  owner_scope        TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  scope_fingerprint  TEXT NOT NULL,
  action             TEXT NOT NULL,
  payload            JSONB NOT NULL,
  intent_fingerprint TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'pending',
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner        TEXT,
  lease_claim_id     TEXT,
  lease_version      BIGINT NOT NULL DEFAULT 0,
  lease_expires_at   TIMESTAMPTZ,
  last_error         TEXT,
  retain_until       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (queue_namespace, scope_fingerprint),
  CONSTRAINT ${table}_valid_scope_fingerprint
    CHECK (scope_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ${table}_valid_action CHECK (action IN ('complete', 'fail')),
  CONSTRAINT ${table}_valid_state CHECK (state IN ('pending', 'dead_letter', 'acknowledged')),
  CONSTRAINT ${table}_valid_retention CHECK (
    (state = 'acknowledged' AND retain_until IS NOT NULL) OR
    (state <> 'acknowledged' AND retain_until IS NULL)
  ),
  CONSTRAINT ${table}_valid_payload CHECK (jsonb_typeof(payload) = 'object')
);

-- Upgrade queues provisioned by an earlier SDK beta before creating indexes
-- or writing the acknowledged state. These operations are deliberately
-- idempotent so operators can rerun the generated migration safely.
ALTER TABLE ${table}
  ADD COLUMN IF NOT EXISTS retain_until TIMESTAMPTZ;

ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_valid_state;
ALTER TABLE ${table}
  ADD CONSTRAINT ${table}_valid_state CHECK (state IN ('pending', 'dead_letter', 'acknowledged'));

ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_valid_retention;
ALTER TABLE ${table}
  ADD CONSTRAINT ${table}_valid_retention CHECK (
    (state = 'acknowledged' AND retain_until IS NOT NULL) OR
    (state <> 'acknowledged' AND retain_until IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_${table}_due
  ON ${table}(queue_namespace, next_attempt_at, lease_expires_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS idx_${table}_acknowledged_retention
  ON ${table}(queue_namespace, retain_until)
  WHERE state = 'acknowledged';
`.trim();
}

/**
 * Create a durable task-settlement intent queue.
 *
 * @example
 * ```ts
 * const queue = createPostgresTaskSettlementIntentQueue({
 *   db: pool,
 *   namespace: 'seller-prod',
 * });
 *
 * await withTransaction(async tx => {
 *   await saveApproval(tx, approval);
 *   await queue.enqueue({ taskRef, action: 'complete', result }, { db: tx });
 * });
 *
 * await queue.recover({
 *   settle: async intent => {
 *     await settleThroughRegistryOrPushCoordinator(intent);
 *     return 'settled';
 *   },
 * });
 * ```
 */
export function createPostgresTaskSettlementIntentQueue(
  options: CreatePostgresTaskSettlementIntentQueueOptions
): PostgresTaskSettlementIntentQueue {
  if (!options?.db || typeof options.db.query !== 'function') {
    throw new TypeError('createPostgresTaskSettlementIntentQueue requires a PostgreSQL queryable');
  }
  const db = options.db;
  const namespace = options.namespace;
  assertValidNamespace(namespace);
  const table = options.tableName ?? DEFAULT_TABLE;
  assertValidTableName(table);
  const idempotencyHorizonMs = options.idempotencyHorizonMs ?? TASK_SETTLEMENT_INTENT_IDEMPOTENCY_HORIZON_MS;
  if (!Number.isSafeInteger(idempotencyHorizonMs) || idempotencyHorizonMs <= 0) {
    throw new TypeError('idempotencyHorizonMs must be a positive safe integer');
  }

  const queue: PostgresTaskSettlementIntentQueue = {
    durability: 'durable',

    async enqueue(intent, writeOptions = {}) {
      const normalized = canonicalizeTaskSettlementIntent(intent);
      const fingerprint = canonicalJsonSha256(normalized);
      const payload = payloadForIntent(normalized);
      assertPayloadSize(payload);
      const ref = normalized.taskRef;
      const scopeFingerprint = taskRefFingerprint(ref);
      const writeDb = writeOptions.db ?? db;
      const result = await queryDb(
        writeDb,
        'enqueue',
        `INSERT INTO ${table} (
           queue_namespace, registry_id, account_id, owner_scope, task_id,
           action, payload, intent_fingerprint, scope_fingerprint
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (queue_namespace, scope_fingerprint)
         DO UPDATE SET
           registry_id = EXCLUDED.registry_id,
           account_id = EXCLUDED.account_id,
           owner_scope = EXCLUDED.owner_scope,
           task_id = EXCLUDED.task_id,
           action = EXCLUDED.action,
           payload = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN EXCLUDED.payload
             ELSE ${table}.payload
           END,
           intent_fingerprint = EXCLUDED.intent_fingerprint,
           state = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN 'pending'
             ELSE ${table}.state
           END,
           attempt_count = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN 0
             ELSE ${table}.attempt_count
           END,
           next_attempt_at = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN statement_timestamp()
             ELSE ${table}.next_attempt_at
           END,
           lease_owner = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN NULL
             ELSE ${table}.lease_owner
           END,
           lease_claim_id = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN NULL
             ELSE ${table}.lease_claim_id
           END,
           lease_expires_at = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN NULL
             ELSE ${table}.lease_expires_at
           END,
           last_error = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN NULL
             ELSE ${table}.last_error
           END,
           retain_until = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN NULL
             ELSE ${table}.retain_until
           END,
           created_at = CASE
             WHEN ${table}.state = 'acknowledged' AND ${table}.retain_until <= statement_timestamp()
               THEN statement_timestamp()
             ELSE ${table}.created_at
           END,
           updated_at = statement_timestamp()
           WHERE (
             ${table}.registry_id = EXCLUDED.registry_id
             AND ${table}.account_id = EXCLUDED.account_id
             AND ${table}.owner_scope = EXCLUDED.owner_scope
             AND ${table}.task_id = EXCLUDED.task_id
             AND ${table}.action = EXCLUDED.action
             AND ${table}.intent_fingerprint = EXCLUDED.intent_fingerprint
           ) OR (
             ${table}.state = 'acknowledged'
             AND ${table}.retain_until <= statement_timestamp()
           )
         RETURNING task_id`,
        [
          namespace,
          ref.registryId,
          ref.accountId,
          ref.ownerScope,
          ref.taskId,
          normalized.action,
          JSON.stringify(payload),
          fingerprint,
          scopeFingerprint,
        ]
      );
      if (result.rowCount !== 1) {
        throw new TaskSettlementIntentConflictError('Task is already bound to a different settlement intent');
      }
      return checkpointFor(namespace, ref, fingerprint);
    },

    async acknowledge(checkpoint, writeOptions = {}) {
      validateCheckpoint(checkpoint, namespace);
      const writeDb = writeOptions.db ?? db;
      const result = await queryDb(
        writeDb,
        'acknowledge',
        `UPDATE ${table}
            SET state = 'acknowledged',
                payload = '{}'::jsonb,
                retain_until = clock_timestamp() + ($8::bigint * INTERVAL '1 millisecond'),
                lease_owner = NULL, lease_claim_id = NULL, lease_expires_at = NULL,
                last_error = NULL, updated_at = clock_timestamp()
          WHERE queue_namespace = $1 AND registry_id = $2 AND account_id = $3
            AND owner_scope = $4 AND task_id = $5 AND intent_fingerprint = $6
            AND scope_fingerprint = $7 AND state IN ('pending', 'dead_letter')`,
        [...checkpointValues(checkpoint), idempotencyHorizonMs]
      );
      return result.rowCount === 1;
    },

    async pruneAcknowledged(pruneOptions = {}) {
      const limit = normalizePruneLimit(pruneOptions.limit);
      return pruneExpiredAcknowledgements(pruneOptions.db ?? db, table, namespace, limit);
    },

    async recover(recoveryOptions) {
      const config = normalizeRecoveryOptions(recoveryOptions);
      await pruneExpiredAcknowledgements(db, table, namespace, config.batchSize);
      const metrics: TaskSettlementIntentRecoveryMetrics = {
        claimed: 0,
        settled: 0,
        retried: 0,
        deadLettered: 0,
        leaseLost: 0,
      };
      const seenFingerprints: string[] = [];
      while (metrics.claimed < config.batchSize) {
        const selected = await claimOneDue(db, table, namespace, config, seenFingerprints);
        if (!selected) break;
        metrics.claimed += 1;
        seenFingerprints.push(selected.intentFingerprint);
        if (selected.kind === 'dead_letter') {
          metrics.deadLettered += 1;
          await reportRecoveryError(
            recoveryOptions.onError,
            new Error('Task settlement intent exhausted maxAttempts after its lease expired'),
            selected,
            'dead_letter'
          );
          continue;
        }
        const claim = selected;
        let intent: TaskSettlementIntent | undefined;
        try {
          const payload = await loadClaimPayload(db, table, namespace, claim);
          intent = intentFromClaim(claim, payload);
          const outcome = await recoveryOptions.settle(intent, {
            attemptCount: claim.attemptCount,
            extendLease: () => extendClaimLease(db, table, namespace, claim, config.leaseMs),
          });
          if (outcome !== 'settled') {
            throw new TypeError('Task settlement callback must resolve with the literal `settled`');
          }
          if (await acknowledgeClaim(db, table, namespace, claim, idempotencyHorizonMs)) {
            metrics.settled += 1;
          } else {
            metrics.leaseLost += 1;
            await reportRecoveryError(
              recoveryOptions.onError,
              new Error('Task settlement intent lease was lost after settlement'),
              claim,
              'lease_lost'
            );
          }
        } catch (error) {
          const disposition = await releaseClaim(db, table, namespace, claim, config, error);
          if (disposition === 'retry') metrics.retried += 1;
          else if (disposition === 'dead_letter') metrics.deadLettered += 1;
          else metrics.leaseLost += 1;
          await reportRecoveryError(recoveryOptions.onError, error, claim, disposition);
        }
      }
      return metrics;
    },

    async probe() {
      await queryDb(
        db,
        'probe',
        `SELECT queue_namespace, registry_id, account_id, owner_scope, task_id, scope_fingerprint,
                action, payload, intent_fingerprint, state, attempt_count,
                next_attempt_at, lease_owner, lease_claim_id, lease_version,
                lease_expires_at, last_error, retain_until, created_at, updated_at
           FROM ${table}
          WHERE queue_namespace = $1
          LIMIT 0`,
        [namespace]
      );
    },
  };
  return queue;
}

/** Clone, validate, and reduce an intent to the exact artifact persisted by the task registry. */
export function canonicalizeTaskSettlementIntent(intent: TaskSettlementIntent): TaskSettlementIntent & {
  taskRef: DurableTaskSettlementRef;
} {
  if (!intent || typeof intent !== 'object') throw new TypeError('Task settlement intent is required');
  const taskRef = requireDurableTaskRef(intent.taskRef);
  if (intent.action === 'complete') {
    if (intent.result === undefined) throw new TypeError('A complete task settlement intent requires a result');
    const clonedResult = structuredClone(intent.result);
    assertWellFormedUnicode(clonedResult, 'Task settlement intent');
    const result = sanitizeTaskResultForWire(clonedResult, taskRef);
    assertWellFormedUnicode(result, 'Task settlement intent');
    canonicalJsonSha256(result);
    return { taskRef, action: 'complete', result };
  }
  if (intent.action === 'fail') {
    const clonedError = structuredClone(intent.error);
    assertWellFormedUnicode(clonedError, 'Task settlement intent');
    requireStructuredError(clonedError);
    const error = sanitizeStructuredAdcpError(clonedError);
    requireStructuredError(error);
    const clonedResult = intent.result === undefined ? undefined : structuredClone(intent.result);
    assertWellFormedUnicode(clonedResult, 'Task settlement intent');
    const result = clonedResult === undefined ? undefined : sanitizeTaskResultForWire(clonedResult, taskRef);
    assertWellFormedUnicode({ error, ...(result !== undefined && { result }) }, 'Task settlement intent');
    canonicalJsonSha256({ error, result });
    return { taskRef, action: 'fail', error, ...(result !== undefined && { result }) };
  }
  throw new TypeError('Task settlement intent action must be `complete` or `fail`');
}

function payloadForIntent(intent: TaskSettlementIntent): StoredPayload {
  return intent.action === 'complete'
    ? { result: intent.result }
    : { error: intent.error, ...(intent.result !== undefined && { result: intent.result }) };
}

function requireDurableTaskRef(ref: ScopedTaskRef): DurableTaskSettlementRef {
  if (!ref || typeof ref !== 'object') throw new TypeError('Task settlement intent requires a ScopedTaskRef');
  return {
    taskId: requireTaskRefPart(ref.taskId, 'taskId'),
    accountId: requireTaskRefPart(ref.accountId, 'accountId'),
    ownerScope: requireTaskRefPart(ref.ownerScope, 'ownerScope'),
    registryId: requireTaskRefPart(ref.registryId, 'registryId'),
  };
}

function requireTaskRefPart(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Task settlement intent ${field} must be a non-empty string`);
  }
  if (Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new TypeError(`Task settlement intent ${field} must contain well-formed Unicode`);
  }
  return value;
}

function requireStructuredError(value: unknown): AdcpStructuredError {
  const error = plainObject(value, 'error');
  for (const field of ['code', 'message'] as const) {
    if (typeof error[field] !== 'string' || error[field].length === 0) {
      throw new TypeError(`Task settlement intent error.${field} must be a non-empty string`);
    }
  }
  if (error.recovery !== 'transient' && error.recovery !== 'correctable' && error.recovery !== 'terminal') {
    throw new TypeError('Task settlement intent error.recovery must be `transient`, `correctable`, or `terminal`');
  }
  return value as AdcpStructuredError;
}

function checkpointFor(
  queueNamespace: string,
  ref: DurableTaskSettlementRef,
  intentFingerprint: string
): TaskSettlementIntentCheckpoint {
  return { ...ref, queueNamespace, intentFingerprint };
}

function validateCheckpoint(checkpoint: TaskSettlementIntentCheckpoint, namespace: string): void {
  requireDurableTaskRef(checkpoint);
  if (checkpoint.queueNamespace !== namespace) {
    throw new TypeError('Task settlement checkpoint belongs to a different queue namespace');
  }
  if (!/^[a-f0-9]{64}$/.test(checkpoint.intentFingerprint)) {
    throw new TypeError('Task settlement checkpoint has an invalid intent fingerprint');
  }
}

function checkpointValues(checkpoint: TaskSettlementIntentCheckpoint): unknown[] {
  return [
    checkpoint.queueNamespace,
    checkpoint.registryId,
    checkpoint.accountId,
    checkpoint.ownerScope,
    checkpoint.taskId,
    checkpoint.intentFingerprint,
    taskRefFingerprint(checkpoint),
  ];
}

function normalizeRecoveryOptions(options: RecoverTaskSettlementIntentsOptions) {
  if (!options || typeof options.settle !== 'function') {
    throw new TypeError('recover requires an idempotent settle callback');
  }
  const config = {
    batchSize: options.batchSize ?? DEFAULT_RECOVERY.batchSize,
    leaseMs: options.leaseMs ?? DEFAULT_RECOVERY.leaseMs,
    retryAfterMs: options.retryAfterMs ?? DEFAULT_RECOVERY.retryAfterMs,
    maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULT_RECOVERY.maxRetryAfterMs,
    maxAttempts: options.maxAttempts ?? DEFAULT_RECOVERY.maxAttempts,
    workerId: options.workerId ?? `task-settlement:${process.pid}:${randomUUID()}`,
  };
  for (const field of ['batchSize', 'leaseMs', 'maxRetryAfterMs', 'maxAttempts'] as const) {
    if (!Number.isInteger(config[field]) || config[field] <= 0) {
      throw new TypeError(`${field} must be a positive integer`);
    }
  }
  if (!Number.isInteger(config.retryAfterMs) || config.retryAfterMs < 0) {
    throw new TypeError('retryAfterMs must be a non-negative integer');
  }
  if (config.batchSize > 1000) throw new TypeError('batchSize must not exceed 1000');
  for (const field of ['leaseMs', 'retryAfterMs', 'maxRetryAfterMs', 'maxAttempts'] as const) {
    if (config[field] > 2_147_483_647) throw new TypeError(`${field} must not exceed 2147483647`);
  }
  if (
    typeof config.workerId !== 'string' ||
    config.workerId.length === 0 ||
    Buffer.byteLength(config.workerId, 'utf8') > 1024
  ) {
    throw new TypeError('workerId must be a non-empty string of at most 1024 bytes');
  }
  return config;
}

async function claimOneDue(
  db: PgQueryable,
  table: string,
  namespace: string,
  config: ReturnType<typeof normalizeRecoveryOptions>,
  seenFingerprints: readonly string[]
): Promise<ClaimedIntent | ExhaustedIntent | undefined> {
  const claimId = randomUUID();
  const result = await queryDb(
    db,
    'claim',
    `WITH due AS (
         SELECT candidate.queue_namespace, candidate.registry_id, candidate.account_id,
                candidate.owner_scope, candidate.task_id, candidate.scope_fingerprint
           FROM ${table} AS candidate
          WHERE candidate.queue_namespace = $1 AND candidate.state = 'pending'
            AND next_attempt_at <= clock_timestamp()
            AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
            AND candidate.intent_fingerprint <> ALL($5::text[])
          ORDER BY next_attempt_at, created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE ${table} AS intents
          SET state = CASE WHEN intents.attempt_count >= $6 THEN 'dead_letter' ELSE intents.state END,
              lease_owner = CASE WHEN intents.attempt_count >= $6 THEN NULL ELSE $2 END,
              lease_claim_id = CASE WHEN intents.attempt_count >= $6 THEN NULL ELSE $3 END,
              lease_version = CASE WHEN intents.attempt_count >= $6
                THEN intents.lease_version ELSE intents.lease_version + 1 END,
              lease_expires_at = CASE WHEN intents.attempt_count >= $6 THEN NULL
                ELSE clock_timestamp() + ($4::integer * INTERVAL '1 millisecond') END,
              attempt_count = CASE WHEN intents.attempt_count >= $6
                THEN intents.attempt_count ELSE intents.attempt_count + 1 END,
              last_error = CASE WHEN intents.attempt_count >= $6
                THEN COALESCE(intents.last_error, 'Error') ELSE intents.last_error END,
              updated_at = clock_timestamp()
         FROM due
        WHERE intents.queue_namespace = due.queue_namespace
          AND intents.scope_fingerprint = due.scope_fingerprint
          AND intents.registry_id = due.registry_id
          AND intents.account_id = due.account_id
          AND intents.owner_scope = due.owner_scope
          AND intents.task_id = due.task_id
       RETURNING intents.registry_id, intents.account_id, intents.owner_scope,
                 intents.task_id, intents.scope_fingerprint, intents.action,
                 intents.intent_fingerprint, intents.attempt_count, intents.state,
                 intents.lease_claim_id, intents.lease_version::text`,
    [namespace, config.workerId, claimId, config.leaseMs, seenFingerprints, config.maxAttempts]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const taskRef = {
    registryId: requireRowString(row.registry_id, 'registry_id'),
    accountId: requireRowString(row.account_id, 'account_id'),
    ownerScope: requireRowString(row.owner_scope, 'owner_scope'),
    taskId: requireRowString(row.task_id, 'task_id'),
  };
  const attempt = {
    taskRef,
    action: row.action,
    intentFingerprint: requireRowString(row.intent_fingerprint, 'intent_fingerprint'),
    attemptCount: requireRowInteger(row.attempt_count, 'attempt_count'),
  };
  if (row.state === 'dead_letter') return { ...attempt, kind: 'dead_letter' };
  return {
    ...attempt,
    kind: 'claimed',
    scopeFingerprint: requireFingerprint(row.scope_fingerprint, 'scope_fingerprint'),
    leaseClaimId: requireRowString(row.lease_claim_id, 'lease_claim_id'),
    leaseVersion: requireRowString(row.lease_version, 'lease_version'),
  };
}

async function loadClaimPayload(
  db: PgQueryable,
  table: string,
  namespace: string,
  claim: ClaimedIntent
): Promise<unknown> {
  const result = await queryDb(
    db,
    'loadClaimPayload',
    `SELECT payload FROM ${table}
      WHERE queue_namespace = $1 AND registry_id = $2 AND account_id = $3
        AND owner_scope = $4 AND task_id = $5 AND intent_fingerprint = $6
        AND state = 'pending' AND lease_claim_id = $7 AND lease_version = $8::bigint
        AND scope_fingerprint = $9 AND lease_expires_at > clock_timestamp()`,
    claimValues(namespace, claim)
  );
  if (result.rowCount !== 1) throw new Error('Task settlement intent lease was lost before payload read');
  return result.rows[0]?.payload;
}

function intentFromClaim(claim: ClaimedIntent, storedPayload: unknown): TaskSettlementIntent {
  if (taskRefFingerprint(claim.taskRef) !== claim.scopeFingerprint) {
    throw new TypeError('Stored task settlement scope does not match its immutable fingerprint');
  }
  const payload = plainObject(storedPayload, 'payload');
  let storedIntent: TaskSettlementIntent;
  if (claim.action === 'complete') {
    if (!Object.hasOwn(payload, 'result')) throw new TypeError('Stored complete intent has no result');
    storedIntent = { taskRef: { ...claim.taskRef }, action: 'complete', result: payload.result };
  } else if (claim.action === 'fail') {
    const error = payload.error;
    storedIntent = {
      taskRef: { ...claim.taskRef },
      action: 'fail',
      error: error as AdcpStructuredError,
      ...(Object.hasOwn(payload, 'result') && { result: payload.result }),
    };
  } else {
    throw new TypeError('Stored task settlement intent has an invalid action');
  }
  if (canonicalJsonSha256(storedIntent) !== claim.intentFingerprint) {
    throw new TypeError('Stored task settlement intent does not match its immutable fingerprint');
  }
  assertWellFormedUnicode(storedIntent, 'Task settlement intent');
  if (storedIntent.action === 'complete') {
    return {
      ...storedIntent,
      result: sanitizeTaskResultForWire(structuredClone(storedIntent.result), storedIntent.taskRef),
    };
  }
  const clonedError = structuredClone(storedIntent.error);
  requireStructuredError(clonedError);
  const error = sanitizeStructuredAdcpError(clonedError);
  requireStructuredError(error);
  const result =
    storedIntent.result === undefined
      ? undefined
      : sanitizeTaskResultForWire(structuredClone(storedIntent.result), storedIntent.taskRef);
  return { ...storedIntent, error, ...(result !== undefined ? { result } : {}) };
}

async function acknowledgeClaim(
  db: PgQueryable,
  table: string,
  namespace: string,
  claim: ClaimedIntent,
  idempotencyHorizonMs: number
): Promise<boolean> {
  const result = await queryDb(
    db,
    'acknowledgeClaim',
    `UPDATE ${table}
        SET state = 'acknowledged',
            payload = '{}'::jsonb,
            retain_until = clock_timestamp() + ($10::bigint * INTERVAL '1 millisecond'),
            lease_owner = NULL, lease_claim_id = NULL, lease_expires_at = NULL,
            last_error = NULL, updated_at = clock_timestamp()
      WHERE queue_namespace = $1 AND registry_id = $2 AND account_id = $3
        AND owner_scope = $4 AND task_id = $5 AND intent_fingerprint = $6
        AND state = 'pending' AND lease_claim_id = $7 AND lease_version = $8::bigint
        AND scope_fingerprint = $9 AND lease_expires_at > clock_timestamp()`,
    [...claimValues(namespace, claim), idempotencyHorizonMs]
  );
  return result.rowCount === 1;
}

async function pruneExpiredAcknowledgements(
  db: PgQueryable,
  table: string,
  namespace: string,
  limit: number
): Promise<number> {
  const result = await queryDb(
    db,
    'pruneExpiredAcknowledgements',
    `WITH expired AS (
       SELECT candidate.queue_namespace, candidate.scope_fingerprint
         FROM ${table} AS candidate
        WHERE candidate.queue_namespace = $1
          AND candidate.state = 'acknowledged'
          AND candidate.retain_until <= clock_timestamp()
        ORDER BY candidate.retain_until
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${table} AS intents
      USING expired
      WHERE intents.queue_namespace = expired.queue_namespace
        AND intents.scope_fingerprint = expired.scope_fingerprint`,
    [namespace, limit]
  );
  return result.rowCount ?? 0;
}

function normalizePruneLimit(value: number | undefined): number {
  const limit = value ?? 1000;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new TypeError('pruneAcknowledged limit must be a positive integer no greater than 10000');
  }
  return limit;
}

async function extendClaimLease(
  db: PgQueryable,
  table: string,
  namespace: string,
  claim: ClaimedIntent,
  leaseMs: number
): Promise<boolean> {
  const result = await queryDb(
    db,
    'extendLease',
    `UPDATE ${table}
        SET lease_expires_at = clock_timestamp() + ($10::integer * INTERVAL '1 millisecond'),
            updated_at = clock_timestamp()
      WHERE queue_namespace = $1 AND registry_id = $2 AND account_id = $3
        AND owner_scope = $4 AND task_id = $5 AND intent_fingerprint = $6
        AND state = 'pending' AND lease_claim_id = $7 AND lease_version = $8::bigint
        AND scope_fingerprint = $9 AND lease_expires_at > clock_timestamp()`,
    [...claimValues(namespace, claim), leaseMs]
  );
  return result.rowCount === 1;
}

async function releaseClaim(
  db: PgQueryable,
  table: string,
  namespace: string,
  claim: ClaimedIntent,
  config: ReturnType<typeof normalizeRecoveryOptions>,
  error: unknown
): Promise<'retry' | 'dead_letter' | 'lease_lost'> {
  const deadLetter = claim.attemptCount >= config.maxAttempts;
  const multiplier = 2 ** Math.min(Math.max(claim.attemptCount - 1, 0), 8);
  const retryAfterMs = Math.min(config.retryAfterMs * multiplier, config.maxRetryAfterMs);
  const errorName = safeErrorName(error);
  const result = await queryDb(
    db,
    'releaseClaim',
    `UPDATE ${table}
        SET state = $10,
            next_attempt_at = CASE WHEN $10 = 'pending'
              THEN clock_timestamp() + ($11::integer * INTERVAL '1 millisecond')
              ELSE next_attempt_at END,
            lease_owner = NULL, lease_claim_id = NULL, lease_expires_at = NULL,
            last_error = $12, updated_at = clock_timestamp()
      WHERE queue_namespace = $1 AND registry_id = $2 AND account_id = $3
        AND owner_scope = $4 AND task_id = $5 AND intent_fingerprint = $6
        AND state = 'pending' AND lease_claim_id = $7 AND lease_version = $8::bigint
        AND scope_fingerprint = $9 AND lease_expires_at > clock_timestamp()`,
    [...claimValues(namespace, claim), deadLetter ? 'dead_letter' : 'pending', retryAfterMs, errorName]
  );
  if (result.rowCount !== 1) return 'lease_lost';
  return deadLetter ? 'dead_letter' : 'retry';
}

function safeErrorName(error: unknown): string {
  try {
    // `Error#name` is mutable and can contain exception messages, credentials,
    // or arbitrary adopter input. Persist only classifications proven by the
    // built-in prototype chain; unknown and cross-realm values stay generic.
    if (error instanceof EvalError) return 'EvalError';
    if (error instanceof RangeError) return 'RangeError';
    if (error instanceof ReferenceError) return 'ReferenceError';
    if (error instanceof SyntaxError) return 'SyntaxError';
    if (error instanceof TypeError) return 'TypeError';
    if (error instanceof URIError) return 'URIError';
    if (error instanceof AggregateError) return 'AggregateError';
  } catch {
    // Treat hostile proxies and Error subclasses as an anonymous failure.
  }
  return 'Error';
}

function claimValues(namespace: string, claim: ClaimedIntent): unknown[] {
  return [
    namespace,
    claim.taskRef.registryId,
    claim.taskRef.accountId,
    claim.taskRef.ownerScope,
    claim.taskRef.taskId,
    claim.intentFingerprint,
    claim.leaseClaimId,
    claim.leaseVersion,
    claim.scopeFingerprint,
  ];
}

function taskRefFingerprint(ref: DurableTaskSettlementRef): string {
  return canonicalJsonSha256({
    registryId: ref.registryId,
    accountId: ref.accountId,
    ownerScope: ref.ownerScope,
    taskId: ref.taskId,
  });
}

async function queryDb(
  db: PgQueryable,
  operation: string,
  sql: string,
  values?: unknown[]
): Promise<Awaited<ReturnType<PgQueryable['query']>>> {
  try {
    return await db.query(sql, values);
  } catch (cause) {
    throw new Error(`PostgresTaskSettlementIntentQueue.${operation}: database operation failed`, { cause });
  }
}

async function reportRecoveryError(
  hook: RecoverTaskSettlementIntentsOptions['onError'],
  error: unknown,
  claim: IntentAttempt,
  disposition: TaskSettlementIntentRecoveryErrorContext['disposition']
): Promise<void> {
  if (!hook) return;
  try {
    await hook(error, {
      taskRef: claim.taskRef,
      action: claim.action === 'complete' ? 'complete' : 'fail',
      attemptCount: claim.attemptCount,
      disposition,
    });
  } catch {
    // Observability must not change durable recovery state.
  }
}

function assertPayloadSize(payload: StoredPayload): void {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new TypeError(`Task settlement intent payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
}

function assertValidTableName(table: string): void {
  if (!VALID_IDENTIFIER.test(table) || Buffer.byteLength(table, 'utf8') > 40) {
    throw new TypeError('Task settlement intent tableName must be a lowercase SQL identifier of at most 40 bytes');
  }
}

function assertValidNamespace(namespace: string): void {
  if (typeof namespace !== 'string' || !VALID_NAMESPACE.test(namespace)) {
    throw new TypeError(
      'Task settlement intent namespace must be 1-255 ASCII letters, digits, dots, underscores, colons, or hyphens'
    );
  }
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Stored task settlement intent ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireRowString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Stored task settlement intent ${field} must be a non-empty string`);
  }
  return value;
}

function requireFingerprint(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`Stored task settlement intent ${field} must be a SHA-256 fingerprint`);
  }
  return value;
}

function requireRowInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`Stored task settlement intent ${field} must be a positive integer`);
  }
  return value;
}
