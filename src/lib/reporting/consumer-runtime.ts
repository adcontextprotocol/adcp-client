import type { GetReportingStatusRequest } from '../types';
import type {
  ReportingDeliveryReadyWebhook,
  ReportingLedgerChangedWebhook,
  ReportingStatusChangedWebhook,
} from '../types/core.generated';
import type {
  ReportingChangesCheckpointStoreV1,
  ReportingConsumerNotificationStoreV1,
  ReportingConsumerWorkLeaseStoreV1,
  ReportingConsumerWorkLeaseV1,
} from './consumer-postgres';
import { canonicalJsonSha256 } from '../utils/jcs';
import {
  ReportingReconciliationError,
  reconcileReporting,
  type ReconcileReportingOptions,
  type ReportingLedgerLimits,
  type ReportingPendingConsumerStatusStore,
  type ReportingCheckpointStore,
  type ReportingReconciliationClient,
  type ReportingReconciliationResult,
} from './reconciliation';

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_MAX_CONCURRENCY = 4;

type ReportingNotificationV1 =
  | ReportingDeliveryReadyWebhook
  | ReportingLedgerChangedWebhook
  | ReportingStatusChangedWebhook;

type DurableOptionKeys =
  | 'checkpointStore'
  | 'checkpointScope'
  | 'pendingConsumerStatusStore'
  | 'pendingConsumerStatusScope';

export interface ReliableReportingConsumerAccountV1<TCredential = unknown> {
  /** Stable, non-secret seller + authenticated-principal identity. */
  consumerScope: string;
  /** Must match `reconciliation.request.account.account_id`. */
  accountId: string;
  /** Full-snapshot reconciliation inputs. Durable stores are injected by this runtime. */
  reconciliation: Omit<ReconcileReportingOptions<TCredential>, DurableOptionKeys>;
}

export interface ReliableReportingConsumerPersistenceV1 {
  checkpointStore: ReportingCheckpointStore;
  pendingConsumerStatusStore: ReportingPendingConsumerStatusStore;
  changesCheckpointStore: ReportingChangesCheckpointStoreV1;
  workLeases: ReportingConsumerWorkLeaseStoreV1;
  /** Enables durable at-least-once notification deduplication across restarts. */
  notifications?: ReportingConsumerNotificationStoreV1;
}

export interface CreateReliableReportingConsumerOptionsV1<TCredential = unknown> {
  accounts: readonly ReliableReportingConsumerAccountV1<TCredential>[];
  persistence: ReliableReportingConsumerPersistenceV1;
  /** Unique per running process. It is coordination metadata, not a credential. */
  ownerToken: string;
  pollIntervalMs?: number;
  leaseMilliseconds?: number;
  maxConcurrentAccounts?: number;
  runOnStart?: boolean;
  onResult?: (result: ReliableReportingConsumerRunResultV1) => void | Promise<void>;
  onError?: (error: unknown, accountId: string) => void | Promise<void>;
}

export type ReliableReportingConsumerRunReasonV1 =
  | 'startup'
  | 'poll'
  | 'manual'
  | ReportingNotificationV1['notification_type'];

export type ReliableReportingConsumerRunResultV1 =
  | { accountId: string; reason: ReliableReportingConsumerRunReasonV1; state: 'busy' | 'stopping' | 'duplicate' }
  | {
      accountId: string;
      reason: ReliableReportingConsumerRunReasonV1;
      state: 'unchanged';
      changesCheckpoint: string;
    }
  | {
      accountId: string;
      reason: ReliableReportingConsumerRunReasonV1;
      state: 'reconciled';
      /** Present when the seller supports opaque incremental change checkpoints. */
      changesCheckpoint?: string;
      cursorRecovered: boolean;
      reconciliation: ReportingReconciliationResult;
    }
  | { accountId: string; reason: ReliableReportingConsumerRunReasonV1; state: 'lease_lost' };

export interface ReliableReportingConsumerV1<TCredential = unknown> {
  start(): void;
  stop(): Promise<void>;
  /** Atomically replace the configured account roster without restarting the worker. */
  replaceAccounts(accounts: readonly ReliableReportingConsumerAccountV1<TCredential>[]): void;
  runAccount(
    accountId: string,
    reason?: ReliableReportingConsumerRunReasonV1,
    /** Required when the same account ID is configured under multiple authenticated sellers/principals. */
    consumerScope?: string
  ): Promise<ReliableReportingConsumerRunResultV1>;
  /** Call only after authenticating and verifying the webhook signature. */
  handleAuthenticatedNotification(
    payload: unknown,
    authentication: { consumerScope: string }
  ): Promise<ReliableReportingConsumerRunResultV1 | null>;
}

