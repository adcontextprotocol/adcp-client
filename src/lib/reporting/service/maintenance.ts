import type { PostgresReportingLedgerStore } from '../ledger';

/**
 * Period-aligned retention. Whole periods are retired once
 * `max(statusRetentionDays, recordRetentionDays)` has elapsed since both the
 * period end and its latest publication. `statusRetentionDays` always comes
 * from the service, so retention can never disagree with the commitment the
 * service advertises to buyers.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingRetentionOptionsV1 {
  enabled: true;
  recordRetentionDays?: number;
  limit?: number;
}

/**
 * Opt-in compaction of superseded snapshot revisions to metadata only, as
 * adcontextprotocol/adcp#8100 permits. Off unless `enabled: true`. Uses the
 * service's `statusRetentionDays` and `automatedRecoveryWindowSeconds`, so it
 * can never drop content earlier than the commitments advertised to buyers.
 *
 * Compaction takes effect in the AdCP release after November 20, 2026; do not
 * enable it in production before then. See `docs/guides/REPORTING-OPERATIONS.md`.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingCompactionOptionsV1 {
  enabled: true;
  /** Revisions compacted per pass. Defaults to 100. */
  limit?: number;
}

/**
 * Opt-in listing collector for row objects the write-intent sweep cannot see: an upload that
 * succeeded before its intent recorded it, an intent for a binding no running host configures, and
 * an intent lost to a database restore. Off unless `enabled: true`. It lists each configured object
 * binding under its owned prefix, `{prefix}/{namespace_key}/`, and deletes an object only when it is
 * old enough and no ledger record or open upload names it. Cost grows with bucket size, so each pass
 * examines at most `limit` objects per binding and resumes from where it stopped.
 *
 * Enable it only on the ledger database that owns the namespace. A clone or restore of that
 * database that still points at the same bucket shares its namespace and would delete the objects
 * of every row set the original wrote after the clone was taken. Start with `dryRun: true` and read
 * `candidates` in the task result. See `docs/guides/REPORTING-OPERATIONS.md`.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingOrphanCollectionOptionsV1 {
  enabled: true;
  /** Report what would be deleted and delete nothing. Defaults to false. */
  dryRun?: boolean;
  /**
   * Required unless `dryRun`: your statement that this ledger database is the only one that owns the
   * namespace, and not a clone or restore pointed at the same bucket.
   */
  acknowledgeExclusiveNamespace?: boolean;
  /**
   * Minimum time between full listings, counted from when the previous one finished. Defaults to 86400 (a
   * day). Passes in between do nothing; a listing that has not finished (it stops at `limit`) continues on
   * every pass.
   */
  intervalSeconds?: number;
  /**
   * Objects younger than this are never deleted. Defaults to 7 days; at least 1 day. Keep it well above
   * the longest write deadline plus intent expiry.
   */
  minAgeSeconds?: number;
  /** Objects examined per binding per pass. Defaults to 1000. */
  limit?: number;
  /** Also collect from `readOnly` bindings, which are skipped by default. */
  includeReadOnly?: boolean;
}

/**
 * Progress of the orphan collector between passes. Create one per process (`{ cursors: {} }`) and pass it to
 * every pass; it is not persisted, so a restart begins a new listing.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingOrphanCollectionStateV1 {
  cursors: Record<string, string>;
  /** Epoch milliseconds before which no new full listing starts. */
  nextCycleAt?: number;
}

