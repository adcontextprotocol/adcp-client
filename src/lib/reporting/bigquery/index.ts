/**
 * BigQuery warehouse sink for Reliable Reporting.
 *
 * Every export of this subpath is `@experimental` and may change in minor releases.
 *
 * Stability policy: https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 *
 * @packageDocumentation
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import type { PostgresReportingLedgerStore, ReportingLedgerRevisionMetadataV1, ReportingPgPool } from '../ledger';
import { decodeReportingChangeCursorV1 } from '../ledger/change-feed';
import { reportingPeriodDate } from '../ledger/schedule';

/**
 * BigQuery warehouse sink for Reliable Reporting (shared SDK persistence spec,
 * adcontextprotocol/adcp#7996 §3.6).
 *
 * The sink is a derived, non-authoritative copy of committed revisions. It
 * follows the ledger's host change feed, reads every revision's rows through
 * the store's verified reader, maps them to the adopter's columns, and loads
 * one batch per tick with a deterministic job ID. It is never read for
 * serving or verification, so its tables, columns, partitioning and retention
 * are the adopter's.
 *
 * Exactly-once loading: a batch (change-feed range, revision list, job IDs) is
 * planned durably in PostgreSQL before any load. Before every submission the
 * sink looks the deterministic job ID up in the destination project and
 * location: a job that finished cleanly counts as loaded, a job still running
 * is waited for (never uploaded again), and only a missing job is uploaded.
 * A crash or timeout between the load and the cursor commit therefore replays
 * the same batch under the same job IDs without a second upload. A failed load
 * job is retried under a new attempt suffix only after BigQuery reports that
 * job finished with an error, and each table keeps its own attempt count, so
 * no batch lands twice. A load that outlasts the deadline never changes the job
 * ID: the sink grows that table's deadline instead (persisted with the plan).
 * Concurrent runs claim one durable plan with compare-and-swap. Replays of
 * that plan share job IDs; stale runs cannot change its attempts or cursor.
 */