export interface DrainReportingChangesOptionsV1 {
  client: ReportingReconciliationClient;
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination' | 'changes_after'>;
  changesAfter: string;
  limits?: ReportingLedgerLimits;
  /** Resolved durable account partition, required for natural-key account requests. */
  expectedAccountId?: string;
}

export interface DrainReportingChangesResultV1 {
  changed: boolean;
  recordCount: number;
  ledgerSnapshotId: string;
  ledgerAsOf: string;
  changesCheckpoint: string;
}

/**
 * Consume every page after one opaque checkpoint without treating a doorbell
 * payload as evidence. The returned checkpoint is safe to persist only because
 * this function refuses partial, looping, or snapshot-changing walks.
 */
export async function drainReportingChangesV1(
  options: DrainReportingChangesOptionsV1
): Promise<DrainReportingChangesResultV1> {
  return drainReportingChanges(options, false);
}

async function drainReportingChanges(
  options: DrainReportingChangesOptionsV1,
  stopAfterChangeDetected: boolean
): Promise<DrainReportingChangesResultV1> {
  boundedString(options.changesAfter, 'changesAfter', 16 * 1024);
  const maxPages = options.limits?.maxPages ?? 1_000;
  const maxRecords = options.limits?.maxRecords ?? 100_000;
  const maxLoadMs = options.limits?.maxLoadMs ?? 60_000;
  boundedInteger(maxPages, 'maxPages', 1, 10_000);
  boundedInteger(maxRecords, 'maxRecords', 1, 1_000_000);
  boundedInteger(maxLoadMs, 'maxLoadMs', 1, 3_600_000);
  const requestedAccountId = options.expectedAccountId ?? accountIdFromRequest(options.request);
  if (requestedAccountId !== undefined) boundedString(requestedAccountId, 'expectedAccountId', 512);
  const deadline = Date.now() + maxLoadMs;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let page = 0;
  let snapshotId: string | undefined;
  let ledgerAsOf: string | undefined;
  let changesCheckpoint: string | undefined;
  let totalCount: number | undefined;
  let totalCountPresence: boolean | undefined;
  let observedRecords = 0;

  do {
    page += 1;
    if (page > maxPages) throw consumerError('CHANGE_LIMIT_EXCEEDED', 'reporting change walk exceeded page limit');
    const response = await callWithDeadline(
      signal =>
        options.client.getReportingStatus(
          {
            ...options.request,
            view: 'periods',
            changes_after: options.changesAfter,
            ...(cursor ? { pagination: { cursor } } : {}),
          },
          { signal }
        ),
      deadline
    );
    if (
      response.status !== 'completed' ||
      response.view !== 'periods' ||
      !response.ledger_snapshot_id ||
      !response.ledger_as_of ||
      !response.account_id ||
      (requestedAccountId !== undefined && response.account_id !== requestedAccountId)
    ) {
      throw consumerError('INCOMPLETE_CHANGE_PAGE', 'get_reporting_status returned an incomplete change page');
    }
    const pagination = response.pagination ?? { has_more: false };
    const count = pagination.total_count;
    const pageHasTotalCount = count !== undefined;
    if (
      count !== undefined &&
      (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > maxRecords)
    ) {
      throw consumerError('INCOMPLETE_CHANGE_PAGE', 'reporting change walk returned an invalid total_count');
    }
    if (totalCountPresence !== undefined && totalCountPresence !== pageHasTotalCount) {
      throw consumerError('CHANGE_SNAPSHOT_CHANGED', 'reporting change total_count presence changed during pagination');
    }
    if (
      (snapshotId && snapshotId !== response.ledger_snapshot_id) ||
      (ledgerAsOf && ledgerAsOf !== response.ledger_as_of) ||
      (changesCheckpoint && changesCheckpoint !== response.changes_checkpoint) ||
      (totalCount !== undefined && count !== undefined && totalCount !== count)
    ) {
      throw consumerError('CHANGE_SNAPSHOT_CHANGED', 'reporting change snapshot changed during pagination');
    }
    snapshotId = response.ledger_snapshot_id;
    ledgerAsOf = response.ledger_as_of;
    if (response.changes_checkpoint !== undefined) changesCheckpoint = response.changes_checkpoint;
    if (count !== undefined) totalCount = count;
    totalCountPresence = pageHasTotalCount;
    observedRecords += changePageRecordCount(response as unknown as Record<string, unknown>);
    if (observedRecords > maxRecords) {
      throw consumerError('CHANGE_LIMIT_EXCEEDED', 'reporting change walk exceeded record limit');
    }
    if (stopAfterChangeDetected && changesCheckpoint && ((totalCount ?? 0) > 0 || observedRecords > 0)) {
      return {
        changed: true,
        recordCount: Math.max(totalCount ?? 0, observedRecords),
        ledgerSnapshotId: snapshotId,
        ledgerAsOf,
        changesCheckpoint,
      };
    }
    if (pagination.has_more) {
      const next = pagination.cursor;
      if (!next || cursors.has(next)) {
        throw consumerError('CHANGE_CURSOR_LOOP', 'reporting change pagination did not advance');
      }
      boundedString(next, 'reporting change cursor', 16 * 1024);
      cursors.add(next);
      cursor = next;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  if (!changesCheckpoint) {
    throw consumerError('INCOMPLETE_CHANGE_PAGE', 'reporting change walk did not return a final changes checkpoint');
  }

  return {
    changed: (totalCount ?? 0) > 0 || observedRecords > 0,
    recordCount: Math.max(totalCount ?? 0, observedRecords),
    ledgerSnapshotId: snapshotId!,
    ledgerAsOf: ledgerAsOf!,
    changesCheckpoint: changesCheckpoint!,
  };
}

function changePageRecordCount(response: Record<string, unknown>): number {
  return [
    'periods',
    'revisions',
    'materializations',
    'receipts',
    'consumer_statuses',
    'adjustments',
    'adjustment_receipts',
  ].reduce((count, field) => count + (Array.isArray(response[field]) ? response[field].length : 0), 0);
}

export function createReliableReportingConsumerV1<TCredential = unknown>(
  options: CreateReliableReportingConsumerOptionsV1<TCredential>
): ReliableReportingConsumerV1<TCredential> {
  if (!options.persistence) throw new TypeError('reliable reporting consumer persistence is required');
  boundedString(options.ownerToken, 'ownerToken', 255);
  if (options.ownerToken.length < 8) throw new TypeError('ownerToken must contain at least 8 characters');
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MS;
  const maxConcurrentAccounts = options.maxConcurrentAccounts ?? DEFAULT_MAX_CONCURRENCY;
  boundedInteger(pollIntervalMs, 'pollIntervalMs', 1_000, 86_400_000);
  boundedInteger(leaseMilliseconds, 'leaseMilliseconds', 1_000, 300_000);
  boundedInteger(maxConcurrentAccounts, 'maxConcurrentAccounts', 1, 256);

  const accounts = new Map<string, ReliableReportingConsumerAccountV1<TCredential>>();
  const accountsById = new Map<string, ReliableReportingConsumerAccountV1<TCredential>[]>();
  const replaceAccounts = (configured: readonly ReliableReportingConsumerAccountV1<TCredential>[]): void => {
    if (!Array.isArray(configured)) throw new TypeError('reporting consumer accounts must be an array');
    const nextAccounts = new Map<string, ReliableReportingConsumerAccountV1<TCredential>>();
    const nextById = new Map<string, ReliableReportingConsumerAccountV1<TCredential>[]>();
    for (const account of configured) {
      boundedString(account.consumerScope, 'consumerScope', 4_096);
      boundedString(account.accountId, 'accountId', 512);
      const inlineAccountId = accountIdFromRequest(account.reconciliation.request);
      if (inlineAccountId !== undefined && inlineAccountId !== account.accountId) {
        throw new TypeError(`reporting consumer account ${account.accountId} does not match its request account`);
      }
      const key = runtimeAccountKey(account.consumerScope, account.accountId);
      if (nextAccounts.has(key)) throw new TypeError(`duplicate reporting consumer account ${account.accountId}`);
      nextAccounts.set(key, account);
      const sameId = nextById.get(account.accountId) ?? [];
      sameId.push(account);
      nextById.set(account.accountId, sameId);
    }
    accounts.clear();
    accountsById.clear();
    for (const [key, account] of nextAccounts) accounts.set(key, account);
    for (const [accountId, candidates] of nextById) accountsById.set(accountId, candidates);
  };
  replaceAccounts(options.accounts);

  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tickPromise: Promise<void> | undefined;
  const active = new Map<string, Promise<ReliableReportingConsumerRunResultV1>>();

  const invokeHook = async (result: ReliableReportingConsumerRunResultV1): Promise<void> => {
    try {
      await options.onResult?.(result);
    } catch (error) {
      await reportError(error, result.accountId);
    }
  };

  const reportError = async (error: unknown, accountId: string): Promise<void> => {
    try {
      await options.onError?.(error, accountId);
    } catch {
      // Observability must not turn a completed or failed reconciliation into
      // an unhandled rejection in the scheduler.
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      tickPromise = runAll('poll').finally(() => {
        tickPromise = undefined;
        schedule();
      });
    }, pollIntervalMs);
    timer.unref?.();
  };

  const runAll = async (reason: 'startup' | 'poll'): Promise<void> => {
    const queue = [...accounts.values()];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrentAccounts, queue.length) }, async () => {
        while (!stopped) {
          const index = next++;
          if (index >= queue.length) return;
          const queued = queue[index]!;
          if (accounts.get(runtimeAccountKey(queued.consumerScope, queued.accountId)) !== queued) continue;
          try {
            await runSelectedAccount(queued, reason);
          } catch (error) {
            await reportError(error, queued.accountId);
          }
        }
      })
    );
  };

  const execute = async (
    account: ReliableReportingConsumerAccountV1<TCredential>,
    reason: ReliableReportingConsumerRunReasonV1
  ): Promise<ReliableReportingConsumerRunResultV1> => {
    const key = { consumerScope: account.consumerScope, accountId: account.accountId };
    const claimedLease = await options.persistence.workLeases.claim({
      key,
      ownerToken: options.ownerToken,
      leaseMilliseconds,
    });
    if (!claimedLease) return { accountId: account.accountId, reason, state: 'busy' };
    let lease: ReportingConsumerWorkLeaseV1 = claimedLease;

    const leaseAbort = new AbortController();
    let leaseLost = false;
    let renewing = false;
    let leaseFinished = false;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const markLeaseLost = (reason: unknown): void => {
      if (leaseLost) return;
      leaseLost = true;
      leaseAbort.abort(reason);
    };
    const armLeaseExpiry = (): void => {
      if (leaseFinished) return;
      if (expiryTimer) clearTimeout(expiryTimer);
      const expiresAt = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAt)) {
        markLeaseLost(consumerError('WORK_LEASE_LOST', 'reporting consumer work lease expiry is invalid'));
        return;
      }
      expiryTimer = setTimeout(
        () => {
          if (Date.now() >= expiresAt) {
            markLeaseLost(consumerError('WORK_LEASE_LOST', 'reporting consumer work lease expired'));
          } else {
            armLeaseExpiry();
          }
        },
        Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647)
      );
      expiryTimer.unref?.();
    };
    const assertLeaseCurrent = (): void => {
      if (leaseLost || Date.now() >= Date.parse(lease.expiresAt)) {
        markLeaseLost(consumerError('WORK_LEASE_LOST', 'reporting consumer work lease expired'));
        throw consumerError('WORK_LEASE_LOST', 'reporting consumer work lease was lost');
      }
    };
    armLeaseExpiry();
    const renewal = setInterval(
      async () => {
        if (renewing || leaseLost) return;
        renewing = true;
        try {
          const renewed = await options.persistence.workLeases.renew(lease!, leaseMilliseconds);
          if (leaseFinished) return;
          if (!renewed) {
            markLeaseLost(consumerError('WORK_LEASE_LOST', 'reporting consumer work lease was lost'));
          } else {
            lease = renewed;
            armLeaseExpiry();
          }
        } catch (error) {
          markLeaseLost(error);
        } finally {
          renewing = false;
        }
      },
      Math.max(250, Math.floor(leaseMilliseconds / 3))
    );
    renewal.unref?.();

    try {
      const previous = await options.persistence.changesCheckpointStore.get(key);
      const incremental = reason === 'reporting.delivery_ready' || reason === 'reporting.ledger_changed';
      let cursorRecovered = false;
      if (incremental && previous) {
        try {
          const delta = await drainReportingChanges(
            {
              client: abortableClient(account.reconciliation.client, leaseAbort.signal, account.accountId),
              request: withoutChangesAfter(account.reconciliation.request),
              changesAfter: previous.checkpoint,
              limits: account.reconciliation.ledgerLimits,
              expectedAccountId: account.accountId,
            },
            true
          );
          if (!delta.changed) {
            if (leaseLost) return { accountId: account.accountId, reason, state: 'lease_lost' };
            await advanceCheckpoint(
              options.persistence.changesCheckpointStore,
              key,
              previous.checkpoint,
              delta.changesCheckpoint,
              lease,
              assertLeaseCurrent
            );
            const unchanged: ReliableReportingConsumerRunResultV1 = {
              accountId: account.accountId,
              reason,
              state: 'unchanged',
              changesCheckpoint: delta.changesCheckpoint,
            };
            await invokeHook(unchanged);
            return unchanged;
          }
        } catch (error) {
          if (leaseLost) return { accountId: account.accountId, reason, state: 'lease_lost' };
          cursorRecovered = true;
          await reportError(error, account.accountId);
        }
      }

      const reconciliation = await reconcileReporting({
        ...account.reconciliation,
        client: abortableClient(account.reconciliation.client, leaseAbort.signal, account.accountId),
        request: withoutChangesAfter(account.reconciliation.request),
        checkpointStore: leaseGuardedCheckpointStore(options.persistence.checkpointStore, assertLeaseCurrent),
        checkpointScope: account.consumerScope,
        pendingConsumerStatusStore: leaseGuardedPendingStatusStore(
          options.persistence.pendingConsumerStatusStore,
          lease,
          assertLeaseCurrent
        ),
        pendingConsumerStatusScope: account.consumerScope,
      } as ReconcileReportingOptions<TCredential>);
      if (leaseLost) return { accountId: account.accountId, reason, state: 'lease_lost' };
      if (reconciliation.ledger.accountId !== account.accountId) {
        throw consumerError(
          'ACCOUNT_SCOPE_MISMATCH',
          'reporting reconciliation returned a different resolved account than the configured durable partition'
        );
      }
      const checkpoint = reconciliation.ledger.changesCheckpoint;
      let checkpointAdvanced = false;
      if (checkpoint) {
        try {
          await advanceCheckpoint(
            options.persistence.changesCheckpointStore,
            key,
            previous?.checkpoint ?? null,
            checkpoint,
            lease,
            assertLeaseCurrent
          );
          checkpointAdvanced = true;
        } catch (error) {
          await reportError(error, account.accountId);
        }
      } else if (previous && options.persistence.changesCheckpointStore.clear) {
        try {
          assertLeaseCurrent();
          await options.persistence.changesCheckpointStore.clear(key, previous.checkpoint, lease);
        } catch (error) {
          await reportError(error, account.accountId);
        }
      }
      const completed: ReliableReportingConsumerRunResultV1 = {
        accountId: account.accountId,
        reason,
        state: 'reconciled',
        ...(checkpoint && checkpointAdvanced ? { changesCheckpoint: checkpoint } : {}),
        cursorRecovered,
        reconciliation,
      };
      await invokeHook(completed);
      return completed;
    } catch (error) {
      if (leaseLost || leaseAbort.signal.aborted) {
        return { accountId: account.accountId, reason, state: 'lease_lost' };
      }
      throw error;
    } finally {
      leaseFinished = true;
      clearInterval(renewal);
      if (expiryTimer) clearTimeout(expiryTimer);
      await options.persistence.workLeases.release(lease).catch(error => reportError(error, account.accountId));
    }
  };

  const runSelectedAccount = (
    account: ReliableReportingConsumerAccountV1<TCredential>,
    reason: ReliableReportingConsumerRunReasonV1
  ): Promise<ReliableReportingConsumerRunResultV1> => {
    const key = runtimeAccountKey(account.consumerScope, account.accountId);
    if (stopped) return Promise.resolve({ accountId: account.accountId, reason, state: 'stopping' });
    const existing = active.get(key);
    if (existing) return existing;
    const work = execute(account, reason).finally(() => active.delete(key));
    active.set(key, work);
    return work;
  };

  const runAccount = (
    accountId: string,
    reason: ReliableReportingConsumerRunReasonV1 = 'manual',
    consumerScope?: string
  ): Promise<ReliableReportingConsumerRunResultV1> => {
    const candidates = accountsById.get(accountId) ?? [];
    const account = consumerScope
      ? candidates.find(candidate => candidate.consumerScope === consumerScope)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (candidates.length > 1 && consumerScope === undefined) {
      return Promise.reject(
        new TypeError(`reporting consumer account ${accountId} is ambiguous; consumerScope is required`)
      );
    }
    if (candidates.length > 0 && consumerScope !== undefined && !account) {
      return Promise.reject(
        new TypeError(`reporting consumer account ${accountId} is not configured for consumerScope ${consumerScope}`)
      );
    }
    if (!account) return Promise.reject(new TypeError(`unknown reporting consumer account ${accountId}`));
    return runSelectedAccount(account, reason);
  };

  return {
    start() {
      if (started || stopped) return;
      started = true;
      if (options.runOnStart !== false) {
        tickPromise = runAll('startup').finally(() => {
          tickPromise = undefined;
          schedule();
        });
      } else {
        schedule();
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      await tickPromise;
      await Promise.allSettled([...active.values()]);
    },
    replaceAccounts(configured) {
      if (stopped) throw new Error('Reliable reporting consumer is stopped');
      replaceAccounts(configured);
    },
    runAccount,
    async handleAuthenticatedNotification(payload, authentication) {
      const notification = reportingNotification(payload);
      if (!notification) return null;
      if (!authentication) {
        throw new TypeError('consumerScope is required for a reporting notification');
      }
      const candidates = accountsById.get(notification.account_id) ?? [];
      const account = candidates.find(candidate => candidate.consumerScope === authentication.consumerScope);
      if (!account) {
        await reportError(
          consumerError(
            'NOTIFICATION_SCOPE_UNRECOGNIZED',
            'authenticated reporting notification does not match the current account roster'
          ),
          notification.account_id
        );
        return null;
      }
      const payloadSha256 = canonicalJsonSha256(payload);
      const notificationIdentity = {
        consumerScope: account.consumerScope,
        accountId: account.accountId,
        idempotencyKey: notification.idempotency_key,
        payloadSha256,
      };
      if (await options.persistence.notifications?.isProcessed(notificationIdentity)) {
        return { accountId: account.accountId, reason: notification.notification_type, state: 'duplicate' };
      }
      const accountKey = runtimeAccountKey(account.consumerScope, account.accountId);
      const existing = active.get(accountKey);
      if (existing) {
        try {
          await existing;
        } catch (error) {
          await reportError(error, account.accountId);
        }
        // A concurrent delivery of this same logical notification may have
        // completed while we waited. Different notifications always receive a
        // follow-up read after the older in-flight snapshot settles.
        if (await options.persistence.notifications?.isProcessed(notificationIdentity)) {
          return { accountId: account.accountId, reason: notification.notification_type, state: 'duplicate' };
        }
      }
      if (accounts.get(runtimeAccountKey(account.consumerScope, account.accountId)) !== account) return null;
      const result = await runSelectedAccount(account, notification.notification_type);
      if (result.state === 'reconciled' || result.state === 'unchanged') {
        await options.persistence.notifications?.markProcessed(notificationIdentity);
      }
      return result;
    },
  };
}

