import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import type { PostgresReportingLedgerStore, ReportingLedgerRevisionMetadataV1, ReportingPgPool } from '../ledger';
import { decodeReportingChangeCursorV1 } from '../ledger/change-feed';

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
 * planned durably in PostgreSQL before any load. A crash between the load and
 * the cursor commit replays the same batch under the same job IDs, which
 * BigQuery refuses to run twice. A failed load job is retried under a new
 * attempt suffix only after BigQuery reports that job finished with an error,
 * and each table keeps its own attempt count, so no batch lands twice.
 * Concurrent runs claim one durable plan with compare-and-swap. Replays of
 * that plan share job IDs; stale runs cannot change its attempts or cursor.
 */

/** Apply after `REPORTING_LEDGER_CHANGES_MIGRATION`. Holds one row per sink. */
export const REPORTING_WAREHOUSE_SINK_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_warehouse_sinks (
  sink_name TEXT PRIMARY KEY CHECK (sink_name ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  committed_cursor TEXT,
  planned_from_cursor TEXT,
  planned_to_cursor TEXT,
  planned_revisions JSONB,
  planned_rows_attempt INTEGER NOT NULL DEFAULT 0 CHECK (planned_rows_attempt >= 0),
  planned_revisions_attempt INTEGER NOT NULL DEFAULT 0 CHECK (planned_revisions_attempt >= 0),
  reset_generation INTEGER NOT NULL DEFAULT 0 CHECK (reset_generation >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((planned_to_cursor IS NULL) = (planned_revisions IS NULL))
);
ALTER TABLE adcp_reporting_warehouse_sinks
  ADD COLUMN IF NOT EXISTS reset_generation INTEGER NOT NULL DEFAULT 0 CHECK (reset_generation >= 0);
`.trim();

/** Structural subset of the official `@google-cloud/bigquery` client the sink uses. */
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
    /** Request cancellation. Optional so wrappers written before the sink used it still type-check. */
    cancel?(): Promise<unknown>;
  };
  query(options: { query: string; location?: string }): Promise<unknown>;
}

export interface ReportingWarehouseRowContextV1 {
  revision: ReportingLedgerRevisionMetadataV1;
  ordinal: number;
}

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
  /** Dataset location, so jobs run in the dataset's region. */
  location?: string;
  /** Restrict the sink to one account; omit for the deployment-wide feed. */
  account_id?: string;
  /**
   * Map one verified report row to the adopter's columns. The sink always adds
   * `reporting_revision_id`, `reporting_obligation_id`, `account_id`,
   * `revision_number`, `finality`, `period_date` and `ordinal`. Default: the
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
   * Deadline for one load (and for each status check). Default 10 minutes.
   * When a load exceeds it, the sink asks BigQuery to cancel that job by its
   * deterministic ID (in `projectId` and `location`) and rejects, leaving the
   * plan in place. The next run finds the cancelled job finished with an
   * error, advances that table's attempt and rejects; the run after that
   * loads under the new attempt. If the cancel has not taken effect yet the
   * next run waits for the job. Each attempt doubles the load deadline (up to
   * 6 hours), so a load that is slow but healthy converges; set this above
   * your slowest expected load to avoid the cancelled attempts. A status
   * check that times out is not cancelled. This is a client-side deadline:
   * BigQuery's server-side `jobTimeoutMs` cannot be set on a local-file load
   * through the official client, and cancellation is best effort.
   */
  loadTimeoutMilliseconds?: number;
}

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
   * history. Nothing holds change retention between `reset()` and the first
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
let warnedLabelsIgnored = false;
const PROJECT = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
const DATASET_OR_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

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

  /**
   * Best effort: ask BigQuery to stop a load the client gave up on. Failures
   * never replace the deadline error, because the plan and deterministic job
   * ID make a job that keeps running harmless. A failure other than "not
   * found" (the job was never submitted) is surfaced as a process warning so
   * an operator can see a job that may still be running and billing.
   */
  async function cancelLoad(jobId: string, signal?: AbortSignal): Promise<void> {
    try {
      const job = options.bigquery.job(jobId, jobOptions);
      if (typeof job.cancel !== 'function') return;
      const cancel = job.cancel.bind(job);
      await withinDeadline(cancel, Math.min(loadTimeout, 30_000), signal);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 404 || signal?.aborted) return;
      process.emitWarning(
        `Cancelling BigQuery load job ${jobId} failed (${typeof code === 'number' || typeof code === 'string' ? code : 'no status code'}); the job may still be running`,
        { code: 'ADCP_BIGQUERY_SINK_CANCEL_FAILED' }
      );
    }
  }

  async function loadOnce(
    tableId: string,
    jobId: string,
    lines: string[],
    attempt: number,
    signal?: AbortSignal
  ): Promise<void> {
    // Each attempt doubles the load deadline, so a load that is healthy but slower than the
    // deadline is cancelled at most a few times and then fits.
    const loadDeadline = Math.min(loadTimeout * 2 ** Math.min(attempt, 16), MAX_LOAD_TIMEOUT);
    signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'adcp-warehouse-'));
    const file = path.join(directory, `${jobId}.ndjson`);
    try {
      await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
      try {
        await withinDeadline(
          () =>
            dataset.table(tableId).load(file, {
              jobId,
              sourceFormat: 'NEWLINE_DELIMITED_JSON',
              writeDisposition: 'WRITE_APPEND',
              ...(options.location ? { location: options.location } : {}),
            }),
          loadDeadline,
          signal
        );
      } catch (error) {
        if (isDeadlineExceeded(error)) await cancelLoad(jobId, signal);
        if (!isAlreadyExists(error)) throw error;
        // The job ran before (a crash or timeout after submission, before the
        // cursor commit). Accept it only if it finished cleanly.
        const metadata = await withinDeadline(
          () => options.bigquery.job(jobId, jobOptions).getMetadata(),
          loadTimeout,
          signal
        );
        assertJobSucceeded(metadata);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
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
            reset_generation: number;
          }>(
            `SELECT committed_cursor, planned_from_cursor, planned_to_cursor, planned_revisions,
                  planned_rows_attempt, planned_revisions_attempt, reset_generation
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
        };
        const claimed = await options.db.query(
          `UPDATE adcp_reporting_warehouse_sinks
              SET planned_from_cursor = $2, planned_to_cursor = $3, planned_revisions = $4::jsonb,
                  planned_rows_attempt = 0, planned_revisions_attempt = 0, updated_at = clock_timestamp()
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
      for (const planned of plan.revisions) {
        signal?.throwIfAborted();
        const revision = await options.store.getRevisionMetadata(planned.id, planned.account_id);
        // Retired before this batch ran: its period no longer exists in the
        // ledger, so the sink fell behind retention. Report it, never drop it silently.
        if (!revision) {
          missing.push(planned.id);
          continue;
        }
        const periodDate = sourceLocalDate(
          revision.wireRevision.period?.start,
          revision.wireRevision.period?.source_timezone
        );
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
            period_start: revision.wireRevision.period?.start ?? null,
            period_end: revision.wireRevision.period?.end ?? null,
            source_timezone: revision.wireRevision.period?.source_timezone ?? null,
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
        { table: options.rowsTableId, kind: 'rows', lines: rowLines, attempt: plan.rowsAttempt },
        { table: options.revisionsTableId, kind: 'revs', lines: revisionLines, attempt: plan.revisionsAttempt },
      ] as const;
      for (const step of steps) {
        if (!step.lines.length) continue;
        try {
          await loadOnce(
            step.table,
            `${baseJobId}_${step.kind}${suffix(step.attempt)}`,
            [...step.lines],
            step.attempt,
            signal
          );
        } catch (error) {
          if (isFinishedWithError(error)) {
            const column = step.kind === 'rows' ? 'planned_rows_attempt' : 'planned_revisions_attempt';
            await options.db.query(
              `UPDATE adcp_reporting_warehouse_sinks SET ${column} = ${column} + 1,
                      updated_at = clock_timestamp() ${matchesPlan}`,
              planValues
            );
          }
          throw error;
        }
      }
      const committed = await options.db.query(
        `UPDATE adcp_reporting_warehouse_sinks
            SET committed_cursor = $3, planned_from_cursor = NULL, planned_to_cursor = NULL,
                planned_revisions = NULL, planned_rows_attempt = 0, planned_revisions_attempt = 0,
                updated_at = clock_timestamp()
          ${matchesPlan} RETURNING sink_name`,
        planValues
      );
      if (committed.rows.length === 0) throw stalePlan();
      await options.store.saveFeedConsumerCursor(options.name, plan.to);
      return { idle: plan.revisions.length === 0, revisions: revisionLines.length, rows: rowLines.length, missing };
    },
  };
}

/** 42703 undefined_column: a sink table created before `reset_generation` existed. */
function missingMigration(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === '42703') {
    throw new Error(
      'The adcp_reporting_warehouse_sinks table is missing columns; apply REPORTING_WAREHOUSE_SINK_MIGRATION again (it is idempotent)',
      { cause: error }
    );
  }
  throw error;
}

/** Deterministic load job ID for one planned change-feed range. */
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

/** DDL for the default warehouse tables: partitioned by period date, clustered by account and revision. */
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

function sourceLocalDate(start: string | undefined, timeZone: string | undefined): string | null {
  if (!start) return null;
  const instant = new Date(start);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
    return parts;
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/**
 * Bound one client call by a deadline and the caller's signal. The official
 * client takes no abort signal, so an abandoned call may still complete in
 * the background; deterministic job IDs make that harmless.
 */
async function withinDeadline<T>(operation: () => Promise<T>, milliseconds: number, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('BigQuery call exceeded its deadline; the batch will be retried');
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

function isFinishedWithError(error: unknown): boolean {
  return (error as { adcpJobFailed?: unknown } | undefined)?.adcpJobFailed === true;
}

function assertJobSucceeded(metadata: unknown): void {
  const record = (Array.isArray(metadata) ? metadata[0] : metadata) as
    | { status?: { state?: string; errorResult?: unknown } }
    | undefined;
  if (record?.status?.state !== 'DONE') {
    throw new Error('A BigQuery load job for this batch is still running; retry later');
  }
  if (record.status.errorResult) {
    const failure = new Error('A BigQuery load job for this batch failed; it will be retried as a new attempt');
    Object.defineProperty(failure, 'adcpJobFailed', { value: true });
    throw failure;
  }
}
