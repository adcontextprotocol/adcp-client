/**
 * One storage decision for reporting (experimental, AdCP 3.3).
 *
 * `memoryStorage()` here, or `postgresStorage({ pool })` from `@adcp/reporting-storage`, returns a
 * {@link ReportingStorage} that holds every reporting store: the reporting ledger, `sync_principal`
 * principal records, the reporting-subscription engine state (grant journal, exceptions, frozen owed
 * periods) and the buyer consumer's checkpoints, leases and processed notifications. Pass it to
 * `createReliableReportingService({ storage })` on the seller, or `createReliableReportingConsumerV1({ storage })`
 * on the buyer.
 *
 * - **Durability is a property of the storage**, never a flag: `memoryStorage()` is `'process-local'`
 *   and `postgresStorage()` is `'durable'`.
 * - **Process-local storage is refused in production** with `REPORTING_STORAGE_NOT_DURABLE`. It is
 *   allowed when `NODE_ENV` is `test` or `development`.
 * - **Migrations are versioned**, applied by `npx adcp-reporting-storage migrate`; durable storage
 *   refuses to start on a schema that is behind (`REPORTING_SCHEMA_BEHIND`).
 *
 * The PostgreSQL storage ships in `@adcp/reporting-storage`, because `@adcp/sdk` never depends on a
 * storage driver.
 *
 * @experimental Reporting storage (AdCP 3.3): breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import type { ReliableReportingConsumerPersistenceV1 } from '../reporting/consumer-runtime';
import type {
  ReportingChangesCheckpointStoreV1,
  ReportingConsumerNotificationStoreV1,
  ReportingConsumerWorkLeaseStoreV1,
  ReportingConsumerWorkLeaseV1,
} from '../reporting/consumer-postgres';
import type { ReportingLedgerStore } from '../reporting/ledger/types';
import type {
  ReportingCheckpointStore,
  ReportingPendingConsumerStatusStore,
  ReportingPersistenceLeaseFenceV1,
} from '../reporting/reconciliation';
import { createReportingSubscriptionEngineStateStoreV1 } from '../reporting/subscriptions/engine-state-store';
import type { ReportingSubscriptionEngineStoreV1 } from '../reporting/subscriptions/engine';
import { PlatformConfigError } from '../server/decisioning/runtime/validate-platform';
import { createPrincipalStateStore } from '../server/principal/store';
import type { PrincipalStateStore } from '../server/principal/types';
import { InMemoryStateStore } from '../server/state-store';
import { createReportingEventStore, type ReportingEventStore } from '../principal/reporting-events';
import { MemoryReportingLedgerStore } from './memory-ledger';

/**
 * Whether a storage survives process loss.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export type ReportingStorageDurability = 'process-local' | 'durable';

/**
 * Every reporting store, chosen together. Built by `memoryStorage()` or `postgresStorage({ pool })`
 * (`@adcp/reporting-storage`); a custom backend implements the same shape.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export interface ReportingStorage {
  /** `'durable'` only when every store survives a restart. */
  readonly durability: ReportingStorageDurability;
  /** The reporting ledger (`createReliableReportingService`'s `store`). */
  readonly ledger: ReportingLedgerStore;
  /** `sync_principal` principal records (`createPrincipalLifecycle`'s `store`). */
  readonly principals: PrincipalStateStore;
  /** Reporting-subscription engine state: the grant journal, exceptions and frozen owed periods. */
  readonly subscriptions: ReportingSubscriptionEngineStoreV1;
  /** The buyer consumer's checkpoints, pending statuses, change cursors, leases and processed notifications. */
  readonly consumer: ReliableReportingConsumerPersistenceV1;
  /**
   * The buyer's acknowledged reporting-event snapshots (`client.reporting.poll()`); pass it as the
   * client's `reportingEventStore`. Optional so custom storage objects keep compiling.
   */
  readonly events?: ReportingEventStore;
  /**
   * Refuses a schema that is behind this release with `REPORTING_SCHEMA_BEHIND`, naming the migrate
   * command and the pending versions. Never changes the schema. The reporting service runs it before
   * its first cycle; call it at boot to fail before serving requests.
   */
  checkSchema(): Promise<void>;
  /** Releases what the storage opened. A borrowed pool stays open. */
  close(): Promise<void>;
}

