/**
 * Crash-safe PostgreSQL settlement for push-enabled decisioning tasks.
 *
 * The task transition and terminal webhook outbox checkpoint commit in one
 * database transaction. Delivery remains the existing webhook recovery
 * worker's responsibility, so a process can die after commit without losing
 * the buyer's promised terminal notification.
 */

import { createHash } from 'node:crypto';
import { canonicalJsonSha256 } from '../../../utils/jcs';
import { isAdcpVersionAtLeast, isValidAdcpVersion } from '../../../utils/adcp-version-config';
import { assertWellFormedUnicode } from '../../../utils/well-formed-unicode';
import type { AdcpStructuredError } from '../async-outcome';
import { sanitizeStructuredAdcpError } from '../../errors';
import type { WebhookAuthentication, WebhookRetryOptions } from '../../webhook-emitter';
import { quoteWebhookTable } from '../../webhook-delivery/common';
import {
  createWebhookDeliveryRecovery,
  type CreateWebhookDeliveryRecoveryOptions,
  type DurableWebhookDeliveryRecovery,
  type PreparedWebhookDeliverySnapshot,
  type StoredWebhookDeliverySnapshot,
  type WebhookAuthenticationAdapter,
  WebhookAuthenticationProtectionError,
} from '../../webhook-delivery/recovery';
import { pgWebhookDeliveryRecoveryBackend, type PgWebhookDeliveryRecoveryOptions } from '../../webhook-delivery/pg';
import { protocolForTool, SPEC_WEBHOOK_TASK_TYPES } from './protocol-for-tool';
import {
  _postgresTaskRegistryBinding,
  type PgQueryable,
  type PgTransactionClient,
  type PgTransactionalPool,
} from './postgres-task-registry';
import { sanitizeTaskResultForWire, type ScopedTaskRef, type TaskRegistry, type TaskStatus } from './task-registry';

export interface TaskPushSettlementConfig {
  /** Validated destination from the original push_notification_config. */
  url: string;
  /** Original buyer correlation identity. */
  operationId?: string;
  /** Negotiated AdCP version; required when operationId is absent to prove a legacy route. */
  servedAdcpVersion?: string;
  /** Optional validation token echoed in the task-webhook payload. */
  token?: string;
  /** Optional legacy transport authentication. RFC 9421 remains the baseline. */
  authentication?: WebhookAuthentication;
}

export type TaskPushDeliveryState = 'durably_bound' | 'recoverable' | 'delivered' | 'terminal';

export type TaskPushSettlementOutcome =
  | { outcome: 'applied'; delivery: 'durably_bound' }
  | {
      outcome: 'already_terminal';
      status: TaskStatus;
      compatibility: 'compatible';
      delivery: TaskPushDeliveryState;
    }
  | {
      outcome: 'already_terminal';
      status: TaskStatus;
      compatibility: 'conflicting';
      delivery: 'not_applicable';
    }
  | { outcome: 'not_found_in_scope'; delivery: 'not_applicable' };

type TerminalSettlement =
  | { status: 'completed'; result: unknown }
  | { status: 'failed'; error: AdcpStructuredError; result?: unknown };

export interface PostgresTaskSettlementCoordinatorOptions {
  /** The exact PostgreSQL registry that issued the ScopedTaskRef. */
  registry: TaskRegistry;
  /** Stable publisher namespace; normally the server's configured name. */
  publisherScope: string;
  /** PostgreSQL outbox options. The outbox is always created on the registry's pool. */
  outbox?: PgWebhookDeliveryRecoveryOptions;
  /** Required when push tokens or legacy transport credentials are present. */
  authenticationAdapter?: WebhookAuthenticationAdapter;
  /** Recovery lease/snapshot limits shared with the returned recovery worker. */
  recovery?: Omit<CreateWebhookDeliveryRecoveryOptions, 'backend' | 'authenticationAdapter'>;
  /** Retry policy persisted with every terminal snapshot. */
  retries?: WebhookRetryOptions;
}

