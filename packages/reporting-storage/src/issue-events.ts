/**
 * The issue-lifecycle event outbox over PostgreSQL (adcp-client#3648, the TypeScript side of
 * adcp-client-python#1874).
 *
 * Every write that changes whether a consumer statement conflicts with the seller's record (a
 * `sync_reporting_status` statement landing, a revision commit) records the resulting `opened` and
 * `resolved` events in `adcp_reporting_issue_events` inside the same transaction, so an event exists
 * exactly when its transition committed. The escalation sweep adds `escalated` once an open occurrence
 * passes `openedAt` plus the seller's `consumer_mismatch_escalation_seconds`. A worker claims pending
 * events under a lease, hands each to the issue observer, and stamps it delivered.
 *
 * An occurrence is `(issue_id, consumer_id)`: the read path's `issue_id` names the obligation and the causing
 * statement but not the consumer, and two consumers may reuse one `reporting_status_id`.
 * `UNIQUE (issue_id, consumer_id, kind)` makes the record exactly once across replicas, and `event_id` is
 * derived from that triple, so a redelivery carries the same `event_id`. The table is also the occurrence
 * ledger, so pruning removes whole resolved, fully delivered occurrences and never an open one.
 *
 * The table is installed by migration `0012` (`npx adcp-reporting-storage migrate`). Until it exists the
 * writes record nothing and `issueEventsReady()` is `false`; nothing else changes.
 */
import {
  compareReportingInstants,
  planReportingIssueEventsV1,
  reportingConsumerMismatchOccurrenceV1,
  reportingConsumerStatusChainKeyFromIdentityV1,
  reportingIssueEscalationV1,
} from '@adcp/sdk/reporting/ledger';
import type {
  ReportingConsumerMismatchOccurrenceV1,
  ReportingIssueEventKindV1,
  ReportingIssueEventLeaseV1,
  ReportingIssueEventRecordV1,
  ReportingLedgerConsumerStatementV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionMetadataV1,
  ReportingLedgerTransactionV1,
} from '@adcp/sdk/reporting/ledger';

/**
 * The issue-event outbox the issue observer reads: one new table and its indexes, nothing else. Applied as
 * migration `0012`. Idempotent.
 *
 * Additive only: no existing table, key, function or trigger changes, so processes of earlier releases,
 * which neither read nor write the table, keep running beside it. They record no events for the
 * transitions they make.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_ISSUE_EVENTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_issue_events (
  event_id TEXT PRIMARY KEY,
  -- Recording order. Every write here holds the account's advisory lock, so per account it is commit
  -- order, and the worker delivers one occurrence's events in this order.
  seq BIGSERIAL NOT NULL,
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  -- The consumer statement whose disagreement this occurrence is.
  reporting_status_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opened', 'escalated', 'acknowledged', 'waived', 'resolved')),
  -- When the transition took effect, as the exact RFC 3339 instant: opened_at, the escalation
  -- boundary, or when it resolved. Text, because a timestamptz would round a nanosecond opened_at and
  -- date an escalation before its boundary.
  occurred_at TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- The next delivery attempt; a failed attempt moves it forward.
  due_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  -- One occurrence is (issue_id, consumer_id): issue_id does not name the consumer, and two consumers may
  -- reuse one reporting_status_id. Each occurrence makes each transition at most once.
  UNIQUE (issue_id, consumer_id, kind),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_issue_events_pending
  ON adcp_reporting_issue_events (due_at, seq) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_issue_events_account_pending
  ON adcp_reporting_issue_events (account_id, due_at, seq) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_issue_events_issue_pending
  ON adcp_reporting_issue_events (issue_id, consumer_id, seq) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_issue_events_delivered
  ON adcp_reporting_issue_events (delivered_at) WHERE delivered_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS adcp_reporting_issue_events_obligation_opened
  ON adcp_reporting_issue_events (obligation_id) WHERE kind = 'opened';
CREATE INDEX IF NOT EXISTS adcp_reporting_issue_events_statement_opened
  ON adcp_reporting_issue_events (account_id, consumer_id, reporting_status_id) WHERE kind = 'opened';
`.trim();

type Client = ReportingLedgerTransactionV1;

const RFC3339 = (expression: string): string =>
  `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const RECORD_COLUMNS = `e.event_id, e.kind, e.issue_id, e.account_id, e.consumer_id, e.obligation_id,
  e.reporting_status_id, e.occurred_at`;

type RecordRow = Record<string, unknown> & {
  event_id: string;
  kind: ReportingIssueEventKindV1;
  issue_id: string;
  account_id: string;
  consumer_id: string;
  obligation_id: string;
  reporting_status_id: string;
  occurred_at: string;
};

function recordFromRow(row: RecordRow): ReportingIssueEventRecordV1 {
  return {
    eventId: row.event_id,
    kind: row.kind,
    issueId: row.issue_id,
    accountId: row.account_id,
    consumerId: row.consumer_id,
    reportingObligationId: row.obligation_id,
    reportingStatusId: row.reporting_status_id,
    occurredAt: row.occurred_at,
  };
}

/** Whether migration `0012` installed the outbox in this schema. */
export async function issueEventStorageOn(client: Pick<Client, 'query'>): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    "SELECT to_regclass(quote_ident(current_schema()) || '.adcp_reporting_issue_events') IS NOT NULL AS present"
  );
  return result.rows[0]?.present === true;
}