function leaseGuardedCheckpointStore(
  store: ReportingCheckpointStore,
  assertLeaseCurrent: () => void
): ReportingCheckpointStore {
  return {
    get: key => store.get(key),
    async put(key, checkpoint) {
      assertLeaseCurrent();
      await store.put(key, checkpoint);
    },
    ...(store.getAdjustment ? { getAdjustment: key => store.getAdjustment!(key) } : {}),
    ...(store.putAdjustment
      ? {
          async putAdjustment(
            key: Parameters<NonNullable<ReportingCheckpointStore['putAdjustment']>>[0],
            checkpoint: Parameters<NonNullable<ReportingCheckpointStore['putAdjustment']>>[1]
          ) {
            assertLeaseCurrent();
            await store.putAdjustment!(key, checkpoint);
          },
        }
      : {}),
  };
}

function leaseGuardedPendingStatusStore(
  store: ReportingPendingConsumerStatusStore,
  lease: ReportingConsumerWorkLeaseV1,
  assertLeaseCurrent: () => void
): ReportingPendingConsumerStatusStore {
  return {
    get: key => store.get(key),
    async put(key, pending) {
      assertLeaseCurrent();
      await store.put(key, pending, lease);
      assertLeaseCurrent();
    },
    async clear(key, expected) {
      assertLeaseCurrent();
      await store.clear(key, expected, lease);
      assertLeaseCurrent();
    },
  };
}

