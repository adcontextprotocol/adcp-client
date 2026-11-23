/**
 * Crash-safe PostgreSQL settlement for push-enabled decisioning tasks.
 *
 * The task transition and terminal webhook outbox checkpoint commit in one
 * database transaction. Delivery remains the existing webhook recovery
 * worker's responsibility, so a process can die after commit without losing
 * the buyer's promised terminal notification.
 *
 * The coordinator also owns the push bindings for externally settled
 * framework handoffs: when `createAdcpServerFromPlatform` accepts
 * `ctx.handoffToTask(fn, { settlement: 'external' })` for a request that
 * carries `push_notification_config`, it stores the buyer's validated route
 * against the task here, before the buyer is told the task was submitted. A
 * worker then settles with the bound helpers, which read that route; a worker
 * never supplies (and so can never change) the destination or token.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
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
  type WebhookAuthenticationContext,
  WebhookAuthenticationProtectionError,
  _protectWebhookAuthentication,
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
import { projectBoundTaskResultForRelease } from './task-result-release';

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
  /**
   * Signing profile the buyer requested in `push_notification_config.signing_profile`.
   * Omitted means the default `adcp/webhook-signing/v1`.
   */
  signingProfile?: 'adcp/webhook-signing/v1' | 'web-bot-auth';
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
  | { status: 'failed'; error: AdcpStructuredError; result?: unknown }
  | { status: 'rejected'; result: unknown; reason?: string };

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
  /**
   * Prove that a scoped terminal task has its deterministic durable webhook
   * checkpoint. This does not compare the task's result/error with a caller's
   * intended artifact and does not prove delivery; verify terminal artifact
   * compatibility separately before acknowledging an intent. Reconstructed
   * coordinators must use the same registry, publisher scope, and outbox, and
   * the checkpoint must be retained for the full intent replay horizon. The
   * proof does not require the now-redacted push config.
   */
  hasTerminalCheckpoint(ref: ScopedTaskRef): Promise<boolean>;
  settle(
    ref: ScopedTaskRef,
    terminal: TerminalSettlement,
    push: TaskPushSettlementConfig
  ): Promise<TaskPushSettlementOutcome>;
}

/** Configuration or immutable-delivery conflict detected before commit. */
export class TaskPushSettlementConfigurationError extends Error {
  override readonly name: string = 'TaskPushSettlementConfigurationError';
}

/**
 * A caller-supplied push config does not match the route the SDK bound to an
 * externally settled task at handoff, or a second binding for the same task
 * named a different route. Nothing was written. Settle a bound task with
 * `completeBoundPushTask()` / `failBoundPushTask()` / `rejectBoundPushTask()`,
 * which read the stored route instead of taking one.
 */
export class TaskPushBindingMismatchError extends TaskPushSettlementConfigurationError {
  override readonly name: string = 'TaskPushBindingMismatchError';
}

/**
 * A route the framework binds at handoff. `serverAdcpVersion` is the server's
 * release, which the worker's result is in; a bound settlement converts the
 * webhook result from it to `servedAdcpVersion`, as the in-process task
 * webhook does.
 *
 * @internal
 */
export type TaskPushBindingRoute = TaskPushSettlementConfig & { serverAdcpVersion?: string };

/**
 * Internal capability the framework uses to bind a buyer push route to an
 * externally settled task, and the bound helpers use to settle it. Not part
 * of the public coordinator interface: only the SDK's handoff path creates a
 * binding.
 *
 * @internal
 */
export interface TaskPushBindingSupport {
  readonly registryId: string;
  /** Whether a push token can be protected at rest (an authenticationAdapter is configured). */
  readonly protectsTokens: boolean;
  /**
   * Confirm the registry table can hold a binding (the `push_binding` column
   * exists). Called before a task is created, so an unmigrated deployment
   * fails without leaving an orphaned `has_webhook` task.
   */
  ensureReady(): Promise<void>;
  bind(ref: ScopedTaskRef, push: TaskPushBindingRoute): Promise<void>;
  settleBound(ref: ScopedTaskRef, terminal: TerminalSettlement): Promise<TaskPushSettlementOutcome>;
}

