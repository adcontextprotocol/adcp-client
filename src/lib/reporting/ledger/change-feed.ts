import { ReportingRowStoreError } from './row-storage-errors';

/**
 * Host-facing reporting change feed (shared SDK persistence spec,
 * adcontextprotocol/adcp#7996 §2.1 and §3.7).
 *
 * Apply after {@link REPORTING_LEDGER_MIGRATION}; PostgreSQL 13 or later
 * (`xid8`). The store appends one row per committed obligation, revision,
 * adjustment and retirement in the same transaction as the record. Deployment-wide
 * and account readers both order by `(xid, seq)` and stop below the reading
 * snapshot's `xmin`, so a slow commit is never skipped and no feed depends on the
 * account lock, or on the order a writer drew `seq` in, for its order. Account
 * cursors carry `xid`; a cursor from before that carried only `seq`, and
 * `changesAfter` maps it to a position that skips nothing. Use exactly one writer
 * SDK per ledger database.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_LEDGER_CHANGES_MIGRATION = `
-- Serialize concurrent appliers (several instances may run migrations at startup) so the guarded
-- constraint swap below cannot race. Released at the end of this implicit transaction; a runner that
-- splits the statements releases it early, which is harmless but serializes nothing.
SELECT pg_advisory_xact_lock(hashtextextended('adcp-reporting-changes-migration', 0));

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
-- Superseded by adcp_reporting_changes_account_xid for the account feed; kept so
-- re-applying this migration never drops an index. Drop it once no older host runs.
CREATE INDEX IF NOT EXISTS adcp_reporting_changes_account
  ON adcp_reporting_changes (account_id, seq);
CREATE INDEX IF NOT EXISTS adcp_reporting_changes_account_xid
  ON adcp_reporting_changes (account_id, xid, seq);
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

-- Highest (xid, seq) ever pruned per account: an account cursor below it fails
-- closed. pruned_through_seq is the highest seq pruned, whatever its xid. Account
-- feeds no longer read it; it exists so an account cursor from before the
-- (xid, seq) order, which carries no xid, can still be checked exactly.
CREATE TABLE IF NOT EXISTS adcp_reporting_change_account_horizon (
  account_id TEXT PRIMARY KEY,
  pruned_through_seq BIGINT NOT NULL,
  pruned_through_xid xid8 NOT NULL DEFAULT '0',
  pruned_through_xid_seq BIGINT NOT NULL DEFAULT 0
);
ALTER TABLE adcp_reporting_change_account_horizon
  ADD COLUMN IF NOT EXISTS pruned_through_xid xid8 NOT NULL DEFAULT '0';
ALTER TABLE adcp_reporting_change_account_horizon
  ADD COLUMN IF NOT EXISTS pruned_through_xid_seq BIGINT NOT NULL DEFAULT 0;

-- Registered consumers hold back pruning in (xid, seq) order, per account for an
-- account consumer. A row saved before the account feed carried an xid has a NULL
-- cursor_xid and holds by seq until the consumer saves its next cursor.
CREATE TABLE IF NOT EXISTS adcp_reporting_feed_consumers (
  consumer_name TEXT PRIMARY KEY CHECK (consumer_name ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  account_id TEXT,
  cursor_xid xid8,
  cursor_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT adcp_reporting_feed_consumers_cursor_scope CHECK (account_id IS NOT NULL OR cursor_xid IS NOT NULL)
);
DO $adcp_feed_consumers$
DECLARE stale TEXT;
BEGIN
  FOR stale IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'adcp_reporting_feed_consumers'::regclass AND contype = 'c'
       AND conname <> 'adcp_reporting_feed_consumers_cursor_scope'
       AND pg_get_constraintdef(oid) LIKE '%account_id IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE adcp_reporting_feed_consumers DROP CONSTRAINT %I', stale);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'adcp_reporting_feed_consumers'::regclass
       AND conname = 'adcp_reporting_feed_consumers_cursor_scope'
  ) THEN
    ALTER TABLE adcp_reporting_feed_consumers
      ADD CONSTRAINT adcp_reporting_feed_consumers_cursor_scope CHECK (account_id IS NOT NULL OR cursor_xid IS NOT NULL);
  END IF;
END
$adcp_feed_consumers$;
`.trim();

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingChangeKindV1 = 'obligation' | 'revision' | 'adjustment' | 'retirement';

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingChangeRecordV1 {
  kind: ReportingChangeKindV1;
  record_id: string;
  reporting_obligation_id: string;
  account_id: string;
  recorded_at: string;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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
  /**
   * The writing transaction of the last record returned. Every feed orders by `(xid, seq)`. Only
   * an account cursor issued before that order existed omits it; see
   * {@link isLegacyAccountChangeCursor}.
   */
  xid?: string;
}

const INT64_MAX = 9223372036854775807n;
const UINT64_MAX = 18446744073709551615n;

// A value PostgreSQL's `bigint` / `xid8` casts would reject must fail as INVALID_INPUT here, not as a
// raw database error mid-query.
function fitsUnsigned(value: unknown, max: bigint): boolean {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= max;
}

/**
 * True for an account cursor issued before account feeds ordered by `(xid, seq)`: it carries a
 * `seq` and no `xid`. `changesAfter` maps one to a position that cannot skip a change.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function isLegacyAccountChangeCursor(cursor: { account: string | null; xid?: string }): boolean {
  return cursor.account !== null && cursor.xid === undefined;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export function encodeReportingChangeCursorV1(cursor: ChangeCursorV1): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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
    !fitsUnsigned(cursor.seq, INT64_MAX) ||
    (cursor.xid === undefined ? account === null : !fitsUnsigned(cursor.xid, UINT64_MAX))
  ) {
    throw new ReportingRowStoreError('INVALID_INPUT', 'change cursor does not belong to this feed');
  }
  return cursor as ChangeCursorV1;
}

/**
 * Thrown when a change cursor is older than the retained change history.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export class ReportingChangeCursorExpiredError extends Error {
  readonly code = 'CURSOR_EXPIRED' as const;
  /**
   * Original feed position, when available, so a cold-start consumer can retain its recovery
   * boundary. It encodes the feed's account scope: do not serialize it to other tenants.
   */
  constructor(readonly cursor?: string) {
    super('Reporting change cursor is older than the retained change history; resynchronize from current revisions');
    this.name = 'ReportingChangeCursorExpiredError';
  }
}
