import type { GetReportingStatusRequest } from '../types';
import type {
  ReportingDeliveryReadyWebhook,
  ReportingLedgerChangedWebhook,
  ReportingStatusChangedWebhook,
} from '../types/core.generated';
import type {
  ReportingChangesCheckpointStoreV1,
  ReportingConsumerWorkLeaseStoreV1,
  ReportingConsumerWorkLeaseV1,
} from './consumer-postgres';
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
const DEFAULT_MAX_CONCURRENCY = 8;

type ReportingNotificationV1 =
  | ReportingDeliveryReadyWebhook
  | ReportingLedgerChangedWebhook
  | ReportingStatusChangedWebhook;

type DurableOptionKeys = 'checkpointStore' | 'checkpointScope' | 'pendingConsumerStatusStore';

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
  | { accountId: string; reason: ReliableReportingConsumerRunReasonV1; state: 'busy' | 'stopping' }
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
      changesCheckpoint: string;
      cursorRecovered: boolean;
      reconciliation: ReportingReconciliationResult;
    }
  | { accountId: string; reason: ReliableReportingConsumerRunReasonV1; state: 'lease_lost' };

export interface ReliableReportingConsumerV1 {
  start(): void;
  stop(): Promise<void>;
  runAccount(
    accountId: string,
    reason?: ReliableReportingConsumerRunReasonV1
  ): Promise<ReliableReportingConsumerRunResultV1>;
  /** Call only after authenticating and verifying the webhook signature. */
  handleAuthenticatedNotification(payload: unknown): Promise<ReliableReportingConsumerRunResultV1 | null>;
}

export interface DrainReportingChangesOptionsV1 {
  client: ReportingReconciliationClient;
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination' | 'changes_after'>;
  changesAfter: string;
  limits?: ReportingLedgerLimits;
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
  boundedString(options.changesAfter, 'changesAfter', 16 * 1024);
  const maxPages = options.limits?.maxPages ?? 1_000;
  const maxRecords = options.limits?.maxRecords ?? 100_000;
  const maxLoadMs = options.limits?.maxLoadMs ?? 60_000;
  boundedInteger(maxPages, 'maxPages', 1, 10_000);
  boundedInteger(maxRecords, 'maxRecords', 1, 1_000_000);
  boundedInteger(maxLoadMs, 'maxLoadMs', 1, 3_600_000);
  const requestedAccountId = accountIdFromRequest(options.request);
  const deadline = Date.now() + maxLoadMs;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let page = 0;
  let snapshotId: string | undefined;
  let ledgerAsOf: string | undefined;
  let changesCheckpoint: string | undefined;
  let totalCount: number | undefined;

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
      !response.changes_checkpoint ||
      !response.pagination ||
      response.account_id !== requestedAccountId
    ) {
      throw consumerError('INCOMPLETE_CHANGE_PAGE', 'get_reporting_status returned an incomplete change page');
    }
    const count = response.pagination.total_count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > maxRecords) {
      throw consumerError('CHANGE_LIMIT_EXCEEDED', 'reporting change walk returned an invalid record count');
    }
    if (
      (snapshotId && snapshotId !== response.ledger_snapshot_id) ||
      (ledgerAsOf && ledgerAsOf !== response.ledger_as_of) ||
      (changesCheckpoint && changesCheckpoint !== response.changes_checkpoint) ||
      (totalCount !== undefined && totalCount !== count)
    ) {
      throw consumerError('CHANGE_SNAPSHOT_CHANGED', 'reporting change snapshot changed during pagination');
    }
    snapshotId = response.ledger_snapshot_id;
    ledgerAsOf = response.ledger_as_of;
    changesCheckpoint = response.changes_checkpoint;
    totalCount = count;
    if (response.pagination.has_more) {
      const next = response.pagination.cursor;
      if (!next || cursors.has(next)) {
        throw consumerError('CHANGE_CURSOR_LOOP', 'reporting change pagination did not advance');
      }
      cursors.add(next);
      cursor = next;
    } else {
      cursor = undefined;
    }
  } while (cursor);

  return {
    changed: (totalCount ?? 0) > 0,
    recordCount: totalCount ?? 0,
    ledgerSnapshotId: snapshotId!,
    ledgerAsOf: ledgerAsOf!,
    changesCheckpoint: changesCheckpoint!,
  };
}