const taskPushBindingSupport = new WeakMap<object, TaskPushBindingSupport>();

/** @internal */
export function _taskPushBindingSupport(coordinator: unknown): TaskPushBindingSupport | undefined {
  return coordinator !== null && typeof coordinator === 'object' ? taskPushBindingSupport.get(coordinator) : undefined;
}

/**
 * Stored, non-secret form of a bound push route, kept in the task row's
 * `push_binding` column. The token is adapter-protected; `fingerprint` (an
 * unkeyed consistency hash over every other field and the token's protected
 * fingerprint) is checked on every read. It catches corruption or a partial
 * edit, not deliberate tampering by someone with write access to the table,
 * which, as for the outbox, is outside the threat model.
 */
interface StoredTaskPushBinding {
  url: string;
  operationId?: string;
  servedAdcpVersion?: string;
  /** The server's release at handoff, which the worker's result is in. */
  serverAdcpVersion?: string;
  signingProfile?: 'adcp/webhook-signing/v1' | 'web-bot-auth';
  token?: { protectedValue: unknown; fingerprint: string };
  fingerprint?: string;
}

const PG_UNDEFINED_COLUMN = '42703';

function pgErrorCode(cause: unknown): unknown {
  return cause !== null && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined;
}

interface LockedTaskRow {
  tool: string;
  status: TaskStatus;
  result: unknown;
  error: unknown;
  status_message: string | null;
  has_webhook: boolean;
  /** The SDK-bound push route; null or absent when the task was not bound. */
  push_binding?: StoredTaskPushBinding | null;
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

  const adapter = options.authenticationAdapter;
  const bindingTenantScope = stableRegistryScope(registryId, binding.namespace);
  // The binding key depends only on the registry identity and the task ref.
  // No coordinator setting (publisherScope, outbox table) can move it.
  const bindingKeyFor = (ref: ScopedTaskRef): TaskPushBindingKey => ({
    publisherScope: 'adcp:task-push-binding',
    tenantScope: bindingTenantScope,
    deliveryId: stableScope('task-push-binding', ref),
  });

  /**
   * Read the task row including its `push_binding`. A registry table that
   * predates the column cannot hold a binding (binding requires the column),
   * so on that table every task reads as unbound. Inside the settlement
   * transaction the probe runs under a savepoint, because a failed statement
   * would otherwise abort the transaction.
   */
  let bindingColumnSeen = false;
  const readTaskRowWithBinding = async (
    db: PgQueryable,
    ref: ScopedTaskRef,
    lock: boolean
  ): Promise<LockedTaskRow | undefined> => {
    if (lock) await db.query('SAVEPOINT adcp_push_binding_read');
    try {
      const row = await readTaskRow(db, binding.tableName, binding.namespace, ref, lock, true);
      bindingColumnSeen = true;
      if (lock) await db.query('RELEASE SAVEPOINT adcp_push_binding_read');
      return row;
    } catch (cause) {
      if (pgErrorCode(cause) !== PG_UNDEFINED_COLUMN) throw cause;
      if (bindingColumnSeen) {
        // This coordinator has seen the column, so bound tasks may exist.
        // Its disappearance must not turn them into unbound tasks.
        throw new TaskPushSettlementConfigurationError(
          `The push_binding column disappeared from ${binding.tableName}; refusing to settle push tasks without it`
        );
      }
      if (lock) await db.query('ROLLBACK TO SAVEPOINT adcp_push_binding_read');
      return readTaskRow(db, binding.tableName, binding.namespace, ref, lock, false);
    }
  };