/** The database clock as an exact RFC 3339 instant. */
export async function databaseInstantOn(client: Client): Promise<string> {
  const result = await client.query<{ instant: string }>(`SELECT ${RFC3339('clock_timestamp()')} AS instant`);
  return result.rows[0]!.instant;
}

/** Insert each record unless its `(issue_id, consumer_id, kind)` is already recorded. Returns the rows inserted. */
async function recordOn(client: Client, records: readonly ReportingIssueEventRecordV1[]): Promise<number> {
  let recorded = 0;
  for (const record of records) {
    const result = await client.query(
      `INSERT INTO adcp_reporting_issue_events
         (event_id, account_id, consumer_id, issue_id, obligation_id, reporting_status_id, kind, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        record.eventId,
        record.accountId,
        record.consumerId,
        record.issueId,
        record.reportingObligationId,
        record.reportingStatusId,
        record.kind,
        record.occurredAt,
      ]
    );
    recorded += result.rowCount ?? 0;
  }
  return recorded;
}

const OPEN = `e.kind = 'opened' AND NOT EXISTS (
  SELECT 1 FROM adcp_reporting_issue_events resolved
   WHERE resolved.issue_id = e.issue_id AND resolved.consumer_id = e.consumer_id
     AND resolved.kind = 'resolved')`;

function statusMatchesObligation(
  status: ReportingLedgerConsumerStatementV1,
  obligation: ReportingLedgerObligationV1
): boolean {
  return (
    status.account_id === obligation.account.account_id &&
    status.delivery_config_id === obligation.delivery_config_id &&
    status.delivery_config_version === obligation.delivery_config_version &&
    status.report_definition_id === obligation.report_definition_id &&
    compareReportingInstants(status.period.start, obligation.period.start) === 0 &&
    compareReportingInstants(status.period.end, obligation.period.end) === 0 &&
    status.period.source_timezone === obligation.period.sourceTimezone
  );
}

async function revisionsOn(client: Client, obligationId: string): Promise<ReportingLedgerRevisionMetadataV1[]> {
  const result = await client.query<{ data: ReportingLedgerRevisionMetadataV1 }>(
    `SELECT data - 'rows' AS data FROM adcp_reporting_revisions WHERE obligation_id = $1 ORDER BY revision_number`,
    [obligationId]
  );
  return result.rows.map(row => row.data);
}

/**
 * Re-derive one obligation's occurrences after a write, in the writer's transaction (which holds the
 * account lock): open what conflicts now, resolve what no longer does or whose statement was superseded.
 * `at` is the write's instant. Returns the events recorded.
 */
export async function settleIssueObligationOn(client: Client, obligationId: string, at: string): Promise<number> {
  const obligation = (
    await client.query<{ data: ReportingLedgerObligationV1 }>(
      'SELECT data FROM adcp_reporting_obligations WHERE obligation_id = $1',
      [obligationId]
    )
  ).rows[0]?.data;
  let conflicts: ReportingConsumerMismatchOccurrenceV1[] = [];
  if (obligation) {
    const revisions = await revisionsOn(client, obligationId);
    const leaves = await client.query<{ data: ReportingLedgerConsumerStatementV1 }>(
      `SELECT data FROM adcp_reporting_consumer_statuses
        WHERE account_id = $1 AND chain_key = $2 AND is_current`,
      [
        obligation.account.account_id,
        reportingConsumerStatusChainKeyFromIdentityV1({
          delivery_config_id: obligation.delivery_config_id,
          delivery_config_version: obligation.delivery_config_version,
          report_definition_id: obligation.report_definition_id,
          periodStart: obligation.period.start,
          periodEnd: obligation.period.end,
          sourceTimezone: obligation.period.sourceTimezone,
        }),
      ]
    );
    conflicts = leaves.rows
      .map(row => row.data)
      .filter(leaf => statusMatchesObligation(leaf, obligation))
      .map(leaf => reportingConsumerMismatchOccurrenceV1(obligation, leaf, revisions))
      .filter((value): value is ReportingConsumerMismatchOccurrenceV1 => value !== undefined);
  }
  const open = await client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM adcp_reporting_issue_events e
      WHERE e.obligation_id = $1 AND ${OPEN} ORDER BY e.seq`,
    [obligationId]
  );
  return recordOn(client, planReportingIssueEventsV1({ open: open.rows.map(recordFromRow), conflicts, at }));
}

/**
 * After a statement lands, in the ingest transaction: resolve the occurrence of the leaf it superseded
 * (any open occurrence on its chain), and open one for it when it conflicts. Scoped to the statement's own
 * chain, so it resolves even when the obligation is gone.
 */
export async function settleIssueChainOn(
  client: Client,
  statement: ReportingLedgerConsumerStatementV1,
  chainKey: string
): Promise<number> {
  const candidates = await client.query<{ data: ReportingLedgerObligationV1 }>(
    `SELECT data FROM adcp_reporting_obligations
      WHERE account_id = $1 AND period_start = $2::timestamptz AND period_end = $3::timestamptz`,
    [statement.account_id, statement.period.start, statement.period.end]
  );
  const obligation = candidates.rows.map(row => row.data).find(value => statusMatchesObligation(statement, value));
  const occurrence = obligation
    ? reportingConsumerMismatchOccurrenceV1(
        obligation,
        statement,
        await revisionsOn(client, obligation.reporting_obligation_id)
      )
    : undefined;
  const open = await client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM adcp_reporting_issue_events e
      WHERE e.account_id = $1 AND e.consumer_id = $2
        AND e.reporting_status_id IN (
          SELECT consumer_status_id FROM adcp_reporting_consumer_statuses
           WHERE account_id = $1 AND consumer_id = $2 AND chain_key = $3)
        AND ${OPEN}
      ORDER BY e.seq`,
    [statement.account_id, statement.consumerId, chainKey]
  );
  return recordOn(
    client,
    planReportingIssueEventsV1({
      open: open.rows.map(recordFromRow),
      conflicts: occurrence ? [occurrence] : [],
      at: statement.recorded_at,
    })
  );
}

/**
 * Obligations with an open, unescalated occurrence past `openedAt + escalationSeconds`, oldest first.
 * Read outside the account lock; each is re-checked under it.
 */
export async function escalationCandidatesOn(
  client: Pick<Client, 'query'>,
  input: { escalationSeconds: number; accountId?: string; limit: number }
): Promise<Array<{ accountId: string; obligationId: string }>> {
  const result = await client.query<{ account_id: string; obligation_id: string }>(
    `SELECT e.account_id, e.obligation_id FROM adcp_reporting_issue_events e
      WHERE ($1::text IS NULL OR e.account_id = $1)
        AND e.occurred_at::timestamptz + make_interval(secs => $2) <= clock_timestamp()
        AND ${OPEN}
        AND NOT EXISTS (
          SELECT 1 FROM adcp_reporting_issue_events escalated
           WHERE escalated.issue_id = e.issue_id AND escalated.consumer_id = e.consumer_id
             AND escalated.kind = 'escalated')
      GROUP BY e.account_id, e.obligation_id
      ORDER BY MIN(e.seq)
      LIMIT $3`,
    [input.accountId ?? null, input.escalationSeconds, input.limit]
  );
  return result.rows.map(row => ({ accountId: row.account_id, obligationId: row.obligation_id }));
}

/**
 * Under the account lock: settle the obligation first, so a cleared condition resolves instead of
 * escalating, then record `escalated` for each occurrence still open past the boundary.
 */
export async function escalateObligationOn(
  client: Client,
  obligationId: string,
  escalationSeconds: number
): Promise<number> {
  const now = await databaseInstantOn(client);
  await settleIssueObligationOn(client, obligationId, now);
  const open = await client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM adcp_reporting_issue_events e
      WHERE e.obligation_id = $1 AND ${OPEN}
        AND NOT EXISTS (
          SELECT 1 FROM adcp_reporting_issue_events escalated
           WHERE escalated.issue_id = e.issue_id AND escalated.consumer_id = e.consumer_id
             AND escalated.kind = 'escalated')
      ORDER BY e.seq`,
    [obligationId]
  );
  const escalations = open.rows
    .map(recordFromRow)
    .map(value => reportingIssueEscalationV1(value, escalationSeconds, now))
    .filter((value): value is ReportingIssueEventRecordV1 => value !== undefined);
  return recordOn(client, escalations);
}