/**
 * Apply after `REPORTING_LEDGER_CHANGES_MIGRATION`. Holds one row per sink.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_WAREHOUSE_SINK_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_warehouse_sinks (
  sink_name TEXT PRIMARY KEY CHECK (sink_name ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  committed_cursor TEXT,
  planned_from_cursor TEXT,
  planned_to_cursor TEXT,
  planned_revisions JSONB,
  planned_rows_attempt INTEGER NOT NULL DEFAULT 0 CHECK (planned_rows_attempt >= 0),
  planned_revisions_attempt INTEGER NOT NULL DEFAULT 0 CHECK (planned_revisions_attempt >= 0),
  planned_rows_timeouts INTEGER NOT NULL DEFAULT 0 CHECK (planned_rows_timeouts >= 0),
  planned_revisions_timeouts INTEGER NOT NULL DEFAULT 0 CHECK (planned_revisions_timeouts >= 0),
  reset_generation INTEGER NOT NULL DEFAULT 0 CHECK (reset_generation >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((planned_to_cursor IS NULL) = (planned_revisions IS NULL))
);
ALTER TABLE adcp_reporting_warehouse_sinks
  ADD COLUMN IF NOT EXISTS reset_generation INTEGER NOT NULL DEFAULT 0 CHECK (reset_generation >= 0);
ALTER TABLE adcp_reporting_warehouse_sinks
  ADD COLUMN IF NOT EXISTS planned_rows_timeouts INTEGER NOT NULL DEFAULT 0 CHECK (planned_rows_timeouts >= 0);
ALTER TABLE adcp_reporting_warehouse_sinks
  ADD COLUMN IF NOT EXISTS planned_revisions_timeouts INTEGER NOT NULL DEFAULT 0 CHECK (planned_revisions_timeouts >= 0);
`.trim();

/**
 * Structural subset of the official `@google-cloud/bigquery` client the sink uses.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingBigQueryClientV1 {
  dataset(
    datasetId: string,
    options?: { projectId?: string; location?: string }
  ): {
    table(tableId: string): {
      load(source: string, metadata: Record<string, unknown>): Promise<unknown>;
    };
  };
  job(
    jobId: string,
    options?: { projectId?: string; location?: string }
  ): {
    getMetadata(): Promise<unknown>;
    /** @deprecated Unused: BigQuery does not stop a running load, so the sink never cancels. Kept so wrappers that declare it still type-check. */
    cancel?(): Promise<unknown>;
  };
  query(options: { query: string; location?: string }): Promise<unknown>;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingWarehouseRowContextV1 {
  revision: ReportingLedgerRevisionMetadataV1;
  ordinal: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface CreateBigQueryReportingWarehouseSinkOptionsV1 {
  /** Ledger store with `changeFeed: true`. */
  store: Pick<PostgresReportingLedgerStore, 'changesAfter' | 'getRevisionMetadata' | 'readRevisionRows'> & {
    /**
     * The sink ignores the result, so wrappers written when this resolved
     * `void` keep compiling.
     */
    saveFeedConsumerCursor(name: string, cursor: string, options?: { refreshUnchanged?: boolean }): Promise<unknown>;
  } & /** Needed only by `reset()`; custom store wrappers that predate it keep compiling. */ Partial<
      Pick<PostgresReportingLedgerStore, 'removeFeedConsumer'>
    >;
  /** PostgreSQL pool holding `REPORTING_WAREHOUSE_SINK_MIGRATION`. */
  db: Pick<ReportingPgPool, 'query'>;
  /** Host-constructed official BigQuery client. */
  bigquery: ReportingBigQueryClientV1;
  /**
   * Stable sink and consumer name. All replicas sharing it must use the same
   * ledger database, feed scope, destination, location and row mapping. Use
   * a new name when that configuration changes. Names must also be unique
   * across independent ledgers sharing a BigQuery project.
   */
  name: string;
  projectId?: string;
  datasetId: string;
  rowsTableId: string;
  revisionsTableId: string;
  /**
   * Dataset location, so jobs run in the dataset's region. Set it for any dataset outside the US and EU
   * multi-regions: BigQuery answers a job lookup without the right location with 404, and the sink then
   * cannot find the jobs it created.
   */
  location?: string;
  /** Restrict the sink to one account; omit for the deployment-wide feed. */
  account_id?: string;
  /**
   * Map one verified report row to the adopter's columns. The sink always adds
   * `reporting_revision_id`, `reporting_obligation_id`, `account_id`,
   * `revision_number`, `finality`, `period_date` (the period start's calendar date in its
   * `source_timezone`, AdCP's `YYYY-MM-DD`; the batch fails if it cannot be computed) and
   * `ordinal`. Default: the
   * row as a `row` JSON column.
   */
  mapRow?(row: Record<string, unknown>, context: ReportingWarehouseRowContextV1): Record<string, unknown>;
  /** Revisions per batch. Default 200. */
  maxRevisionsPerBatch?: number;
  /**
   * @deprecated Has no effect, and the sink warns when it is set. The official
   * client submits a local-file load by uploading a job resource whose
   * `configuration.load` is built from the load options, and offers no way to
   * set `configuration.labels`; BigQuery silently drops `labels` found inside
   * `configuration.load`. For cost attribution, filter
   * `INFORMATION_SCHEMA.JOBS` on `destination_table` or on the `adcp_rr_`
   * job ID prefix instead.
   */
  labels?: Readonly<Record<string, string>>;
  /**
   * Base deadline for one run's work on one load. Default 10 minutes. It bounds
   * how long a run uploads a file or waits for a running job; it does not bound
   * the job. BigQuery does not stop a load when the client gives up (a cancel
   * is accepted and the job finishes anyway), so the sink never cancels.
   * Before every submission it looks the deterministic job ID up in `projectId`
   * and `location`: a job that finished cleanly is accepted, a job that is
   * pending or running is waited for (polled within the deadline) instead of
   * being uploaded again, and only a missing job is uploaded. When the
   * deadline passes, the run rejects with the plan retained and nothing
   * advanced, and the next run checks the job again. Each such timeout doubles
   * that table's deadline for later runs (up to 6 hours, persisted with the
   * plan, and never changing the job ID), so an upload slower than the
   * deadline eventually gets enough time. Set it above your slowest expected
   * load to avoid the extra runs. Only a job that finished with an error
   * advances the attempt. A status check that times out is bounded by this base
   * deadline and does not grow it. This is a client-side deadline: BigQuery's
   * server-side `jobTimeoutMs` cannot be set on a local-file load through the
   * official client.
   */
  loadTimeoutMilliseconds?: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface BigQueryReportingWarehouseSinkV1 {
  /**
   * Load at most one batch. Resolves with what was loaded; `idle` when no
   * revision changes were selected. Idle ticks can advance past other feed changes.
   * An overlapping run that loses its plan or cursor claim rejects. Retry
   * `runOnce()` to resume the current durable plan or committed cursor.
   *
   * `missing` lists revision IDs the change feed announced that no longer
   * exist in the ledger because their period was retired before this batch
   * ran. That is a data-loss signal: the sink fell behind retention (it was
   * down longer than `maxFeedHoldDays`, so retention stopped waiting for it)
   * and the warehouse lacks those revisions. Backfill them from another source
   * or accept the gap. The cursor still advances so the sink is not stuck.
   * Alert on a non-empty `missing`. After a crash-and-replay of a planned
   * batch, a listed revision may already have been loaded by the first attempt.
   */
  runOnce(options?: {
    signal?: AbortSignal;
  }): Promise<{ idle: boolean; revisions: number; rows: number; missing: string[] }>;
  /**
   * Clear the sink's saved state so the next `runOnce()` starts again from the
   * oldest retained change, and unregister its feed consumer so the old
   * checkpoint stops holding back retention. This is the way out of a sink
   * that keeps rejecting with `CURSOR_EXPIRED`: a brand-new sink whose first
   * read lost a startup race with pruning, or a sink that fell behind
   * retention and has been resynchronized from current revisions. Stop every
   * worker using this sink name first.
   *
   * It refuses while a batch plan is retained, because that batch's load jobs
   * may already have succeeded; pass `discardRetainedPlan: true` once you have
   * reconciled it against BigQuery. The warehouse is not touched: a sink that
   * already loaded history will load the retained revisions again, so empty
   * the destination tables first, or use a new sink name against new tables.
   * Each reset starts a new job ID generation, so reloaded batches submit
   * fresh BigQuery jobs instead of matching the finished jobs of the earlier
   * history. The sink never cancels a load, so stop every worker and let its
   * in-flight uploads and jobs finish before emptying the destination tables. Nothing holds change retention between `reset()` and the first
   * committed batch. If `reset()` rejects after clearing the sink's state
   * (the consumer could not be unregistered), call it again before restarting
   * workers; it is idempotent. Needs a store with `removeFeedConsumer`.
   * Resolves with whether a saved sink state existed.
   */
  reset(options?: { discardRetainedPlan?: boolean }): Promise<{ cleared: boolean }>;
  /** DDL for the default rows and revisions tables (partitioned and clustered). */
  readonly defaultTablesSql: string;
  /** DDL for the reference `current_rows` view. */
  readonly currentRowsViewSql: string;
}

const MAX_LOAD_TIMEOUT = 6 * 3_600_000;
/** Doublings stop at 2^16: even the 1 second minimum is then past the 6 hour cap. */
const MAX_TIMEOUT_DOUBLINGS = 16;
let warnedLabelsIgnored = false;
const PROJECT = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const DATASET_OR_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function createBigQueryReportingWarehouseSinkV1(
  options: CreateBigQueryReportingWarehouseSinkOptionsV1
): BigQueryReportingWarehouseSinkV1 {
  if (!NAME.test(options.name)) throw new TypeError('Warehouse sink name must be a bounded non-secret identifier');
  if (options.projectId !== undefined && !PROJECT.test(options.projectId)) {
    throw new TypeError('BigQuery projectId is invalid');
  }
  for (const [label, value] of [
    ['datasetId', options.datasetId],
    ['rowsTableId', options.rowsTableId],
    ['revisionsTableId', options.revisionsTableId],
  ] as const) {
    if (!DATASET_OR_TABLE.test(value)) throw new TypeError(`BigQuery ${label} is invalid`);
  }
  const loadTimeout = options.loadTimeoutMilliseconds ?? 600_000;
  if (!Number.isSafeInteger(loadTimeout) || loadTimeout < 1_000 || loadTimeout > MAX_LOAD_TIMEOUT) {
    throw new RangeError('loadTimeoutMilliseconds must be between 1 second and 6 hours');
  }
  const maxRevisions = options.maxRevisionsPerBatch ?? 200;
  if (!Number.isSafeInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > 10_000) {
    throw new RangeError('maxRevisionsPerBatch must be between 1 and 10000');
  }
  if (options.labels && Object.keys(options.labels).length > 0 && !warnedLabelsIgnored) {
    warnedLabelsIgnored = true;
    process.emitWarning(
      "BigQuery warehouse sink option `labels` has no effect: BigQuery ignores labels inside a load job's configuration.load and the official client cannot set configuration.labels for local-file loads. Attribute cost through INFORMATION_SCHEMA.JOBS by destination table or the adcp_rr_ job ID prefix.",
      { code: 'ADCP_BIGQUERY_SINK_LABELS_IGNORED', type: 'DeprecationWarning' }
    );
  }
  const tables = {
    projectId: options.projectId,
    datasetId: options.datasetId,
    rowsTableId: options.rowsTableId,
    revisionsTableId: options.revisionsTableId,
  };
  const dataset = options.bigquery.dataset(options.datasetId, {
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.location ? { location: options.location } : {}),
  });
  const matchesPlan = `WHERE sink_name = $1
    AND committed_cursor IS NOT DISTINCT FROM $2
    AND planned_from_cursor IS NOT DISTINCT FROM $2
    AND planned_to_cursor = $3 AND planned_revisions = $4::jsonb
    AND planned_rows_attempt = $5 AND planned_revisions_attempt = $6
    AND reset_generation = $7`;
  const stalePlan = () => new Error('Warehouse sink plan changed during an overlapping run; retry runOnce()');

  const jobOptions =
    options.projectId || options.location
      ? {
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.location ? { location: options.location } : {}),
        }
      : undefined;

  /** Uploads submitted by this process and not yet settled, by job ID, so a rerun can wait on one. */
  const uploads = new Map<string, UploadEntry>();

  /**
   * Write the lines to a temporary file and submit the load. The temporary directory goes away when the
   * upload settles, or when a later run replaces an upload that never settled (the client opened the file
   * when it started, so deleting it does not disturb a running upload).
   */
  function startUpload(tableId: string, jobId: string, lines: string[]): Promise<unknown> {
    const entry: UploadEntry = {
      startedAt: Date.now(),
      done: Promise.resolve(),
    };
    const cleanup = async () => {
      if (uploads.get(jobId) === entry) uploads.delete(jobId);
      if (entry.directory) await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => {});
    };
    entry.done = (async () => {
      const directory = await fs.mkdtemp(path.join(tmpdir(), 'adcp-warehouse-'));
      entry.directory = directory;
      const file = path.join(directory, `${jobId}.ndjson`);
      await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
      return dataset.table(tableId).load(file, {
        jobId,
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_APPEND',
        ...(options.location ? { location: options.location } : {}),
      });
    })();
    const replaced = uploads.get(jobId);
    uploads.set(jobId, entry);
    // Settling is handled here, so an abandoned upload that later fails is never an unhandled rejection.
    void entry.done.then(cleanup, cleanup);
    if (replaced?.directory) void fs.rm(replaced.directory, { recursive: true, force: true }).catch(() => {});
    return entry.done;
  }

  /**
   * Look the job up in the destination project and location. `missing` is a 404;
   * a job that finished with an error throws the retryable failure; anything not
   * DONE (PENDING, RUNNING, or a response without a state) is `running`.
   */
  async function jobStatus(
    jobId: string,
    signal?: AbortSignal,
    boundMilliseconds = loadTimeout,
    context?: string
  ): Promise<'missing' | 'done' | 'running'> {
    let metadata: unknown;
    try {
      metadata = await withinDeadline(
        () => options.bigquery.job(jobId, jobOptions).getMetadata(),
        boundMilliseconds,
        signal,
        context
      );
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 404) return 'missing';
      throw error;
    }
    const record = (Array.isArray(metadata) ? metadata[0] : metadata) as
      | { status?: { state?: string; errorResult?: unknown } }
      | undefined;
    if (record?.status?.state !== 'DONE') return 'running';
    if (record.status.errorResult) {
      const failure = new Error('A BigQuery load job for this batch failed; it will be retried as a new attempt');
      Object.defineProperty(failure, 'adcpJobFailed', { value: true });
      throw failure;
    }
    return 'done';
  }

  /**
   * Load one table's lines under a deterministic job ID. The job is looked up
   * first, so a job a previous run created (even one whose upload outlasted that
   * run's deadline) is accepted or waited for and never uploaded twice. The
   * deadline starts after that lookup and bounds this run only: a load that
   * outlasts it rejects with `adcpLoadTimedOut` and nothing is cancelled.
   * Errors name the table (role and ID) and its timeout count, which is the
   * table's own: the rows and revisions tables grow their deadlines separately.
   */
  async function loadOnce(
    role: 'rows' | 'revisions',
    tableId: string,
    jobId: string,
    lines: string[],
    timeouts: number,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    const table = `the ${role} table "${tableId}" (timeout count ${timeouts})`;
    let status = await jobStatus(jobId, signal, loadTimeout, table);
    if (status === 'done') return;
    const loadDeadline = reportingWarehouseLoadDeadlineV1(loadTimeout, timeouts);
    const deadlineAt = Date.now() + loadDeadline;
    const timedOut = (what: string) => {
      const error = new Error(
        `${what} exceeded this run's ${loadDeadline} ms deadline for ${table}; the next run checks the job again`
      );
      Object.defineProperty(error, 'adcpDeadlineExceeded', { value: true });
      Object.defineProperty(error, 'adcpLoadTimedOut', { value: true });
      return error;
    };
    if (status === 'missing') {
      try {
        // An upload an earlier run abandoned at its deadline is still running in this process (the client
        // takes no abort signal), so wait for it, within this run's deadline, instead of starting another
        // upload of the same file. How long ago it started does not matter: that age includes the gap
        // between runs. A map entry exists only while its upload is pending, so only a hung upload older
        // than the largest deadline any run can have is abandoned and replaced. BigQuery refuses a
        // duplicate job ID, so a replacement can never load the batch twice.
        const running = uploads.get(jobId);
        const upload =
          running && Date.now() - running.startedAt < MAX_LOAD_TIMEOUT
            ? running.done
            : startUpload(tableId, jobId, lines);
        await withinDeadline(() => upload, Math.max(deadlineAt - Date.now(), 1), signal);
        return;
      } catch (error) {
        if (isDeadlineExceeded(error)) throw timedOut('Uploading the load');
        if (!isAlreadyExists(error)) throw error;
        // The job exists (a crash or timeout after submission, or a concurrent run). Check how it ended.
        status = await jobStatus(jobId, signal, loadTimeout, table);
        if (status === 'missing') {
          throw new Error(
            'BigQuery refused the load job ID as already existing, but the job cannot be found. Check that projectId ' +
              'and location match the dataset (location is required for datasets outside the US and EU multi-regions)',
            { cause: error }
          );
        }
      }
    }
    // The job is pending or running: wait for it, never upload again.
    const pollMilliseconds = Math.min(5_000, Math.max(250, Math.floor(loadDeadline / 10)));
    while (status !== 'done') {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw timedOut('Waiting for the running load job');
      await sleep(Math.min(pollMilliseconds, remaining), signal);
      const bound = Math.max(Math.min(loadTimeout, deadlineAt - Date.now()), 1);
      try {
        status = await jobStatus(jobId, signal, bound, table);
      } catch (error) {
        // A status call cut short by this run's remaining time is the run's deadline, not a failed check.
        if (isDeadlineExceeded(error) && bound < loadTimeout) throw timedOut('Waiting for the running load job');
        throw error;
      }
      if (status === 'missing') throw new Error('A BigQuery load job for this batch disappeared while it was awaited');
    }
  }

  return {
    defaultTablesSql: reportingWarehouseDefaultTablesSqlV1(tables),
    currentRowsViewSql: reportingWarehouseCurrentRowsViewSqlV1(tables),
    async reset(resetOptions = {}) {
      const removeConsumer = options.store.removeFeedConsumer?.bind(options.store);
      if (!removeConsumer) {
        throw new TypeError('reset() needs a store with removeFeedConsumer (PostgresReportingLedgerStore has it)');
      }
      const cleared = await options.db
        .query(
          `UPDATE adcp_reporting_warehouse_sinks
            SET committed_cursor = NULL, planned_from_cursor = NULL, planned_to_cursor = NULL,
                planned_revisions = NULL, planned_rows_attempt = 0, planned_revisions_attempt = 0,
                planned_rows_timeouts = 0, planned_revisions_timeouts = 0,
                reset_generation = reset_generation + 1, updated_at = clock_timestamp()
          WHERE sink_name = $1 AND ($2::boolean OR planned_to_cursor IS NULL)
          RETURNING sink_name`,
          [options.name, resetOptions.discardRetainedPlan === true]
        )
        .catch(missingMigration);
      if (cleared.rows.length === 0) {
        const exists = await options.db.query(`SELECT 1 FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1`, [
          options.name,
        ]);
        if (exists.rows.length > 0) {
          throw new Error(
            'Warehouse sink has a retained batch plan whose load jobs may have succeeded; reconcile it against BigQuery, then call reset({ discardRetainedPlan: true })'
          );
        }
      }
      // Drop the old checkpoint's retention hold; the next committed batch registers a fresh one.
      try {
        await removeConsumer(options.name);
      } catch (cause) {
        throw new Error(
          'Warehouse sink state was cleared but its feed consumer could not be unregistered; call reset() again before restarting workers',
          { cause }
        );
      }
      return { cleared: cleared.rows.length > 0 };
    },
    async runOnce(runOptions = {}) {
      const signal = runOptions.signal;
      await options.db.query(
        `INSERT INTO adcp_reporting_warehouse_sinks (sink_name) VALUES ($1) ON CONFLICT DO NOTHING`,
        [options.name]
      );
      const state = (
        await options.db
          .query<{
            committed_cursor: string | null;
            planned_from_cursor: string | null;
            planned_to_cursor: string | null;
            planned_revisions: { id: string; account_id: string }[] | null;
            planned_rows_attempt: number;
            planned_revisions_attempt: number;
            planned_rows_timeouts: number;
            planned_revisions_timeouts: number;
            reset_generation: number;
          }>(
            `SELECT committed_cursor, planned_from_cursor, planned_to_cursor, planned_revisions,
                  planned_rows_attempt, planned_revisions_attempt,
                  planned_rows_timeouts, planned_revisions_timeouts, reset_generation
             FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1`,
            [options.name]
          )
          .catch(missingMigration)
      ).rows[0]!;
      if (state.planned_to_cursor !== null && state.planned_from_cursor !== state.committed_cursor) {
        throw new Error(
          'Warehouse sink has an inconsistent retained plan; reconcile the plan and BigQuery jobs before resuming'
        );
      }
      if (options.account_id && state.planned_revisions?.some(planned => planned.account_id !== options.account_id)) {
        throw new Error(
          'Warehouse sink has a retained plan for another account; this sink name is shared across feed scopes'
        );
      }
      let plan =
        state.planned_to_cursor && state.planned_revisions
          ? {
              from: state.planned_from_cursor,
              to: state.planned_to_cursor,
              revisions: state.planned_revisions,
              rowsAttempt: state.planned_rows_attempt,
              revisionsAttempt: state.planned_revisions_attempt,
              rowsTimeouts: state.planned_rows_timeouts,
              revisionsTimeouts: state.planned_revisions_timeouts,
            }
          : undefined;
      if (!plan) {
        const position = {
          ...(state.committed_cursor ? { cursor: state.committed_cursor } : {}),
          ...(options.account_id ? { account_id: options.account_id } : {}),
          limit: maxRevisions,
        };
        let page: Awaited<ReturnType<typeof options.store.changesAfter>>;
        let readCursor = position.cursor;
        try {
          page = await options.store.changesAfter({ ...position, kinds: ['revision'] });
          if (page.records.length === 0) {
            // Drain changes that do not require a warehouse load, so idle
            // heartbeats cannot indefinitely hold an unread non-revision tail.
            // Preserve the first read's retention horizon on cold start.
            readCursor = page.cursor;
            page = await options.store.changesAfter({ ...position, cursor: readCursor });
          }
        } catch (error) {
          // Compare the code, not the class: the store and the sink may load
          // through different module formats (CJS and ESM).
          if ((error as { code?: unknown } | null)?.code === 'CURSOR_EXPIRED' && state.committed_cursor === null) {
            const cursor = readCursor ?? (error as { cursor?: unknown }).cursor;
            if (cursor !== undefined && typeof cursor !== 'string') throw error;
            if (cursor !== undefined) {
              try {
                decodeReportingChangeCursorV1(cursor, position.account_id ?? null);
              } catch {
                throw error;
              }
              // Keep a failed bootstrap's starting position across restarts.
              // A newer horizon must not turn this explicit gap into an idle
              // success. No acknowledgment or retention heartbeat is saved.
              await options.db.query(
                `UPDATE adcp_reporting_warehouse_sinks SET committed_cursor = $2, updated_at = clock_timestamp()
                  WHERE sink_name = $1 AND committed_cursor IS NULL AND reset_generation = $3
                    AND planned_from_cursor IS NULL AND planned_to_cursor IS NULL AND planned_revisions IS NULL`,
                [options.name, cursor, state.reset_generation]
              );
            }
          }
          throw error;
        }
        if (page.records.length === 0 && page.cursor === state.committed_cursor) {
          // Recover a lost acknowledgment without renewing an unchanged
          // hold. A deployment feed can look empty behind its xmin fence.
          if (state.committed_cursor) {
            await options.store.saveFeedConsumerCursor(options.name, state.committed_cursor, {
              refreshUnchanged: false,
            });
          }
          return { idle: true, revisions: 0, rows: 0, missing: [] };
        }
        plan = {
          from: state.committed_cursor,
          to: page.cursor,
          revisions: page.records
            .filter(record => record.kind === 'revision')
            .map(record => ({ id: record.record_id, account_id: record.account_id })),
          rowsAttempt: 0,
          revisionsAttempt: 0,
          rowsTimeouts: 0,
          revisionsTimeouts: 0,
        };
        const claimed = await options.db.query(
          `UPDATE adcp_reporting_warehouse_sinks
              SET planned_from_cursor = $2, planned_to_cursor = $3, planned_revisions = $4::jsonb,
                  planned_rows_attempt = 0, planned_revisions_attempt = 0,
                  planned_rows_timeouts = 0, planned_revisions_timeouts = 0, updated_at = clock_timestamp()
            WHERE sink_name = $1 AND committed_cursor IS NOT DISTINCT FROM $2
              AND planned_to_cursor IS NULL AND planned_revisions IS NULL AND reset_generation = $5
            RETURNING sink_name`,
          [options.name, plan.from, plan.to, JSON.stringify(plan.revisions), state.reset_generation]
        );
        if (claimed.rows.length === 0) throw stalePlan();
      }
      const planValues = [
        options.name,
        plan.from,
        plan.to,
        JSON.stringify(plan.revisions),
        plan.rowsAttempt,
        plan.revisionsAttempt,
        state.reset_generation,
      ];

      const rowLines: string[] = [];
      const revisionLines: string[] = [];
      const missing: string[] = [];
      // Resolve every revision's metadata and period date before reading any rows, so a revision
      // that cannot be dated fails the batch immediately instead of after re-reading the rows of
      // the revisions ahead of it on every retry.
      const resolved: {
        planned: (typeof plan.revisions)[number];
        revision: ReportingLedgerRevisionMetadataV1;
        periodDate: string;
      }[] = [];
      for (const planned of plan.revisions) {
        signal?.throwIfAborted();
        const revision = await options.store.getRevisionMetadata(planned.id, planned.account_id);
        // Retired before this batch ran: its period no longer exists in the
        // ledger, so the sink fell behind retention. Report it, never drop it silently.
        if (!revision) {
          missing.push(planned.id);
          continue;
        }
        resolved.push({ planned, revision, periodDate: periodDateOf(revision) });
      }
      for (const { planned, revision, periodDate } of resolved) {
        signal?.throwIfAborted();
        const base = {
          reporting_revision_id: revision.reporting_revision_id,
          reporting_obligation_id: revision.reporting_obligation_id,
          account_id: planned.account_id,
          revision_number: revision.revisionNumber,
          finality: revision.finality,
          period_date: periodDate,
        };
        for (let offset = 0; offset < revision.binding.rowCount; ) {
          const page = await options.store.readRevisionRows({
            reporting_revision_id: revision.reporting_revision_id,
            account_id: planned.account_id,
            offset,
            limit: 5_000,
            ...(signal ? { signal } : {}),
          });
          if (!page || page.rows.length === 0) throw new Error('Reporting revision rows ended early');
          page.rows.forEach((row, index) => {
            const ordinal = offset + index;
            const mapped = options.mapRow ? options.mapRow(row, { revision, ordinal }) : { row };
            rowLines.push(JSON.stringify({ ...mapped, ...base, ordinal }));
          });
          offset += page.rows.length;
        }
        revisionLines.push(
          JSON.stringify({
            ...base,
            supersedes_reporting_revision_id: revision.supersedes_reporting_revision_id ?? null,
            period_start: revision.wireRevision.period.start,
            period_end: revision.wireRevision.period.end,
            source_timezone: revision.wireRevision.period.source_timezone,
            observed_at: revision.observedAt,
            data_through: revision.dataThrough,
            revision_content_sha256: revision.binding.sha256,
            row_count: revision.binding.rowCount,
            control_totals: revision.wireRevision.control_totals ?? [],
          })
        );
      }

      const baseJobId = reportingWarehouseJobIdV1(options.name, plan.from, plan.to, state.reset_generation);
      const suffix = (attempt: number) => (attempt ? `_a${attempt}` : '');
      // Rows first, then revisions: a revision row implies its rows landed,
      // and `current_rows` joins through the revisions table. A rows job that
      // already succeeded is recognised by its job ID and never re-run.
      const steps = [
        {
          table: options.rowsTableId,
          role: 'rows',
          kind: 'rows',
          lines: rowLines,
          attempt: plan.rowsAttempt,
          timeouts: plan.rowsTimeouts,
          timeoutColumn: 'planned_rows_timeouts',
          attemptColumn: 'planned_rows_attempt',
        },
        {
          table: options.revisionsTableId,
          role: 'revisions',
          kind: 'revs',
          lines: revisionLines,
          attempt: plan.revisionsAttempt,
          timeouts: plan.revisionsTimeouts,
          timeoutColumn: 'planned_revisions_timeouts',
          attemptColumn: 'planned_revisions_attempt',
        },
      ] as const;
      for (const step of steps) {
        if (!step.lines.length) continue;
        try {
          await loadOnce(
            step.role,
            step.table,
            `${baseJobId}_${step.kind}${suffix(step.attempt)}`,
            [...step.lines],
            step.timeouts,
            signal
          );
        } catch (error) {
          if (isFinishedWithError(error)) {
            // Only a job BigQuery reports as finished with an error changes the job ID.
            await options.db.query(
              `UPDATE adcp_reporting_warehouse_sinks SET ${step.attemptColumn} = ${step.attemptColumn} + 1,
                      updated_at = clock_timestamp() ${matchesPlan}`,
              planValues
            );
          } else if (isLoadTimedOut(error)) {
            // The job may exist in the background, so the job ID stays; the table's next run gets a longer
            // deadline. Conditioning on the value this run read lets overlapping runs grow it once.
            await options.db.query(
              `UPDATE adcp_reporting_warehouse_sinks
                  SET ${step.timeoutColumn} = $8::integer + 1, updated_at = clock_timestamp()
                ${matchesPlan} AND ${step.timeoutColumn} = $8::integer`,
              [...planValues, step.timeouts]
            );
          }
          throw error;
        }
      }
      const committed = await options.db.query(
        `UPDATE adcp_reporting_warehouse_sinks
            SET committed_cursor = $3, planned_from_cursor = NULL, planned_to_cursor = NULL,
                planned_revisions = NULL, planned_rows_attempt = 0, planned_revisions_attempt = 0,
                planned_rows_timeouts = 0, planned_revisions_timeouts = 0, updated_at = clock_timestamp()
          ${matchesPlan} RETURNING sink_name`,
        planValues
      );
      if (committed.rows.length === 0) throw stalePlan();
      await options.store.saveFeedConsumerCursor(options.name, plan.to);
      return { idle: plan.revisions.length === 0, revisions: revisionLines.length, rows: rowLines.length, missing };
    },
  };
}