/**
 * `NODE_ENV` values under which process-local storage is allowed.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export const DEVELOPMENT_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'test']);

/**
 * Whether process-local storage is allowed: `NODE_ENV` is `test` or `development`.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export function developmentEnvironment(): boolean {
  return DEVELOPMENT_ENVIRONMENTS.has(process.env.NODE_ENV ?? '');
}

/**
 * Refuse process-local reporting storage outside development, with `REPORTING_STORAGE_NOT_DURABLE`.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export function requireDurable(durable: boolean, options: { stores: string; configField?: string }): void {
  if (durable || developmentEnvironment()) return;
  throw new PlatformConfigError(
    `Reporting keeps obligations, grants and frozen coverage in ${options.stores}, which does not survive a restart. ` +
      'Pass storage: postgresStorage({ pool }) (@adcp/reporting-storage), or set NODE_ENV=development to run in memory.',
    { code: 'REPORTING_STORAGE_NOT_DURABLE', configField: options.configField ?? 'storage' }
  );
}

/**
 * Whether `value` has the {@link ReportingStorage} shape.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export function isReportingStorage(value: unknown): value is ReportingStorage {
  if (!value || typeof value !== 'object') return false;
  const storage = value as Partial<ReportingStorage>;
  return (
    (storage.durability === 'durable' || storage.durability === 'process-local') &&
    typeof storage.ledger === 'object' &&
    storage.ledger !== null &&
    typeof storage.principals === 'object' &&
    storage.principals !== null &&
    typeof storage.subscriptions === 'object' &&
    storage.subscriptions !== null &&
    typeof storage.consumer === 'object' &&
    storage.consumer !== null &&
    typeof storage.checkSchema === 'function' &&
    typeof storage.close === 'function'
  );
}

/**
 * Options for {@link memoryStorage}.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export interface MemoryStorageOptions {
  /** Clock for the ledger and lease expiry. Defaults to the system clock. */
  now?: () => Date;
}

/**
 * Process-local storage for tests and development: every reporting store in process memory, lost on
 * restart. Refused outside `NODE_ENV=test|development` with `REPORTING_STORAGE_NOT_DURABLE`.
 *
 * @experimental Reporting storage (AdCP 3.3).
 */
export function memoryStorage(options: MemoryStorageOptions = {}): ReportingStorage {
  const now = options.now ?? (() => new Date());
  const state = new InMemoryStateStore();
  return Object.freeze({
    durability: 'process-local' as const,
    ledger: new MemoryReportingLedgerStore(now),
    principals: createPrincipalStateStore({ store: state }),
    subscriptions: createReportingSubscriptionEngineStateStoreV1({ store: state }),
    consumer: createMemoryConsumerPersistence(now),
    events: createReportingEventStore({ store: state }),
    async checkSchema() {},
    async close() {},
  });
}