export interface PostgresTaskSettlementCoordinator {
  readonly durability: 'durable';
  /** Wire this into the normal webhook recovery poller/emitter. */
  readonly recovery: DurableWebhookDeliveryRecovery;
  settle(
    ref: ScopedTaskRef,
    terminal: TerminalSettlement,
    push: TaskPushSettlementConfig
  ): Promise<TaskPushSettlementOutcome>;
}

/** Configuration or immutable-delivery conflict detected before commit. */
export class TaskPushSettlementConfigurationError extends Error {
  override readonly name = 'TaskPushSettlementConfigurationError';
}

interface LockedTaskRow {
  tool: string;
  status: TaskStatus;
  result: unknown;
  error: unknown;
  has_webhook: boolean;
}

const TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'rejected', 'canceled']);
const MAX_RESULT_BYTES = 4 * 1024 * 1024;
const TOKEN_CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export function createPostgresTaskSettlementCoordinator(
  options: PostgresTaskSettlementCoordinatorOptions
): PostgresTaskSettlementCoordinator {
  const binding = _postgresTaskRegistryBinding(options.registry);
  if (!binding) {
    throw new TypeError('createPostgresTaskSettlementCoordinator requires a registry from createPostgresTaskRegistry');
  }
  const pool = binding.pool as Partial<PgTransactionalPool>;
  if (typeof pool.connect !== 'function') {
    throw new TypeError(
      'Crash-safe task settlement requires a pg Pool with connect(); a query-only adapter cannot own a transaction'
    );
  }
  const registryId = options.registry.registryId;
  if (typeof registryId !== 'string' || registryId.length === 0) {
    throw new TypeError('Crash-safe task settlement requires task registry storageId/registryId binding');
  }
  if (typeof options.publisherScope !== 'string' || options.publisherScope.length === 0) {
    throw new TypeError('publisherScope must be a non-empty string');
  }
  assertWellFormedUnicode(registryId, 'Task settlement registryId');
  assertWellFormedUnicode(options.publisherScope, 'Task settlement publisherScope');

  const outboxOptions = options.outbox ?? {};
  const outboxTable = quoteWebhookTable(outboxOptions.tableName ?? 'adcp_webhook_outbox');
  const claimScope = {
    publisherScope: options.publisherScope,
    tenantScope: stableRegistryScope(registryId, binding.namespace),
  };
  const backend = pgWebhookDeliveryRecoveryBackend(binding.pool, { ...outboxOptions, claimScope });
  const recovery = createWebhookDeliveryRecovery({
    ...options.recovery,
    backend,
    ...(options.authenticationAdapter && { authenticationAdapter: options.authenticationAdapter }),
  });
  const retries = resolveRetries(options.retries);

  return {
    durability: 'durable',
    recovery,
    async settle(ref, terminal, push): Promise<TaskPushSettlementOutcome> {
      const settlementRef = snapshotSettlementRef(ref);
      if (settlementRef.registryId !== registryId) {
        return { outcome: 'not_found_in_scope', delivery: 'not_applicable' };
      }
      let clonedTerminal: TerminalSettlement;
      let clonedPush: TaskPushSettlementConfig;
      try {
        clonedTerminal = structuredClone(terminal);
        clonedPush = structuredClone(push);
        assertWellFormedUnicode(clonedTerminal, 'Task terminal result/error');
        assertWellFormedUnicode(clonedPush, 'Task push settlement config');
      } catch (cause) {
        throw new TaskPushSettlementConfigurationError('Task settlement inputs must contain serializable JSON', {
          cause,
        });
      }
      const deliveryKey = {
        ...claimScope,
        deliveryId: stableScope('task-webhook', settlementRef),
      };
      const transactionalPool = pool as PgTransactionalPool;

      // Read the immutable inputs needed by protection without retaining a
      // transaction client. KMS/secret-manager adapters may be slow or hung;
      // they must never run while a task/outbox row lock or pooled connection
      // is held. The transaction below re-reads and validates every relevant
      // task/outbox field before committing.
      let observed: LockedTaskRow | undefined;
      try {
        observed = await readTaskRow(transactionalPool, binding.tableName, binding.namespace, settlementRef, false);
      } catch (cause) {
        throwSettlementFailure(cause);
      }
      if (!observed) return { outcome: 'not_found_in_scope', delivery: 'not_applicable' };

      validatePush(clonedPush);
      if (observed.has_webhook !== true) {
        throw new TaskPushSettlementConfigurationError(
          'Crash-safe push settlement requires a task created with hasWebhook: true'
        );
      }

      let result: unknown;
      let error: AdcpStructuredError | undefined;
      try {
        result =
          clonedTerminal.status === 'completed'
            ? sanitizeTaskResultForWire(clonedTerminal.result, settlementRef)
            : clonedTerminal.result === undefined
              ? { errors: [sanitizeStructuredAdcpError(clonedTerminal.error)] }
              : sanitizeTaskResultForWire(clonedTerminal.result, settlementRef);
        error = clonedTerminal.status === 'failed' ? sanitizeStructuredAdcpError(clonedTerminal.error) : undefined;
        assertWellFormedUnicode({ result, error }, 'Task terminal result/error');
        // Validate the exact canonical domain used later for immutable
        // terminal and outbox fingerprints. JSON.stringify alone would
        // silently coerce NaN/Infinity and exotic objects.
        canonicalJsonSha256({ result, error });
        assertPayloadSize(result, error);
      } catch (cause) {
        if (cause instanceof TaskPushSettlementConfigurationError) throw cause;
        throw new TaskPushSettlementConfigurationError('Task terminal result/error must be serializable JSON', {
          cause,
        });
      }

      if (
        TERMINAL.has(observed.status) &&
        !terminalMatches(observed, clonedTerminal.status, result, error, settlementRef)
      ) {
        return {
          outcome: 'already_terminal',
          status: observed.status,
          compatibility: 'conflicting',
          delivery: 'not_applicable',
        };
      }
      if (!SPEC_WEBHOOK_TASK_TYPES.has(observed.tool)) {
        throw new TaskPushSettlementConfigurationError(
          `Task type ${observed.tool} cannot be emitted by the closed AdCP task-webhook schema`
        );
      }

      let observedOutbox: OutboxRow | undefined;
      try {
        observedOutbox = await readOutbox(transactionalPool, outboxTable, deliveryKey, false);
      } catch (cause) {
        throwSettlementFailure(cause);
      }
      if (TERMINAL.has(observed.status) && !observedOutbox) {
        throw new TaskPushSettlementConfigurationError(
          'Terminal task has no atomic webhook delivery checkpoint; refusing to create a duplicate notification'
        );
      }
      const existingTimestamp =
        observedOutbox?.state === 'pending' ? observedOutbox.snapshot.payload.timestamp : undefined;
      const payload: Record<string, unknown> = {
        idempotency_key: `pending.${deliveryKey.deliveryId.slice(-48)}`,
        operation_id: resolveOperationId(clonedPush, observed.tool, settlementRef.taskId),
        task_id: settlementRef.taskId,
        task_type: observed.tool,
        status: clonedTerminal.status,
        timestamp: typeof existingTimestamp === 'string' ? existingTimestamp : new Date().toISOString(),
        protocol: protocolForTool(observed.tool),
        result,
        ...(clonedPush.token !== undefined && { token: clonedPush.token }),
        ...(clonedTerminal.status === 'failed' && { message: error!.message }),
      };
      let prepared: PreparedWebhookDeliverySnapshot;
      try {
        prepared = await recovery.prepare(
          deliveryKey,
          {
            url: clonedPush.url,
            payload,
            authentication: clonedPush.authentication ?? null,
            retries,
          },
          { protectPayloadToken: clonedPush.token !== undefined }
        );
      } catch (cause) {
        if (cause instanceof WebhookAuthenticationProtectionError) throwSettlementFailure(cause);
        throw new TaskPushSettlementConfigurationError('Terminal webhook delivery configuration is invalid', {
          cause,
        });
      }
      const intentFingerprint = taskPushIntentFingerprint(prepared.snapshot, settlementRef);

      let client: PgTransactionClient | undefined;
      try {
        client = await transactionalPool.connect();
        await client.query('BEGIN');
        const row = await readTaskRow(client, binding.tableName, binding.namespace, settlementRef, true);
        if (!row) {
          await client.query('ROLLBACK');
          return { outcome: 'not_found_in_scope', delivery: 'not_applicable' };
        }
        if (row.has_webhook !== true) {
          throw new TaskPushSettlementConfigurationError(
            'Crash-safe push settlement requires a task created with hasWebhook: true'
          );
        }
        if (row.tool !== observed.tool) {
          throw new TaskPushSettlementConfigurationError('Task type changed during settlement protection');
        }
        if (!SPEC_WEBHOOK_TASK_TYPES.has(row.tool)) {
          throw new TaskPushSettlementConfigurationError(
            `Task type ${row.tool} cannot be emitted by the closed AdCP task-webhook schema`
          );
        }
        const compatible = terminalMatches(row, clonedTerminal.status, result, error, settlementRef);
        if (TERMINAL.has(row.status) && !compatible) {
          await client.query('COMMIT');
          return {
            outcome: 'already_terminal',
            status: row.status,
            compatibility: 'conflicting',
            delivery: 'not_applicable',
          };
        }

        const existing = await readOutbox(client, outboxTable, deliveryKey, true);
        if (TERMINAL.has(row.status) && !existing) {
          throw new TaskPushSettlementConfigurationError(
            'Terminal task has no atomic webhook delivery checkpoint; refusing to create a duplicate notification'
          );
        }
        let inserted = false;
        let delivery = existing ? deliveryState(existing) : undefined;

        // Settled records redact their snapshots but retain a non-secret
        // fingerprint of every immutable route/payload field except the
        // generated timestamp, so exact retries remain distinguishable from
        // changed delivery intent.
        if (existing?.state === 'settled') {
          if (!TERMINAL.has(row.status)) {
            throw new Error('Settled webhook outbox row exists for a non-terminal task');
          }
          const matchesCurrentIntent = existing.intent_fingerprint === intentFingerprint;
          const matchesLegacyArtifact =
            existing.intent_fingerprint !== null &&
            existing.intent_fingerprint === taskPushLegacyIntentFingerprint(prepared.snapshot, row.result);
          if (existing.intent_fingerprint !== null && !matchesCurrentIntent && !matchesLegacyArtifact) {
            throw new TaskPushSettlementConfigurationError(
              'Terminal webhook delivery identity is already bound to a conflicting route or payload'
            );
          }
          await client.query('COMMIT');
          return {
            outcome: 'already_terminal',
            status: row.status,
            compatibility: 'compatible',
            delivery: deliveryState(existing),
          };
        }

        if (existing && !outboxMatchesPrepared(existing, intentFingerprint, settlementRef)) {
          throw new TaskPushSettlementConfigurationError(
            'Terminal webhook delivery identity is already bound to a conflicting route or payload'
          );
        }

        if (!existing) {
          const write = await client.query(
            `INSERT INTO ${outboxTable} (
               publisher_scope, tenant_scope, delivery_id, snapshot, snapshot_fingerprint,
               storage_fingerprint, intent_fingerprint, state, attempt_count, next_attempt_at
             ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'pending', 0, clock_timestamp())
             ON CONFLICT (publisher_scope, tenant_scope, delivery_id) DO NOTHING`,
            [
              deliveryKey.publisherScope,
              deliveryKey.tenantScope,
              deliveryKey.deliveryId,
              JSON.stringify(prepared.snapshot),
              prepared.snapshotFingerprint,
              prepared.storageFingerprint,
              intentFingerprint,
            ]
          );
          if ((write.rowCount ?? 0) !== 1) {
            const raced = await readOutbox(client, outboxTable, deliveryKey, true);
            if (!raced || !outboxMatchesPrepared(raced, intentFingerprint, settlementRef)) {
              throw new TaskPushSettlementConfigurationError(
                'Terminal webhook delivery identity is already bound to a conflicting route or payload'
              );
            }
            delivery = deliveryState(raced);
          } else {
            inserted = true;
            delivery = 'durably_bound';
          }
        }

        if (!TERMINAL.has(row.status)) {
          const update =
            clonedTerminal.status === 'completed'
              ? await client.query(
                  `UPDATE ${binding.tableName}
                      SET status = 'completed', result = $5::jsonb, error = NULL,
                          status_message = NULL, updated_at = clock_timestamp()
                    WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4`,
                  [
                    settlementRef.taskId,
                    binding.namespace,
                    settlementRef.accountId,
                    settlementRef.ownerScope,
                    JSON.stringify(result),
                  ]
                )
              : await client.query(
                  `UPDATE ${binding.tableName}
                      SET status = 'failed', result = $5::jsonb, error = $6::jsonb,
                          status_message = $7, updated_at = clock_timestamp()
                    WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4`,
                  [
                    settlementRef.taskId,
                    binding.namespace,
                    settlementRef.accountId,
                    settlementRef.ownerScope,
                    JSON.stringify(result),
                    JSON.stringify(error),
                    error!.message,
                  ]
                );
          if ((update.rowCount ?? 0) !== 1) throw new Error('Task disappeared while holding its settlement lock');
          await client.query('COMMIT');
          return { outcome: 'applied', delivery: 'durably_bound' };
        }

        await client.query('COMMIT');
        return {
          outcome: 'already_terminal',
          status: row.status,
          compatibility: 'compatible',
          delivery: inserted ? 'durably_bound' : (delivery ?? 'recoverable'),
        };
      } catch (cause) {
        if (client) await rollbackQuietly(client);
        throwSettlementFailure(cause);
      } finally {
        client?.release();
      }
    },
  };
}

