import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import type { PostgresReportingLedgerStore, ReportingLedgerRevisionMetadataV1, ReportingPgPool } from '../ledger';

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((planned_to_cursor IS NULL) = (planned_revisions IS NULL))
);
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
  job(jobId: string, options?: { location?: string }): { getMetadata(): Promise<unknown> };
  query(options: { query: string; location?: string }): Promise<unknown>;
}

export interface ReportingWarehouseRowContextV1 {
  revision: ReportingLedgerRevisionMetadataV1;
  ordinal: number;
}

export interface CreateBigQueryReportingWarehouseSinkOptionsV1 {
  /** Ledger store with `changeFeed: true`. */
  store: Pick<
    PostgresReportingLedgerStore,
    'changesAfter' | 'saveFeedConsumerCursor' | 'getRevisionMetadata' | 'readRevisionRows'
  >;
  /** PostgreSQL pool holding `REPORTING_WAREHOUSE_SINK_MIGRATION`. */
  db: Pick<ReportingPgPool, 'query'>;
  /** Host-constructed official BigQuery client. */
  bigquery: ReportingBigQueryClientV1;
  /** Stable sink name; also the registered change-feed consumer name. */
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
  /** Job labels for cost attribution. */
  labels?: Readonly<Record<string, string>>;
}

export interface BigQueryReportingWarehouseSinkV1 {
  /** Load at most one batch. Resolves with what was loaded; `idle` when nothing new committed. */
  runOnce(options?: { signal?: AbortSignal }): Promise<{ idle: boolean; revisions: number; rows: number }>;
  /** DDL for the default rows and revisions tables (partitioned and clustered). */
  readonly defaultTablesSql: string;
  /** DDL for the reference `current_rows` view. */
  readonly currentRowsViewSql: string;
}

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
  const maxRevisions = options.maxRevisionsPerBatch ?? 200;
  if (!Number.isSafeInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > 10_000) {
    throw new RangeError('maxRevisionsPerBatch must be between 1 and 10000');
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

  async function loadOnce(tableId: string, jobId: string, lines: string[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'adcp-warehouse-'));
    const file = path.join(directory, `${jobId}.ndjson`);
    try {
      await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '');
      try {
        await dataset.table(tableId).load(file, {
          jobId,
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: 'WRITE_APPEND',
          ...(options.location ? { location: options.location } : {}),
          ...(options.labels ? { labels: { ...options.labels } } : {}),
        });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        // The job ran before (a crash after the load, before the cursor
        // commit). Accept it only if it finished cleanly.
        const metadata = await options.bigquery
          .job(jobId, options.location ? { location: options.location } : undefined)
          .getMetadata();
        assertJobSucceeded(metadata);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  return {
    defaultTablesSql: reportingWarehouseDefaultTablesSqlV1(tables),
    currentRowsViewSql: reportingWarehouseCurrentRowsViewSqlV1(tables),
    async runOnce(runOptions = {}) {
      const signal = runOptions.signal;
      await options.db.query(
        `INSERT INTO adcp_reporting_warehouse_sinks (sink_name) VALUES ($1) ON CONFLICT DO NOTHING`,
        [options.name]
      );
      const state = (
        await options.db.query<{
          committed_cursor: string | null;
          planned_from_cursor: string | null;
          planned_to_cursor: string | null;
          planned_revisions: { id: string; account_id: string }[] | null;
          planned_rows_attempt: number;
          planned_revisions_attempt: number;
        }>(
          `SELECT committed_cursor, planned_from_cursor, planned_to_cursor, planned_revisions,
                  planned_rows_attempt, planned_revisions_attempt
             FROM adcp_reporting_warehouse_sinks WHERE sink_name = $1`,
          [options.name]
        )
      ).rows[0]!;
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
        const page = await options.store.changesAfter({
          ...(state.committed_cursor ? { cursor: state.committed_cursor } : {}),
          ...(options.account_id ? { account_id: options.account_id } : {}),
          kinds: ['revision'],
          limit: maxRevisions,
        });
        if (page.records.length === 0) {
          if (page.cursor !== state.committed_cursor) await commit(page.cursor);
          return { idle: true, revisions: 0, rows: 0 };
        }
        plan = {
          from: state.committed_cursor,
          to: page.cursor,
          revisions: page.records.map(record => ({ id: record.record_id, account_id: record.account_id })),
          rowsAttempt: 0,
          revisionsAttempt: 0,
        };
        await options.db.query(
          `UPDATE adcp_reporting_warehouse_sinks
              SET planned_from_cursor = $2, planned_to_cursor = $3, planned_revisions = $4::jsonb,
                  planned_rows_attempt = 0, planned_revisions_attempt = 0, updated_at = clock_timestamp()
            WHERE sink_name = $1`,
          [options.name, plan.from, plan.to, JSON.stringify(plan.revisions)]
        );
      }

      const rowLines: string[] = [];
      const revisionLines: string[] = [];
      for (const planned of plan.revisions) {
        signal?.throwIfAborted();
        const revision = await options.store.getRevisionMetadata(planned.id, planned.account_id);
        // Retired before this batch ran: its period no longer exists in the ledger.
        if (!revision) continue;
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

      const baseJobId = reportingWarehouseJobIdV1(options.name, plan.from, plan.to);
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
          await loadOnce(step.table, `${baseJobId}_${step.kind}${suffix(step.attempt)}`, [...step.lines], signal);
        } catch (error) {
          if (isFinishedWithError(error)) {
            const column = step.kind === 'rows' ? 'planned_rows_attempt' : 'planned_revisions_attempt';
            await options.db.query(
              `UPDATE adcp_reporting_warehouse_sinks SET ${column} = ${column} + 1,
                      updated_at = clock_timestamp() WHERE sink_name = $1`,
              [options.name]
            );
          }
          throw error;
        }
      }
      await commit(plan.to);
      return { idle: false, revisions: revisionLines.length, rows: rowLines.length };
    },
  };

  async function commit(cursor: string): Promise<void> {
    await options.db.query(
      `UPDATE adcp_reporting_warehouse_sinks
          SET committed_cursor = $2, planned_from_cursor = NULL, planned_to_cursor = NULL,
              planned_revisions = NULL, planned_rows_attempt = 0, planned_revisions_attempt = 0,
              updated_at = clock_timestamp()
        WHERE sink_name = $1`,
      [options.name, cursor]
    );
    await options.store.saveFeedConsumerCursor(options.name, cursor);
  }
}

/** Deterministic load job ID for one planned change-feed range. */
export function reportingWarehouseJobIdV1(name: string, from: string | null, to: string): string {
  return `adcp_rr_${createHash('sha256')
    .update(JSON.stringify([name, from, to]))
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