async function advanceCheckpoint(
  store: ReportingChangesCheckpointStoreV1,
  key: { consumerScope: string; accountId: string },
  expected: string | null,
  checkpoint: string,
  lease?: ReportingConsumerWorkLeaseV1,
  assertLeaseCurrent?: () => void
): Promise<void> {
  assertLeaseCurrent?.();
  const result = await store.compareAndSet(key, expected, checkpoint, lease);
  if (result === 'conflict') {
    throw consumerError('CHANGES_CHECKPOINT_CONFLICT', 'reporting changes checkpoint was concurrently advanced');
  }
}

function withoutChangesAfter(
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination'>
): Omit<GetReportingStatusRequest, 'view' | 'pagination' | 'changes_after'> {
  const { changes_after: _changesAfter, ...rest } = request;
  return rest;
}

function accountIdFromRequest(request: Pick<GetReportingStatusRequest, 'account'>): string | undefined {
  const accountId = (request.account as { account_id?: unknown } | undefined)?.account_id;
  if (accountId === undefined) return undefined;
  boundedString(accountId, 'request.account.account_id', 512);
  return accountId;
}

function abortableClient(
  client: ReportingReconciliationClient,
  runtimeSignal: AbortSignal,
  expectedAccountId: string
): ReportingReconciliationClient {
  const signal = (callSignal?: AbortSignal): AbortSignal => combineSignals(callSignal, runtimeSignal);
  return {
    getReportingStatus: async (params, options) => {
      const response = await client.getReportingStatus(params, { ...options, signal: signal(options?.signal) });
      if (response.account_id !== undefined && response.account_id !== expectedAccountId) {
        throw consumerError(
          'ACCOUNT_SCOPE_MISMATCH',
          'reporting reconciliation returned a different resolved account than the configured durable partition'
        );
      }
      return response;
    },
    syncReportingReceipts: (params, options) =>
      client.syncReportingReceipts(params, { ...options, signal: signal(options?.signal) }),
    ...(client.syncReportingStatus
      ? {
          syncReportingStatus: (
            params: Parameters<NonNullable<typeof client.syncReportingStatus>>[0],
            options?: { signal?: AbortSignal }
          ) => client.syncReportingStatus!(params, { ...options, signal: signal(options?.signal) }),
        }
      : {}),
    ...(client.getMediaBuyDelivery
      ? {
          getMediaBuyDelivery: (
            params: Parameters<NonNullable<typeof client.getMediaBuyDelivery>>[0],
            options?: { signal?: AbortSignal }
          ) => client.getMediaBuyDelivery!(params, { ...options, signal: signal(options?.signal) }),
        }
      : {}),
  };
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal): AbortSignal {
  if (!left) return right;
  return AbortSignal.any([left, right]);
}

