import type { PostgresReportingLedgerStore } from '../ledger';

/**
 * Period-aligned retention. Whole periods are retired once
 * `max(statusRetentionDays, recordRetentionDays)` has elapsed since both the
 * period end and its latest publication. `statusRetentionDays` always comes
 * from the service, so retention can never disagree with the commitment the
 * service advertises to buyers.
 */
export interface ReportingRetentionOptionsV1 {
  enabled: true;
  recordRetentionDays?: number;
  limit?: number;
}

/** Change-feed pruning window and the consumer hold shared with retention. */
export type ReportingChangeFeedMaintenanceOptionsV1 =
  | boolean
  | { changeRetentionDays?: number; maxFeedHoldDays?: number };

/** The ledger-store surface a maintenance pass drives. */
export type ReportingLedgerMaintenanceStoreV1 = Pick<
  PostgresReportingLedgerStore,
  'sweepRowWriteIntents' | 'pruneChanges' | 'retireExpiredPeriods'
>;

interface ReportingLedgerMaintenanceTaskOutcomesV1 {
  'snapshot sweep': Awaited<ReturnType<PostgresReportingLedgerStore['sweepExpiredState']>>;
  'row upload sweep': Awaited<ReturnType<PostgresReportingLedgerStore['sweepRowWriteIntents']>>;
  'change-feed pruning': Awaited<ReturnType<PostgresReportingLedgerStore['pruneChanges']>>;
  retention: Awaited<ReturnType<PostgresReportingLedgerStore['retireExpiredPeriods']>>;
}

export type ReportingLedgerMaintenanceTaskNameV1 = keyof ReportingLedgerMaintenanceTaskOutcomesV1;

/**
 * A scheduled maintenance pass completed but could not process some items
 * (for example, a retention period whose objects could not be deleted). The
 * pass resumes them next time; repeated reports need operator attention.
 */
export class ReportingMaintenancePartialFailureError extends Error {
  constructor(
    readonly task: string,
    readonly failedCount: number,
    readonly failedIds: readonly string[]
  ) {
    super(
      `Reporting ${task} could not process ${failedCount} item(s)${failedIds.length ? `: ${failedIds.slice(0, 20).join(', ')}` : ''}`
    );
    this.name = 'ReportingMaintenancePartialFailureError';
  }
}

/**
 * Outcome of one maintenance task. A task that resolved but could not process
 * some items (a retention period whose objects would not delete, an upload that
 * would not sweep) is `completed` with `partialFailure` set; the pass resumes
 * those items next time.
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

export interface RunReportingLedgerMaintenanceInputV1 {
  store: ReportingLedgerMaintenanceStoreV1;
  /**
   * Expired cursor snapshot and checkpoint sweep. Omitted when the caller has
   * no way to reach the database, in which case that task is not run.
   */
  sweepSnapshots?: (limit: number) => Promise<ReportingLedgerMaintenanceTaskOutcomesV1['snapshot sweep']>;
  statusRetentionDays: number;
  retention?: ReportingRetentionOptionsV1 | undefined;
  changeFeed?: ReportingChangeFeedMaintenanceOptionsV1 | undefined;
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
 */
export async function runReportingLedgerMaintenance(
  input: RunReportingLedgerMaintenanceInputV1
): Promise<ReportingLedgerMaintenanceTaskResultV1[]> {
  const { store, signal, changeFeed, retention } = input;
  const tasks: StartedTask[] = [
    ...(input.sweepSnapshots ? ([['snapshot sweep', input.sweepSnapshots(1_000)]] as StartedTask[]) : []),
    ['row upload sweep', store.sweepRowWriteIntents({ limit: 100, ...(signal ? { signal } : {}) })],
    ...(changeFeed
      ? ([
          [
            'change-feed pruning',
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
            ),
          ],
        ] as StartedTask[])
      : []),
    ...(retention?.enabled
      ? ([
          [
            'retention',
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
            }),
          ],
        ] as StartedTask[])
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
        }
      | undefined;
    const failed = Array.isArray(value?.failed)
      ? value.failed.length
      : typeof value?.failed === 'number'
        ? value.failed
        : 0;
    let partialFailure: ReportingMaintenancePartialFailureError | undefined;
    if (failed > 0) {
      partialFailure = new ReportingMaintenancePartialFailureError(
        name,
        failed,
        value?.failures?.length
          ? value.failures.map(entry => `${entry.reporting_obligation_id} (${entry.cause})`)
          : Array.isArray(value?.failed)
            ? value.failed
            : []
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
 */
export function assertReportingLedgerMaintenanceOptions(
  input: {
    retention?: ReportingRetentionOptionsV1 | undefined;
    changeFeed?: ReportingChangeFeedMaintenanceOptionsV1 | undefined;
  },
  statusRetentionDays: number
): void {
  const positive = (value: unknown, field: string) => {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new TypeError(`${field} must be a positive safe integer`);
    }
  };
  const { retention, changeFeed } = input;
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