/**
 * Change-feed pruning window and the consumer hold shared with retention.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingChangeFeedMaintenanceOptionsV1 =
  | boolean
  | { changeRetentionDays?: number; maxFeedHoldDays?: number };

/**
 * The ledger-store surface a maintenance pass drives.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingLedgerMaintenanceStoreV1 = Pick<
  PostgresReportingLedgerStore,
  'sweepRowWriteIntents' | 'pruneChanges' | 'retireExpiredPeriods'
> &
  Partial<Pick<PostgresReportingLedgerStore, 'compactSupersededSnapshots' | 'collectOrphanedRowObjects'>>;

interface ReportingLedgerMaintenanceTaskOutcomesV1 {
  'snapshot sweep': Awaited<ReturnType<PostgresReportingLedgerStore['sweepExpiredState']>>;
  'row upload sweep': Awaited<ReturnType<PostgresReportingLedgerStore['sweepRowWriteIntents']>>;
  'change-feed pruning': Awaited<ReturnType<PostgresReportingLedgerStore['pruneChanges']>>;
  retention: Awaited<ReturnType<PostgresReportingLedgerStore['retireExpiredPeriods']>>;
  'snapshot compaction': Awaited<ReturnType<PostgresReportingLedgerStore['compactSupersededSnapshots']>>;
  'orphan object collection': Awaited<ReturnType<PostgresReportingLedgerStore['collectOrphanedRowObjects']>>;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingLedgerMaintenanceTaskNameV1 = keyof ReportingLedgerMaintenanceTaskOutcomesV1;

/**
 * A scheduled maintenance pass completed but could not process some items
 * (for example, a retention period whose objects could not be deleted). The
 * pass resumes them next time; repeated reports need operator attention.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export class ReportingMaintenancePartialFailureError extends Error {
  constructor(
    readonly task: string,
    readonly failedCount: number,
    readonly failedIds: readonly string[],
    /**
     * Backlog the task is not reaching: items backing off, items this host cannot
     * handle, items that have failed persistently. Appended to the message so
     * `onError` and the logs carry them.
     */
    readonly warnings: readonly string[] = []
  ) {
    super(
      (failedCount > 0
        ? `Reporting ${task} could not process ${failedCount} item(s)${failedIds.length ? `: ${failedIds.slice(0, 20).join(', ')}` : ''}`
        : `Reporting ${task} needs attention`) +
        (warnings.length ? `${failedCount > 0 ? '; ' : ': '}${warnings.join('; ')}` : '')
    );
    this.name = 'ReportingMaintenancePartialFailureError';
  }
}

/**
 * Outcome of one maintenance task. A task that resolved but could not process
 * some items (a retention period whose objects would not delete, an upload that
 * would not sweep) is `completed` with `partialFailure` set; the pass resumes
 * those items next time.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingLedgerMaintenanceTaskResultV1 = {
  [Task in ReportingLedgerMaintenanceTaskNameV1]:
    | {
        readonly task: Task;
        readonly status: 'completed';
        readonly result: ReportingLedgerMaintenanceTaskOutcomesV1[Task];
        readonly partialFailure?: ReportingMaintenancePartialFailureError;
      }
    | { readonly task: Task; readonly status: 'failed'; readonly error: unknown };
}[ReportingLedgerMaintenanceTaskNameV1];

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface RunReportingLedgerMaintenanceInputV1 {
  store: ReportingLedgerMaintenanceStoreV1;
  /**
   * Expired cursor snapshot and checkpoint sweep. Omitted when the caller has
   * no way to reach the database, in which case that task is not run.
   */
  sweepSnapshots?: (limit: number) => Promise<ReportingLedgerMaintenanceTaskOutcomesV1['snapshot sweep']>;
  statusRetentionDays: number;
  /** The service's advertised `automated_recovery_window_seconds`; required when `compaction` is enabled. */
  automatedRecoveryWindowSeconds?: number | undefined;
  retention?: ReportingRetentionOptionsV1 | undefined;
  compaction?: ReportingCompactionOptionsV1 | undefined;
  changeFeed?: ReportingChangeFeedMaintenanceOptionsV1 | undefined;
  orphanCollection?: ReportingOrphanCollectionOptionsV1 | undefined;
  /**
   * Where `orphanCollection` is up to: listing positions by binding ID, and when the next full listing may
   * start. The caller owns it and passes the same object on every pass; the pass reads and updates it, so a
   * large listing resumes where the last pass stopped and `intervalSeconds` is honoured. Omit it and every
   * pass starts from the beginning.
   */
  orphanState?: ReportingOrphanCollectionStateV1 | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Called, in task order and awaited, for every task that rejected or
   * partially failed, unless `signal` has aborted (an abort is shutdown, not a
   * fault).
   */
  report?: (error: unknown) => Promise<void>;
}

type StartedTask = [ReportingLedgerMaintenanceTaskNameV1, Promise<unknown>];