interface UploadEntry {
  startedAt: number;
  done: Promise<unknown>;
  directory?: string;
}

/** 42703 undefined_column: a sink table created before `reset_generation` or the deadline columns existed. */
function missingMigration(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === '42703') {
    throw new Error(
      'The adcp_reporting_warehouse_sinks table is missing columns; apply REPORTING_WAREHOUSE_SINK_MIGRATION again (it is idempotent)',
      { cause: error }
    );
  }
  throw error;
}

/**
 * How long one run may upload a file or wait for a running job: the configured
 * base doubled once per earlier timeout of that table's load, capped at 6 hours.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingWarehouseLoadDeadlineV1(baseMilliseconds: number, timeouts: number): number {
  return Math.min(baseMilliseconds * 2 ** Math.min(Math.max(timeouts, 0), MAX_TIMEOUT_DOUBLINGS), MAX_LOAD_TIMEOUT);
}

/**
 * Deterministic load job ID for one planned change-feed range.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingWarehouseJobIdV1(name: string, from: string | null, to: string, generation = 0): string {
  // Generation 0 hashes exactly as before, so job IDs of in-flight plans survive an upgrade.
  return `adcp_rr_${createHash('sha256')
    .update(JSON.stringify(generation > 0 ? [name, from, to, generation] : [name, from, to]))
    .digest('hex')
    .slice(0, 40)}`;
}

interface WarehouseTablesV1 {
  projectId?: string;
  datasetId: string;
  rowsTableId: string;
  revisionsTableId: string;
}

function qualified(tables: WarehouseTablesV1, table: string): string {
  return `\`${tables.projectId ? `${tables.projectId}.` : ''}${tables.datasetId}.${table}\``;
}

/**
 * DDL for the default warehouse tables: partitioned by period date, clustered by account and revision.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingWarehouseDefaultTablesSqlV1(tables: WarehouseTablesV1): string {
  return `
CREATE TABLE IF NOT EXISTS ${qualified(tables, tables.rowsTableId)} (
  reporting_revision_id STRING NOT NULL,
  reporting_obligation_id STRING NOT NULL,
  account_id STRING NOT NULL,
  revision_number INT64 NOT NULL,
  finality STRING NOT NULL,
  period_date DATE,
  ordinal INT64 NOT NULL,
  row JSON
)
PARTITION BY period_date
CLUSTER BY account_id, reporting_revision_id;

CREATE TABLE IF NOT EXISTS ${qualified(tables, tables.revisionsTableId)} (
  reporting_revision_id STRING NOT NULL,
  reporting_obligation_id STRING NOT NULL,
  account_id STRING NOT NULL,
  revision_number INT64 NOT NULL,
  finality STRING NOT NULL,
  period_date DATE,
  supersedes_reporting_revision_id STRING,
  period_start TIMESTAMP,
  period_end TIMESTAMP,
  source_timezone STRING,
  observed_at TIMESTAMP,
  data_through TIMESTAMP,
  revision_content_sha256 STRING NOT NULL,
  row_count INT64 NOT NULL,
  control_totals JSON
)
PARTITION BY period_date
CLUSTER BY account_id, reporting_obligation_id;`.trim();
}

/**
 * DDL for the reference `current_rows` view: only each obligation's current
 * revision (its official revision, otherwise its latest snapshot). Summing
 * cumulative snapshots across revisions double-counts; query this view.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function reportingWarehouseCurrentRowsViewSqlV1(tables: WarehouseTablesV1 & { viewId?: string }): string {
  const view = tables.viewId ?? 'current_rows';
  if (!DATASET_OR_TABLE.test(view)) throw new TypeError('BigQuery viewId is invalid');
  return `
CREATE OR REPLACE VIEW ${qualified(tables, view)} AS
SELECT row_data.*
  FROM ${qualified(tables, tables.rowsTableId)} AS row_data
  JOIN (
    SELECT reporting_obligation_id,
           ARRAY_AGG(reporting_revision_id ORDER BY revision_number DESC LIMIT 1)[OFFSET(0)] AS reporting_revision_id
      FROM ${qualified(tables, tables.revisionsTableId)}
     GROUP BY reporting_obligation_id
  ) AS current_revision
 USING (reporting_obligation_id, reporting_revision_id);`.trim();
}

/**
 * The row's `period_date`: the calendar date of the period start in the period's `source_timezone`,
 * as `YYYY-MM-DD`, via the same helper that renders object-key dates. It fails the batch rather
 * than guess: a missing or unusable timezone must not become a UTC date that partitions the
 * period into the wrong day. It is the start's date only, not a coverage range: a period that
 * crosses local midnight, or spans several days, is still one `period_date`.
 */