async function callWithDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw consumerError('CHANGE_LIMIT_EXCEEDED', 'reporting change walk exceeded time limit');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = consumerError('CHANGE_LIMIT_EXCEEDED', 'reporting change walk exceeded time limit');
      controller.abort(error);
      reject(error);
    }, remaining);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([operation(controller.signal), timeout]);
    if (Date.now() >= deadline) {
      throw consumerError('CHANGE_LIMIT_EXCEEDED', 'reporting change walk exceeded time limit');
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function reportingNotification(value: unknown): ReportingNotificationV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as { notification_type?: unknown; account_id?: unknown };
  if (
    candidate.notification_type !== 'reporting.delivery_ready' &&
    candidate.notification_type !== 'reporting.ledger_changed' &&
    candidate.notification_type !== 'reporting.status_changed'
  ) {
    return null;
  }
  boundedString(candidate.account_id, 'notification.account_id', 512);
  const idempotencyKey = (value as { idempotency_key?: unknown }).idempotency_key;
  boundedString(idempotencyKey, 'notification.idempotency_key', 255);
  if (idempotencyKey.length < 16 || !/^[A-Za-z0-9_.:-]+$/.test(idempotencyKey)) {
    throw new TypeError('notification.idempotency_key is invalid');
  }
  return value as ReportingNotificationV1;
}

function runtimeAccountKey(consumerScope: string, accountId: string): string {
  return canonicalJsonSha256({ consumerScope, accountId });
}

function consumerError(code: string, message: string): ReportingReconciliationError {
  return new ReportingReconciliationError(code, message);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function boundedString(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${name} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL`);
  }
}