  /** Verify and resolve a stored binding. Throws rather than ever returning a partial route. */
  const resolveBinding = async (ref: ScopedTaskRef, stored: StoredTaskPushBinding): Promise<TaskPushBindingRoute> => {
    if (
      stored === null ||
      typeof stored !== 'object' ||
      typeof stored.url !== 'string' ||
      typeof stored.fingerprint !== 'string' ||
      stored.fingerprint !== bindingFingerprint(stored)
    ) {
      throw new TaskPushSettlementConfigurationError('Task push binding failed its consistency check');
    }
    const route: TaskPushBindingRoute = {
      url: stored.url,
      ...(stored.operationId !== undefined && { operationId: stored.operationId }),
      ...(stored.servedAdcpVersion !== undefined && { servedAdcpVersion: stored.servedAdcpVersion }),
      ...(stored.serverAdcpVersion !== undefined && { serverAdcpVersion: stored.serverAdcpVersion }),
      ...(stored.signingProfile !== undefined && { signingProfile: stored.signingProfile }),
    };
    if (stored.token !== undefined) {
      if (!adapter) {
        throw new TaskPushSettlementConfigurationError(
          'This task push binding carries a protected token; configure the authenticationAdapter used at handoff'
        );
      }
      let resolved: WebhookAuthentication;
      try {
        resolved = await adapter.resolve(
          structuredClone(stored.token.protectedValue),
          bindingTokenContext(bindingKeyFor(ref), stored)
        );
      } catch (cause) {
        // A KMS or secret-manager outage is retryable, as it is for outbox recovery.
        throwSettlementFailure(cause);
      }
      if (resolved?.type !== 'bearer' || typeof resolved.token !== 'string') {
        throw new TaskPushSettlementConfigurationError('Task push binding token resolved to an invalid value');
      }
      route.token = resolved.token;
    }
    validatePush(route);
    return route;
  };

  let bindingColumnReady = false;
  const ensureReady = async (): Promise<void> => {
    if (bindingColumnReady) return;
    try {
      await (pool as PgTransactionalPool).query(`SELECT push_binding FROM ${binding.tableName} WHERE false`);
    } catch (cause) {
      if (pgErrorCode(cause) === PG_UNDEFINED_COLUMN) {
        throw new TaskPushSettlementConfigurationError(
          `The task registry table ${binding.tableName} has no push_binding column. ` +
            `Run getTaskPushBindingMigration({ tableName: '${binding.tableName}' }) before accepting ` +
            'externally settled handoffs with push_notification_config.'
        );
      }
      throwSettlementFailure(cause);
    }
    bindingColumnReady = true;
    bindingColumnSeen = true;
  };