export async function completeScopedPushTask<TResult>(
  coordinator: PostgresTaskSettlementCoordinator,
  ref: ScopedTaskRef,
  push: TaskPushSettlementConfig,
  result: TResult
): Promise<TaskPushSettlementOutcome> {
  return coordinator.settle(ref, { status: 'completed', result }, push);
}

export async function failScopedPushTask(
  coordinator: PostgresTaskSettlementCoordinator,
  ref: ScopedTaskRef,
  push: TaskPushSettlementConfig,
  error: AdcpStructuredError,
  result?: unknown
): Promise<TaskPushSettlementOutcome> {
  return coordinator.settle(ref, { status: 'failed', error, ...(result !== undefined && { result }) }, push);
}

function snapshotSettlementRef(ref: ScopedTaskRef): ScopedTaskRef & { registryId: string } {
  const cloned = structuredClone(ref) as Partial<ScopedTaskRef>;
  const snapshot = {
    registryId: requireSettlementRefPart(cloned.registryId, 'registryId'),
    accountId: requireSettlementRefPart(cloned.accountId, 'accountId'),
    ownerScope: requireSettlementRefPart(cloned.ownerScope, 'ownerScope'),
    taskId: requireSettlementRefPart(cloned.taskId, 'taskId'),
  };
  assertWellFormedUnicode(snapshot, 'Task settlement reference');
  return snapshot;
}