type LeaseRow = RecordRow & {
  recorded_at_text: string;
  attempts: number;
  lease_token: string;
  lease_expires_at_text: string;
  seq: string;
};

/**
 * Lease due events, at most one per occurrence, oldest first. An occurrence's events are claimable in
 * recording order: an event is claimable only once every earlier event of its occurrence was delivered.
 * `SKIP LOCKED` lets workers on several replicas claim disjoint events; an expired lease is claimable again.
 */
export async function claimOn(
  client: Client,
  input: { leaseMilliseconds: number; limit: number; accountId?: string; leaseToken: string }
): Promise<ReportingIssueEventLeaseV1[]> {
  const claimed = await client.query<LeaseRow>(
    `WITH due AS (
       SELECT e.event_id FROM adcp_reporting_issue_events e
        WHERE e.delivered_at IS NULL AND e.due_at <= clock_timestamp()
          AND ($3::text IS NULL OR e.account_id = $3)
          AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= clock_timestamp())
          AND NOT EXISTS (
            SELECT 1 FROM adcp_reporting_issue_events earlier
             WHERE earlier.issue_id = e.issue_id AND earlier.consumer_id = e.consumer_id
               AND earlier.delivered_at IS NULL AND earlier.seq < e.seq)
        ORDER BY e.due_at, e.seq
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE adcp_reporting_issue_events e
        SET lease_token = $2,
            lease_expires_at = clock_timestamp() + make_interval(secs => $4::double precision / 1000),
            attempts = e.attempts + 1
       FROM due WHERE e.event_id = due.event_id
     RETURNING ${RECORD_COLUMNS}, ${RFC3339('e.recorded_at')} AS recorded_at_text, e.attempts, e.lease_token,
       ${RFC3339('e.lease_expires_at')} AS lease_expires_at_text, e.seq`,
    [input.limit, input.leaseToken, input.accountId ?? null, input.leaseMilliseconds]
  );
  const rows = [...claimed.rows].sort((left, right) => Number(BigInt(left.seq) - BigInt(right.seq)));
  if (rows.length === 0) return [];
  const statements = await client.query<{
    account_id: string;
    consumer_id: string;
    consumer_status_id: string;
    data: ReportingLedgerConsumerStatementV1;
  }>(
    `SELECT s.account_id, s.consumer_id, s.consumer_status_id, s.data
       FROM adcp_reporting_consumer_statuses s
       JOIN unnest($1::text[], $2::text[], $3::text[]) AS wanted(account_id, consumer_id, consumer_status_id)
         ON s.account_id = wanted.account_id AND s.consumer_id = wanted.consumer_id
        AND s.consumer_status_id = wanted.consumer_status_id`,
    [rows.map(row => row.account_id), rows.map(row => row.consumer_id), rows.map(row => row.reporting_status_id)]
  );
  const byStatement = new Map(
    statements.rows.map(row => [[row.account_id, row.consumer_id, row.consumer_status_id].join('\u0000'), row.data])
  );
  return rows.map(row => {
    const statement = byStatement.get([row.account_id, row.consumer_id, row.reporting_status_id].join('\u0000'));
    return {
      ...recordFromRow(row),
      recordedAt: row.recorded_at_text,
      attempts: Number(row.attempts),
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at_text,
      ...(statement ? { statement } : {}),
    };
  });
}