  /**
   * Bind the buyer's validated route to a freshly created push-enabled task,
   * in the task row under its row lock. Immutable once written: only an
   * exact retry of the same route succeeds.
   */
  const bind = async (ref: ScopedTaskRef, push: TaskPushBindingRoute): Promise<void> => {
    const settlementRef = snapshotSettlementRef(ref);
    if (settlementRef.registryId !== registryId) {
      throw new TaskPushSettlementConfigurationError('Task push binding ref belongs to a different registry');
    }
    let route: TaskPushBindingRoute;
    try {
      route = structuredClone(push);
    } catch (cause) {
      throw new TaskPushSettlementConfigurationError('Task push binding must contain serializable JSON', { cause });
    }
    validatePush(route);
    if (route.authentication !== undefined && route.authentication !== null) {
      throw new TaskPushSettlementConfigurationError('Task push bindings do not carry legacy transport authentication');
    }
    if (route.serverAdcpVersion !== undefined && !isValidAdcpVersion(route.serverAdcpVersion)) {
      throw new TaskPushSettlementConfigurationError(
        'Task push binding serverAdcpVersion must be a valid AdCP version'
      );
    }
    const stored: StoredTaskPushBinding = {
      url: route.url,
      ...(route.operationId !== undefined && { operationId: route.operationId }),
      ...(route.servedAdcpVersion !== undefined && { servedAdcpVersion: route.servedAdcpVersion }),
      ...(route.serverAdcpVersion !== undefined && { serverAdcpVersion: route.serverAdcpVersion }),
      ...(route.signingProfile !== undefined && { signingProfile: route.signingProfile }),
    };
    if (route.token !== undefined) {
      if (!adapter) {
        throw new TaskPushSettlementConfigurationError(
          'Binding a push token requires an authenticationAdapter so the token is protected at rest'
        );
      }
      // Protect before taking a connection or a row lock: the adapter may be slow.
      stored.token = await _protectWebhookAuthentication(
        adapter,
        { type: 'bearer', token: route.token },
        bindingTokenContext(bindingKeyFor(settlementRef), stored)
      );
    }
    stored.fingerprint = bindingFingerprint(stored);

    let client: PgTransactionClient | undefined;
    try {
      client = await (pool as PgTransactionalPool).connect();
      await client.query('BEGIN');
      const task = await readTaskRow(client, binding.tableName, binding.namespace, settlementRef, true, true);
      if (!task) throw new TaskPushSettlementConfigurationError('Task push binding target was not found in scope');
      if (task.has_webhook !== true || TERMINAL.has(task.status)) {
        throw new TaskPushSettlementConfigurationError(
          'Task push bindings require a non-terminal task created with hasWebhook: true'
        );
      }
      if (task.push_binding !== null && task.push_binding !== undefined) {
        if (task.push_binding.fingerprint !== stored.fingerprint) {
          throw new TaskPushBindingMismatchError('Task is already bound to a different push route');
        }
        await client.query('COMMIT');
        return;
      }
      const update = await client.query(
        `UPDATE ${binding.tableName} SET push_binding = $5::jsonb
          WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4`,
        [
          settlementRef.taskId,
          binding.namespace,
          settlementRef.accountId,
          settlementRef.ownerScope,
          JSON.stringify(stored),
        ]
      );
      if ((update.rowCount ?? 0) !== 1) throw new Error('Task disappeared while holding its binding lock');
      await client.query('COMMIT');
    } catch (cause) {
      if (client) await rollbackQuietly(client);
      if (pgErrorCode(cause) === PG_UNDEFINED_COLUMN) {
        throw new TaskPushSettlementConfigurationError(
          `The task registry table ${binding.tableName} has no push_binding column; run getTaskPushBindingMigration()`
        );
      }
      throwSettlementFailure(cause);
    } finally {
      client?.release();
    }
  };