function requireSettlementRefPart(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Task settlement ${field} must be a non-empty string`);
  }
  return value;
}

function terminalMatches(
  row: LockedTaskRow,
  status: 'completed' | 'failed',
  result: unknown,
  error: AdcpStructuredError | undefined,
  ref: ScopedTaskRef
): boolean {
  if (row.status !== status) return false;
  try {
    assertWellFormedUnicode({ result: row.result, error: row.error }, 'Stored task terminal result/error');
    const storedResult = sanitizeTaskResultForWire(structuredClone(row.result), ref);
    const storedError =
      status === 'failed' ? sanitizeStructuredAdcpError(structuredClone(row.error) as AdcpStructuredError) : undefined;
    return (
      canonicalJsonSha256(storedResult) === canonicalJsonSha256(result) &&
      (status === 'completed' || canonicalJsonSha256(storedError) === canonicalJsonSha256(error))
    );
  } catch {
    return false;
  }
}

function stableScope(prefix: string, ref: ScopedTaskRef): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([ref.registryId, ref.accountId, ref.ownerScope, ref.taskId]))
    .digest('hex');
  return `${prefix}:${digest}`;
}

function stableRegistryScope(registryId: string, namespace: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([registryId, namespace]))
    .digest('hex');
  return `task-registry:${digest}`;
}

function taskPushIntentFingerprint(snapshot: StoredWebhookDeliverySnapshot, ref: ScopedTaskRef): string {
  const { timestamp: _generatedTimestamp, ...storedPayload } = snapshot.payload;
  const payload = structuredClone(storedPayload);
  if (Object.hasOwn(payload, 'result')) {
    payload.result = sanitizeTaskResultForWire(payload.result, ref);
  }
  return taskPushIntentFingerprintForPayload(snapshot, payload);
}

function taskPushLegacyIntentFingerprint(snapshot: StoredWebhookDeliverySnapshot, storedResult: unknown): string {
  const { timestamp: _generatedTimestamp, ...storedPayload } = snapshot.payload;
  const payload = structuredClone(storedPayload);
  payload.result = structuredClone(storedResult);
  return taskPushIntentFingerprintForPayload(snapshot, payload);
}

function taskPushIntentFingerprintForPayload(
  snapshot: StoredWebhookDeliverySnapshot,
  payload: Record<string, unknown>
): string {
  const domain = {
    url: snapshot.url,
    payload,
    retries: snapshot.retries,
    authentication:
      snapshot.authentication.kind === 'none'
        ? { kind: 'none' }
        : { kind: 'protected', fingerprint: snapshot.authentication.fingerprint },
    ...(snapshot.payloadToken && { payloadToken: { fingerprint: snapshot.payloadToken.fingerprint } }),
  };
  assertWellFormedUnicode(domain, 'Task push settlement fingerprint');
  return canonicalJsonSha256(domain);
}

function validatePush(push: TaskPushSettlementConfig): void {
  if (!push || typeof push !== 'object') {
    throw new TaskPushSettlementConfigurationError('push settlement config is required');
  }
  assertWellFormedUnicode(push, 'Task push settlement config');
  const allowHttp =
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'development' ||
    process.env.ADCP_DECISIONING_ALLOW_HTTP_WEBHOOKS === '1';
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = typeof push.url === 'string' ? new URL(push.url) : undefined;
  } catch {
    // Report the same non-secret configuration error as an unsupported scheme.
  }
  if (
    parsedUrl === undefined ||
    parsedUrl.hostname.length === 0 ||
    parsedUrl.username.length > 0 ||
    parsedUrl.password.length > 0 ||
    (parsedUrl.protocol !== 'https:' && !(allowHttp && parsedUrl.protocol === 'http:'))
  ) {
    throw new TaskPushSettlementConfigurationError(
      'push settlement url must be a request-validated HTTPS destination (HTTP requires the development allowlist)'
    );
  }
  if (
    push.operationId !== undefined &&
    (typeof push.operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,255}$/.test(push.operationId))
  ) {
    throw new TaskPushSettlementConfigurationError('push settlement operationId must match /^[A-Za-z0-9_.:-]{1,255}$/');
  }
  if (
    push.operationId === undefined &&
    (!isValidAdcpVersion(push.servedAdcpVersion) || isAdcpVersionAtLeast(push.servedAdcpVersion, '3.2.0-beta.5'))
  ) {
    throw new TaskPushSettlementConfigurationError(
      'push settlement operationId is required unless servedAdcpVersion is an explicit valid pre-3.2.0-beta.5 version'
    );
  }
  if (
    push.token !== undefined &&
    (typeof push.token !== 'string' ||
      push.token.length < 16 ||
      push.token.length > 4096 ||
      TOKEN_CONTROL_CHAR_RE.test(push.token))
  ) {
    throw new TaskPushSettlementConfigurationError(
      'push settlement token must be a string from 16 through 4096 characters'
    );
  }
  if (push.authentication !== undefined && push.authentication !== null) {
    const authentication = push.authentication as Partial<Exclude<WebhookAuthentication, null>>;
    const validBearer =
      authentication.type === 'bearer' && typeof authentication.token === 'string' && authentication.token.length >= 32;
    const validHmac =
      authentication.type === 'hmac_sha256' &&
      typeof authentication.secret === 'string' &&
      authentication.secret.length >= 32;
    if (!validBearer && !validHmac) {
      throw new TaskPushSettlementConfigurationError(
        'push settlement authentication must be a WebhookAuthentication value'
      );
    }
  }
}

function resolveOperationId(push: TaskPushSettlementConfig, tool: string, taskId: string): string {
  // Pre-3.2 negotiated bundles did not carry operation_id. Match the live
  // framework path's stable compatibility value so reconstructed workers
  // produce the same payload after restart.
  return push.operationId ?? `${tool}.${taskId}`;
}

function resolveRetries(retries: WebhookRetryOptions | undefined): Required<WebhookRetryOptions> {
  const resolved = {
    maxAttempts: retries?.maxAttempts ?? 5,
    initialDelayMs: retries?.initialDelayMs ?? 1000,
    maxDelayMs: retries?.maxDelayMs ?? 60_000,
    jitter: retries?.jitter ?? 0.25,
  };
  if (!Number.isSafeInteger(resolved.maxAttempts) || resolved.maxAttempts < 1) {
    throw new TypeError('retries.maxAttempts must be an integer of at least 1');
  }
  for (const key of ['initialDelayMs', 'maxDelayMs'] as const) {
    if (!Number.isFinite(resolved[key]) || resolved[key] < 0) {
      throw new TypeError(`retries.${key} must be a finite non-negative number`);
    }
  }
  if (!Number.isFinite(resolved.jitter) || resolved.jitter < 0 || resolved.jitter > 1) {
    throw new TypeError('retries.jitter must be a finite number from 0 through 1');
  }
  return resolved;
}

function assertPayloadSize(result: unknown, error: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify({ result, error }), 'utf8');
  if (bytes > MAX_RESULT_BYTES) {
    throw new TaskPushSettlementConfigurationError(`Task result/error JSON exceeds ${MAX_RESULT_BYTES} bytes`);
  }
}

interface OutboxRow {
  snapshot: StoredWebhookDeliverySnapshot;
  snapshot_fingerprint: string;
  intent_fingerprint: string | null;
  state: string;
  disposition: string | null;
}

async function readTaskRow(
  db: PgQueryable,
  table: string,
  namespace: string,
  ref: ScopedTaskRef,
  lock: boolean
): Promise<LockedTaskRow | undefined> {
  const found = await db.query(
    `SELECT tool, status, result, error, has_webhook
       FROM ${table}
      WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4${lock ? '\n      FOR UPDATE' : ''}`,
    [ref.taskId, namespace, ref.accountId, ref.ownerScope]
  );
  return found.rows[0] as unknown as LockedTaskRow | undefined;
}

async function readOutbox(
  db: PgQueryable,
  table: string,
  key: { publisherScope: string; tenantScope: string; deliveryId: string },
  lock: boolean
): Promise<OutboxRow | undefined> {
  const found = await db.query(
    `SELECT snapshot, snapshot_fingerprint, intent_fingerprint, state, disposition
       FROM ${table}
      WHERE publisher_scope = $1 AND tenant_scope = $2 AND delivery_id = $3${lock ? '\n      FOR UPDATE' : ''}`,
    [key.publisherScope, key.tenantScope, key.deliveryId]
  );
  return found.rows[0] as unknown as OutboxRow | undefined;
}

function outboxMatchesPrepared(existing: OutboxRow, intentFingerprint: string, ref: ScopedTaskRef): boolean {
  if (existing.intent_fingerprint === intentFingerprint) return true;
  if (existing.state === 'settled') return false;
  try {
    return taskPushIntentFingerprint(existing.snapshot, ref) === intentFingerprint;
  } catch {
    return false;
  }
}

function throwSettlementFailure(cause: unknown): never {
  if (cause instanceof TaskPushSettlementConfigurationError) throw cause;
  throw new Error('PostgresTaskSettlementCoordinator.settle: transaction failed', { cause });
}

function deliveryState(row: OutboxRow): TaskPushDeliveryState {
  if (row.state !== 'settled') return 'recoverable';
  return row.disposition === 'delivered' ? 'delivered' : 'terminal';
}

async function rollbackQuietly(client: PgTransactionClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original failure. The pool will discard a broken client.
  }
}