class MemoryConsumerConflictError extends Error {
  override name = 'ReportingConsumerPersistenceConflictError';
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** In-memory {@link ReliableReportingConsumerPersistenceV1} with the PostgreSQL runtime's fencing rules. */
function createMemoryConsumerPersistence(now: () => Date): ReliableReportingConsumerPersistenceV1 {
  const checkpoints = new Map<string, { sha: string; value: unknown }>();
  const pending = new Map<string, unknown>();
  const cursors = new Map<string, { checkpoint: string; generation: number }>();
  const leases = new Map<string, { ownerToken: string; generation: number; expiresAt: number }>();
  const processed = new Map<string, { payloadSha256: string; processedAt: number }>();
  const scopeOf = (key: { consumerScope: string; accountId: string }) => digest([key.consumerScope, key.accountId]);

  function leaseCurrent(scope: string, lease: ReportingPersistenceLeaseFenceV1 | undefined): boolean {
    if (!lease) return true;
    const current = leases.get(scope);
    return (
      lease.scopeKey === scope &&
      current !== undefined &&
      current.ownerToken === lease.ownerToken &&
      current.generation === lease.generation &&
      current.expiresAt > now().getTime()
    );
  }

  function putImmutable(key: string, value: unknown, conflict: string): void {
    const sha = digest(value);
    const existing = checkpoints.get(key);
    if (existing && existing.sha !== sha) throw new MemoryConsumerConflictError(conflict);
    if (!existing) checkpoints.set(key, { sha, value: structuredClone(value) });
  }

  const checkpointStore: ReportingCheckpointStore = {
    async get(key) {
      return structuredClone(checkpoints.get(digest(['receipt', key]))?.value) as never;
    },
    async put(key, checkpoint) {
      putImmutable(
        digest(['receipt', key]),
        checkpoint,
        'A different receipt checkpoint already owns this immutable reporting revision and destination'
      );
    },
    async getAdjustment(key) {
      return structuredClone(checkpoints.get(digest(['adjustment', key]))?.value) as never;
    },
    async putAdjustment(key, checkpoint) {
      putImmutable(
        digest(['adjustment', key]),
        checkpoint,
        'A different adjustment checkpoint already owns this immutable reporting correction'
      );
    },
  };

  const pendingConsumerStatusStore: ReportingPendingConsumerStatusStore = {
    async get(key) {
      return structuredClone(pending.get(digest(key))) as never;
    },
    async put(key, value, lease) {
      if (!leaseCurrent(scopeOf(key), lease)) {
        throw new MemoryConsumerConflictError('The pending consumer status lease is no longer current');
      }
      pending.set(digest(key), structuredClone(value));
    },
    async clear(key, expected, lease) {
      if (!leaseCurrent(scopeOf(key), lease)) return;
      const current = pending.get(digest(key));
      if (expected !== undefined && digest(current) !== digest(expected)) return;
      pending.delete(digest(key));
    },
  };

  const changesCheckpointStore: ReportingChangesCheckpointStoreV1 = {
    async get(key) {
      const row = cursors.get(scopeOf(key));
      return row ? { ...row } : undefined;
    },
    async compareAndSet(key, expected, checkpoint, lease) {
      const scope = scopeOf(key);
      if (!leaseCurrent(scope, lease)) return 'conflict';
      const row = cursors.get(scope);
      if (expected === null) {
        if (row) return 'conflict';
        cursors.set(scope, { checkpoint, generation: 1 });
        return 'applied';
      }
      if (!row || row.checkpoint !== expected) return 'conflict';
      if (expected === checkpoint) return 'unchanged';
      cursors.set(scope, { checkpoint, generation: row.generation + 1 });
      return 'applied';
    },
    async clear(key, expected, lease) {
      const scope = scopeOf(key);
      const row = cursors.get(scope);
      if (!row || !leaseCurrent(scope, lease) || (expected !== undefined && row.checkpoint !== expected)) return false;
      cursors.delete(scope);
      return true;
    },
  };

  const workLeases: ReportingConsumerWorkLeaseStoreV1 = {
    async claim({ key, ownerToken, leaseMilliseconds }) {
      const scope = scopeOf(key);
      const at = now().getTime();
      const current = leases.get(scope);
      if (current && current.expiresAt > at) return null;
      const lease = { ownerToken, generation: (current?.generation ?? 0) + 1, expiresAt: at + leaseMilliseconds };
      leases.set(scope, lease);
      return {
        scopeKey: scope,
        ownerToken,
        generation: lease.generation,
        expiresAt: new Date(lease.expiresAt).toISOString(),
      };
    },
    async renew(lease: ReportingConsumerWorkLeaseV1, leaseMilliseconds) {
      if (!leaseCurrent(lease.scopeKey, lease)) return null;
      const expiresAt = now().getTime() + leaseMilliseconds;
      leases.set(lease.scopeKey, { ownerToken: lease.ownerToken, generation: lease.generation, expiresAt });
      return { ...lease, expiresAt: new Date(expiresAt).toISOString() };
    },
    async release(lease) {
      if (!leaseCurrent(lease.scopeKey, lease)) return false;
      leases.set(lease.scopeKey, { ownerToken: lease.ownerToken, generation: lease.generation, expiresAt: 0 });
      return true;
    },
  };

  const notifications: ReportingConsumerNotificationStoreV1 = {
    async isProcessed(input) {
      const existing = processed.get(digest([input.consumerScope, input.accountId, input.idempotencyKey]));
      if (existing && existing.payloadSha256 !== input.payloadSha256) {
        throw new MemoryConsumerConflictError('Reporting notification idempotency identity names different content');
      }
      return existing !== undefined;
    },
    async markProcessed(input) {
      const key = digest([input.consumerScope, input.accountId, input.idempotencyKey]);
      const existing = processed.get(key);
      if (existing && existing.payloadSha256 !== input.payloadSha256) {
        throw new MemoryConsumerConflictError('Reporting notification idempotency identity names different content');
      }
      if (!existing) processed.set(key, { payloadSha256: input.payloadSha256, processedAt: now().getTime() });
    },
    async pruneProcessed(options = {}) {
      const cutoff = now().getTime() - (options.retentionDays ?? 90) * 86_400_000;
      let pruned = 0;
      for (const [key, value] of processed) {
        if (pruned >= (options.limit ?? 1_000)) break;
        if (value.processedAt < cutoff) {
          processed.delete(key);
          pruned += 1;
        }
      }
      return pruned;
    },
  };

  return { checkpointStore, pendingConsumerStatusStore, changesCheckpointStore, workLeases, notifications };
}

// The buyer's reporting-event snapshot store, for consumers that build their own storage object.
export { InMemoryReportingEventStore, createReportingEventStore } from '../principal/reporting-events';
export type { ReportingEventStore } from '../principal/reporting-events';