  const settleWithRoute = async (
    ref: ScopedTaskRef,
    terminal: TerminalSettlement,
    callerPush: TaskPushSettlementConfig | undefined
  ): Promise<TaskPushSettlementOutcome> => {
    const settlementRef = snapshotSettlementRef(ref);
    if (settlementRef.registryId !== registryId) {
      return { outcome: 'not_found_in_scope', delivery: 'not_applicable' };
    }
    let clonedTerminal: TerminalSettlement;
    let callerRoute: TaskPushSettlementConfig | undefined;
    try {
      clonedTerminal = structuredClone(terminal);
      callerRoute = callerPush === undefined ? undefined : structuredClone(callerPush);
      assertWellFormedUnicode(clonedTerminal, 'Task terminal result/error');
      if (callerRoute !== undefined) assertWellFormedUnicode(callerRoute, 'Task push settlement config');
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
      observed = await readTaskRowWithBinding(transactionalPool, settlementRef, false);
    } catch (cause) {
      throwSettlementFailure(cause);
    }
    if (!observed) return { outcome: 'not_found_in_scope', delivery: 'not_applicable' };

    if (callerRoute !== undefined) validatePush(callerRoute);
    if (observed.has_webhook !== true) {
      throw new TaskPushSettlementConfigurationError(
        'Crash-safe push settlement requires a task created with hasWebhook: true'
      );
    }

    let result: unknown;
    let error: AdcpStructuredError | undefined;
    let reason: string | undefined;
    try {
      result =
        clonedTerminal.status === 'completed'
          ? sanitizeTaskResultForWire(clonedTerminal.result, settlementRef)
          : clonedTerminal.status === 'rejected'
            ? sanitizeTaskResultForWire(clonedTerminal.result, settlementRef)
            : clonedTerminal.result === undefined
              ? { errors: [sanitizeStructuredAdcpError(clonedTerminal.error)] }
              : sanitizeTaskResultForWire(clonedTerminal.result, settlementRef);
      error = clonedTerminal.status === 'failed' ? sanitizeStructuredAdcpError(clonedTerminal.error) : undefined;
      reason = clonedTerminal.status === 'rejected' ? clonedTerminal.reason : undefined;
      if (reason !== undefined && typeof reason !== 'string') {
        throw new TypeError('Task rejection reason must be a string');
      }
      assertWellFormedUnicode({ result, error, reason }, 'Task terminal result/error');
      // Validate the exact canonical domain used later for immutable
      // terminal and outbox fingerprints. JSON.stringify alone would
      // silently coerce NaN/Infinity and exotic objects.
      canonicalJsonSha256({ result, error, reason });
      assertPayloadSize(result, error, reason);
    } catch (cause) {
      if (cause instanceof TaskPushSettlementConfigurationError) throw cause;
      throw new TaskPushSettlementConfigurationError('Task terminal result/error must be serializable JSON', {
        cause,
      });
    }

    if (
      TERMINAL.has(observed.status) &&
      !terminalMatches(observed, clonedTerminal.status, result, error, reason, settlementRef)
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

    // A route the SDK bound at handoff is authoritative, and it lives on the
    // task row itself, so its location is fixed by the registry identity in
    // the ref rather than by any coordinator setting. A bound task always
    // settles to its bound route: a bound settlement delivers there, and a
    // caller-supplied route must match it exactly. If the binding cannot be
    // read or resolved, settlement fails; it never falls back to the caller.
    const observedBinding = observed.push_binding ?? null;
    let clonedPush: TaskPushSettlementConfig;
    let resultAdcpVersion: string | undefined;
    if (observedBinding !== null) {
      const { serverAdcpVersion, ...boundRoute } = await resolveBinding(settlementRef, observedBinding);
      if (callerRoute !== undefined) assertMatchesBinding(callerRoute, boundRoute);
      clonedPush = boundRoute;
      resultAdcpVersion = serverAdcpVersion;
    } else {
      if (callerRoute === undefined) {
        throw new TaskPushSettlementConfigurationError(
          'This task has no SDK push binding. Bound settlement applies only to an externally settled handoff ' +
            'whose request carried push_notification_config. Settle an application-managed push task with ' +
            'completeScopedPushTask() and a polling-only task with completeScopedTask().'
        );
      }
      clonedPush = callerRoute;
    }

    // A bound task's result is in the server's release recorded at handoff.
    // Its webhook carries it in the release the request was served at,
    // converted as the in-process task webhook converts it (DR-0024). The
    // task row keeps the server-release result, which a poll converts on
    // read. When this SDK cannot convert it, no new webhook is checkpointed
    // (here and at the outbox insert below); an exact retry of a settlement
    // that is already checkpointed still succeeds, because the intent
    // fingerprint covers the source result rather than its conversion.
    let webhookResult = result;
    let webhookResultError: unknown;
    if (resultAdcpVersion !== undefined && clonedPush.servedAdcpVersion !== undefined) {
      try {
        webhookResult = projectBoundTaskResultForRelease(
          observed.tool,
          result,
          resultAdcpVersion,
          clonedPush.servedAdcpVersion
        );
      } catch (cause) {
        webhookResultError = cause;
      }
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
    if (webhookResultError !== undefined && !observedOutbox) unconvertibleWebhookResult(webhookResultError);
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
      // An unconverted result is never checkpointed. Leave it out, so the
      // snapshot prepared only to fingerprint a retry is not held to the
      // snapshot size limit by a result that was converted when checkpointed.
      ...(webhookResultError === undefined && { result: webhookResult }),
      ...(clonedPush.token !== undefined && { token: clonedPush.token }),
      ...(clonedTerminal.status === 'failed' && { message: error!.message }),
      ...(clonedTerminal.status === 'rejected' && reason !== undefined && { message: reason }),
    };
    let prepared: PreparedWebhookDeliverySnapshot;
    try {
      prepared = await recovery.prepare(
        deliveryKey,
        {
          url: clonedPush.url,
          ...(clonedPush.signingProfile !== undefined && { signingProfile: clonedPush.signingProfile }),
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
    const intentFingerprint = taskPushIntentFingerprint(prepared.snapshot, settlementRef, result);

    let client: PgTransactionClient | undefined;
    try {
      client = await transactionalPool.connect();
      await client.query('BEGIN');
      const row = await readTaskRowWithBinding(client, settlementRef, true);
      if (!row) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found_in_scope', delivery: 'not_applicable' };
      }
      // The route was chosen from the observed binding. Under the row lock,
      // require that binding to be unchanged, so a binding written in between
      // can never be bypassed by a caller-supplied route.
      if (canonicalJsonSha256(row.push_binding ?? null) !== canonicalJsonSha256(observedBinding)) {
        throw new TaskPushSettlementConfigurationError(
          'Task push binding changed during settlement; retry the settlement'
        );
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
      const compatible = terminalMatches(row, clonedTerminal.status, result, error, reason, settlementRef);
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
        if (webhookResultError !== undefined) unconvertibleWebhookResult(webhookResultError);
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
            : clonedTerminal.status === 'rejected'
              ? await client.query(
                  `UPDATE ${binding.tableName}
                      SET status = 'rejected', result = $5::jsonb, error = NULL,
                          status_message = $6, updated_at = clock_timestamp()
                    WHERE task_id = $1 AND registry_namespace = $2 AND account_id = $3 AND owner_scope = $4`,
                  [
                    settlementRef.taskId,
                    binding.namespace,
                    settlementRef.accountId,
                    settlementRef.ownerScope,
                    JSON.stringify(result),
                    reason ?? null,
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
  };

  const coordinator: PostgresTaskSettlementCoordinator = {
    durability: 'durable',
    recovery,
    async hasTerminalCheckpoint(ref): Promise<boolean> {
      const settlementRef = snapshotSettlementRef(ref);
      if (settlementRef.registryId !== registryId) return false;
      const deliveryKey = {
        ...claimScope,
        deliveryId: stableScope('task-webhook', settlementRef),
      };
      try {
        const task = await readTaskRow(
          pool as PgTransactionalPool,
          binding.tableName,
          binding.namespace,
          settlementRef,
          false
        );
        if (!task || !TERMINAL.has(task.status) || task.has_webhook !== true) return false;
        return Boolean(await readOutbox(pool as PgTransactionalPool, outboxTable, deliveryKey, false));
      } catch (cause) {
        throw new Error('PostgresTaskSettlementCoordinator.hasTerminalCheckpoint: query failed', { cause });
      }
    },
    async settle(ref, terminal, push): Promise<TaskPushSettlementOutcome> {
      return settleWithRoute(ref, terminal, push);
    },
  };
  taskPushBindingSupport.set(coordinator, {
    registryId,
    protectsTokens: adapter !== undefined,
    ensureReady,
    bind,
    settleBound: (ref, terminal) => settleWithRoute(ref, terminal, undefined),
  });
  return coordinator;
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

/** Reject a push-enabled task with a terminal business-decision artifact. */
export async function rejectScopedPushTask(
  coordinator: PostgresTaskSettlementCoordinator,
  ref: ScopedTaskRef,
  push: TaskPushSettlementConfig,
  result: unknown,
  reason?: string
): Promise<TaskPushSettlementOutcome> {
  return coordinator.settle(ref, { status: 'rejected', result, ...(reason !== undefined && { reason }) }, push);
}

function requireTaskPushBindingSupport(coordinator: PostgresTaskSettlementCoordinator): TaskPushBindingSupport {
  const support = _taskPushBindingSupport(coordinator);
  if (!support) {
    throw new TypeError('Bound push settlement requires a coordinator from createPostgresTaskSettlementCoordinator');
  }
  return support;
}

/**
 * Complete an externally settled framework handoff whose request carried
 * `push_notification_config`, delivering the terminal webhook to the route
 * the SDK bound to the task at handoff. The worker supplies only the scoped
 * ref and the result; it cannot choose or change the destination or token.
 *
 * Same outcomes, outbox, signing, retry and idempotency as
 * `completeScopedPushTask()`: the task transition and the terminal webhook
 * checkpoint commit in one transaction, and the webhook recovery worker
 * delivers it. Throws `TaskPushSettlementConfigurationError` when the task
 * has no SDK binding.
 */
export async function completeBoundPushTask<TResult>(
  coordinator: PostgresTaskSettlementCoordinator,
  ref: ScopedTaskRef,
  result: TResult
): Promise<TaskPushSettlementOutcome> {
  return requireTaskPushBindingSupport(coordinator).settleBound(ref, { status: 'completed', result });
}

/** Fail a bound external push task; see {@link completeBoundPushTask}. */
export async function failBoundPushTask(
  coordinator: PostgresTaskSettlementCoordinator,
  ref: ScopedTaskRef,
  error: AdcpStructuredError,
  result?: unknown
): Promise<TaskPushSettlementOutcome> {
  return requireTaskPushBindingSupport(coordinator).settleBound(ref, {
    status: 'failed',
    error,
    ...(result !== undefined && { result }),
  });
}

/** Reject a bound external push task with a business-decision artifact; see {@link completeBoundPushTask}. */
export async function rejectBoundPushTask(
  coordinator: PostgresTaskSettlementCoordinator,
  ref: ScopedTaskRef,
  result: unknown,
  reason?: string
): Promise<TaskPushSettlementOutcome> {
  return requireTaskPushBindingSupport(coordinator).settleBound(ref, {
    status: 'rejected',
    result,
    ...(reason !== undefined && { reason }),
  });
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
  status: 'completed' | 'failed' | 'rejected',
  result: unknown,
  error: AdcpStructuredError | undefined,
  reason: string | undefined,
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
      (status === 'completed' ||
        (status === 'failed' && canonicalJsonSha256(storedError) === canonicalJsonSha256(error)) ||
        (status === 'rejected' && row.status_message === (reason ?? null)))
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

/**
 * `sourceResult`, when given, stands in for the payload's `result`: a bound
 * settlement's webhook result is converted to the served release, and the
 * fingerprint covers the result it was converted from, so an exact retry
 * stays compatible on an SDK that converts it differently. Without a
 * conversion the two are the same value.
 */
function taskPushIntentFingerprint(
  snapshot: StoredWebhookDeliverySnapshot,
  ref: ScopedTaskRef,
  sourceResult?: unknown
): string {
  const { timestamp: _generatedTimestamp, ...storedPayload } = snapshot.payload;
  const payload = structuredClone(storedPayload);
  if (sourceResult !== undefined) {
    payload.result = sanitizeTaskResultForWire(structuredClone(sourceResult), ref);
  } else if (Object.hasOwn(payload, 'result')) {
    payload.result = sanitizeTaskResultForWire(payload.result, ref);
  }
  return taskPushIntentFingerprintForPayload(snapshot, payload);
}

function unconvertibleWebhookResult(cause: unknown): never {
  throw new TaskPushSettlementConfigurationError(
    'Task terminal result cannot be converted to the AdCP release the request was served at. Settle it with an ' +
      'SDK that packages the AdCP release recorded at handoff and every release down to the served one',
    { cause }
  );
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
    // Present only for a non-default profile, so every fingerprint written
    // before signing profiles were carried keeps its value.
    ...(snapshot.signingProfile !== undefined && { signingProfile: snapshot.signingProfile }),
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
  if (
    push.signingProfile !== undefined &&
    push.signingProfile !== 'adcp/webhook-signing/v1' &&
    push.signingProfile !== 'web-bot-auth'
  ) {
    throw new TaskPushSettlementConfigurationError(
      "push settlement signingProfile must be 'adcp/webhook-signing/v1' or 'web-bot-auth'"
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

type TaskPushBindingKey = { publisherScope: string; tenantScope: string; deliveryId: string };

/**
 * Adapter context for a bound push token. Its own `task_push_binding`
 * purpose and key separate it from outbox snapshots. The key depends only on
 * the registry identity and the task ref, never on coordinator settings, so
 * every coordinator for the registry resolves the same binding.
 */
function bindingTokenContext(key: TaskPushBindingKey, stored: StoredTaskPushBinding): WebhookAuthenticationContext {
  const route = {
    url: stored.url,
    ...(stored.operationId !== undefined && { operationId: stored.operationId }),
    ...(stored.servedAdcpVersion !== undefined && { servedAdcpVersion: stored.servedAdcpVersion }),
    ...(stored.serverAdcpVersion !== undefined && { serverAdcpVersion: stored.serverAdcpVersion }),
    ...(stored.signingProfile !== undefined && { signingProfile: stored.signingProfile }),
  };
  return {
    key: { ...key },
    url: stored.url,
    purpose: 'task_push_binding',
    snapshotContextFingerprint: canonicalJsonSha256({ purpose: 'task_push_binding', key, route }),
  };
}

function bindingFingerprint(stored: StoredTaskPushBinding): string {
  return canonicalJsonSha256({
    url: stored.url,
    ...(stored.operationId !== undefined && { operationId: stored.operationId }),
    ...(stored.servedAdcpVersion !== undefined && { servedAdcpVersion: stored.servedAdcpVersion }),
    ...(stored.serverAdcpVersion !== undefined && { serverAdcpVersion: stored.serverAdcpVersion }),
    ...(stored.signingProfile !== undefined && { signingProfile: stored.signingProfile }),
    ...(stored.token !== undefined && { tokenFingerprint: stored.token.fingerprint }),
  });
}

/**
 * A caller-supplied route for a bound task must name exactly the bound
 * destination, operation id, signing profile and token, and add no transport
 * authentication. `servedAdcpVersion` is taken from the binding.
 */
function assertMatchesBinding(caller: TaskPushSettlementConfig, bound: TaskPushSettlementConfig): void {
  const profile = (route: TaskPushSettlementConfig) => route.signingProfile ?? 'adcp/webhook-signing/v1';
  const sameToken =
    caller.token === undefined || bound.token === undefined
      ? caller.token === bound.token
      : Buffer.byteLength(caller.token) === Buffer.byteLength(bound.token) &&
        timingSafeEqual(Buffer.from(caller.token), Buffer.from(bound.token));
  if (
    caller.url !== bound.url ||
    caller.operationId !== bound.operationId ||
    profile(caller) !== profile(bound) ||
    !sameToken ||
    (caller.authentication !== undefined && caller.authentication !== null)
  ) {
    throw new TaskPushBindingMismatchError(
      'The push config does not match the route bound to this task at handoff; settle it with the bound push helpers'
    );
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

function assertPayloadSize(result: unknown, error: unknown, reason: string | undefined): void {
  const bytes = Buffer.byteLength(JSON.stringify({ result, error, reason }), 'utf8');
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
  lock: boolean,
  withBinding = false
): Promise<LockedTaskRow | undefined> {
  const found = await db.query(
    `SELECT tool, status, result, error, status_message, has_webhook${withBinding ? ', push_binding' : ''}
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