/** Stamp a delivered event. `false` when the lease was lost to another worker. */
export async function completeOn(client: Pick<Client, 'query'>, lease: ReportingIssueEventLeaseV1): Promise<boolean> {
  const result = await client.query(
    `UPDATE adcp_reporting_issue_events
        SET delivered_at = clock_timestamp(), lease_token = NULL, lease_expires_at = NULL
      WHERE event_id = $1 AND lease_token = $2 AND delivered_at IS NULL`,
    [lease.eventId, lease.leaseToken]
  );
  return result.rowCount === 1;
}

/** Give a failed delivery back, due again `retryAfterMilliseconds` from now (the database clock). */
export async function releaseOn(
  client: Pick<Client, 'query'>,
  lease: ReportingIssueEventLeaseV1,
  retryAfterMilliseconds: number
): Promise<boolean> {
  const result = await client.query(
    `UPDATE adcp_reporting_issue_events
        SET due_at = clock_timestamp() + make_interval(secs => GREATEST($3::double precision, 0) / 1000),
            lease_token = NULL, lease_expires_at = NULL
      WHERE event_id = $1 AND lease_token = $2 AND delivered_at IS NULL`,
    [lease.eventId, lease.leaseToken, retryAfterMilliseconds]
  );
  return result.rowCount === 1;
}