export function createReliableReportingConsumerV1<TCredential = unknown>(
  options: CreateReliableReportingConsumerOptionsV1<TCredential>
): ReliableReportingConsumerV1 {
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
  for (const account of options.accounts) {
    boundedString(account.consumerScope, 'consumerScope', 4_096);
    boundedString(account.accountId, 'accountId', 512);
    if (accountIdFromRequest(account.reconciliation.request) !== account.accountId) {
      throw new TypeError(`reporting consumer account ${account.accountId} does not match its request account`);
    }
    if (accounts.has(account.accountId))
      throw new TypeError(`duplicate reporting consumer account ${account.accountId}`);
    accounts.set(account.accountId, account);
  }

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
    const queue = [...accounts.keys()];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrentAccounts, queue.length) }, async () => {
        while (!stopped) {
          const index = next++;
          if (index >= queue.length) return;
          try {
            await runAccount(queue[index]!, reason);
          } catch (error) {
            await reportError(error, queue[index]!);
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
    let lease = await options.persistence.workLeases.claim({
      key,
      ownerToken: options.ownerToken,
      leaseMilliseconds,
    });
    if (!lease) return { accountId: account.accountId, reason, state: 'busy' };

    const leaseAbort = new AbortController();
    let leaseLost = false;
    let renewing = false;
    const renewal = setInterval(
      async () => {
        if (renewing || leaseLost) return;
        renewing = true;
        try {
          const renewed = await options.persistence.workLeases.renew(lease!, leaseMilliseconds);
          if (!renewed) {
            leaseLost = true;
            leaseAbort.abort(consumerError('WORK_LEASE_LOST', 'reporting consumer work lease was lost'));
          } else {
            lease = renewed;
          }
        } catch (error) {
          leaseLost = true;
          leaseAbort.abort(error);
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
          const delta = await drainReportingChangesV1({
            client: abortableClient(account.reconciliation.client, leaseAbort.signal),
            request: withoutChangesAfter(account.reconciliation.request),
            changesAfter: previous.checkpoint,
            limits: account.reconciliation.ledgerLimits,
          });
          if (!delta.changed) {
            if (leaseLost) return { accountId: account.accountId, reason, state: 'lease_lost' };
            await advanceCheckpoint(
              options.persistence.changesCheckpointStore,
              key,
              previous.checkpoint,
              delta.changesCheckpoint
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
        client: abortableClient(account.reconciliation.client, leaseAbort.signal),
        request: withoutChangesAfter(account.reconciliation.request),
        checkpointStore: options.persistence.checkpointStore,
        checkpointScope: account.consumerScope,
        pendingConsumerStatusStore: options.persistence.pendingConsumerStatusStore,
      } as ReconcileReportingOptions<TCredential>);
      if (leaseLost) return { accountId: account.accountId, reason, state: 'lease_lost' };
      const checkpoint = reconciliation.ledger.changesCheckpoint;
      if (!checkpoint) {
        throw consumerError(
          'CHANGES_CHECKPOINT_REQUIRED',
          'production reporting consumer requires a changes_checkpoint on periods responses'
        );
      }
      await advanceCheckpoint(
        options.persistence.changesCheckpointStore,
        key,
        previous?.checkpoint ?? null,
        checkpoint
      );
      const completed: ReliableReportingConsumerRunResultV1 = {
        accountId: account.accountId,
        reason,
        state: 'reconciled',
        changesCheckpoint: checkpoint,
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
      clearInterval(renewal);
      await options.persistence.workLeases.release(lease).catch(error => reportError(error, account.accountId));
    }
  };

  const runAccount = (
    accountId: string,
    reason: ReliableReportingConsumerRunReasonV1 = 'manual'
  ): Promise<ReliableReportingConsumerRunResultV1> => {
    const account = accounts.get(accountId);
    if (!account) return Promise.reject(new TypeError(`unknown reporting consumer account ${accountId}`));
    if (stopped) return Promise.resolve({ accountId, reason, state: 'stopping' });
    const existing = active.get(accountId);
    if (existing) return existing;
    const work = execute(account, reason).finally(() => active.delete(accountId));
    active.set(accountId, work);
    return work;
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
    runAccount,
    async handleAuthenticatedNotification(payload) {
      const notification = reportingNotification(payload);
      if (!notification) return null;
      if (!accounts.has(notification.account_id)) return null;
      return runAccount(notification.account_id, notification.notification_type);
    },
  };
}

async function advanceCheckpoint(
  store: ReportingChangesCheckpointStoreV1,
  key: { consumerScope: string; accountId: string },
  expected: string | null,
  checkpoint: string
): Promise<void> {
  const result = await store.compareAndSet(key, expected, checkpoint);
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

function accountIdFromRequest(request: Pick<GetReportingStatusRequest, 'account'>): string {
  const accountId = (request.account as { account_id?: unknown } | undefined)?.account_id;
  boundedString(accountId, 'request.account.account_id', 512);
  return accountId;
}

function abortableClient(
  client: ReportingReconciliationClient,
  runtimeSignal: AbortSignal
): ReportingReconciliationClient {
  const signal = (callSignal?: AbortSignal): AbortSignal => combineSignals(callSignal, runtimeSignal);
  return {
    getReportingStatus: (params, options) =>
      client.getReportingStatus(params, { ...options, signal: signal(options?.signal) }),
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
  const timer = setTimeout(() => controller.abort(), remaining);
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
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
  return value as ReportingNotificationV1;
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