function periodDateOf(revision: ReportingLedgerRevisionMetadataV1): string {
  const period = revision.wireRevision.period;
  try {
    if (!period) throw new TypeError('the revision carries no period');
    return reportingPeriodDate(period.start, period.source_timezone);
  } catch (error) {
    throw new Error(
      `Cannot compute period_date for revision ${revision.reporting_revision_id}: ` +
        `${error instanceof Error ? error.message : String(error)}. The batch stays retained and every run fails ` +
        `until the revision's period is repaired (or, if this runtime's timezone data is older than the writer's, ` +
        `until it is upgraded); reset({ discardRetainedPlan: true }) restarts from the beginning, so empty the ` +
        `destination tables first.`,
      { cause: error }
    );
  }
}

/**
 * Bound one client call by a deadline and the caller's signal. The official
 * client takes no abort signal, so an abandoned call may still complete in
 * the background; deterministic job IDs make that harmless.
 */
async function withinDeadline<T>(
  operation: () => Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
  context?: string
): Promise<T> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `BigQuery call exceeded its deadline${context ? ` of ${milliseconds} ms for ${context}` : ''}; the batch will be retried`
          );
          Object.defineProperty(error, 'adcpDeadlineExceeded', { value: true });
          reject(error);
        }, milliseconds);
        if (signal) {
          onAbort = () => reject(signal.reason ?? new Error('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function isDeadlineExceeded(error: unknown): boolean {
  return (error as { adcpDeadlineExceeded?: unknown } | undefined)?.adcpDeadlineExceeded === true;
}

function isAlreadyExists(error: unknown): boolean {
  const record = error as { code?: unknown; errors?: { reason?: unknown }[] } | undefined;
  return record?.code === 409 || !!record?.errors?.some(entry => entry.reason === 'duplicate');
}

function isLoadTimedOut(error: unknown): boolean {
  return (error as { adcpLoadTimedOut?: unknown } | undefined)?.adcpLoadTimedOut === true;
}

/** Sleep, ending early (rejecting) when the caller aborts. */
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isFinishedWithError(error: unknown): boolean {
  return (error as { adcpJobFailed?: unknown } | undefined)?.adcpJobFailed === true;
}