/**
 * The single ledger-maintenance pass shared by the Core service and the
 * production service, so partial-failure surfacing, the `maxFeedHoldDays` that
 * retention honours, per-task limits and abort handling cannot drift between
 * them. Tasks start together, in a fixed order, and are isolated: one task's
 * failure never prevents another from running.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function runReportingLedgerMaintenance(
  input: RunReportingLedgerMaintenanceInputV1
): Promise<ReportingLedgerMaintenanceTaskResultV1[]> {
  const { store, signal, changeFeed, retention, compaction, orphanCollection } = input;
  // Each task starts inside `start`, so a synchronous throw becomes that
  // task's rejection instead of aborting the list: the tasks after it still
  // run and the ones already started are never orphaned.
  const start = (name: ReportingLedgerMaintenanceTaskNameV1, run: () => Promise<unknown>): StartedTask => {
    try {
      return [name, run()];
    } catch (error) {
      return [name, Promise.reject(error)];
    }
  };
  const tasks: StartedTask[] = [
    ...(input.sweepSnapshots ? [start('snapshot sweep', () => input.sweepSnapshots!(1_000))] : []),
    start('row upload sweep', () => store.sweepRowWriteIntents({ limit: 100, ...(signal ? { signal } : {}) })),
    ...(changeFeed
      ? [
          start('change-feed pruning', () =>
            store.pruneChanges(
              typeof changeFeed === 'object'
                ? {
                    ...(changeFeed.changeRetentionDays !== undefined
                      ? { changeRetentionDays: changeFeed.changeRetentionDays }
                      : {}),
                    ...(changeFeed.maxFeedHoldDays !== undefined
                      ? { maxFeedHoldDays: changeFeed.maxFeedHoldDays }
                      : {}),
                  }
                : {}
            )
          ),
        ]
      : []),
    ...(retention?.enabled
      ? [
          start('retention', () =>
            store.retireExpiredPeriods({
              statusRetentionDays: input.statusRetentionDays,
              ...(retention.recordRetentionDays !== undefined
                ? { recordRetentionDays: retention.recordRetentionDays }
                : {}),
              ...(typeof changeFeed === 'object' && changeFeed.maxFeedHoldDays !== undefined
                ? { maxFeedHoldDays: changeFeed.maxFeedHoldDays }
                : {}),
              limit: retention.limit ?? 100,
              ...(signal ? { signal } : {}),
            })
          ),
        ]
      : []),
    ...(compaction?.enabled
      ? [
          start('snapshot compaction', () => {
            if (typeof store.compactSupersededSnapshots !== 'function') {
              throw new TypeError('compaction requires a store with compactSupersededSnapshots');
            }
            if (input.automatedRecoveryWindowSeconds === undefined) {
              throw new TypeError('compaction requires automatedRecoveryWindowSeconds');
            }
            return store.compactSupersededSnapshots({
              statusRetentionDays: input.statusRetentionDays,
              automatedRecoveryWindowSeconds: input.automatedRecoveryWindowSeconds,
              ...(typeof changeFeed === 'object' && changeFeed.maxFeedHoldDays !== undefined
                ? { maxFeedHoldDays: changeFeed.maxFeedHoldDays }
                : {}),
              limit: compaction.limit ?? 100,
              ...(signal ? { signal } : {}),
            });
          }),
        ]
      : []),
    ...(orphanCollection?.enabled
      ? [
          start('orphan object collection', async () => {
            if (typeof store.collectOrphanedRowObjects !== 'function') {
              throw new TypeError('orphan collection requires a store with collectOrphanedRowObjects');
            }
            const state = input.orphanState;
            if (state?.nextCycleAt !== undefined && Date.now() < state.nextCycleAt) {
              // Between full listings: nothing to do this pass.
              return {
                dryRun: orphanCollection.dryRun === true,
                listed: 0,
                referenced: 0,
                tooYoung: 0,
                foreign: 0,
                deleted: 0,
                wouldDelete: 0,
                failed: 0,
                unsupported: [],
                skippedReadOnly: [],
                candidates: [],
                cursors: {},
                bindings: [],
              };
            }
            const outcome = await store.collectOrphanedRowObjects({
              ...(orphanCollection.dryRun !== undefined ? { dryRun: orphanCollection.dryRun } : {}),
              ...(orphanCollection.acknowledgeExclusiveNamespace !== undefined
                ? { acknowledgeExclusiveNamespace: orphanCollection.acknowledgeExclusiveNamespace }
                : {}),
              ...(orphanCollection.minAgeSeconds !== undefined
                ? { minAgeSeconds: orphanCollection.minAgeSeconds }
                : {}),
              ...(orphanCollection.limit !== undefined ? { limit: orphanCollection.limit } : {}),
              ...(orphanCollection.includeReadOnly !== undefined
                ? { includeReadOnly: orphanCollection.includeReadOnly }
                : {}),
              ...(state ? { cursors: { ...state.cursors } } : {}),
              ...(signal ? { signal } : {}),
            });
            if (state) {
              state.cursors = outcome.cursors;
              // A finished, clean listing rests for the interval; anything else carries on next pass.
              if (Object.keys(outcome.cursors).length === 0 && outcome.failed === 0) {
                state.nextCycleAt = Date.now() + (orphanCollection.intervalSeconds ?? 86_400) * 1000;
              } else {
                delete state.nextCycleAt;
              }
            }
            return outcome;
          }),
        ]
      : []),
  ];
  const settled = await Promise.allSettled(tasks.map(([, task]) => task));
  const results: ReportingLedgerMaintenanceTaskResultV1[] = [];
  for (const [index, outcome] of settled.entries()) {
    const name = tasks[index]![0];
    if (outcome.status === 'rejected') {
      if (!signal?.aborted) await input.report?.(outcome.reason);
      results.push({ task: name, status: 'failed', error: outcome.reason } as ReportingLedgerMaintenanceTaskResultV1);
      continue;
    }
    // Partial failures resolve rather than reject; surface them so a period
    // or upload that fails every pass is visible to error reporting.
    const value = outcome.value as
      | {
          failed?: number | readonly string[];
          failures?: readonly { reporting_obligation_id: string; cause: string }[];
          // Retention: periods backing off, and periods that keep failing.
          deferred?: number;
          stuck?: readonly { reporting_obligation_id: string; attempts: number; cause: string }[];
          // Row upload sweep: backlog the pass is not reaching.
          skippedUnconfigured?: number;
          overdue?: number;
          // Orphan object collection: bindings it could not cover.
          unsupported?: readonly string[];
          bindings?: readonly { bindingId: string; status: string; error?: string }[];
        }
      | undefined;
    const failed = Array.isArray(value?.failed)
      ? value.failed.length
      : typeof value?.failed === 'number'
        ? value.failed
        : 0;
    const warnings: string[] = [];
    if (value?.stuck?.length) {
      warnings.push(
        `${value.stuck.length} period(s) keep failing: ${value.stuck
          .slice(0, 20)
          .map(entry => `${entry.reporting_obligation_id} (${entry.cause}, ${entry.attempts} attempts)`)
          .join(', ')}`
      );
    }
    if (typeof value?.deferred === 'number' && value.deferred > 0) {
      warnings.push(`${value.deferred} item(s) backing off after a failure`);
    }
    if (typeof value?.skippedUnconfigured === 'number' && value.skippedUnconfigured > 0) {
      warnings.push(
        `${value.skippedUnconfigured} expired upload(s) skipped because this host does not configure their row binding`
      );
    }
    if (typeof value?.overdue === 'number' && value.overdue > 0) {
      warnings.push(
        `${value.overdue} upload(s) expired long ago and still unswept; their objects are leaking (check that a host configures their binding and that provider deletes succeed)`
      );
    }
    if (value?.unsupported?.length) {
      warnings.push(
        `orphan collection cannot cover row binding(s) ${value.unsupported.join(', ')}: their provider has no list(), so orphaned objects there are never collected`
      );
    }
    for (const binding of value?.bindings ?? []) {
      if (binding.status === 'failed') {
        warnings.push(`orphan collection failed for row binding ${binding.bindingId} (${binding.error ?? 'unknown'})`);
      }
    }
    let partialFailure: ReportingMaintenancePartialFailureError | undefined;
    if (failed > 0 || warnings.length > 0) {
      partialFailure = new ReportingMaintenancePartialFailureError(
        name,
        failed,
        value?.failures?.length
          ? value.failures.map(entry => `${entry.reporting_obligation_id} (${entry.cause})`)
          : Array.isArray(value?.failed)
            ? value.failed
            : [],
        warnings
      );
      if (!signal?.aborted) await input.report?.(partialFailure);
    }
    results.push({
      task: name,
      status: 'completed',
      result: outcome.value,
      ...(partialFailure ? { partialFailure } : {}),
    } as ReportingLedgerMaintenanceTaskResultV1);
  }
  return results;
}

/**
 * Fail fast on maintenance options the store would otherwise reject on every
 * pass. Mirrors the checks `retireExpiredPeriods` and `pruneChanges` apply.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function assertReportingLedgerMaintenanceOptions(
  input: {
    retention?: ReportingRetentionOptionsV1 | undefined;
    compaction?: ReportingCompactionOptionsV1 | undefined;
    changeFeed?: ReportingChangeFeedMaintenanceOptionsV1 | undefined;
    orphanCollection?: ReportingOrphanCollectionOptionsV1 | undefined;
  },
  statusRetentionDays: number
): void {
  const positive = (value: unknown, field: string) => {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
  };
  const { retention, changeFeed, compaction, orphanCollection } = input;
  if (orphanCollection !== undefined) {
    if (orphanCollection === null || typeof orphanCollection !== 'object' || orphanCollection.enabled !== true) {
      throw new TypeError('maintenance.orphanCollection must be { enabled: true, ... }');
    }
    if (orphanCollection.limit !== undefined) positive(orphanCollection.limit, 'maintenance.orphanCollection.limit');
    if (orphanCollection.intervalSeconds !== undefined) {
      positive(orphanCollection.intervalSeconds, 'maintenance.orphanCollection.intervalSeconds');
    }
    if (orphanCollection.dryRun !== true && orphanCollection.acknowledgeExclusiveNamespace !== true) {
      throw new TypeError(
        'maintenance.orphanCollection deletes objects: set acknowledgeExclusiveNamespace: true to confirm this ledger ' +
          'database is the only one that owns the namespace (not a clone or restore pointed at the same bucket), or set dryRun: true'
      );
    }
    if (orphanCollection.minAgeSeconds !== undefined) {
      positive(orphanCollection.minAgeSeconds, 'maintenance.orphanCollection.minAgeSeconds');
      if (orphanCollection.minAgeSeconds < 24 * 3600) {
        throw new RangeError(
          'maintenance.orphanCollection.minAgeSeconds must be at least 1 day (86400): a younger object may belong to an upload still in flight'
        );
      }
    }
    for (const flag of ['dryRun', 'includeReadOnly', 'acknowledgeExclusiveNamespace'] as const) {
      if (orphanCollection[flag] !== undefined && typeof orphanCollection[flag] !== 'boolean') {
        throw new TypeError(`maintenance.orphanCollection.${flag} must be a boolean`);
      }
    }
  }
  if (compaction !== undefined) {
    if (compaction === null || typeof compaction !== 'object' || compaction.enabled !== true) {
      throw new TypeError('maintenance.compaction must be { enabled: true, ... }');
    }
    if (compaction.limit !== undefined) positive(compaction.limit, 'maintenance.compaction.limit');
  }
  if (retention !== undefined) {
    if (retention === null || typeof retention !== 'object' || retention.enabled !== true) {
      throw new TypeError('maintenance.retention must be { enabled: true, ... }');
    }
    if (retention.recordRetentionDays !== undefined) {
      positive(retention.recordRetentionDays, 'maintenance.retention.recordRetentionDays');
      if (retention.recordRetentionDays < statusRetentionDays) {
        throw new RangeError(
          'maintenance.retention.recordRetentionDays must be no shorter than statusRetentionDays, the retention advertised to buyers'
        );
      }
    }
    if (retention.limit !== undefined) positive(retention.limit, 'maintenance.retention.limit');
  }
  if (typeof changeFeed === 'object' && changeFeed !== null) {
    if (changeFeed.changeRetentionDays !== undefined) {
      positive(changeFeed.changeRetentionDays, 'maintenance.changeFeed.changeRetentionDays');
    }
    if (changeFeed.maxFeedHoldDays !== undefined) {
      positive(changeFeed.maxFeedHoldDays, 'maintenance.changeFeed.maxFeedHoldDays');
    }
  }
}