/**
 * Delete up to `limit` whole occurrences that are resolved and whose every event was delivered more than
 * `olderThanMilliseconds` ago. Returns the events deleted. An open occurrence is never pruned: its `opened`
 * row is what a later write resolves and what the sweep escalates.
 */
export async function pruneOn(
  client: Pick<Client, 'query'>,
  input: { olderThanMilliseconds: number; limit: number }
): Promise<number> {
  const result = await client.query(
    `WITH horizon AS (
       SELECT clock_timestamp() - make_interval(secs => $1::double precision / 1000) AS before
     ), expired AS (
       SELECT r.issue_id, r.consumer_id
         FROM adcp_reporting_issue_events r, horizon
        WHERE r.kind = 'resolved' AND r.delivered_at IS NOT NULL AND r.delivered_at < horizon.before
          AND NOT EXISTS (
            SELECT 1 FROM adcp_reporting_issue_events other
             WHERE other.issue_id = r.issue_id AND other.consumer_id = r.consumer_id
               AND (other.delivered_at IS NULL OR other.delivered_at >= horizon.before))
        ORDER BY r.delivered_at
        LIMIT $2
     )
     DELETE FROM adcp_reporting_issue_events e USING expired
      WHERE e.issue_id = expired.issue_id AND e.consumer_id = expired.consumer_id`,
    [input.olderThanMilliseconds, input.limit]
  );
  return result.rowCount ?? 0;
}
