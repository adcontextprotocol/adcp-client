import { ReportingRowStoreError } from './row-storage-errors';

/**
 * Host-facing reporting change feed (shared SDK persistence spec,
 * adcontextprotocol/adcp#7996 §2.1 and §3.7).
 *
 * Apply after {@link REPORTING_LEDGER_MIGRATION}; PostgreSQL 13 or later
 * (`xid8`). The store appends one row per committed obligation, revision,
 * adjustment and retirement in the same transaction as the record, taking the
 * sequence value only after the account lock, so per-account sequence order is
 * commit order. Deployment-wide readers order by `(xid, seq)` and stop below
 * the reading snapshot's `xmin`, so a slow commit is never skipped.
 */
export const REPORTING_LEDGER_CHANGES_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_changes (
  seq BIGSERIAL PRIMARY KEY,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  account_id TEXT NOT NULL,
  record_kind TEXT NOT NULL
    CHECK (record_kind IN ('obligation', 'revision', 'adjustment', 'retirement')),
  record_id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_changes_account
  ON adcp_reporting_changes (account_id, seq);
CREATE INDEX IF NOT EXISTS adcp_reporting_changes_deployment
  ON adcp_reporting_changes (xid, seq);
CREATE INDEX IF NOT EXISTS adcp_reporting_changes_recorded
  ON adcp_reporting_changes (recorded_at, seq);

-- Highest (xid, seq) ever pruned: a deployment-wide cursor below it may have
-- missed a deleted change and fails closed.
CREATE TABLE IF NOT EXISTS adcp_reporting_change_horizon (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  pruned_through_xid xid8 NOT NULL DEFAULT '0',
  pruned_through_seq BIGINT NOT NULL DEFAULT 0
);
INSERT INTO adcp_reporting_change_horizon (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;

-- Highest seq ever pruned per account: an account cursor below it fails closed.
CREATE TABLE IF NOT EXISTS adcp_reporting_change_account_horizon (
  account_id TEXT PRIMARY KEY,
  pruned_through_seq BIGINT NOT NULL
);

-- Registered consumers hold back pruning in their own feed order: account
-- consumers by seq within their account, deployment consumers by (xid, seq).
CREATE TABLE IF NOT EXISTS adcp_reporting_feed_consumers (
  consumer_name TEXT PRIMARY KEY CHECK (consumer_name ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  account_id TEXT,
  cursor_xid xid8,
  cursor_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((account_id IS NULL) = (cursor_xid IS NOT NULL))
);
`.trim();

export type ReportingChangeKindV1 = 'obligation' | 'revision' | 'adjustment' | 'retirement';

export interface ReportingChangeRecordV1 {
  kind: ReportingChangeKindV1;
  record_id: string;
  reporting_obligation_id: string;
  account_id: string;
  recorded_at: string;
}

export interface ReportingChangesPageV1 {
  records: ReportingChangeRecordV1[];
  /** Pass back to resume. Always present; equal to the input when nothing new committed. */
  cursor: string;
}

interface ChangeCursorV1 {
  v: 1;
  /** Account scope, or `null` for the deployment-wide feed. */
  account: string | null;
  seq: string;
  /** Deployment-wide feeds only: the writing transaction of the last record returned. */
  xid?: string;
}

export function encodeReportingChangeCursorV1(cursor: ChangeCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeReportingChangeCursorV1(value: string, account: string | null): ChangeCursorV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new ReportingRowStoreError('INVALID_INPUT', 'change cursor is malformed');
  }
  const cursor = parsed as Partial<ChangeCursorV1>;
  if (
    cursor.v !== 1 ||
    (cursor.account ?? null) !== account ||
    typeof cursor.seq !== 'string' ||
    !/^\d{1,19}$/.test(cursor.seq) ||
    (account === null ? typeof cursor.xid !== 'string' || !/^\d{1,20}$/.test(cursor.xid) : cursor.xid !== undefined)
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'change cursor does not belong to this feed');
  }
  return cursor as ChangeCursorV1;
}

/** Thrown when a change cursor is older than the retained change history. */
export class ReportingChangeCursorExpiredError extends Error {
  readonly code = 'CURSOR_EXPIRED' as const;
  constructor() {
    super('Reporting change cursor is older than the retained change history; resynchronize from current revisions');
    this.name = 'ReportingChangeCursorExpiredError';
  }
}
