import { createHash, randomUUID } from 'node:crypto';

import { canonicalize } from '../../utils/jcs';
import type { ReportingAdjustmentReceipt, ReportingMaterialization, ReportingReceipt } from '../../types';
import { DEFAULT_UNKNOWN_ERROR_RECOVERY, getErrorRecovery, type ErrorRecovery } from '../../types/error-codes';
import { canonicalJsonV1 } from '../source';
import { isWellFormedUnicodeString } from '../../utils/well-formed-unicode';
import {
  evaluateReportingLedgerCoverageV1,
  reportingLedgerEffectivePeriod,
  reportingLedgerScopeClosed,
} from './coverage';
import {
  assertReportingConsumerMismatchEscalation,
  projectReportingConsumerStatusMismatchV1,
  projectReportingObligationHealthV1,
} from './health';
import { compareReportingInstants } from './instant';
import {
  REPORTING_CONSUMER_STATUS_BATCH_RESULT_MAX_BYTES,
  REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES,
  REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES,
  REPORTING_CONSUMER_STATUS_MAX_BYTES,
  REPORTING_LEDGER_AUTHORITY,
  ReportingLedgerSnapshotUnavailableError,
} from './types';
import type {
  ReportingLedgerConfigurationV1,
  ReportingLedgerAdjustmentV1,
  ReportingLedgerConsumerStatusV1,
  ReportingLedgerConsumerStatementV1,
  ReportingLedgerIssueV1,
  ReportingLedgerLeaseV1,
  ReportingLedgerObligationV1,
  ReportingLedgerPageV1,
  ReportingLedgerRevisionV1,
  ReportingLedgerRevisionSnapshotV1,
  ReportingLedgerAdjustmentSnapshotV1,
  ReportingLedgerSnapshotQueryV1,
  ReportingLedgerSnapshotV1,
  ReportingLedgerStatusTransitionV1,
  ReportingLedgerStore,
  ReportingConsumerStatusBatchInputV1,
  ReportingConsumerStatusBatchResultV1,
  ReportingConsumerStatusReplayInputV1,
  ReportingLedgerRevisionMetadataV1,
  ReportingManagedDeliveryBindingV1,
  ReportingManagedLifecycleProjectionV1,
  ReportingLedgerAuthorityV1,
} from './types';
import { ReportingConsumerStatusConflictError } from './types';
import type { ReportingConsumerMismatchEscalationV1 } from './types';
import { moreSevereReportingHealthV1, projectManagedDelivery } from './handler';
import { reportingCanonicalAdjustmentSha256V1 } from './producer';
import {
  normalizeReportingConsumerStatusIdsV1,
  reportingConsumerStatusChainKeyFromIdentityV1,
  reportingConsumerStatusChainKeyV1,
  reportingConsumerStatusFingerprintV1,
} from './consumer-status-identity';

type QueryResultRow = Record<string, unknown>;
interface ReportingPgResult<Row extends QueryResultRow> {
  rows: Row[];
  rowCount: number | null;
}
interface ReportingPgClient {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<ReportingPgResult<Row>>;
  release(error?: Error): void;
}
export interface ReportingPgPool {
  query<Row extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<ReportingPgResult<Row>>;
  connect(): Promise<ReportingPgClient>;
}

export const REPORTING_LEDGER_MIGRATION = `
CREATE TABLE IF NOT EXISTS adcp_reporting_configurations (
  configuration_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  delivery_config_id TEXT NOT NULL,
  delivery_config_version INTEGER NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, delivery_config_id, delivery_config_version)
);

CREATE TABLE IF NOT EXISTS adcp_reporting_obligations (
  obligation_id TEXT PRIMARY KEY,
  configuration_id TEXT NOT NULL REFERENCES adcp_reporting_configurations(configuration_id),
  account_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,
  lease_generation BIGINT NOT NULL DEFAULT 0,
  lease_expires_at TIMESTAMPTZ,
  UNIQUE (configuration_id, period_start, period_end),
  CHECK (period_start < period_end),
  CHECK (state IN ('pending', 'terminal'))
);

CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_due
  ON adcp_reporting_obligations (next_attempt_at, obligation_id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_account_due
  ON adcp_reporting_obligations (account_id, next_attempt_at, obligation_id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_account_period
  ON adcp_reporting_obligations (account_id, period_start, obligation_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_obligations_changed
  ON adcp_reporting_obligations (account_id, changed_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_revisions (
  revision_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  revision_number INTEGER NOT NULL,
  finality TEXT NOT NULL,
  kind TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES adcp_reporting_revisions(revision_id),
  content_sha256 TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (obligation_id, revision_number),
  CHECK (finality IN ('snapshot', 'official')),
  CHECK (kind IN ('snapshot', 'official'))
);
CREATE INDEX IF NOT EXISTS adcp_reporting_revisions_obligation
  ON adcp_reporting_revisions (obligation_id, revision_number);
CREATE INDEX IF NOT EXISTS adcp_reporting_revisions_created
  ON adcp_reporting_revisions (obligation_id, recorded_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_adjustments (
  adjustment_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  adjusts_revision_id TEXT NOT NULL REFERENCES adcp_reporting_revisions(revision_id),
  adjustment_number INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (obligation_id, adjustment_number)
);
CREATE INDEX IF NOT EXISTS adcp_reporting_adjustments_obligation
  ON adcp_reporting_adjustments (obligation_id, adjustment_number);
CREATE INDEX IF NOT EXISTS adcp_reporting_adjustments_created
  ON adcp_reporting_adjustments (obligation_id, recorded_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_consumer_statuses (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  consumer_status_id TEXT NOT NULL,
  chain_key TEXT NOT NULL,
  revision_id TEXT REFERENCES adcp_reporting_revisions(revision_id),
  obligation_id TEXT REFERENCES adcp_reporting_obligations(obligation_id),
  supersedes_consumer_status_id TEXT,
  is_current BOOLEAN NOT NULL DEFAULT true,
  semantic_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, consumer_status_id)
);
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN revision_id DROP NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN obligation_id DROP NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS consumer_id TEXT;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS chain_key TEXT;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS is_current BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE adcp_reporting_consumer_statuses ADD COLUMN IF NOT EXISTS semantic_fingerprint TEXT;
-- Preserve predecessor API rows under a reserved compatibility principal;
-- putConsumerStatus/listConsumerStatuses continue to serve this namespace.
UPDATE adcp_reporting_consumer_statuses AS status
SET account_id = COALESCE(
      status.account_id,
      obligation.data->'account'->>'account_id',
      '__legacy_unscoped_account__'
    ),
    consumer_id = COALESCE(status.consumer_id, '__legacy_unscoped_consumer__'),
    chain_key = COALESCE(status.chain_key, 'legacy:' || status.consumer_status_id),
    semantic_fingerprint = COALESCE(status.semantic_fingerprint, 'legacy:' || status.consumer_status_id)
FROM adcp_reporting_obligations AS obligation
WHERE status.obligation_id = obligation.obligation_id
  AND (status.account_id IS NULL OR status.consumer_id IS NULL OR status.chain_key IS NULL
       OR status.semantic_fingerprint IS NULL);
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN consumer_id SET NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN chain_key SET NOT NULL;
ALTER TABLE adcp_reporting_consumer_statuses ALTER COLUMN semantic_fingerprint SET NOT NULL;
DO $migration$
DECLARE self_fk RECORD;
BEGIN
  FOR self_fk IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'adcp_reporting_consumer_statuses'::regclass
      AND confrelid = 'adcp_reporting_consumer_statuses'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE adcp_reporting_consumer_statuses DROP CONSTRAINT %I',
      self_fk.conname
    );
  END LOOP;
END
$migration$;
ALTER TABLE adcp_reporting_consumer_statuses DROP CONSTRAINT IF EXISTS adcp_reporting_consumer_statuses_pkey;
ALTER TABLE adcp_reporting_consumer_statuses
  ADD CONSTRAINT adcp_reporting_consumer_statuses_pkey PRIMARY KEY (account_id, consumer_id, consumer_status_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_revision
  ON adcp_reporting_consumer_statuses (revision_id, created_at, consumer_status_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_scope
  ON adcp_reporting_consumer_statuses (account_id, consumer_id, created_at, consumer_status_id);
CREATE UNIQUE INDEX IF NOT EXISTS adcp_reporting_consumer_statuses_current
  ON adcp_reporting_consumer_statuses (account_id, consumer_id, chain_key) WHERE is_current;

CREATE TABLE IF NOT EXISTS adcp_reporting_consumer_status_batches (
  account_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status_ids JSONB NOT NULL,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, consumer_id, idempotency_key)
);
ALTER TABLE adcp_reporting_consumer_status_batches ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS adcp_reporting_issues (
  issue_id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  data JSONB NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_issues_obligation
  ON adcp_reporting_issues (obligation_id, observed_at, issue_id);

-- Per-obligation reconciliation watermark. A reconcile that changes nothing
-- still has to record that it looked, or a change with no health effect stays
-- a candidate forever and starves newer work behind it. Core, not managed:
-- the lifecycle sweep is a Core concern and must not depend on the add-on.
CREATE TABLE IF NOT EXISTS adcp_reporting_lifecycle_state (
  obligation_id TEXT PRIMARY KEY REFERENCES adcp_reporting_obligations(obligation_id),
  processed_state_version TEXT,
  processed_roster_version TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_lifecycle_state_processed
  ON adcp_reporting_lifecycle_state (processed_at, obligation_id);
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS current_roster_version TEXT;
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE adcp_reporting_lifecycle_state
  ADD COLUMN IF NOT EXISTS roster_refreshed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS adcp_reporting_lifecycle_state_roster_refreshed
  ON adcp_reporting_lifecycle_state (roster_refreshed_at, obligation_id);

CREATE TABLE IF NOT EXISTS adcp_reporting_transitions (
  transition_id TEXT PRIMARY KEY,
  transition_sequence BIGSERIAL NOT NULL UNIQUE,
  obligation_id TEXT NOT NULL REFERENCES adcp_reporting_obligations(obligation_id),
  data JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS adcp_reporting_transitions_obligation
  ON adcp_reporting_transitions (obligation_id, occurred_at, transition_id);
CREATE INDEX IF NOT EXISTS adcp_reporting_transitions_pending
  ON adcp_reporting_transitions (recorded_at, transition_id)
  WHERE NOT (data ? 'notifiedAt');

CREATE TABLE IF NOT EXISTS adcp_reporting_snapshots (
  snapshot_id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  query_fingerprint TEXT NOT NULL,
  data JSONB NOT NULL,
  byte_count BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS adcp_reporting_snapshots_created
  ON adcp_reporting_snapshots (created_at);
CREATE INDEX IF NOT EXISTS adcp_reporting_snapshots_expiry
  ON adcp_reporting_snapshots (expires_at);

CREATE TABLE IF NOT EXISTS adcp_reporting_checkpoints (
  checkpoint_id UUID PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope_fingerprint TEXT NOT NULL,
  ledger_as_of TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS adcp_reporting_checkpoints_expiry
  ON adcp_reporting_checkpoints (expires_at);
`.trim();

const MAX_SNAPSHOT_ITEMS = 10_000;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_SNAPSHOTS_PER_ACCOUNT = 32;
const MAX_ACTIVE_SNAPSHOT_BYTES_PER_ACCOUNT = 128 * 1024 * 1024;
const MAX_CONSUMER_STATUS_BATCHES = 10_000;
const MAX_CONSUMER_STATUS_STATEMENTS = 100_000;
const SNAPSHOT_RETENTION_MS = 15 * 60 * 1000;
const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonRow<T> = QueryResultRow & { data: T };
type StoredConsumerStatusBatchResult = {
  kind: 'recorded' | 'unchanged' | 'failed';
  id: string;
  errorCode?: string;
  recovery?: ErrorRecovery;
  retryAfterSeconds?: number;
  safeMessage?: string;
  errorField?: string;
  errorKeyword?: string;
};

export interface PostgresReportingLedgerStoreOptions {
  /** Assert that the supplied PostgreSQL database/schema is isolated to this deployment. */
  acknowledgeIsolatedDatabase?: boolean;
  /**
   * Same advertised escalation commitment passed to
   * `createReportingStatusHandler`. The store needs it because the `health`
   * query filter is applied while building the snapshot, before the handler
   * projects anything — so if the two disagree about when a consumer-status
   * mismatch escalates, a filtered `periods` read silently omits obligations
   * the unfiltered read shows.
   */
  consumerMismatchEscalation?: ReportingConsumerMismatchEscalationV1;
  /** Explicitly opt this Core store into projecting the additive #2944 tables. */
  managedDelivery?: boolean;
  /**
   * Supplies the principals that owe a receipt for one obligation.
   *
   * Nothing durable in the managed tables enumerates them — destination
   * authorizations and bindings are keyed by
   * `(account_id, destination_ref, generation)` with no consumer dimension — so
   * without this the store can only report who has already submitted, and must
   * stay conservative: a `consumer_receipt` obligation is then never reported
   * reconciled on a lifecycle transition. Wire this to whatever your
   * authorization layer knows and return `complete: true` to get accurate
   * reconciled transitions and webhooks.
   *
   * `complete: true` is taken at your word, and this is the only place in the
   * subsystem where an adopter assertion can mark billing reconciled: a roster
   * omitting a principal that owes a receipt makes that duty vanish from the
   * fold, so the obligation can be persisted and notified reconciled while
   * that principal never accepted. It is invoked outside the store's
   * transaction and under a deadline, so it may do I/O — but it must not be
   * slower than that deadline.
   */
  obligatedConsumers?: (input: {
    reporting_obligation_id: string;
    account_id: string;
  }) => Promise<{ ids: readonly string[]; complete: boolean; version?: string }>;
}

export class ReportingLedgerLeaseLostError extends Error {
  constructor(message = 'Reporting ledger lease was lost before commit') {
    super(message);
    this.name = 'ReportingLedgerLeaseLostError';
  }
}

export class ReportingLedgerContinuityError extends Error {
  constructor(message = 'Reporting ledger revision continuity invariant failed') {
    super(message);
    this.name = 'ReportingLedgerContinuityError';
  }
}

/** Bounded global cleanup for expired cursor snapshots and changes checkpoints. */
export async function sweepExpiredReportingLedgerState(
  pool: Pick<ReportingPgPool, 'query'>,
  limit = 1_000
): Promise<{ snapshotsDeleted: number; checkpointsDeleted: number }> {
  positiveInteger(limit, 'limit');
  if (limit > 10_000) throw new RangeError('limit must not exceed 10000');
  try {
    const snapshots = await pool.query(
      `WITH expired AS (
         SELECT snapshot_id FROM adcp_reporting_snapshots
          WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at, snapshot_id
          FOR UPDATE SKIP LOCKED LIMIT $1
       )
       DELETE FROM adcp_reporting_snapshots target
        USING expired WHERE target.snapshot_id = expired.snapshot_id`,
      [limit]
    );
    const checkpoints = await pool.query(
      `WITH expired AS (
         SELECT checkpoint_id FROM adcp_reporting_checkpoints
          WHERE expires_at <= clock_timestamp()
          ORDER BY expires_at, checkpoint_id
          FOR UPDATE SKIP LOCKED LIMIT $1
       )
       DELETE FROM adcp_reporting_checkpoints target
        USING expired WHERE target.checkpoint_id = expired.checkpoint_id`,
      [limit]
    );
    return { snapshotsDeleted: snapshots.rowCount ?? 0, checkpointsDeleted: checkpoints.rowCount ?? 0 };
  } catch (cause) {
    throw new Error('Reporting ledger expiry cleanup failed', { cause });
  }
}

export class PostgresReportingLedgerStore implements ReportingLedgerStore {
  /**
   * Exposed so `createReportingStatusHandler` can inherit it and refuse a
   * disagreement. The store applies `health` while building the snapshot and
   * the handler projects severity afterwards, so two independently configured
   * copies of the escalation window would let a filtered periods read
   * contradict the summary.
   */
  readonly consumerMismatchEscalation?: ReportingConsumerMismatchEscalationV1;
  readonly [REPORTING_LEDGER_AUTHORITY]: ReportingLedgerAuthorityV1;
  private readonly managedDelivery: boolean;
  private readonly obligatedConsumers: PostgresReportingLedgerStoreOptions['obligatedConsumers'];

  constructor(
    private readonly pool: ReportingPgPool,
    options: PostgresReportingLedgerStoreOptions = {}
  ) {
    this.managedDelivery = options.managedDelivery === true;
    this.obligatedConsumers = options.obligatedConsumers;
    this[REPORTING_LEDGER_AUTHORITY] = { substrate: pool, managedDelivery: this.managedDelivery };
    const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
    if (!development && !options.acknowledgeIsolatedDatabase) {
      throw new Error(
        'PostgresReportingLedgerStore requires an isolated database/schema or acknowledgeIsolatedDatabase: true'
      );
    }
    this.consumerMismatchEscalation = assertReportingConsumerMismatchEscalation(options.consumerMismatchEscalation);
  }

  async putConfiguration(configuration: ReportingLedgerConfigurationV1) {
    return this.transaction(
      async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `adcp-reporting-config:${configuration.account.account_id}:${configuration.delivery_config_id}`,
        ]);
        const newer = await client.query<QueryResultRow & { highest: number | null }>(
          `SELECT MAX(delivery_config_version)::integer AS highest
           FROM adcp_reporting_configurations WHERE account_id = $1 AND delivery_config_id = $2`,
          [configuration.account.account_id, configuration.delivery_config_id]
        );
        if ((newer.rows[0]?.highest ?? -1) > configuration.delivery_config_version) {
          throw new Error('Reporting configuration version cannot regress');
        }
        const inserted = await client.query<JsonRow<ReportingLedgerConfigurationV1>>(
          `INSERT INTO adcp_reporting_configurations
           (configuration_id, account_id, delivery_config_id, delivery_config_version,
            semantic_fingerprint, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())
         ON CONFLICT DO NOTHING RETURNING data`,
          [
            configuration.configurationId,
            configuration.account.account_id,
            configuration.delivery_config_id,
            configuration.delivery_config_version,
            configuration.semanticFingerprint,
            JSON.stringify(configuration),
          ]
        );
        const value =
          inserted.rows[0]?.data ??
          (
            await client.query<JsonRow<ReportingLedgerConfigurationV1>>(
              `SELECT data FROM adcp_reporting_configurations
              WHERE account_id = $1 AND delivery_config_id = $2 AND delivery_config_version = $3`,
              [
                configuration.account.account_id,
                configuration.delivery_config_id,
                configuration.delivery_config_version,
              ]
            )
          ).rows[0]?.data;
        if (!value || value.semanticFingerprint !== configuration.semanticFingerprint) {
          throw new Error('Immutable reporting configuration identity names different content');
        }
        return { inserted: inserted.rowCount === 1, value: clone(value) };
      },
      { preBeginAdvisoryLock: accountLock(configuration.account.account_id) }
    );
  }

  async listConfigurations(account_id?: string): Promise<ReportingLedgerConfigurationV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerConfigurationV1>>(
      `SELECT data FROM adcp_reporting_configurations
        WHERE ($1::text IS NULL OR account_id = $1)
        ORDER BY created_at, configuration_id`,
      [account_id ?? null]
    );
    return result.rows.map(row => clone(row.data));
  }

  async putObligation(obligation: ReportingLedgerObligationV1) {
    return this.putImmutable(
      `INSERT INTO adcp_reporting_obligations
         (obligation_id, configuration_id, account_id, period_start, period_end,
          next_attempt_at, state, semantic_fingerprint, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, clock_timestamp())
       ON CONFLICT DO NOTHING RETURNING data`,
      [
        obligation.reporting_obligation_id,
        obligation.configurationId,
        obligation.account.account_id,
        obligation.period.start,
        obligation.period.end,
        obligation.nextAttemptAt,
        obligation.state,
        obligation.semanticFingerprint,
        JSON.stringify(obligation),
      ],
      `SELECT data FROM adcp_reporting_obligations
        WHERE configuration_id = $1 AND period_start = $2 AND period_end = $3`,
      [obligation.configurationId, obligation.period.start, obligation.period.end],
      obligation,
      value => value.semanticFingerprint,
      accountLock(obligation.account.account_id)
    );
  }

  async getObligation(id: string, account_id?: string): Promise<ReportingLedgerObligationV1 | null> {
    return this.one<ReportingLedgerObligationV1>(
      `SELECT data FROM adcp_reporting_obligations
        WHERE obligation_id = $1 AND ($2::text IS NULL OR account_id = $2)`,
      [id, account_id ?? null]
    );
  }

  async listObligations(account_id?: string): Promise<ReportingLedgerObligationV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerObligationV1>>(
      `SELECT data FROM adcp_reporting_obligations
        WHERE ($1::text IS NULL OR account_id = $1) ORDER BY period_start, obligation_id`,
      [account_id ?? null]
    );
    return result.rows.map(row => clone(row.data));
  }

  async listLifecycleDueObligations(input: {
    ledgerAsOf: string;
    account_id?: string;
    limit: number;
  }): Promise<ReportingLedgerObligationV1[]> {
    positiveInteger(input.limit, 'limit');
    if (input.limit > 1_000) throw new RangeError('limit must not exceed 1000');
    if (!Number.isFinite(Date.parse(input.ledgerAsOf))) throw new TypeError('ledgerAsOf must be an RFC 3339 instant');
    // The managed arm names managed tables, and PostgreSQL resolves those at
    // parse time regardless of any runtime guard — so a Core-only deployment
    // would fail on "relation does not exist". Include it only when the
    // managed schema is actually present.
    const managedDueArm = (await this.managedDueTablesReady()) ? MANAGED_DUE_ARM : '';
    const result = await this.query<JsonRow<ReportingLedgerObligationV1>>(
      `SELECT obligation.data FROM adcp_reporting_obligations obligation
       LEFT JOIN LATERAL (
         SELECT transition.data->>'health' AS health, transition.occurred_at
           FROM adcp_reporting_transitions transition
          WHERE transition.obligation_id = obligation.obligation_id
          ORDER BY transition.transition_sequence DESC LIMIT 1
       ) latest ON TRUE
       LEFT JOIN adcp_reporting_lifecycle_state state
              ON state.obligation_id = obligation.obligation_id
       CROSS JOIN LATERAL (
         -- A reconcile that changed no health still has to count as work done,
         -- or a managed change with no health effect keeps the obligation due
         -- forever and, at small page sizes, starves everything behind it.
         SELECT GREATEST(
                  COALESCE(state.processed_at, obligation.created_at),
                  COALESCE(latest.occurred_at, obligation.created_at)
                ) AS since
       ) watermark
       WHERE ($1::text IS NULL OR obligation.account_id = $1)
         AND ((COALESCE(latest.health, 'waiting') = 'waiting'
               AND (obligation.data->>'expectedAt')::timestamptz <= $2)
           OR (latest.health = 'delayed'
               AND (obligation.data->>'recoveryDeadlineAt')::timestamptz <= $2)
           OR (obligation.state = 'terminal'
               AND COALESCE(latest.health, 'waiting') <> 'complete'
               AND EXISTS (
                 SELECT 1 FROM adcp_reporting_revisions revision
                  WHERE revision.obligation_id = obligation.obligation_id
               ))
${managedDueArm}       )
         -- A tenant that keeps failing must not monopolise every sweep. Its
         -- backoff cursor holds it out of selection until it is due again,
         -- while processed_at ordering still favours whoever has waited
         -- longest among the eligible.
         AND (state.next_attempt_at IS NULL OR state.next_attempt_at <= $2)
       ORDER BY watermark.since, LEAST(
         (obligation.data->>'expectedAt')::timestamptz,
         (obligation.data->>'recoveryDeadlineAt')::timestamptz
       ), obligation.obligation_id
       LIMIT $3`,
      [input.account_id ?? null, input.ledgerAsOf, input.limit]
    );
    return result.rows.map(row => clone(row.data));
  }

  async updateObligation(
    obligation: ReportingLedgerObligationV1,
    lease: ReportingLedgerLeaseV1,
    issue?: ReportingLedgerIssueV1
  ): Promise<void> {
    assertLeaseTarget(obligation.reporting_obligation_id, lease);
    await this.transaction(
      async client => {
        const result = await client.query(
          `UPDATE adcp_reporting_obligations
          SET next_attempt_at = $2, state = $3, data = $4::jsonb, changed_at = clock_timestamp()
        WHERE obligation_id = $1 AND semantic_fingerprint = $5
          AND lease_owner = $6 AND lease_generation = $7 AND lease_expires_at > clock_timestamp()`,
          [
            obligation.reporting_obligation_id,
            obligation.nextAttemptAt,
            obligation.state,
            JSON.stringify(obligation),
            obligation.semanticFingerprint,
            lease.owner,
            lease.generation,
          ]
        );
        if (result.rowCount !== 1) throw new ReportingLedgerLeaseLostError();
        if (issue) {
          if (issue.reporting_obligation_id !== obligation.reporting_obligation_id) {
            throw new Error('Reporting issue must belong to the leased obligation');
          }
          const issueResult = await client.query(
            `INSERT INTO adcp_reporting_issues (issue_id, obligation_id, data, observed_at, resolved_at)
             VALUES ($1, $2, $3::jsonb, $4, $5)
             -- rc.3 fixes opened_at at first emission: it MUST NOT advance while
             -- the same issue_id is re-emitted, including across the delayed ->
             -- action_required severity change that re-upserts this row. Keep the
             -- stored anchor and let every other field advance.
             ON CONFLICT (issue_id) DO UPDATE SET
               data = jsonb_set(EXCLUDED.data, '{openedAt}', COALESCE(adcp_reporting_issues.data -> 'openedAt', EXCLUDED.data -> 'openedAt')),
               observed_at = EXCLUDED.observed_at,
               resolved_at = EXCLUDED.resolved_at,
               changed_at = clock_timestamp()
             WHERE adcp_reporting_issues.obligation_id = EXCLUDED.obligation_id`,
            [
              issue.issueId,
              issue.reporting_obligation_id,
              JSON.stringify(issue),
              issue.observedAt,
              issue.resolvedAt ?? null,
            ]
          );
          if (issueResult.rowCount !== 1) throw new Error('Reporting issue identity belongs to another obligation');
        }
      },
      { preBeginAdvisoryLock: accountLock(obligation.account.account_id) }
    );
  }

  async claimObligation(input: {
    owner: string;
    now: string;
    leaseMilliseconds: number;
    account_id?: string;
  }): Promise<ReportingLedgerLeaseV1 | null> {
    positiveInteger(input.leaseMilliseconds, 'leaseMilliseconds');
    if (!Number.isFinite(Date.parse(input.now))) throw new TypeError('now must be an RFC 3339 instant');
    const result = await this.query<
      QueryResultRow & { data: ReportingLedgerObligationV1; lease_generation: string; lease_expires_at: Date }
    >(
      `WITH candidate AS (
         SELECT obligation_id FROM adcp_reporting_obligations
          WHERE state = 'pending' AND next_attempt_at <= $2
            AND ($4::text IS NULL OR account_id = $4)
            AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
          ORDER BY next_attempt_at, obligation_id
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE adcp_reporting_obligations obligation
          SET lease_owner = $1, lease_generation = lease_generation + 1,
              lease_expires_at = clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond')
         FROM candidate WHERE obligation.obligation_id = candidate.obligation_id
       RETURNING obligation.data, obligation.lease_generation::text, obligation.lease_expires_at`,
      [input.owner, input.now, input.leaseMilliseconds, input.account_id ?? null]
    );
    const row = result.rows[0];
    return row
      ? {
          obligation: clone(row.data),
          owner: input.owner,
          generation: Number(row.lease_generation),
          expiresAt: row.lease_expires_at.toISOString(),
        }
      : null;
  }

  async releaseObligationLease(lease: ReportingLedgerLeaseV1): Promise<void> {
    await this.query(
      `UPDATE adcp_reporting_obligations SET lease_owner = NULL, lease_expires_at = NULL
        WHERE obligation_id = $1 AND lease_owner = $2 AND lease_generation = $3`,
      [lease.obligation.reporting_obligation_id, lease.owner, lease.generation]
    );
  }

  async commitRevision(revision: ReportingLedgerRevisionV1, lease: ReportingLedgerLeaseV1) {
    assertLeaseTarget(revision.reporting_obligation_id, lease);
    validateRevisionBinding(revision);
    return this.putImmutable(
      `WITH leased_obligation AS (
         SELECT * FROM adcp_reporting_obligations obligation
          WHERE obligation.obligation_id = $2
            AND obligation.lease_owner = $9 AND obligation.lease_generation = $10
            AND obligation.lease_expires_at > clock_timestamp()
          FOR UPDATE
       )
       INSERT INTO adcp_reporting_revisions
         (revision_id, obligation_id, revision_number, finality, kind,
          supersedes_revision_id, content_sha256, data, created_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, clock_timestamp()
         FROM leased_obligation obligation
        WHERE NOT EXISTS (
            SELECT 1 FROM adcp_reporting_revisions terminal_revision
             WHERE terminal_revision.obligation_id = obligation.obligation_id
               AND terminal_revision.finality = 'official'
          )
          AND $3 = COALESCE((
            SELECT MAX(sequence_revision.revision_number) + 1
              FROM adcp_reporting_revisions sequence_revision
             WHERE sequence_revision.obligation_id = obligation.obligation_id
          ), 1)
          AND (($3 = 1 AND $6::text IS NULL) OR $6 = (
            SELECT predecessor.revision_id FROM adcp_reporting_revisions predecessor
             WHERE predecessor.obligation_id = obligation.obligation_id
               AND predecessor.revision_number = $3 - 1
          ))
       ON CONFLICT DO NOTHING RETURNING data`,
      [
        revision.reporting_revision_id,
        revision.reporting_obligation_id,
        revision.revisionNumber,
        revision.finality,
        revision.kind,
        revision.supersedes_reporting_revision_id ?? null,
        revision.binding.sha256,
        JSON.stringify(revision),
        lease.owner,
        lease.generation,
      ],
      'SELECT data FROM adcp_reporting_revisions WHERE obligation_id = $1 AND revision_number = $2',
      [revision.reporting_obligation_id, revision.revisionNumber],
      revision,
      revisionIdentityFingerprint,
      accountLock(lease.obligation.account.account_id),
      {
        obligationId: revision.reporting_obligation_id,
        owner: lease.owner,
        generation: lease.generation,
      },
      revisionLegacyCanonicalDigestReplay
    );
  }

  async getRevision(id: string, accountId: string): Promise<ReportingLedgerRevisionV1 | null> {
    return this.one<ReportingLedgerRevisionV1>(
      `SELECT revision.data FROM adcp_reporting_revisions revision
         JOIN adcp_reporting_obligations obligation ON obligation.obligation_id = revision.obligation_id
        WHERE revision.revision_id = $1 AND obligation.account_id = $2`,
      [id, accountId]
    );
  }

  async getRevisionMetadata(id: string, accountId: string): Promise<ReportingLedgerRevisionMetadataV1 | null> {
    return this.one<ReportingLedgerRevisionMetadataV1>(
      `SELECT revision.data - 'rows' AS data FROM adcp_reporting_revisions revision
         JOIN adcp_reporting_obligations obligation ON obligation.obligation_id = revision.obligation_id
        WHERE revision.revision_id = $1 AND obligation.account_id = $2`,
      [id, accountId]
    );
  }

  async listRevisions(obligationId: string): Promise<ReportingLedgerRevisionV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerRevisionV1>>(
      `SELECT data FROM adcp_reporting_revisions WHERE obligation_id = $1
        ORDER BY revision_number, revision_id`,
      [obligationId]
    );
    return result.rows.map(row => clone(row.data));
  }

  async commitAdjustment(adjustment: ReportingLedgerAdjustmentV1, lease: ReportingLedgerLeaseV1) {
    assertLeaseTarget(adjustment.reporting_obligation_id, lease);
    validateBoundRows(adjustment);
    return this.putImmutable(
      `WITH leased_obligation AS (
         SELECT * FROM adcp_reporting_obligations obligation
          WHERE obligation.obligation_id = $2
            AND obligation.lease_owner = $7 AND obligation.lease_generation = $8
            AND obligation.lease_expires_at > clock_timestamp()
          FOR UPDATE
       )
       INSERT INTO adcp_reporting_adjustments
         (adjustment_id, obligation_id, adjusts_revision_id, adjustment_number,
          content_sha256, data, created_at)
       SELECT $1, $2, $3, $4, $5, $6::jsonb, clock_timestamp()
         FROM leased_obligation obligation
        WHERE EXISTS (
            SELECT 1 FROM adcp_reporting_revisions official_revision
             WHERE official_revision.obligation_id = obligation.obligation_id
               AND official_revision.revision_id = $3
               AND official_revision.finality = 'official'
          )
          AND $4 = COALESCE((
            SELECT MAX(sequence_adjustment.adjustment_number) + 1
              FROM adcp_reporting_adjustments sequence_adjustment
             WHERE sequence_adjustment.obligation_id = obligation.obligation_id
          ), 1)
       ON CONFLICT DO NOTHING RETURNING data`,
      [
        adjustment.reporting_adjustment_id,
        adjustment.reporting_obligation_id,
        adjustment.adjusts_reporting_revision_id,
        adjustment.adjustmentNumber,
        adjustment.binding.sha256,
        JSON.stringify(adjustment),
        lease.owner,
        lease.generation,
      ],
      'SELECT data FROM adcp_reporting_adjustments WHERE obligation_id = $1 AND adjustment_number = $2',
      [adjustment.reporting_obligation_id, adjustment.adjustmentNumber],
      adjustment,
      adjustmentIdentityFingerprint,
      accountLock(lease.obligation.account.account_id),
      {
        obligationId: adjustment.reporting_obligation_id,
        owner: lease.owner,
        generation: lease.generation,
      },
      adjustmentLegacyCanonicalDigestReplay
    );
  }

  async listAdjustments(obligationId: string): Promise<ReportingLedgerAdjustmentV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerAdjustmentV1>>(
      `SELECT data FROM adcp_reporting_adjustments WHERE obligation_id = $1
        ORDER BY adjustment_number, adjustment_id`,
      [obligationId]
    );
    return result.rows.map(row => clone(row.data));
  }

  async putConsumerStatus(status: ReportingLedgerConsumerStatusV1) {
    const obligation = await this.getObligation(status.reporting_obligation_id);
    if (!obligation) throw new Error('Reporting consumer status obligation is unavailable');
    return this.putImmutable(
      `INSERT INTO adcp_reporting_consumer_statuses
         (account_id, consumer_id, consumer_status_id, chain_key, revision_id, obligation_id,
          supersedes_consumer_status_id, is_current, semantic_fingerprint, data, created_at)
       SELECT $1, '__legacy_unscoped_consumer__', $2, $3, $4, $5, $6, true, $7, $8::jsonb, $9
       WHERE NOT EXISTS (
         SELECT 1 FROM adcp_reporting_consumer_statuses
          WHERE consumer_id = '__legacy_unscoped_consumer__' AND consumer_status_id = $2
       )
       ON CONFLICT DO NOTHING RETURNING data`,
      [
        obligation.account.account_id,
        status.consumerStatusId,
        `legacy:${status.consumerStatusId}`,
        status.reporting_revision_id,
        status.reporting_obligation_id,
        status.supersedesConsumerStatusId ?? null,
        digest(status),
        JSON.stringify(status),
        status.createdAt,
      ],
      `SELECT data FROM adcp_reporting_consumer_statuses
        WHERE consumer_id = '__legacy_unscoped_consumer__' AND consumer_status_id = $1
        ORDER BY created_at LIMIT 1`,
      [status.consumerStatusId],
      status,
      value => digest(value),
      `adcp-reporting-legacy-consumer-status:${status.consumerStatusId}`
    );
  }

  async getConsumerStatusBatchReplay(
    input: ReportingConsumerStatusReplayInputV1
  ): Promise<ReportingConsumerStatusBatchResultV1[] | null> {
    const batch = await this.query<
      QueryResultRow & {
        request_fingerprint: string;
        results: Array<{
          kind: 'recorded' | 'unchanged' | 'failed';
          id: string;
          errorCode?: string;
          recovery?: ErrorRecovery;
          retryAfterSeconds?: number;
          safeMessage?: string;
          errorField?: string;
          errorKeyword?: string;
        }>;
      }
    >(
      `SELECT request_fingerprint, results FROM adcp_reporting_consumer_status_batches
       WHERE account_id = $1 AND consumer_id = $2 AND idempotency_key = $3`,
      [input.account_id, input.consumerId, input.idempotencyKey]
    );
    if (!batch.rows[0]) return null;
    if (batch.rows[0].request_fingerprint !== input.requestFingerprint) {
      throw new ReportingConsumerStatusConflictError('Reporting status idempotency key was reused');
    }
    const replay: ReportingConsumerStatusBatchResultV1[] = [];
    for (const result of batch.rows[0].results) {
      if (result.kind === 'failed') {
        replay.push({
          inserted: false,
          reporting_status_id: result.id,
          errorCode: result.errorCode ?? 'VALIDATION_ERROR',
          recovery: result.recovery,
          retryAfterSeconds: result.retryAfterSeconds,
          safeMessage: boundedConsumerStatusSafeMessage(result.safeMessage ?? 'Reporting consumer status was rejected'),
          ...boundedConsumerStatusErrorField(result.errorField),
          ...boundedConsumerStatusErrorKeyword(result.errorKeyword),
        });
        continue;
      }
      const row = await this.query<JsonRow<ReportingLedgerConsumerStatementV1>>(
        `SELECT data FROM adcp_reporting_consumer_statuses
         WHERE consumer_status_id = $1 AND account_id = $2 AND consumer_id = $3`,
        [result.id, input.account_id, input.consumerId]
      );
      if (!row.rows[0]) throw new ReportingConsumerStatusConflictError('Reporting status replay is unavailable');
      replay.push({ inserted: result.kind === 'recorded', value: clone(row.rows[0].data) });
    }
    return replay;
  }

  async syncConsumerStatusBatch(
    input: ReportingConsumerStatusBatchInputV1
  ): Promise<ReportingConsumerStatusBatchResultV1[]> {
    return this.transaction(
      async client => {
        const priorBatch = await client.query<
          QueryResultRow & { request_fingerprint: string; results: StoredConsumerStatusBatchResult[] }
        >(
          `SELECT request_fingerprint, results FROM adcp_reporting_consumer_status_batches
           WHERE account_id = $1 AND consumer_id = $2 AND idempotency_key = $3`,
          [input.account_id, input.consumerId, input.idempotencyKey]
        );
        if (priorBatch.rows[0]) {
          if (priorBatch.rows[0].request_fingerprint !== input.requestFingerprint) {
            throw new ReportingConsumerStatusConflictError('Reporting status idempotency key was reused');
          }
          const replay: ReportingConsumerStatusBatchResultV1[] = [];
          for (const result of priorBatch.rows[0].results) {
            if (result.kind === 'failed') {
              replay.push({
                inserted: false,
                reporting_status_id: result.id,
                errorCode: result.errorCode ?? 'VALIDATION_ERROR',
                recovery: result.recovery,
                retryAfterSeconds: result.retryAfterSeconds,
                safeMessage: boundedConsumerStatusSafeMessage(
                  result.safeMessage ?? 'Reporting consumer status was rejected'
                ),
                ...boundedConsumerStatusErrorField(result.errorField),
                ...boundedConsumerStatusErrorKeyword(result.errorKeyword),
              });
              continue;
            }
            const row = await client.query<JsonRow<ReportingLedgerConsumerStatementV1>>(
              `SELECT data FROM adcp_reporting_consumer_statuses
               WHERE consumer_status_id = $1 AND account_id = $2 AND consumer_id = $3`,
              [result.id, input.account_id, input.consumerId]
            );
            if (!row.rows[0]) throw new ReportingConsumerStatusConflictError('Reporting status replay is unavailable');
            replay.push({
              inserted: input.replayOriginalResults !== false && result.kind === 'recorded',
              value: clone(row.rows[0].data),
            });
          }
          return replay;
        }

        const normalizedIds = normalizeReportingConsumerStatusIdsV1(input.entries);
        const chainKeys = input.entries.map(entry =>
          'status' in entry
            ? reportingConsumerStatusChainKeyV1(entry.status)
            : entry.chainIdentity
              ? reportingConsumerStatusChainKeyFromIdentityV1(entry.chainIdentity)
              : null
        );
        const duplicateChains = new Set(
          chainKeys.filter(
            (value, index): value is string =>
              value !== null && (chainKeys.indexOf(value) !== index || chainKeys.lastIndexOf(value) !== index)
          )
        );
        const duplicateStatusIds = new Set(
          normalizedIds.values
            .filter((_, index) => !normalizedIds.invalidIndexes.has(index))
            .filter((value, index, values) => values.indexOf(value) !== index || values.lastIndexOf(value) !== index)
        );
        const capacity = await client.query<QueryResultRow & { batches: string; statuses: string }>(
          `SELECT
             (SELECT COUNT(*) FROM adcp_reporting_consumer_status_batches
               WHERE account_id = $1 AND consumer_id = $2)::text AS batches,
             (SELECT COUNT(*) FROM adcp_reporting_consumer_statuses
               WHERE account_id = $1 AND consumer_id = $2)::text AS statuses`,
          [input.account_id, input.consumerId]
        );
        const batchCapacityExhausted = Number(capacity.rows[0]?.batches ?? 0) >= MAX_CONSUMER_STATUS_BATCHES;
        let remainingStatements = MAX_CONSUMER_STATUS_STATEMENTS - Number(capacity.rows[0]?.statuses ?? 0);
        const results: ReportingConsumerStatusBatchResultV1[] = [];
        const storedResults: StoredConsumerStatusBatchResult[] = [];
        const fail = (
          statusId: string,
          errorCode: string,
          safeMessage: string,
          errorField?: string,
          recovery: ErrorRecovery = getErrorRecovery(errorCode) ?? DEFAULT_UNKNOWN_ERROR_RECOVERY,
          errorKeyword?: string,
          retryAfterSeconds?: number
        ) => {
          const boundedErrorField = boundedConsumerStatusErrorField(errorField);
          const boundedErrorKeyword = boundedConsumerStatusErrorKeyword(errorKeyword);
          const boundedSafeMessage = boundedConsumerStatusSafeMessage(safeMessage);
          results.push({
            inserted: false,
            reporting_status_id: statusId,
            errorCode,
            recovery,
            retryAfterSeconds,
            safeMessage: boundedSafeMessage,
            ...boundedErrorField,
            ...boundedErrorKeyword,
          });
          storedResults.push({
            kind: 'failed',
            id: statusId,
            errorCode,
            recovery,
            retryAfterSeconds,
            safeMessage: boundedSafeMessage,
            ...boundedErrorField,
            ...boundedErrorKeyword,
          });
        };
        for (const [index, entry] of input.entries.entries()) {
          const statusId = normalizedIds.values[index]!;
          if (normalizedIds.invalidIndexes.has(index)) {
            fail(statusId, 'VALIDATION_ERROR', 'reporting_status_id is invalid', undefined, 'correctable', 'pattern');
            continue;
          }
          if (duplicateStatusIds.has(statusId)) {
            fail(statusId, 'VALIDATION_ERROR', 'reporting_status_id must be unique in a batch');
            continue;
          }
          if (!('status' in entry)) {
            fail(
              statusId,
              'VALIDATION_ERROR',
              entry.validationError,
              entry.validationField,
              'correctable',
              entry.validationKeyword
            );
            continue;
          }
          const status = entry.status;
          if (duplicateChains.has(chainKeys[index]!)) {
            fail(status.reporting_status_id, 'VALIDATION_ERROR', 'A batch may update each status chain only once');
            continue;
          }
          if (status.account_id !== input.account_id || status.consumerId !== input.consumerId) {
            fail(status.reporting_status_id, 'PERMISSION_DENIED', 'Reporting status scope is unavailable');
            continue;
          }
          const fingerprint = reportingConsumerStatusFingerprintV1(status);
          const existing = await client.query<
            JsonRow<ReportingLedgerConsumerStatementV1> & {
              semantic_fingerprint: string;
              account_id: string;
              consumer_id: string;
            }
          >(
            `SELECT data, semantic_fingerprint, account_id, consumer_id FROM adcp_reporting_consumer_statuses
             WHERE consumer_status_id = $1 AND account_id = $2 AND consumer_id = $3 FOR UPDATE`,
            [status.reporting_status_id, input.account_id, input.consumerId]
          );
          if (existing.rows[0]) {
            if (existing.rows[0].semantic_fingerprint !== fingerprint) {
              fail(status.reporting_status_id, 'IDEMPOTENCY_CONFLICT', 'reporting_status_id is unavailable');
              continue;
            }
            results.push({ inserted: false, value: clone(existing.rows[0].data) });
            storedResults.push({ kind: 'unchanged', id: status.reporting_status_id });
            continue;
          }
          const prevalidation = entry.validationError;
          if (prevalidation) {
            fail(
              status.reporting_status_id,
              'VALIDATION_ERROR',
              prevalidation,
              entry.validationField,
              'correctable',
              entry.validationKeyword
            );
            continue;
          }
          if (Buffer.byteLength(JSON.stringify(status), 'utf8') > REPORTING_CONSUMER_STATUS_MAX_BYTES) {
            fail(
              status.reporting_status_id,
              'REPORTING_STATUS_TOO_LARGE',
              'Reporting consumer status exceeds 64 KiB',
              undefined,
              'correctable'
            );
            continue;
          }
          if (batchCapacityExhausted || remainingStatements <= 0) {
            fail(
              status.reporting_status_id,
              'REPORTING_STATUS_CAPACITY_EXHAUSTED',
              'Reporting consumer status capacity is exhausted',
              undefined,
              'terminal'
            );
            continue;
          }
          const chainKey = chainKeys[index]!;
          const current = await client.query<JsonRow<ReportingLedgerConsumerStatementV1>>(
            `SELECT data FROM adcp_reporting_consumer_statuses
             WHERE account_id = $1 AND consumer_id = $2 AND chain_key = $3 AND is_current
             FOR UPDATE`,
            [input.account_id, input.consumerId, chainKey]
          );
          const leaf = current.rows[0]?.data;
          if ((leaf?.reporting_status_id ?? undefined) !== status.supersedes_reporting_status_id) {
            fail(status.reporting_status_id, 'IDEMPOTENCY_CONFLICT', 'Status must supersede the exact current leaf');
            continue;
          }
          if (leaf && compareReportingInstants(status.status_as_of, leaf.status_as_of) < 0) {
            fail(status.reporting_status_id, 'VALIDATION_ERROR', 'Status time cannot regress');
            continue;
          }
          if (leaf) {
            await client.query(
              `UPDATE adcp_reporting_consumer_statuses SET is_current = false
               WHERE consumer_status_id = $1 AND account_id = $2 AND consumer_id = $3`,
              [leaf.reporting_status_id, input.account_id, input.consumerId]
            );
          }
          const recorded = await client.query<QueryResultRow & { recorded_at: Date }>(
            `SELECT GREATEST(
               clock_timestamp(),
               COALESCE((
                 SELECT MAX(ledger_as_of) + INTERVAL '1 millisecond'
                 FROM adcp_reporting_checkpoints
                 WHERE account_id = $1
               ), '-infinity'::timestamptz)
             ) AS recorded_at`,
            [input.account_id]
          );
          const value: ReportingLedgerConsumerStatementV1 = {
            ...status,
            recorded_at: recorded.rows[0]!.recorded_at.toISOString(),
          };
          await client.query(
            `INSERT INTO adcp_reporting_consumer_statuses
             (consumer_status_id, account_id, consumer_id, chain_key, revision_id, obligation_id,
              supersedes_consumer_status_id, is_current, semantic_fingerprint, data, created_at, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9::jsonb, $10, $10)`,
            [
              status.reporting_status_id,
              input.account_id,
              input.consumerId,
              chainKey,
              status.reporting_revision_id ?? null,
              status.reporting_obligation_id ?? null,
              status.supersedes_reporting_status_id ?? null,
              fingerprint,
              JSON.stringify(value),
              value.recorded_at,
            ]
          );
          results.push({ inserted: true, value: clone(value) });
          storedResults.push({ kind: 'recorded', id: status.reporting_status_id });
          remainingStatements -= 1;
        }
        boundStoredConsumerStatusResults(storedResults, results);
        if (!batchCapacityExhausted) {
          await client.query(
            `INSERT INTO adcp_reporting_consumer_status_batches
           (account_id, consumer_id, idempotency_key, request_fingerprint, status_ids, results)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
            [
              input.account_id,
              input.consumerId,
              input.idempotencyKey,
              input.requestFingerprint,
              JSON.stringify(
                results.map(value => ('value' in value ? value.value.reporting_status_id : value.reporting_status_id))
              ),
              JSON.stringify(storedResults),
            ]
          );
        }
        return results;
      },
      { preBeginAdvisoryLock: accountLock(input.account_id) }
    );
  }

  async listConsumerStatuses(revisionId: string): Promise<ReportingLedgerConsumerStatusV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerConsumerStatusV1>>(
      `SELECT data FROM adcp_reporting_consumer_statuses WHERE revision_id = $1
        AND consumer_id = '__legacy_unscoped_consumer__'
        ORDER BY recorded_at, consumer_status_id`,
      [revisionId]
    );
    return result.rows.map(row => clone(row.data));
  }

  async putIssue(issue: ReportingLedgerIssueV1): Promise<void> {
    const lock = await this.accountLockForObligation(issue.reporting_obligation_id);
    await this.transaction(
      async client => {
        const result = await client.query(
          `INSERT INTO adcp_reporting_issues (issue_id, obligation_id, data, observed_at, resolved_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       -- opened_at is fixed at first emission; see recordIssue.
       ON CONFLICT (issue_id) DO UPDATE SET
         data = jsonb_set(EXCLUDED.data, '{openedAt}', COALESCE(adcp_reporting_issues.data -> 'openedAt', EXCLUDED.data -> 'openedAt')),
         observed_at = EXCLUDED.observed_at,
         resolved_at = EXCLUDED.resolved_at,
         changed_at = clock_timestamp()
       WHERE adcp_reporting_issues.obligation_id = EXCLUDED.obligation_id`,
          [
            issue.issueId,
            issue.reporting_obligation_id,
            JSON.stringify(issue),
            issue.observedAt,
            issue.resolvedAt ?? null,
          ]
        );
        if (result.rowCount !== 1) throw new Error('Reporting issue identity belongs to another obligation');
      },
      { preBeginAdvisoryLock: lock }
    );
  }

  async resolveIssue(issueId: string, resolvedAt: string): Promise<void> {
    const lock = await this.accountLockForIssue(issueId);
    if (!lock) return;
    await this.transaction(
      async client => {
        await client.query(
          `UPDATE adcp_reporting_issues
          SET resolved_at = $2::text::timestamptz,
              data = data || jsonb_build_object('resolvedAt', $2::text),
              changed_at = clock_timestamp()
        WHERE issue_id = $1 AND resolved_at IS NULL`,
          [issueId, resolvedAt]
        );
      },
      { preBeginAdvisoryLock: lock }
    );
  }

  async listIssues(obligationId: string): Promise<ReportingLedgerIssueV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerIssueV1>>(
      `SELECT data FROM adcp_reporting_issues WHERE obligation_id = $1
        ORDER BY observed_at, issue_id`,
      [obligationId]
    );
    return result.rows.map(row => clone(row.data));
  }

  async appendTransition(transition: ReportingLedgerStatusTransitionV1): Promise<{ inserted: boolean }> {
    const lock = await this.accountLockForObligation(transition.reporting_obligation_id);
    return this.transaction(
      async client => {
        const result = await client.query(
          `INSERT INTO adcp_reporting_transitions (transition_id, obligation_id, data, occurred_at)
       SELECT $1, $2, $3::jsonb, $4
        WHERE COALESCE((
          SELECT previous.data->>'health' FROM adcp_reporting_transitions previous
           WHERE previous.obligation_id = $2
           ORDER BY previous.transition_sequence DESC LIMIT 1
        ), 'waiting') = $5
       ON CONFLICT DO NOTHING RETURNING transition_id`,
          [
            transition.transitionId,
            transition.reporting_obligation_id,
            JSON.stringify(transition),
            transition.occurredAt,
            transition.previousHealth,
          ]
        );
        return { inserted: result.rowCount === 1 };
      },
      { preBeginAdvisoryLock: lock }
    );
  }

  async applyLifecycleProjection(input: {
    reporting_obligation_id: string;
    expectedRevisionIds: string[];
    expectedPreviousHealth: import('./types').ReportingHealthV1;
    expectedObligationState: ReportingLedgerObligationV1['state'];
    expectedAttemptCount: number;
    projectedIssues: ReportingLedgerIssueV1[];
    ledgerAsOf: string;
    transition?: ReportingLedgerStatusTransitionV1;
    expectedManagedStateVersion?: string;
    processedManagedStateVersion?: string;
    processedObligatedConsumerRosterVersion?: string;
  }): Promise<{ applied: boolean; transitionInserted: boolean }> {
    const lock = await this.accountLockForObligation(input.reporting_obligation_id);
    return this.transaction(
      async client => {
        const obligations = await client.query<JsonRow<ReportingLedgerObligationV1>>(
          `SELECT data FROM adcp_reporting_obligations WHERE obligation_id = $1 FOR UPDATE`,
          [input.reporting_obligation_id]
        );
        const revisions = await client.query<QueryResultRow & { revision_id: string }>(
          `SELECT revision_id FROM adcp_reporting_revisions
            WHERE obligation_id = $1 ORDER BY revision_number, revision_id`,
          [input.reporting_obligation_id]
        );
        const latest = await client.query<QueryResultRow & { health: string }>(
          `SELECT data->>'health' AS health FROM adcp_reporting_transitions
            WHERE obligation_id = $1 ORDER BY transition_sequence DESC LIMIT 1`,
          [input.reporting_obligation_id]
        );
        const revisionIds = revisions.rows.map(value => value.revision_id);
        const previousHealth = latest.rows[0]?.health ?? 'waiting';
        const obligation = obligations.rows[0]?.data;
        if (
          !obligation ||
          obligation.state !== input.expectedObligationState ||
          obligation.attemptCount !== input.expectedAttemptCount ||
          canonicalJsonV1(revisionIds) !== canonicalJsonV1(input.expectedRevisionIds) ||
          previousHealth !== input.expectedPreviousHealth
        ) {
          return { applied: false, transitionInserted: false };
        }
        // Extend the CAS over managed state. The projection reads managed rows
        // in a separate transaction, so without this a revocation, receipt,
        // adjustment or settled materialization landing in between would be
        // overwritten by a health computed before it existed — most visibly as
        // a `complete` persisted and webhooked over a receipt that had just
        // arrived. The caller retries on a false return.
        if (
          input.expectedManagedStateVersion !== undefined &&
          (await this.readManagedStateVersion(client, input.reporting_obligation_id)) !==
            input.expectedManagedStateVersion
        ) {
          return { applied: false, transitionInserted: false };
        }
        let transitionInserted = false;
        if (input.transition) {
          const inserted = await client.query(
            `INSERT INTO adcp_reporting_transitions (transition_id, obligation_id, data, occurred_at)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT DO NOTHING RETURNING transition_id`,
            [
              input.transition.transitionId,
              input.reporting_obligation_id,
              JSON.stringify(input.transition),
              input.transition.occurredAt,
            ]
          );
          if (inserted.rowCount !== 1) return { applied: false, transitionInserted: false };
          transitionInserted = true;
        }
        // Record the watermark inside the same fenced transaction as the
        // projection it describes, so it can only advance for state that was
        // actually applied.
        {
          await client.query(
            `INSERT INTO adcp_reporting_lifecycle_state
               (obligation_id, processed_state_version, processed_roster_version,
                current_roster_version, processed_at)
             VALUES ($1, $2, $3, $3, $4::timestamptz)
             ON CONFLICT (obligation_id) DO UPDATE SET
               processed_state_version = EXCLUDED.processed_state_version,
               processed_roster_version = EXCLUDED.processed_roster_version,
               -- Reconciling also observes the roster, so the current version
               -- moves with the processed one. A later external change
               -- publishes a different current version and re-arms; without
               -- this the two never matched and the obligation stayed due.
               current_roster_version = EXCLUDED.processed_roster_version,
               processed_at = EXCLUDED.processed_at,
               failure_count = 0,
               next_attempt_at = NULL`,
            [
              input.reporting_obligation_id,
              input.processedManagedStateVersion ?? null,
              // Empty string, not null: null means "never reconciled", which
              // is a due condition. A deployment with no roster source would
              // otherwise stay due forever.
              input.processedObligatedConsumerRosterVersion ?? '',
              // The cutoff the projection actually read at, never the commit
              // instant. Watermarking at commit time swallowed everything
              // that landed between the two: excluded from the projection,
              // and then behind the watermark forever, so it never became
              // due again.
              input.ledgerAsOf,
            ]
          );
        }
        const projectedIds = input.projectedIssues.map(issue => issue.issueId);
        for (const issue of input.projectedIssues) {
          await client.query(
            `INSERT INTO adcp_reporting_issues (issue_id, obligation_id, data, observed_at, resolved_at)
             VALUES ($1, $2, $3::jsonb, $4, NULL)
             -- opened_at is fixed at first emission; see recordIssue. A reopened
             -- issue keeps the anchor because it is the same issue_id.
             ON CONFLICT (issue_id) DO UPDATE SET
               data = jsonb_set(EXCLUDED.data, '{openedAt}', COALESCE(adcp_reporting_issues.data -> 'openedAt', EXCLUDED.data -> 'openedAt')),
               observed_at = EXCLUDED.observed_at,
               resolved_at = NULL, changed_at = clock_timestamp()
             WHERE adcp_reporting_issues.obligation_id = EXCLUDED.obligation_id`,
            [issue.issueId, input.reporting_obligation_id, JSON.stringify(issue), issue.observedAt]
          );
        }
        await client.query(
          `UPDATE adcp_reporting_issues
              SET resolved_at = $2::timestamptz,
                  data = data || jsonb_build_object('resolvedAt', $2::text),
                  changed_at = clock_timestamp()
            WHERE obligation_id = $1 AND resolved_at IS NULL
              AND data->>'code' IN ('REPORT_OVERDUE', 'REPORTING_COVERAGE_INCOMPLETE')
              AND NOT (issue_id = ANY($3::text[]))`,
          [input.reporting_obligation_id, input.ledgerAsOf, projectedIds]
        );
        return { applied: true, transitionInserted };
      },
      { preBeginAdvisoryLock: lock }
    );
  }

  async markTransitionNotified(transitionId: string, notifiedAt: string): Promise<void> {
    const lock = await this.accountLockForTransition(transitionId);
    if (!lock) return;
    await this.transaction(
      async client => {
        await client.query(
          `UPDATE adcp_reporting_transitions
          SET data = data || jsonb_build_object('notifiedAt', $2::text)
        WHERE transition_id = $1 AND NOT (data ? 'notifiedAt')`,
          [transitionId, notifiedAt]
        );
      },
      { preBeginAdvisoryLock: lock }
    );
  }

  async listTransitions(obligationId: string): Promise<ReportingLedgerStatusTransitionV1[]> {
    const result = await this.query<JsonRow<ReportingLedgerStatusTransitionV1>>(
      `SELECT data FROM adcp_reporting_transitions WHERE obligation_id = $1
        ORDER BY transition_sequence`,
      [obligationId]
    );
    return result.rows.map(row => clone(row.data));
  }

  async listPendingTransitions(
    input: { account_id?: string; limit?: number } = {}
  ): Promise<ReportingLedgerStatusTransitionV1[]> {
    const limit = input.limit ?? 100;
    positiveInteger(limit, 'limit');
    if (limit > 1_000) throw new RangeError('limit must not exceed 1000');
    const result = await this.query<JsonRow<ReportingLedgerStatusTransitionV1>>(
      `SELECT transition.data FROM adcp_reporting_transitions transition
         JOIN adcp_reporting_obligations obligation ON obligation.obligation_id = transition.obligation_id
        WHERE NOT (transition.data ? 'notifiedAt')
          AND ($1::text IS NULL OR obligation.account_id = $1)
        ORDER BY transition.recorded_at, transition.transition_id
        LIMIT $2`,
      [input.account_id ?? null, limit]
    );
    return result.rows.map(row => clone(row.data));
  }

  async createSnapshot(query: ReportingLedgerSnapshotQueryV1): Promise<ReportingLedgerSnapshotV1> {
    return this.transaction(
      async client => {
        const clock = await client.query<QueryResultRow & { ledger_as_of: Date }>(
          'SELECT statement_timestamp() AS ledger_as_of'
        );
        const ledgerAsOf = clock.rows[0]!.ledger_as_of.toISOString();
        await client.query(
          'DELETE FROM adcp_reporting_snapshots WHERE account_id = $1 AND expires_at <= clock_timestamp()',
          [query.account_id]
        );
        if (query.view === 'periods') {
          await client.query(
            'DELETE FROM adcp_reporting_checkpoints WHERE account_id = $1 AND expires_at <= clock_timestamp()',
            [query.account_id]
          );
        }
        const active = await client.query<QueryResultRow & { count: string; bytes: string }>(
          `SELECT COUNT(*)::text AS count, COALESCE(SUM(byte_count), 0)::text AS bytes
             FROM adcp_reporting_snapshots WHERE account_id = $1`,
          [query.account_id]
        );
        if (Number(active.rows[0]?.count ?? 0) >= MAX_ACTIVE_SNAPSHOTS_PER_ACCOUNT) {
          throw new Error('Reporting ledger snapshot capacity is exhausted');
        }
        const activeSnapshotBytes = Number(active.rows[0]?.bytes ?? 0);
        const changesAfter = query.changes_after
          ? await this.resolveChangesCheckpoint(client, query, query.changes_after)
          : undefined;
        const managedInstalled = this.managedDelivery && (await this.managedTablesInstalled(client));
        const configurations = await this.listSnapshotConfigurations(client, query, ledgerAsOf);
        if (configurations.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting ledger snapshot exceeds the configuration limit');
        }
        let obligations = await this.listSnapshotObligations(client, query, ledgerAsOf, changesAfter);
        if (managedInstalled && changesAfter) {
          const managedChangedIds = await this.listManagedChangedObligationIds(client, query, ledgerAsOf, changesAfter);
          if (managedChangedIds.size) {
            const fullScope = await this.listSnapshotObligations(
              client,
              { ...query, changes_after: undefined, health: undefined },
              ledgerAsOf
            );
            const byId = new Map(obligations.map(value => [value.reporting_obligation_id, value]));
            for (const obligation of fullScope) {
              if (managedChangedIds.has(obligation.reporting_obligation_id)) {
                byId.set(obligation.reporting_obligation_id, obligation);
              }
            }
            obligations = [...byId.values()].sort(
              (left, right) =>
                left.period.start.localeCompare(right.period.start) ||
                left.reporting_obligation_id.localeCompare(right.reporting_obligation_id)
            );
          }
        }
        if (obligations.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting ledger snapshot exceeds the item limit');
        }
        const coverageObligations = changesAfter
          ? await this.listSnapshotObligations(
              client,
              { ...query, changes_after: undefined, health: undefined, finality: undefined },
              ledgerAsOf
            )
          : obligations;
        if (coverageObligations.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting ledger snapshot exceeds the coverage item limit');
        }
        const ledgerCoverage = evaluateReportingLedgerCoverageV1(
          query,
          configurations,
          coverageObligations.map(value => ({
            configurationId: value.configurationId,
            periodOrdinal: value.periodOrdinal,
          })),
          ledgerAsOf
        );
        let consumerStatuses = query.consumer_id
          ? await this.listSnapshotConsumerStatuses(client, query, ledgerAsOf, changesAfter, MAX_SNAPSHOT_ITEMS + 1)
          : [];
        if (consumerStatuses.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting ledger snapshot exceeds the consumer status limit');
        }
        const consumerStatusProjection = query.consumer_id
          ? await this.listSnapshotConsumerStatuses(client, query, ledgerAsOf, undefined, MAX_SNAPSHOT_ITEMS + 1)
          : [];
        if (consumerStatusProjection.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting ledger snapshot exceeds the consumer status projection limit');
        }
        const supersededConsumerStatusIds = new Set(
          consumerStatusProjection
            .map(value => value.supersedes_reporting_status_id)
            .filter((value): value is string => Boolean(value))
        );
        const exposesMissingObligationStatus =
          query.view === 'periods' &&
          consumerStatusProjection.some(
            value =>
              value.consumer_status === 'obligation_missing' &&
              !supersededConsumerStatusIds.has(value.reporting_status_id)
          );
        if (query.view !== 'revision' && !ledgerCoverage.complete && !exposesMissingObligationStatus) {
          throw new ReportingLedgerContinuityError('Reporting ledger is missing an elapsed obligation');
        }
        const obligationIds = obligations.map(value => value.reporting_obligation_id);
        const remaining = MAX_SNAPSHOT_ITEMS - obligations.length;
        let revisions = await this.listSnapshotRevisions(client, obligationIds, query, ledgerAsOf, remaining + 1);
        if (revisions.length > remaining) throw new Error('Reporting ledger snapshot exceeds the item limit');
        const adjustmentCapacity = remaining - revisions.length;
        let adjustments = await this.listSnapshotAdjustments(client, obligationIds, ledgerAsOf, adjustmentCapacity + 1);
        if (adjustments.length > adjustmentCapacity) {
          throw new Error('Reporting ledger snapshot exceeds the item limit');
        }
        const consumerStatusCapacity = adjustmentCapacity - adjustments.length;
        if (consumerStatuses.length > consumerStatusCapacity) {
          throw new Error('Reporting ledger snapshot exceeds the item limit');
        }
        let issues = await this.listSnapshotIssues(client, obligationIds, MAX_SNAPSHOT_ITEMS + 1);
        const managedBindings = managedInstalled
          ? await this.listSnapshotManagedBindings(
              client,
              configurations.map(value => value.configurationId)
            )
          : [];
        let materializations = managedInstalled
          ? await this.listSnapshotMaterializations(client, obligationIds, ledgerAsOf, changesAfter)
          : [];
        let receipts =
          managedInstalled && query.consumer_id
            ? await this.listSnapshotReceipts(client, query, obligationIds, ledgerAsOf, changesAfter, 'revision')
            : [];
        let adjustmentReceipts =
          managedInstalled && query.consumer_id
            ? await this.listSnapshotReceipts(client, query, obligationIds, ledgerAsOf, changesAfter, 'adjustment')
            : [];
        // Terminal acceptances whose bodies have aged out. The projection
        // needs them or a settled subject reopens the moment retention bites.
        const tombstonedAcceptedSubjects = managedInstalled
          ? await this.listTombstonedAcceptedSubjects(client, query, obligationIds)
          : [];
        // Conclusions survive their evidence: a pruned successful
        // materialization must still read as delivered, or the filtered
        // health path recomputes a settled revision as never delivered.
        const tombstonedDeliveredRevisionIds = managedInstalled
          ? (
              await client.query<QueryResultRow & { revision_id: string }>(
                `SELECT revision_id FROM adcp_reporting_materialization_tombstones
                  WHERE obligation_id = ANY($1::text[]) AND reached_success LIMIT $2`,
                [obligationIds, MAX_SNAPSHOT_ITEMS + 1]
              )
            ).rows.map(row => row.revision_id)
          : [];
        const materializationProjection = managedInstalled
          ? await this.listSnapshotMaterializationProjection(client, obligationIds, ledgerAsOf)
          : [];
        const materializationHistoryProjection =
          managedInstalled && changesAfter
            ? await this.listSnapshotMaterializations(client, obligationIds, ledgerAsOf)
            : materializations;
        const receiptProjection =
          managedInstalled && query.consumer_id && changesAfter
            ? await this.listSnapshotReceipts(client, query, obligationIds, ledgerAsOf, undefined, 'revision')
            : receipts;
        const adjustmentReceiptProjection =
          managedInstalled && query.consumer_id && changesAfter
            ? await this.listSnapshotReceipts(client, query, obligationIds, ledgerAsOf, undefined, 'adjustment')
            : adjustmentReceipts;
        if (
          materializationProjection.length > MAX_SNAPSHOT_ITEMS ||
          materializationHistoryProjection.length > MAX_SNAPSHOT_ITEMS ||
          receiptProjection.length > MAX_SNAPSHOT_ITEMS ||
          adjustmentReceiptProjection.length > MAX_SNAPSHOT_ITEMS
        ) {
          throw new Error('Reporting ledger snapshot exceeds the managed projection limit');
        }
        if (
          obligations.length +
            revisions.length +
            adjustments.length +
            consumerStatuses.length +
            materializations.length +
            receipts.length +
            adjustmentReceipts.length >
          MAX_SNAPSHOT_ITEMS
        ) {
          throw new Error('Reporting ledger snapshot exceeds the item limit');
        }
        if (issues.length > MAX_SNAPSHOT_ITEMS) throw new Error('Reporting ledger snapshot exceeds the issue limit');
        // Filter the same composite health that the handler emits so cursor
        // counts and pages remain truthful for both Core and Managed stores.
        if (query.view === 'periods' && query.health) {
          const scopedObligations = obligations;
          const accepted = new Set(
            scopedObligations
              .filter(value => {
                const obligationRevisions = revisions.filter(
                  item => item.reporting_obligation_id === value.reporting_obligation_id
                );
                const sellerHealth = projectReportingObligationHealthV1(
                  value,
                  obligationRevisions,
                  ledgerAsOf,
                  reportingLedgerScopeClosed(query, ledgerAsOf, ledgerCoverage.complete)
                ).health;
                const statuses = consumerStatusProjection.filter(status => statusMatchesObligation(status, value));
                const leaf = currentConsumerStatus(statuses);
                // Must use the same projection the handler emits, not a second
                // copy of the rule. rc.3 made a stale-`received` mismatch
                // `delayed` inside its grace window, so hardcoding
                // `action_required` here made such an obligation unreachable
                // under every health filter: excluded from the snapshot when
                // the caller asks for `delayed`, and dropped by the handler's
                // own filter when the caller asks for `action_required`.
                const mismatch = projectReportingConsumerStatusMismatchV1(
                  value,
                  leaf,
                  obligationRevisions,
                  sellerHealth,
                  ledgerAsOf,
                  this.consumerMismatchEscalation
                );
                const baseProjection = projectReportingObligationHealthV1(
                  value,
                  obligationRevisions,
                  ledgerAsOf,
                  reportingLedgerScopeClosed(query, ledgerAsOf, ledgerCoverage.complete)
                );
                const managed = projectManagedDelivery(
                  value,
                  managedBindings.find(binding => binding.configurationId === value.configurationId),
                  obligationRevisions,
                  adjustments.filter(item => item.reporting_obligation_id === value.reporting_obligation_id),
                  materializationProjection.filter(
                    item => item.reporting_obligation_id === value.reporting_obligation_id
                  ),
                  materializationHistoryProjection.filter(
                    item => item.reporting_obligation_id === value.reporting_obligation_id
                  ),
                  receiptProjection,
                  adjustmentReceiptProjection,
                  baseProjection,
                  ledgerAsOf,
                  tombstonedAcceptedSubjects,
                  tombstonedDeliveredRevisionIds
                );
                const health = mismatch
                  ? moreSevereReportingHealthV1(managed?.projection.health ?? sellerHealth, mismatch.health)
                  : (managed?.projection.health ?? sellerHealth);
                return query.health!.includes(health);
              })
              .map(value => value.reporting_obligation_id)
          );
          const obligationsByConsumerStatusChain = new Map(
            scopedObligations.map(value => [consumerStatusChainKeyForObligation(value), value])
          );
          const projectedStatusesByChain = new Map<string, ReportingLedgerConsumerStatementV1[]>();
          for (const status of consumerStatusProjection) {
            const key = reportingConsumerStatusChainKeyV1(status);
            const statuses = projectedStatusesByChain.get(key) ?? [];
            statuses.push(status);
            projectedStatusesByChain.set(key, statuses);
          }
          obligations = obligations.filter(value => accepted.has(value.reporting_obligation_id));
          revisions = revisions.filter(value => accepted.has(value.reporting_obligation_id));
          adjustments = adjustments.filter(value => accepted.has(value.reporting_obligation_id));
          materializations = materializations.filter(value => accepted.has(value.reporting_obligation_id));
          const acceptedRevisionIds = new Set(revisions.map(value => value.reporting_revision_id));
          const acceptedAdjustmentIds = new Set(adjustments.map(value => value.reporting_adjustment_id));
          receipts = receipts.filter(value => acceptedRevisionIds.has(value.reporting_revision_id));
          adjustmentReceipts = adjustmentReceipts.filter(value =>
            acceptedAdjustmentIds.has(value.reporting_adjustment_id)
          );
          consumerStatuses = consumerStatuses.filter(value => {
            const key = reportingConsumerStatusChainKeyV1(value);
            const matchingObligation = obligationsByConsumerStatusChain.get(key);
            if (matchingObligation) return accepted.has(matchingObligation.reporting_obligation_id);
            const leaf = currentConsumerStatus(projectedStatusesByChain.get(key) ?? []);
            return query.health!.includes('action_required') && leaf?.consumer_status === 'obligation_missing';
          });
          issues = issues.filter(value => accepted.has(value.reporting_obligation_id));
        }
        const changesCheckpoint = randomUUID();
        const snapshot: ReportingLedgerSnapshotV1 = {
          snapshotId: randomUUID(),
          ledgerAsOf,
          changesCheckpoint,
          queryFingerprint: digest(query),
          query: clone(query),
          configurations,
          coverageOrdinals: coverageObligations.map(value => ({
            configurationId: value.configurationId,
            periodOrdinal: value.periodOrdinal,
          })),
          obligations,
          revisions,
          adjustments,
          ...(managedInstalled
            ? {
                tombstonedAcceptedSubjects,
                tombstonedDeliveredRevisionIds,
                managedBindings,
                materializations,
                materializationHistoryProjection,
                materializationProjection,
                receipts,
                receiptProjection,
                adjustmentReceipts,
                adjustmentReceiptProjection,
              }
            : {}),
          consumerStatuses,
          consumerStatusProjection,
          issues,
        };
        const snapshotJson = JSON.stringify(snapshot);
        const snapshotBytes = Buffer.byteLength(snapshotJson, 'utf8');
        if (snapshotBytes > MAX_SNAPSHOT_BYTES) {
          throw new Error('Reporting ledger snapshot exceeds the byte limit');
        }
        if (activeSnapshotBytes + snapshotBytes > MAX_ACTIVE_SNAPSHOT_BYTES_PER_ACCOUNT) {
          throw new Error('Reporting ledger snapshot byte capacity is exhausted');
        }
        await client.query(
          `INSERT INTO adcp_reporting_snapshots
           (snapshot_id, account_id, query_fingerprint, data, byte_count, created_at, expires_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6,
                 $6::timestamptz + ($7::bigint * INTERVAL '1 millisecond'))`,
          [
            snapshot.snapshotId,
            query.account_id,
            snapshot.queryFingerprint,
            snapshotJson,
            snapshotBytes,
            ledgerAsOf,
            SNAPSHOT_RETENTION_MS,
          ]
        );
        if (query.view === 'periods') {
          await client.query(
            `INSERT INTO adcp_reporting_checkpoints
           (checkpoint_id, account_id, scope_fingerprint, ledger_as_of, expires_at)
         VALUES ($1, $2, $3, $4,
                 $4::timestamptz + ($5::bigint * INTERVAL '1 millisecond'))`,
            [
              changesCheckpoint,
              query.account_id,
              checkpointScopeFingerprint(query),
              ledgerAsOf,
              CHECKPOINT_RETENTION_MS,
            ]
          );
        }
        return clone(snapshot);
      },
      {
        isolation: 'REPEATABLE READ',
        preBeginAdvisoryLock: `adcp-reporting-account:${query.account_id}`,
      }
    );
  }

  async readSnapshotPage(
    snapshotId: string,
    account_id: string,
    cursor: string | undefined,
    limit: number
  ): Promise<ReportingLedgerPageV1> {
    positiveInteger(limit, 'limit');
    if (limit > 500) throw new RangeError('limit must not exceed 500');
    if (!UUID_PATTERN.test(snapshotId)) throw new ReportingLedgerSnapshotUnavailableError();
    const snapshot = await this.one<ReportingLedgerSnapshotV1>(
      `SELECT data FROM adcp_reporting_snapshots
        WHERE snapshot_id = $1 AND account_id = $2 AND expires_at > clock_timestamp()`,
      [snapshotId, account_id]
    );
    if (!snapshot) throw new ReportingLedgerSnapshotUnavailableError();
    const offset = cursor ? decodeCursor(cursor, snapshot) : 0;
    const items = snapshotItems(snapshot);
    const selected = items.slice(offset, offset + limit);
    const obligations = selected
      .filter((value): value is Extract<(typeof items)[number], { kind: 'obligation' }> => value.kind === 'obligation')
      .map(value => value.value);
    const revisions = selected
      .filter((value): value is Extract<(typeof items)[number], { kind: 'revision' }> => value.kind === 'revision')
      .map(value => value.value);
    const adjustments = selected
      .filter((value): value is Extract<(typeof items)[number], { kind: 'adjustment' }> => value.kind === 'adjustment')
      .map(value => value.value);
    const consumerStatuses = selected
      .filter(
        (value): value is Extract<(typeof items)[number], { kind: 'consumer_status' }> =>
          value.kind === 'consumer_status'
      )
      .map(value => value.value);
    const materializations = selected
      .filter(
        (value): value is Extract<(typeof items)[number], { kind: 'materialization' }> =>
          value.kind === 'materialization'
      )
      .map(value => value.value);
    const receipts = selected
      .filter((value): value is Extract<(typeof items)[number], { kind: 'receipt' }> => value.kind === 'receipt')
      .map(value => value.value);
    const adjustmentReceipts = selected
      .filter(
        (value): value is Extract<(typeof items)[number], { kind: 'adjustment_receipt' }> =>
          value.kind === 'adjustment_receipt'
      )
      .map(value => value.value);
    const nextOffset = offset + selected.length;
    const hasMore = nextOffset < items.length;
    return {
      snapshot,
      obligations,
      revisions,
      adjustments,
      materializations,
      receipts,
      adjustmentReceipts,
      consumerStatuses,
      totalCount: items.length,
      offset,
      limit,
      hasMore,
      ...(hasMore ? { nextCursor: encodeCursor(snapshot, nextOffset) } : {}),
    };
  }

  private async listSnapshotConsumerStatuses(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    ledgerAsOf: string,
    changesAfter: string | undefined,
    limit: number,
    currentOnly = false
  ): Promise<ReportingLedgerConsumerStatementV1[]> {
    const period = reportingLedgerEffectivePeriod(query, ledgerAsOf);
    const result = await client.query<JsonRow<ReportingLedgerConsumerStatementV1>>(
      `SELECT status.data FROM adcp_reporting_consumer_statuses status
        JOIN adcp_reporting_configurations configuration
          ON configuration.account_id = status.account_id
         AND configuration.delivery_config_id = status.data->>'delivery_config_id'
         AND configuration.delivery_config_version = (status.data->>'delivery_config_version')::integer
       WHERE status.account_id = $1 AND status.consumer_id = $2
         AND status.recorded_at <= $3
         AND ($4::timestamptz IS NULL OR status.recorded_at > $4)
         AND ($5::text[] IS NULL OR status.data->>'delivery_config_id' = ANY($5))
         AND ($10::text IS NOT NULL OR (status.data->'period'->>'end')::timestamptz > $6)
         AND ($10::text IS NOT NULL OR (status.data->'period'->>'start')::timestamptz < $7)
         AND ($8::text[] IS NULL OR configuration.data->>'feedPurpose' = ANY($8))
         AND ($9::text[] IS NULL OR configuration.data->'mediaBuyIds' ?| $9::text[])
         AND ($10::text IS NULL OR status.data->>'reporting_revision_id' = $10)
         AND (NOT $11::boolean OR status.is_current)
       ORDER BY status.recorded_at, status.consumer_status_id
       LIMIT $12`,
      [
        query.account_id,
        query.consumer_id,
        ledgerAsOf,
        changesAfter ?? null,
        query.delivery_config_ids ?? null,
        period.start,
        period.end,
        query.feed_purposes ?? null,
        query.media_buy_ids ?? null,
        query.reporting_revision_id ?? null,
        currentOnly,
        limit,
      ]
    );
    return result.rows.map(row => clone(row.data));
  }

  private async listSnapshotObligations(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    ledgerAsOf: string,
    changesAfter?: string
  ): Promise<ReportingLedgerObligationV1[]> {
    const defaultPeriod =
      query.view === 'revision'
        ? { start: null, end: null }
        : {
            start: new Date(Date.parse(ledgerAsOf) - 24 * 60 * 60 * 1_000).toISOString(),
            end: ledgerAsOf,
          };
    const result = await client.query<JsonRow<ReportingLedgerObligationV1>>(
      `SELECT data FROM adcp_reporting_obligations
        WHERE account_id = $1 AND created_at <= $2
          AND ($3::timestamptz IS NULL OR changed_at > $3 OR EXISTS (
            SELECT 1 FROM adcp_reporting_revisions revision
             WHERE revision.obligation_id = adcp_reporting_obligations.obligation_id
               AND revision.recorded_at > $3 AND revision.recorded_at <= $2
          ) OR EXISTS (
            SELECT 1 FROM adcp_reporting_adjustments adjustment
             WHERE adjustment.obligation_id = adcp_reporting_obligations.obligation_id
               AND adjustment.recorded_at > $3 AND adjustment.recorded_at <= $2
          ) OR EXISTS (
            SELECT 1 FROM adcp_reporting_consumer_statuses status
             WHERE status.account_id = $1
               AND status.consumer_id = $10
               AND (
                 status.obligation_id = adcp_reporting_obligations.obligation_id
                 OR (
                   status.data->>'delivery_config_id' = adcp_reporting_obligations.data->>'delivery_config_id'
                   AND (status.data->>'delivery_config_version')::bigint =
                     (adcp_reporting_obligations.data->>'delivery_config_version')::bigint
                   AND status.data->>'report_definition_id' = adcp_reporting_obligations.data->>'report_definition_id'
                   AND (status.data->'period'->>'start')::timestamptz = period_start
                   AND (status.data->'period'->>'end')::timestamptz = period_end
                   AND status.data->'period'->>'source_timezone' =
                     adcp_reporting_obligations.data->'period'->>'sourceTimezone'
                 )
               )
               AND status.recorded_at > $3 AND status.recorded_at <= $2
          ) OR EXISTS (
            SELECT 1 FROM adcp_reporting_issues issue
             WHERE issue.obligation_id = adcp_reporting_obligations.obligation_id
               AND issue.changed_at > $3 AND issue.changed_at <= $2
          ) OR EXISTS (
            SELECT 1 FROM adcp_reporting_transitions transition
             WHERE transition.obligation_id = adcp_reporting_obligations.obligation_id
               AND transition.recorded_at > $3 AND transition.recorded_at <= $2
          ) OR ((data->>'expectedAt')::timestamptz > $3 AND (data->>'expectedAt')::timestamptz <= $2)
            OR ((data->>'recoveryDeadlineAt')::timestamptz > $3
              AND (data->>'recoveryDeadlineAt')::timestamptz <= $2)
          )
          AND ($4::text[] IS NULL OR data->>'delivery_config_id' = ANY($4))
          AND ($5::text[] IS NULL OR data->>'feedPurpose' = ANY($5))
          AND ($6::text[] IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(data->'mediaBuyIds') value WHERE value = ANY($6)
          ))
          AND ($7::timestamptz IS NULL OR period_end > $7)
          AND ($8::timestamptz IS NULL OR period_start < $8)
          AND ($9::text IS NOT NULL OR period_end <= $2)
          AND ($9::text IS NULL OR EXISTS (
            SELECT 1 FROM adcp_reporting_revisions exact_revision
             WHERE exact_revision.obligation_id = adcp_reporting_obligations.obligation_id
               AND exact_revision.revision_id = $9 AND exact_revision.recorded_at <= $2
          ))
        ORDER BY period_start, obligation_id
        LIMIT $11`,
      [
        query.account_id,
        ledgerAsOf,
        changesAfter ?? null,
        query.delivery_config_ids ?? null,
        query.feed_purposes ?? null,
        query.media_buy_ids ?? null,
        query.period?.start ?? defaultPeriod.start,
        query.period?.end ?? defaultPeriod.end,
        query.reporting_revision_id ?? null,
        query.consumer_id ?? null,
        MAX_SNAPSHOT_ITEMS + 1,
      ]
    );
    return result.rows.map(row => row.data);
  }

  private async listSnapshotConfigurations(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    ledgerAsOf: string
  ): Promise<ReportingLedgerConfigurationV1[]> {
    const result = await client.query<JsonRow<ReportingLedgerConfigurationV1>>(
      `SELECT data FROM adcp_reporting_configurations
        WHERE account_id = $1 AND created_at <= $2
          AND ($3::text[] IS NULL OR delivery_config_id = ANY($3))
        ORDER BY delivery_config_id, delivery_config_version
        LIMIT $4`,
      [query.account_id, ledgerAsOf, query.delivery_config_ids ?? null, MAX_SNAPSHOT_ITEMS + 1]
    );
    return result.rows.map(row => row.data);
  }

  private async resolveChangesCheckpoint(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    checkpointId: string
  ): Promise<string> {
    if (!UUID_PATTERN.test(checkpointId)) throw new ReportingLedgerSnapshotUnavailableError();
    const result = await client.query<QueryResultRow & { ledger_as_of: Date }>(
      `SELECT ledger_as_of FROM adcp_reporting_checkpoints
        WHERE checkpoint_id = $1 AND account_id = $2 AND scope_fingerprint = $3
          AND expires_at > clock_timestamp()`,
      [checkpointId, query.account_id, checkpointScopeFingerprint(query)]
    );
    const value = result.rows[0]?.ledger_as_of;
    if (!value) throw new ReportingLedgerSnapshotUnavailableError();
    return value.toISOString();
  }

  private async listSnapshotRevisions(
    client: ReportingPgClient,
    obligationIds: string[],
    query: ReportingLedgerSnapshotQueryV1,
    ledgerAsOf: string,
    limit: number
  ): Promise<ReportingLedgerRevisionSnapshotV1[]> {
    if (!obligationIds.length) return [];
    const result = await client.query<JsonRow<ReportingLedgerRevisionSnapshotV1>>(
      `SELECT data - 'rows' AS data FROM adcp_reporting_revisions
        WHERE obligation_id = ANY($1::text[]) AND recorded_at <= $2
          AND ($3::text IS NULL OR revision_id = $3)
        ORDER BY obligation_id, revision_number
        LIMIT $4`,
      [obligationIds, ledgerAsOf, query.reporting_revision_id ?? null, limit]
    );
    return result.rows.map(row => row.data);
  }

  private async listSnapshotIssues(
    client: ReportingPgClient,
    obligationIds: string[],
    limit: number
  ): Promise<ReportingLedgerIssueV1[]> {
    if (!obligationIds.length) return [];
    const result = await client.query<JsonRow<ReportingLedgerIssueV1>>(
      `SELECT data FROM adcp_reporting_issues
        WHERE obligation_id = ANY($1::text[])
        ORDER BY obligation_id, observed_at, issue_id
        LIMIT $2`,
      [obligationIds, limit]
    );
    return result.rows.map(row => row.data);
  }

  private async listSnapshotAdjustments(
    client: ReportingPgClient,
    obligationIds: string[],
    ledgerAsOf: string,
    limit: number
  ): Promise<ReportingLedgerAdjustmentSnapshotV1[]> {
    if (!obligationIds.length) return [];
    const result = await client.query<JsonRow<ReportingLedgerAdjustmentSnapshotV1>>(
      `SELECT data - 'rows' AS data FROM adcp_reporting_adjustments
        WHERE obligation_id = ANY($1::text[]) AND recorded_at <= $2
        ORDER BY obligation_id, adjustment_number
        LIMIT $3`,
      [obligationIds, ledgerAsOf, limit]
    );
    return result.rows.map(row => row.data);
  }

  /**
   * Managed Delivery projection inputs for one obligation, grouped per consumer.
   *
   * The lifecycle reconciler folds these through the same
   * `projectManagedDelivery` the read path uses, so a persisted transition and
   * its webhook report the health a read of the same obligation would return.
   * Returns `null` when Managed Delivery is not installed or the obligation's
   * configuration has no binding, which keeps a Core-only ledger unchanged.
   */
  async getManagedLifecycleProjection(input: {
    reporting_obligation_id: string;
    ledgerAsOf?: string;
  }): Promise<ReportingManagedLifecycleProjectionV1 | null> {
    if (!this.managedDelivery) return null;
    const base = await this.transaction(
      async client => {
        if (!(await this.managedTablesInstalled(client))) return null;
        const obligation = await client.query<QueryResultRow & { configuration_id: string }>(
          'SELECT configuration_id FROM adcp_reporting_obligations WHERE obligation_id = $1',
          [input.reporting_obligation_id]
        );
        const configurationId = obligation.rows[0]?.configuration_id;
        if (!configurationId) return null;
        const [binding] = await this.listSnapshotManagedBindings(client, [configurationId]);
        if (!binding) return null;
        // Read the mutable rows once, with the columns needed to place them at
        // `ledgerAsOf` rather than at now. `status` lives in a row that is
        // updated in place, so a materialization recorded before the cutoff but
        // settled after it must project as it stood at the cutoff — otherwise a
        // later settlement is backdated into an earlier transition. `changed_at`
        // is when the row left `pending`, so `changed_at > ledgerAsOf` means it
        // was still pending then; the same applies to a revocation, which only
        // counts once `revoked_at` is at or before the cutoff.
        // Resolve the cutoff inside the snapshot when the caller did not pin
        // one, and keep every comparison against it in SQL.
        //
        // A caller's `new Date().toISOString()` is millisecond-truncated while
        // these columns are microsecond timestamps, so a cutoff taken in the
        // same millisecond as an insert sorts before it and the row silently
        // disappears — and comparing in JS re-truncates even a microsecond
        // cutoff. The placement predicates and the digest below therefore run
        // in SQL against one value, inside one REPEATABLE READ snapshot.
        const resolvedLedgerAsOf = (
          await client.query<QueryResultRow & { instant: string }>(
            // RFC 3339 with microseconds. PostgreSQL's own ::text rendering
            // uses a space separator and a two-digit offset, which the SDK's
            // instant parser rejects, and round-tripping through a JS Date
            // would truncate the microseconds this exists to preserve.
            `SELECT ${rfc3339Microseconds('COALESCE($1::timestamptz, clock_timestamp())')} AS instant`,
            [input.ledgerAsOf ?? null]
          )
        ).rows[0]!.instant;
        const rows = await client.query<
          JsonRow<ReportingMaterialization> & { settled_after_cutoff: boolean; revoked_at: Date | null }
        >(
          `SELECT materialization.data,
                  materialization.changed_at > $2::timestamptz AS settled_after_cutoff,
                  CASE WHEN authz.revoked_at <= $2::timestamptz THEN authz.revoked_at END AS revoked_at
             FROM adcp_reporting_materializations materialization
             JOIN adcp_reporting_destination_authorizations authz
               ON authz.account_id = materialization.account_id
              AND authz.destination_ref = materialization.destination_ref
              AND authz.generation = materialization.authorization_generation
            WHERE materialization.obligation_id = $1
              AND materialization.recorded_at <= $2::timestamptz
            ORDER BY materialization.attempt, materialization.materialization_id
            LIMIT $3`,
          [input.reporting_obligation_id, resolvedLedgerAsOf, MAX_SNAPSHOT_ITEMS + 1]
        );
        if (rows.rows.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting lifecycle projection exceeds the managed materialization limit');
        }
        const placed = rows.rows.map(row => ({
          atAsOf: row.settled_after_cutoff ? pendingAtCutoff(row.data) : clone(row.data),
          revokedAt: row.revoked_at,
        }));
        const materializationHistory = placed.map(value => value.atAsOf);
        const materializations = placed.map(({ atAsOf, revokedAt }) =>
          revokedAt && (atAsOf.status === 'available' || atAsOf.status === 'delivered')
            ? {
                ...atAsOf,
                status: 'failed' as const,
                failed_at: revokedAt.toISOString(),
                failure_code: 'AUTHORIZATION_REVOKED',
              }
            : atAsOf
        );
        // Every consumer, not just one authenticated caller: a persisted
        // transition is account-level, so the reconciler needs each consumer's
        // own receipt chain to fold the most severe outcome.
        const receipts = await client.query<
          JsonRow<ReportingReceipt | ReportingAdjustmentReceipt> & { consumer_id: string; receipt_kind: string }
        >(
          `SELECT receipt.consumer_id, receipt.receipt_kind, receipt.data
           FROM adcp_reporting_receipts receipt
          -- Ordered and cut off by the database clock, exactly as every other
          -- receipt read path is, so a skewed host cannot make the lifecycle
          -- projection see a different receipt set than get_reporting_status.
          WHERE receipt.recorded_at <= $2
            AND (
              (receipt.receipt_kind = 'revision' AND EXISTS (
                 SELECT 1 FROM adcp_reporting_revisions revision
                  WHERE revision.revision_id = receipt.subject_id
                    AND revision.obligation_id = $1
               ))
              OR (receipt.receipt_kind = 'adjustment' AND EXISTS (
                 SELECT 1 FROM adcp_reporting_adjustments adjustment
                  WHERE adjustment.adjustment_id = receipt.subject_id
                    AND adjustment.obligation_id = $1
               ))
            )
          ORDER BY receipt.consumer_id, receipt.recorded_at, receipt.reporting_receipt_id
          LIMIT $3`,
          [input.reporting_obligation_id, resolvedLedgerAsOf, MAX_SNAPSHOT_ITEMS + 1]
        );
        if (receipts.rows.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting lifecycle projection exceeds the managed receipt limit');
        }
        const byConsumer = new Map<string, ReportingManagedLifecycleProjectionV1['consumers'][number]>();
        for (const row of receipts.rows) {
          const consumer = byConsumer.get(row.consumer_id) ?? {
            consumer_id: row.consumer_id,
            receipts: [],
            adjustmentReceipts: [],
          };
          if (row.receipt_kind === 'revision') consumer.receipts.push(clone(row.data) as ReportingReceipt);
          else consumer.adjustmentReceipts.push(clone(row.data) as ReportingAdjustmentReceipt);
          byConsumer.set(row.consumer_id, consumer);
        }
        // Widen the roster past "who has already submitted a receipt" with every
        // consumer that has engaged with this obligation at all. It is still not
        // provably complete: destination authorizations and managed bindings are
        // keyed by (account_id, destination_ref, generation) with no consumer
        // dimension, so nothing durable here enumerates who owes a receipt. Say
        // so, and let the reconciler stay conservative.
        const engaged = await client.query<QueryResultRow & { consumer_id: string }>(
          `SELECT DISTINCT consumer_id FROM adcp_reporting_consumer_statuses
          WHERE obligation_id = $1 AND consumer_id <> '__legacy_unscoped_consumer__'
          ORDER BY consumer_id LIMIT $2`,
          [input.reporting_obligation_id, MAX_SNAPSHOT_ITEMS + 1]
        );
        if (engaged.rows.length > MAX_SNAPSHOT_ITEMS) {
          throw new Error('Reporting lifecycle projection exceeds the consumer roster limit');
        }
        const observed = [...new Set([...byConsumer.keys(), ...engaged.rows.map(row => row.consumer_id)])].sort();
        // Conclusions that outlived their evidence. Pruning removes bodies
        // and attempt rows, so without these the lifecycle would recompute an
        // accepted subject as outstanding and a delivered revision as never
        // delivered — retention would silently reopen settled work.
        const tombstonedAcceptedSubjects = await this.listTombstonedAcceptedSubjects(
          client,
          { account_id: binding.account_id, consumer_id: undefined, view: 'periods' } as ReportingLedgerSnapshotQueryV1,
          [input.reporting_obligation_id],
          true
        );
        const tombstonedDeliveredRevisionIds = (
          await client.query<QueryResultRow & { revision_id: string }>(
            `SELECT revision_id FROM adcp_reporting_materialization_tombstones
              WHERE obligation_id = $1 AND reached_success LIMIT $2`,
            [input.reporting_obligation_id, MAX_SNAPSHOT_ITEMS + 1]
          )
        ).rows.map(row => row.revision_id);
        // Read last, inside the same transaction as everything above, so the
        // token covers exactly the state this projection was computed from.
        const managedStateVersion = await this.readManagedStateVersion(client, input.reporting_obligation_id);
        return {
          binding,
          materializations,
          materializationHistory,
          consumers: [...byConsumer.values()],
          obligatedConsumerIds: observed,
          obligatedConsumerRosterComplete: false,
          managedStateVersion,
          resolvedLedgerAsOf,
          tombstonedAcceptedSubjects,
          tombstonedDeliveredRevisionIds,
        };
        // REPEATABLE READ, not the default. Under READ COMMITTED every statement
        // above takes its own snapshot, so a settle committing between the
        // materialization read and the digest read produced the one pairing that
        // defeats the CAS entirely: health computed from pre-settle rows carrying
        // a token that already matched post-settle state, which apply would then
        // accept. One snapshot for the reads and the token makes that pairing
        // unrepresentable. The transaction is read-only, so it cannot abort on a
        // write conflict.
      },
      { isolation: 'REPEATABLE READ' }
    );
    if (!base || !this.obligatedConsumers) return base;
    // Deliberately outside the transaction above. The documented purpose of
    // this hook is an external authorization lookup, and this subsystem's one
    // structural rule is that no network I/O happens inside the authoritative
    // transaction: a hung auth service would otherwise pin a pooled connection
    // and a snapshot per in-flight reconcile, and `probe` requires the managed
    // store to share the Core pool, so Core reads would drain with it. Bounded
    // for the same reason every adapter call is.
    const supplied = await withReportingCallbackDeadline(
      this.obligatedConsumers({
        reporting_obligation_id: input.reporting_obligation_id,
        account_id: base.binding.account_id,
      }),
      OBLIGATED_CONSUMERS_DEADLINE_MS,
      'Reporting obligated-consumer lookup deadline elapsed'
    );
    // A roster declared complete is authoritative: it is exactly who owes a
    // receipt. Merging observed principals into it meant any same-account
    // principal that had ever posted a status or receipt inserted itself into
    // the obligated set, so one rogue consumer could hold the whole account's
    // billing permanently unreconciled. Observed principals are still folded
    // in when the roster is NOT complete, where the union is the conservative
    // answer rather than a widening of an authority.
    const ids = obligatedConsumerIdsFor(supplied, base.obligatedConsumerIds ?? []);
    if (ids.length > MAX_SNAPSHOT_ITEMS) {
      throw new Error('Reporting lifecycle projection exceeds the consumer roster limit');
    }
    return {
      ...base,
      obligatedConsumerIds: ids,
      obligatedConsumerRosterComplete: supplied.complete === true,
      obligatedConsumerRosterVersion: obligatedConsumerRosterVersionFor(supplied, ids),
    };
  }

  /**
   * Digest over every managed row that can change this obligation's projected
   * health: materialization status, receipt existence and current-leaf flag,
   * adjustments, and the destination authorization's revocation/cleanup state.
   *
   * `is_current` is included because superseding a receipt flips it with no
   * timestamp of its own, and the authorization's `cleanup_completed_at` is
   * included because `completeRevocation` does not touch `changed_at`.
   */
  private async readManagedStateVersion(client: ReportingPgClient, obligationId: string): Promise<string> {
    const result = await client.query<QueryResultRow & { version: string }>(
      `SELECT md5(COALESCE(string_agg(marker, '|' ORDER BY marker), '')) AS version FROM (
         SELECT 'm:' || materialization_id || ':' || status || ':'
                || EXTRACT(EPOCH FROM changed_at)::text AS marker
           FROM adcp_reporting_materializations WHERE obligation_id = $1
         UNION ALL
         SELECT 'r:' || receipt.reporting_receipt_id || ':' || receipt.is_current::text || ':'
                || EXTRACT(EPOCH FROM receipt.recorded_at)::text
           FROM adcp_reporting_receipts receipt
          WHERE (receipt.receipt_kind = 'revision' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_revisions revision
                    WHERE revision.revision_id = receipt.subject_id AND revision.obligation_id = $1))
             OR (receipt.receipt_kind = 'adjustment' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_adjustments adjustment
                    WHERE adjustment.adjustment_id = receipt.subject_id AND adjustment.obligation_id = $1))
         UNION ALL
         SELECT 'a:' || adjustment_id || ':' || EXTRACT(EPOCH FROM recorded_at)::text
           FROM adcp_reporting_adjustments WHERE obligation_id = $1
         UNION ALL
         -- Consumer statuses are a health input through the mismatch
         -- projection and they widen the observed roster, so a status landing
         -- between projection and apply has to move the token too.
         SELECT 'c:' || status.consumer_id || ':' || status.consumer_status_id || ':'
                || status.is_current::text || ':' || EXTRACT(EPOCH FROM status.created_at)::text
           FROM adcp_reporting_consumer_statuses status
          WHERE status.obligation_id = $1
         UNION ALL
         SELECT 'z:' || authz.generation::text
                || ':' || COALESCE(EXTRACT(EPOCH FROM authz.revoked_at)::text, '')
                || ':' || COALESCE(EXTRACT(EPOCH FROM authz.cleanup_completed_at)::text, '')
                || ':' || EXTRACT(EPOCH FROM authz.changed_at)::text
           FROM adcp_reporting_destination_authorizations authz
           JOIN adcp_reporting_managed_bindings binding
             ON binding.account_id = authz.account_id AND binding.destination_ref = authz.destination_ref
           JOIN adcp_reporting_obligations obligation
             ON obligation.configuration_id = binding.configuration_id
          WHERE obligation.obligation_id = $1
       ) markers`,
      [obligationId]
    );
    return result.rows[0]?.version ?? '';
  }

  /**
   * Current external roster version, read outside any transaction so the
   * reconciler can re-check it immediately before an apply.
   */
  /**
   * Publishes the roster version currently observed for an obligation.
   *
   * The roster is external, so nothing in this database changes when it does.
   * Recording what a reader saw is what lets the due query notice drift from
   * the version last reconciled. Never lowers a watermark; it only reports.
   */
  async recordObligatedConsumerRosterVersion(input: {
    reporting_obligation_id: string;
    version: string;
  }): Promise<void> {
    await this.query(
      `INSERT INTO adcp_reporting_lifecycle_state
         (obligation_id, current_roster_version, roster_refreshed_at, processed_at)
       VALUES ($1, $2, clock_timestamp(), clock_timestamp())
       ON CONFLICT (obligation_id) DO UPDATE SET
         current_roster_version = EXCLUDED.current_roster_version,
         -- Advances the refresh cursor, never the reconciliation watermark:
         -- observing a roster is not reconciling an obligation.
         roster_refreshed_at = clock_timestamp()`,
      [input.reporting_obligation_id, input.version]
    );
  }

  /**
   * Re-reads the external roster for managed obligations and publishes what
   * it saw, so a change made while nothing was scheduled can re-arm.
   *
   * Ordered by least-recently-refreshed and bounded, so a large account is
   * swept over successive passes rather than in one burst of callbacks.
   */
  async refreshObligatedConsumerRosterVersions(input: { account_id?: string; limit: number }): Promise<number> {
    if (!this.managedDelivery || !this.obligatedConsumers) return 0;
    positiveInteger(input.limit, 'limit');
    if (!(await this.managedDueTablesReady())) return 0;
    const candidates = await this.query<QueryResultRow & { obligation_id: string }>(
      `SELECT obligation.obligation_id
         FROM adcp_reporting_obligations obligation
         JOIN adcp_reporting_managed_bindings binding
           ON binding.configuration_id = obligation.configuration_id
         LEFT JOIN adcp_reporting_lifecycle_state state
           ON state.obligation_id = obligation.obligation_id
        WHERE ($1::text IS NULL OR obligation.account_id = $1)
        -- Its own cursor, advanced by the refresh itself. Ordering by the
        -- reconciliation watermark, which a refresh never moves, meant every
        -- sweep re-read the same first page and nothing beyond one page of quiet
        -- obligations was ever refreshed, so their roster changes could never
        -- re-arm.
        ORDER BY state.roster_refreshed_at NULLS FIRST, obligation.obligation_id
        LIMIT $2`,
      [input.account_id ?? null, input.limit]
    );
    let refreshed = 0;
    for (const row of candidates.rows) {
      try {
        await this.readObligatedConsumerRosterVersion({ reporting_obligation_id: row.obligation_id });
        refreshed += 1;
      } catch {
        // One tenant's authorization service being down must not stop the
        // rest of the refresh; the obligation simply keeps its last version.
      }
    }
    return refreshed;
  }

  /**
   * Records a failed reconcile so the obligation backs off instead of
   * re-occupying the head of every sweep, without ever hiding it: the
   * watermark is untouched, so it stays unresolved work.
   */
  async recordLifecycleFailure(input: { reporting_obligation_id: string }): Promise<void> {
    await this.query(
      `INSERT INTO adcp_reporting_lifecycle_state (obligation_id, failure_count, next_attempt_at, processed_at)
       VALUES ($1, 1, clock_timestamp() + INTERVAL '30 seconds', clock_timestamp())
       ON CONFLICT (obligation_id) DO UPDATE SET
         failure_count = adcp_reporting_lifecycle_state.failure_count + 1,
         next_attempt_at = clock_timestamp() + (LEAST(
           ${MAX_LIFECYCLE_BACKOFF_SECONDS}, 30 * POWER(2, LEAST(6, adcp_reporting_lifecycle_state.failure_count))
         ) * INTERVAL '1 second')`,
      [input.reporting_obligation_id]
    );
  }

  /** Authoritative instant from the database clock, at microsecond precision. */
  async readLedgerInstant(): Promise<string> {
    const result = await this.query<QueryResultRow & { instant: string }>(
      `SELECT ${rfc3339Microseconds('clock_timestamp()')} AS instant`
    );
    return result.rows[0]!.instant;
  }

  async readObligatedConsumerRosterVersion(input: { reporting_obligation_id: string }): Promise<string | undefined> {
    if (!this.managedDelivery || !this.obligatedConsumers) return undefined;
    const accountId = await this.query<QueryResultRow & { account_id: string }>(
      'SELECT account_id FROM adcp_reporting_obligations WHERE obligation_id = $1',
      [input.reporting_obligation_id]
    );
    const account_id = accountId.rows[0]?.account_id;
    if (!account_id) return undefined;
    const supplied = await withReportingCallbackDeadline(
      this.obligatedConsumers({ reporting_obligation_id: input.reporting_obligation_id, account_id }),
      OBLIGATED_CONSUMERS_DEADLINE_MS,
      'Reporting obligated-consumer lookup deadline elapsed'
    );
    // Must hash exactly what the projection hashed, or an unversioned roster
    // never matches and every reconcile burns its retry budget and gives up.
    const observed = await this.observedConsumerIds(input.reporting_obligation_id);
    const version = obligatedConsumerRosterVersionFor(supplied, obligatedConsumerIdsFor(supplied, observed));
    await this.recordObligatedConsumerRosterVersion({
      reporting_obligation_id: input.reporting_obligation_id,
      version,
    });
    return version;
  }

  /** Principals that have engaged with this obligation, as the projection sees them. */
  private async observedConsumerIds(obligationId: string): Promise<string[]> {
    const result = await this.query<QueryResultRow & { consumer_id: string }>(
      `SELECT DISTINCT consumer_id FROM (
         SELECT receipt.consumer_id
           FROM adcp_reporting_receipts receipt
          WHERE (receipt.receipt_kind = 'revision' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_revisions revision
                    WHERE revision.revision_id = receipt.subject_id AND revision.obligation_id = $1))
             OR (receipt.receipt_kind = 'adjustment' AND EXISTS (
                   SELECT 1 FROM adcp_reporting_adjustments adjustment
                    WHERE adjustment.adjustment_id = receipt.subject_id AND adjustment.obligation_id = $1))
         UNION
         SELECT status.consumer_id FROM adcp_reporting_consumer_statuses status
          WHERE status.obligation_id = $1 AND status.consumer_id <> '__legacy_unscoped_consumer__'
       ) engaged ORDER BY consumer_id`,
      [obligationId]
    );
    return result.rows.map(row => row.consumer_id);
  }

  private managedDueTablesReadyCache: Promise<boolean> | undefined;

  /** Whether the managed schema exists, resolved once per store instance. */
  private managedDueTablesReady(): Promise<boolean> {
    if (!this.managedDelivery) return Promise.resolve(false);
    // Only a resolved answer is memoised. Caching the rejection made one
    // transient connection failure disable every later sweep until restart.
    this.managedDueTablesReadyCache ??= this.query<QueryResultRow & { ready: boolean }>(
      `SELECT to_regclass('adcp_reporting_managed_bindings') IS NOT NULL
          AND to_regclass('adcp_reporting_materializations') IS NOT NULL
          AND to_regclass('adcp_reporting_receipts') IS NOT NULL AS ready`
    )
      .then(result => result.rows[0]?.ready === true)
      .catch(cause => {
        this.managedDueTablesReadyCache = undefined;
        throw cause;
      });
    return this.managedDueTablesReadyCache;
  }

  /**
   * Terminal receipt subjects whose bodies have been pruned.
   *
   * The projection decides reconciliation from the receipt rows it can see,
   * so once an accepted leaf ages out the subject looks unreconciled again
   * and a settled billing period reopens. The tombstone is the only remaining
   * proof, so the projection has to consult it.
   */
  private async listTombstonedAcceptedSubjects(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    obligationIds: string[],
    allConsumers = false
  ): Promise<Array<{ kind: 'revision' | 'adjustment'; subjectId: string; consumerId: string }>> {
    if (!obligationIds.length || (!query.consumer_id && !allConsumers)) return [];
    const result = await client.query<
      QueryResultRow & { receipt_kind: string; subject_id: string; consumer_id: string }
    >(
      `SELECT tombstone.receipt_kind, tombstone.subject_id, tombstone.consumer_id
         FROM adcp_reporting_receipt_tombstones tombstone
        WHERE tombstone.account_id = $1 AND ($2::text IS NULL OR tombstone.consumer_id = $2)
          AND tombstone.status = 'accepted' AND tombstone.was_current
          AND ((tombstone.receipt_kind = 'revision' AND EXISTS (
                  SELECT 1 FROM adcp_reporting_revisions revision
                   WHERE revision.revision_id = tombstone.subject_id
                     AND revision.obligation_id = ANY($3::text[])))
            OR (tombstone.receipt_kind = 'adjustment' AND EXISTS (
                  SELECT 1 FROM adcp_reporting_adjustments adjustment
                   WHERE adjustment.adjustment_id = tombstone.subject_id
                     AND adjustment.obligation_id = ANY($3::text[]))))
        LIMIT $4`,
      [query.account_id, allConsumers ? null : query.consumer_id, obligationIds, MAX_SNAPSHOT_ITEMS + 1]
    );
    return result.rows.map(row => ({
      kind: row.receipt_kind === 'adjustment' ? ('adjustment' as const) : ('revision' as const),
      subjectId: row.subject_id,
      // Carried through deliberately. An acceptance belongs to the consumer
      // that gave it, so a lifecycle fold that runs per consumer must not let
      // A's pruned acceptance settle the obligation on B's behalf.
      consumerId: row.consumer_id,
    }));
  }

  private async managedTablesInstalled(client: ReportingPgClient): Promise<boolean> {
    const result = await client.query<QueryResultRow & { ready: boolean }>(
      `SELECT to_regclass('adcp_reporting_managed_bindings') IS NOT NULL
          AND to_regclass('adcp_reporting_materializations') IS NOT NULL
          AND to_regclass('adcp_reporting_receipts') IS NOT NULL AS ready`
    );
    return result.rows[0]?.ready === true;
  }

  private async listManagedChangedObligationIds(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    ledgerAsOf: string,
    changesAfter: string
  ): Promise<Set<string>> {
    const result = await client.query<QueryResultRow & { obligation_id: string }>(
      `SELECT DISTINCT changed.obligation_id FROM (
         SELECT materialization.obligation_id
           FROM adcp_reporting_materializations materialization
          WHERE materialization.account_id = $1
            AND GREATEST(materialization.recorded_at, materialization.changed_at) > $3
            AND GREATEST(materialization.recorded_at, materialization.changed_at) <= $2
         UNION ALL
         SELECT COALESCE(revision.obligation_id, adjustment.obligation_id) AS obligation_id
           FROM adcp_reporting_receipts receipt
      LEFT JOIN adcp_reporting_revisions revision
             ON receipt.receipt_kind = 'revision' AND revision.revision_id = receipt.subject_id
      LEFT JOIN adcp_reporting_adjustments adjustment
             ON receipt.receipt_kind = 'adjustment' AND adjustment.adjustment_id = receipt.subject_id
          WHERE receipt.account_id = $1 AND receipt.consumer_id = $4
            AND receipt.recorded_at > $3 AND receipt.recorded_at <= $2
         UNION ALL
         SELECT obligation.obligation_id
           FROM adcp_reporting_destination_authorizations authz
           JOIN adcp_reporting_managed_bindings binding
             ON binding.account_id = authz.account_id
            AND binding.destination_ref = authz.destination_ref
            AND binding.authorization_generation = authz.generation
           JOIN adcp_reporting_obligations obligation ON obligation.configuration_id = binding.configuration_id
          WHERE authz.account_id = $1 AND authz.revoked_at IS NOT NULL
            AND authz.changed_at > $3 AND authz.changed_at <= $2
       ) changed WHERE changed.obligation_id IS NOT NULL`,
      [query.account_id, ledgerAsOf, changesAfter, query.consumer_id ?? null]
    );
    return new Set(result.rows.map(row => row.obligation_id));
  }

  private async listSnapshotManagedBindings(
    client: ReportingPgClient,
    configurationIds: string[]
  ): Promise<ReportingManagedDeliveryBindingV1[]> {
    if (!configurationIds.length) return [];
    const result = await client.query<JsonRow<ReportingManagedDeliveryBindingV1>>(
      `SELECT data FROM adcp_reporting_managed_bindings
        WHERE configuration_id = ANY($1::text[]) ORDER BY configuration_id`,
      [configurationIds]
    );
    return result.rows.map(row => row.data);
  }

  private async listSnapshotMaterializations(
    client: ReportingPgClient,
    obligationIds: string[],
    ledgerAsOf: string,
    changesAfter?: string
  ): Promise<ReportingMaterialization[]> {
    if (!obligationIds.length) return [];
    const result = await client.query<JsonRow<ReportingMaterialization>>(
      `SELECT data FROM adcp_reporting_materializations
        WHERE obligation_id = ANY($1::text[])
          AND recorded_at <= $2
          AND ($3::timestamptz IS NULL OR GREATEST(recorded_at, changed_at) > $3)
        ORDER BY obligation_id, attempt, materialization_id
        LIMIT $4`,
      [obligationIds, ledgerAsOf, changesAfter ?? null, MAX_SNAPSHOT_ITEMS + 1]
    );
    return result.rows.map(row => row.data);
  }

  private async listSnapshotMaterializationProjection(
    client: ReportingPgClient,
    obligationIds: string[],
    ledgerAsOf: string
  ): Promise<ReportingMaterialization[]> {
    if (!obligationIds.length) return [];
    const result = await client.query<JsonRow<ReportingMaterialization> & { revoked_at: Date | null }>(
      `SELECT materialization.data, authz.revoked_at
         FROM adcp_reporting_materializations materialization
         JOIN adcp_reporting_destination_authorizations authz
           ON authz.account_id = materialization.account_id
          AND authz.destination_ref = materialization.destination_ref
          AND authz.generation = materialization.authorization_generation
        WHERE materialization.obligation_id = ANY($1::text[])
          AND materialization.recorded_at <= $2
        ORDER BY materialization.obligation_id, materialization.attempt, materialization.materialization_id
        LIMIT $3`,
      [obligationIds, ledgerAsOf, MAX_SNAPSHOT_ITEMS + 1]
    );
    return result.rows.map(row => {
      if (!row.revoked_at || (row.data.status !== 'available' && row.data.status !== 'delivered')) return row.data;
      return {
        ...row.data,
        status: 'failed',
        failed_at: row.revoked_at.toISOString(),
        failure_code: 'AUTHORIZATION_REVOKED',
      };
    });
  }

  private async listSnapshotReceipts(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    obligationIds: string[],
    ledgerAsOf: string,
    changesAfter: string | undefined,
    kind: 'revision'
  ): Promise<ReportingReceipt[]>;
  private async listSnapshotReceipts(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    obligationIds: string[],
    ledgerAsOf: string,
    changesAfter: string | undefined,
    kind: 'adjustment'
  ): Promise<ReportingAdjustmentReceipt[]>;
  private async listSnapshotReceipts(
    client: ReportingPgClient,
    query: ReportingLedgerSnapshotQueryV1,
    obligationIds: string[],
    ledgerAsOf: string,
    changesAfter: string | undefined,
    kind: 'revision' | 'adjustment'
  ): Promise<Array<ReportingReceipt | ReportingAdjustmentReceipt>> {
    if (!obligationIds.length || !query.consumer_id) return [];
    const join =
      kind === 'revision'
        ? 'JOIN adcp_reporting_revisions subject ON subject.revision_id = receipt.subject_id'
        : 'JOIN adcp_reporting_adjustments subject ON subject.adjustment_id = receipt.subject_id';
    const result = await client.query<JsonRow<ReportingReceipt | ReportingAdjustmentReceipt>>(
      `SELECT receipt.data FROM adcp_reporting_receipts receipt
        ${join}
        WHERE receipt.account_id = $1 AND receipt.consumer_id = $2
          AND receipt.receipt_kind = $3 AND subject.obligation_id = ANY($4::text[])
          AND receipt.recorded_at <= $5
          AND ($6::timestamptz IS NULL OR receipt.recorded_at > $6)
        ORDER BY subject.obligation_id, receipt.recorded_at, receipt.reporting_receipt_id
        LIMIT $7`,
      [
        query.account_id,
        query.consumer_id,
        kind,
        obligationIds,
        ledgerAsOf,
        changesAfter ?? null,
        MAX_SNAPSHOT_ITEMS + 1,
      ]
    );
    return result.rows.map(row => row.data);
  }

  private async one<T>(sql: string, params: unknown[]): Promise<T | null> {
    const result = await this.query<JsonRow<T>>(sql, params);
    return result.rows[0] ? clone(result.rows[0].data) : null;
  }

  private async putImmutable<T>(
    insertSql: string,
    insertParams: unknown[],
    readSql: string,
    readParams: unknown[],
    proposed: T,
    fingerprint: (value: T) => string,
    advisoryLock?: string,
    leaseFence?: { obligationId: string; owner: string; generation: number },
    /**
     * Narrow cutover escape hatch for a durable row written by an older SDK
     * that could not emit a field this build now emits. It must accept only the
     * exact additive difference and nothing else; the stored row is still the
     * value returned, so a tolerated replay never rewrites history.
     */
    legacyReplayEquivalent?: (stored: T, proposed: T) => boolean
  ): Promise<{ inserted: boolean; value: T }> {
    return this.transaction(
      async client => {
        const inserted = await client.query<JsonRow<T>>(insertSql, insertParams);
        const value = inserted.rows[0]?.data ?? (await client.query<JsonRow<T>>(readSql, readParams)).rows[0]?.data;
        if (!value) {
          if (leaseFence) {
            const lease = await client.query(
              `SELECT 1 FROM adcp_reporting_obligations
                WHERE obligation_id = $1 AND lease_owner = $2 AND lease_generation = $3
                  AND lease_expires_at > clock_timestamp()`,
              [leaseFence.obligationId, leaseFence.owner, leaseFence.generation]
            );
            if (lease.rowCount === 1) throw new ReportingLedgerContinuityError();
            throw new ReportingLedgerLeaseLostError();
          }
          throw new Error('Immutable reporting ledger replay could not be resolved');
        }
        if (fingerprint(value) !== fingerprint(proposed) && !legacyReplayEquivalent?.(value, proposed)) {
          throw new Error('Immutable reporting ledger identity names different content');
        }
        return { inserted: inserted.rowCount === 1, value: clone(value) };
      },
      { preBeginAdvisoryLock: advisoryLock }
    );
  }

  private async accountLockForObligation(obligationId: string): Promise<string> {
    const result = await this.query<QueryResultRow & { account_id: string }>(
      'SELECT account_id FROM adcp_reporting_obligations WHERE obligation_id = $1',
      [obligationId]
    );
    const accountId = result.rows[0]?.account_id;
    if (!accountId) throw new Error('Reporting obligation is unavailable');
    return accountLock(accountId);
  }

  private async accountLockForIssue(issueId: string): Promise<string | null> {
    const result = await this.query<QueryResultRow & { obligation_id: string }>(
      'SELECT obligation_id FROM adcp_reporting_issues WHERE issue_id = $1',
      [issueId]
    );
    return result.rows[0]?.obligation_id ? this.accountLockForObligation(result.rows[0].obligation_id) : null;
  }

  private async accountLockForTransition(transitionId: string): Promise<string | null> {
    const result = await this.query<QueryResultRow & { obligation_id: string }>(
      'SELECT obligation_id FROM adcp_reporting_transitions WHERE transition_id = $1',
      [transitionId]
    );
    return result.rows[0]?.obligation_id ? this.accountLockForObligation(result.rows[0].obligation_id) : null;
  }

  private async transaction<T>(
    work: (client: ReportingPgClient) => Promise<T>,
    options: { isolation?: 'READ COMMITTED' | 'REPEATABLE READ'; preBeginAdvisoryLock?: string } = {}
  ): Promise<T> {
    let client: ReportingPgClient;
    try {
      client = await this.pool.connect();
    } catch (cause) {
      throw new Error('PostgresReportingLedgerStore database connection failed', { cause });
    }
    let releaseError: Error | undefined;
    let transactionStarted = false;
    let advisoryLockAcquired = false;
    let lockTimeoutSet = false;
    try {
      if (options.preBeginAdvisoryLock) {
        await client.query("SET lock_timeout = '5s'");
        lockTimeoutSet = true;
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [options.preBeginAdvisoryLock]);
        advisoryLockAcquired = true;
        await client.query('RESET lock_timeout');
        lockTimeoutSet = false;
      }
      await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`);
      transactionStarted = true;
      const result = await work(client);
      await client.query('COMMIT');
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
          transactionStarted = false;
        } catch (rollbackCause) {
          // Preserve the operation error; a failed connection cannot reliably roll back.
          releaseError = rollbackCause instanceof Error ? rollbackCause : new Error('Reporting ledger rollback failed');
        }
      }
      if (
        error instanceof ReportingLedgerLeaseLostError ||
        error instanceof ReportingLedgerContinuityError ||
        error instanceof ReportingLedgerSnapshotUnavailableError ||
        error instanceof ReportingConsumerStatusConflictError
      ) {
        throw error;
      }
      throw new Error('PostgresReportingLedgerStore transaction failed', { cause: error });
    } finally {
      if (lockTimeoutSet) {
        try {
          await client.query('RESET lock_timeout');
        } catch (resetCause) {
          releaseError =
            resetCause instanceof Error ? resetCause : new Error('Reporting ledger lock timeout reset failed');
        }
      }
      if (options.preBeginAdvisoryLock && advisoryLockAcquired) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [options.preBeginAdvisoryLock]);
        } catch (unlockCause) {
          releaseError = unlockCause instanceof Error ? unlockCause : new Error('Reporting ledger unlock failed');
        }
      }
      client.release(releaseError);
    }
  }

  private async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
    try {
      return await this.pool.query<T>(sql, params);
    } catch (cause) {
      throw new Error('PostgresReportingLedgerStore database operation failed', { cause });
    }
  }
}

function snapshotItems(snapshot: ReportingLedgerSnapshotV1) {
  const visibleRevisions = snapshot.query.finality
    ? snapshot.revisions.filter(value => snapshot.query.finality!.includes(value.finality))
    : snapshot.revisions;
  const visibleRevisionIds = new Set(visibleRevisions.map(value => value.reporting_revision_id));
  const revisions = new Map<string, ReportingLedgerRevisionSnapshotV1[]>();
  for (const revision of visibleRevisions) {
    const values = revisions.get(revision.reporting_obligation_id) ?? [];
    values.push(revision);
    revisions.set(revision.reporting_obligation_id, values);
  }
  const adjustments = new Map<string, ReportingLedgerAdjustmentSnapshotV1[]>();
  for (const adjustment of snapshot.adjustments) {
    if (snapshot.query.finality && !visibleRevisionIds.has(adjustment.adjusts_reporting_revision_id)) continue;
    const values = adjustments.get(adjustment.reporting_obligation_id) ?? [];
    values.push(adjustment);
    adjustments.set(adjustment.reporting_obligation_id, values);
  }
  const obligationByRevision = new Map(
    snapshot.revisions.map(value => [value.reporting_revision_id, value.reporting_obligation_id])
  );
  const obligationByAdjustment = new Map(
    snapshot.adjustments.map(value => [value.reporting_adjustment_id, value.reporting_obligation_id])
  );
  const materializations = new Map<string, ReportingMaterialization[]>();
  for (const materialization of snapshot.materializations ?? []) {
    const values = materializations.get(materialization.reporting_obligation_id) ?? [];
    values.push(materialization);
    materializations.set(materialization.reporting_obligation_id, values);
  }
  const receipts = new Map<string, ReportingReceipt[]>();
  for (const receipt of snapshot.receipts ?? []) {
    const obligationId = obligationByRevision.get(receipt.reporting_revision_id);
    if (!obligationId) continue;
    const values = receipts.get(obligationId) ?? [];
    values.push(receipt);
    receipts.set(obligationId, values);
  }
  const adjustmentReceipts = new Map<string, ReportingAdjustmentReceipt[]>();
  for (const receipt of snapshot.adjustmentReceipts ?? []) {
    const obligationId = obligationByAdjustment.get(receipt.reporting_adjustment_id);
    if (!obligationId) continue;
    const values = adjustmentReceipts.get(obligationId) ?? [];
    values.push(receipt);
    adjustmentReceipts.set(obligationId, values);
  }
  return [
    ...snapshot.obligations.flatMap(obligation => [
      ...(snapshot.query.view === 'revision' ? [] : [{ kind: 'obligation' as const, value: obligation }]),
      ...(revisions.get(obligation.reporting_obligation_id) ?? []).map(value => ({
        kind: 'revision' as const,
        value,
      })),
      ...(adjustments.get(obligation.reporting_obligation_id) ?? []).map(value => ({
        kind: 'adjustment' as const,
        value,
      })),
      ...(materializations.get(obligation.reporting_obligation_id) ?? []).map(value => ({
        kind: 'materialization' as const,
        value,
      })),
      ...(receipts.get(obligation.reporting_obligation_id) ?? []).map(value => ({
        kind: 'receipt' as const,
        value,
      })),
      ...(adjustmentReceipts.get(obligation.reporting_obligation_id) ?? []).map(value => ({
        kind: 'adjustment_receipt' as const,
        value,
      })),
    ]),
    ...(snapshot.query.view === 'periods' || snapshot.query.view === 'revision'
      ? (snapshot.consumerStatuses ?? []).map(value => ({ kind: 'consumer_status' as const, value }))
      : []),
  ];
}

function validateRevisionBinding(revision: ReportingLedgerRevisionV1): void {
  const bytes = Buffer.from(
    canonicalize({
      reporting_revision_id: revision.reporting_revision_id,
      row_count: revision.rows.length,
      control_totals: revision.wireRevision.control_totals,
      reporting_rows: revision.rows,
    }),
    'utf8'
  );
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    revision.binding.algorithm !== 'rfc8785_jcs_v1' ||
    revision.binding.sha256 !== sha256 ||
    revision.binding.byteCount !== bytes.byteLength ||
    revision.binding.rowCount !== revision.rows.length ||
    revision.wireRevision.revision_content_sha256 !== sha256
  ) {
    throw new Error('Reporting revision rows do not match their canonical binding');
  }
}

function statusMatchesObligation(
  status: ReportingLedgerConsumerStatementV1,
  obligation: ReportingLedgerObligationV1
): boolean {
  return (
    status.delivery_config_id === obligation.delivery_config_id &&
    status.delivery_config_version === obligation.delivery_config_version &&
    status.report_definition_id === obligation.report_definition_id &&
    compareReportingInstants(status.period.start, obligation.period.start) === 0 &&
    compareReportingInstants(status.period.end, obligation.period.end) === 0 &&
    status.period.source_timezone === obligation.period.sourceTimezone
  );
}

function currentConsumerStatus(
  statuses: ReportingLedgerConsumerStatementV1[]
): ReportingLedgerConsumerStatementV1 | undefined {
  const superseded = new Set(
    statuses.map(value => value.supersedes_reporting_status_id).filter((value): value is string => Boolean(value))
  );
  return statuses.find(value => !superseded.has(value.reporting_status_id));
}

function validateBoundRows(value: Pick<ReportingLedgerRevisionV1, 'rows' | 'binding'>): void {
  const bytes = Buffer.from(canonicalize(value.rows), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    value.binding.algorithm !== 'rfc8785_jcs_v1' ||
    value.binding.sha256 !== sha256 ||
    value.binding.byteCount !== bytes.byteLength ||
    value.binding.rowCount !== value.rows.length
  ) {
    throw new Error('Reporting revision rows do not match their canonical binding');
  }
}

function assertLeaseTarget(reportingObligationId: string, lease: ReportingLedgerLeaseV1): void {
  if (lease.obligation.reporting_obligation_id !== reportingObligationId) {
    throw new ReportingLedgerLeaseLostError();
  }
}

function encodeCursor(snapshot: ReportingLedgerSnapshotV1, offset: number): string {
  const payload = { snapshotId: snapshot.snapshotId, offset, queryFingerprint: snapshot.queryFingerprint };
  return Buffer.from(canonicalJsonV1({ ...payload, digest: digest(payload) }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, snapshot: ReportingLedgerSnapshotV1): number {
  let parsed: { snapshotId?: unknown; offset?: unknown; queryFingerprint?: unknown; digest?: unknown };
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!isRecord(decoded)) throw new ReportingLedgerSnapshotUnavailableError();
    parsed = decoded;
  } catch {
    throw new ReportingLedgerSnapshotUnavailableError();
  }
  const payload = {
    snapshotId: parsed.snapshotId,
    offset: parsed.offset,
    queryFingerprint: parsed.queryFingerprint,
  };
  if (
    parsed.snapshotId !== snapshot.snapshotId ||
    parsed.queryFingerprint !== snapshot.queryFingerprint ||
    !Number.isSafeInteger(parsed.offset) ||
    (parsed.offset as number) < 0 ||
    parsed.digest !== digest(payload)
  ) {
    throw new ReportingLedgerSnapshotUnavailableError();
  }
  return parsed.offset as number;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function revisionIdentityFingerprint(value: ReportingLedgerRevisionV1): string {
  const { rows: _rows, createdAt: _createdAt, wireRevision, ...identity } = value;
  const { created_at: _wireCreatedAt, ...stableWireRevision } =
    wireRevision as ReportingLedgerRevisionV1['wireRevision'] & {
      created_at: string;
    };
  return digest(JSON.parse(JSON.stringify({ ...identity, wireRevision: stableWireRevision })));
}

function adjustmentIdentityFingerprint(value: ReportingLedgerAdjustmentV1): string {
  const { rows: _rows, createdAt: _createdAt, wireAdjustment, ...identity } = value;
  const { created_at: _wireCreatedAt, ...stableWireAdjustment } =
    wireAdjustment as ReportingLedgerAdjustmentV1['wireAdjustment'] & {
      created_at: string;
    };
  return digest(JSON.parse(JSON.stringify({ ...identity, wireAdjustment: stableWireAdjustment })));
}

/**
 * Accepts a stored revision that predates the `canonical_content_digest` gate
 * widening, and nothing else.
 *
 * The digest used to be emitted only for `billing` feeds; it is now emitted
 * whenever the Core configuration pins a canonicalization contract, because a
 * non-billing `consumer_receipt` binding cannot reconcile without it. That made
 * an in-flight revision committed by an older SDK replay as a different
 * identity. Tolerate exactly one shape — the stored row has no digest, the
 * proposed row does, and the two are otherwise byte-identical.
 */
function revisionLegacyCanonicalDigestReplay(
  stored: ReportingLedgerRevisionV1,
  proposed: ReportingLedgerRevisionV1
): boolean {
  if (stored.wireRevision.canonical_content_digest !== undefined) return false;
  if (proposed.wireRevision.canonical_content_digest === undefined) return false;
  const { canonical_content_digest: _digest, ...withoutDigest } = proposed.wireRevision;
  return (
    revisionIdentityFingerprint({
      ...proposed,
      wireRevision: withoutDigest as ReportingLedgerRevisionV1['wireRevision'],
    }) === revisionIdentityFingerprint(stored)
  );
}

/**
 * Accepts a stored adjustment that predates `canonical_adjustment_sha256`, and
 * nothing else.
 *
 * Same cutover as {@link revisionLegacyCanonicalDigestReplay}, with one extra
 * guard: the proposed digest must be the digest RC3 derives from the proposed
 * content, so a caller cannot smuggle an unrelated value through the tolerance.
 */
function adjustmentLegacyCanonicalDigestReplay(
  stored: ReportingLedgerAdjustmentV1,
  proposed: ReportingLedgerAdjustmentV1
): boolean {
  if (stored.wireAdjustment.canonical_adjustment_sha256 !== undefined) return false;
  const proposedDigest = proposed.wireAdjustment.canonical_adjustment_sha256;
  if (proposedDigest === undefined) return false;
  const { canonical_adjustment_sha256: _digest, ...withoutDigest } = proposed.wireAdjustment;
  if (reportingCanonicalAdjustmentSha256V1(withoutDigest) !== proposedDigest) return false;
  return (
    adjustmentIdentityFingerprint({
      ...proposed,
      wireAdjustment: withoutDigest as ReportingLedgerAdjustmentV1['wireAdjustment'],
    }) === adjustmentIdentityFingerprint(stored)
  );
}

const OBLIGATED_CONSUMERS_DEADLINE_MS = 10_000;

/** Bounds an adopter callback so a hung dependency cannot stall a reconcile. */
async function withReportingCallbackDeadline<T>(value: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A materialization as it stood before it was settled.
 *
 * `changed_at` records when the row left `pending`, so a row whose
 * `changed_at` is after the cutoff had none of its settlement evidence then.
 */
function pendingAtCutoff(value: ReportingMaterialization): ReportingMaterialization {
  const {
    ready_at: _readyAt,
    resource: _resource,
    verification: _verification,
    failed_at: _failedAt,
    failure_code: _failureCode,
    ...pending
  } = clone(value);
  return { ...pending, status: 'pending' };
}

const MANAGED_DUE_ARM = `           OR (EXISTS (
                 SELECT 1 FROM adcp_reporting_managed_bindings binding
                  WHERE binding.configuration_id = obligation.configuration_id
                    AND (
                      -- A managed change after the last transition. Health is
                      -- composed from managed state, but only Core evidence
                      -- and the clock used to schedule a reconcile — so a
                      -- settlement, revocation, receipt, consumer status or
                      -- roster-visible change arriving after a complete left
                      -- that complete persisted and webhooked forever while
                      -- a live read of the same obligation degraded.
                      EXISTS (
                        SELECT 1 FROM adcp_reporting_materializations m
                         WHERE m.obligation_id = obligation.obligation_id
                           AND m.changed_at > watermark.since
                           AND m.changed_at <= $2)
                      OR EXISTS (
                        -- Adjustments are managed health inputs too: after an
                        -- accepted billing receipt, a correction makes the live
                        -- read action_required while the persisted health and
                        -- its webhook stayed complete.
                        SELECT 1 FROM adcp_reporting_adjustments adj
                         WHERE adj.obligation_id = obligation.obligation_id
                           AND adj.recorded_at > watermark.since
                           AND adj.recorded_at <= $2)
                      OR EXISTS (
                        SELECT 1 FROM adcp_reporting_destination_authorizations authz
                         WHERE authz.account_id = binding.account_id
                           AND authz.destination_ref = binding.destination_ref
                           AND GREATEST(authz.changed_at, COALESCE(authz.cleanup_completed_at, authz.changed_at))
                               > watermark.since
                           AND authz.changed_at <= $2)
                      OR EXISTS (
                        SELECT 1 FROM adcp_reporting_receipts receipt
                         WHERE receipt.recorded_at > watermark.since
                           AND receipt.recorded_at <= $2
                           AND ((receipt.receipt_kind = 'revision' AND EXISTS (
                                  SELECT 1 FROM adcp_reporting_revisions rv
                                   WHERE rv.revision_id = receipt.subject_id
                                     AND rv.obligation_id = obligation.obligation_id))
                             OR (receipt.receipt_kind = 'adjustment' AND EXISTS (
                                  SELECT 1 FROM adcp_reporting_adjustments aj
                                   WHERE aj.adjustment_id = receipt.subject_id
                                     AND aj.obligation_id = obligation.obligation_id))))
                      OR EXISTS (
                        SELECT 1 FROM adcp_reporting_consumer_statuses status
                         WHERE status.obligation_id = obligation.obligation_id
                           AND status.created_at > watermark.since
                           AND status.created_at <= $2)
                      -- An external roster change writes nothing here at all,
                      -- so the only durable trace is the version recorded at
                      -- the last reconcile. A null one means never reconciled.
                      OR state.processed_roster_version IS NULL
                      -- A roster lives outside this database, so the only way
                      -- a change can re-arm anything is if someone records
                      -- it. Every read of the roster publishes the version it
                      -- saw; a difference from what was last reconciled is a
                      -- due condition. Without this the first reconcile made
                      -- processed_roster_version non-null and no later roster
                      -- change could ever schedule work again.
                      OR state.current_roster_version IS DISTINCT FROM state.processed_roster_version
                      -- A retained resource expiring is a health change with
                      -- no row written anywhere, so nothing else can notice it.
                      OR EXISTS (
                        SELECT 1 FROM adcp_reporting_materializations m
                         WHERE m.obligation_id = obligation.obligation_id
                           AND m.status IN ('available', 'delivered')
                           AND (m.data -> 'resource' ->> 'expires_at')::timestamptz <= $2
                           AND (m.data -> 'resource' ->> 'expires_at')::timestamptz
                               > watermark.since)
                    )
               ))
`;

/**
 * The obligated roster the projection and the version must both agree on.
 *
 * A complete roster is authoritative and excludes anyone it does not list.
 * An incomplete one is only a hint, so observed principals are unioned in.
 */
function obligatedConsumerIdsFor(
  supplied: { ids: readonly string[]; complete: boolean },
  observed: readonly string[]
): string[] {
  return supplied.complete === true
    ? [...new Set(supplied.ids)].sort()
    : [...new Set([...supplied.ids, ...observed])].sort();
}

/** Falls back to hashing the resolved roster when the adopter supplies no version. */
function obligatedConsumerRosterVersionFor(
  supplied: { ids: readonly string[]; complete: boolean; version?: string },
  ids: readonly string[]
): string {
  return supplied.version ?? digest({ ids, complete: supplied.complete === true });
}

/** Caps exponential lifecycle backoff so a recovered tenant is retried promptly. */
const MAX_LIFECYCLE_BACKOFF_SECONDS = 900;

/** Renders a timestamptz as an RFC 3339 UTC instant without losing microseconds. */
function rfc3339Microseconds(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function accountLock(accountId: string): string {
  return `adcp-reporting-account:${accountId}`;
}

function consumerStatusChainKeyForObligation(obligation: ReportingLedgerObligationV1): string {
  return reportingConsumerStatusChainKeyFromIdentityV1({
    delivery_config_id: obligation.delivery_config_id,
    delivery_config_version: obligation.delivery_config_version,
    report_definition_id: obligation.report_definition_id,
    periodStart: obligation.period.start,
    periodEnd: obligation.period.end,
    sourceTimezone: obligation.period.sourceTimezone,
  });
}

function boundedConsumerStatusErrorField(errorField?: string): { errorField?: string } {
  return errorField &&
    !errorField.includes('\u0000') &&
    isWellFormedUnicodeString(errorField) &&
    Buffer.byteLength(errorField, 'utf8') <= REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES
    ? { errorField }
    : {};
}

function boundedConsumerStatusErrorKeyword(errorKeyword?: string): { errorKeyword?: string } {
  return errorKeyword && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(errorKeyword) ? { errorKeyword } : {};
}

function boundedConsumerStatusSafeMessage(safeMessage: string): string {
  const wellFormed = Buffer.from(safeMessage, 'utf8')
    .toString('utf8')
    .replace(/\u0000/g, '\ufffd');
  if (Buffer.byteLength(wellFormed, 'utf8') <= REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES) {
    return wellFormed || 'Reporting consumer status was rejected';
  }
  let bounded = '';
  let bytes = 0;
  for (const character of wellFormed) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded || 'Reporting consumer status was rejected';
}

function storedResultsJsonBytes(results: unknown[]): number {
  return Buffer.byteLength(JSON.stringify(results), 'utf8');
}

function boundStoredConsumerStatusResults(
  storedResults: StoredConsumerStatusBatchResult[],
  results: ReportingConsumerStatusBatchResultV1[]
): void {
  if (storedResultsJsonBytes(storedResults) <= REPORTING_CONSUMER_STATUS_BATCH_RESULT_MAX_BYTES) return;
  for (let index = storedResults.length - 1; index >= 0; index -= 1) {
    const stored = storedResults[index];
    const result = results[index];
    if (stored?.errorField !== undefined) {
      delete stored.errorField;
      if (result && !('value' in result)) delete result.errorField;
      if (storedResultsJsonBytes(storedResults) <= REPORTING_CONSUMER_STATUS_BATCH_RESULT_MAX_BYTES) return;
    }
  }
  const fallback = 'Reporting consumer status was rejected';
  for (let index = storedResults.length - 1; index >= 0; index -= 1) {
    const stored = storedResults[index];
    const result = results[index];
    if (stored?.kind === 'failed' && stored.safeMessage !== fallback) {
      stored.safeMessage = fallback;
      if (result && !('value' in result)) result.safeMessage = fallback;
      if (storedResultsJsonBytes(storedResults) <= REPORTING_CONSUMER_STATUS_BATCH_RESULT_MAX_BYTES) return;
    }
  }
  throw new RangeError('Reporting consumer status replay metadata exceeds 64 KiB');
}

function checkpointScopeFingerprint(query: ReportingLedgerSnapshotQueryV1): string {
  const sorted = (value: string[]) => [...value].sort();
  return digest({
    account_id: query.account_id,
    ...(query.consumer_id ? { consumer_id: query.consumer_id } : {}),
    ...(query.media_buy_ids ? { media_buy_ids: sorted(query.media_buy_ids) } : {}),
    ...(query.delivery_config_ids ? { delivery_config_ids: sorted(query.delivery_config_ids) } : {}),
    ...(query.feed_purposes ? { feed_purposes: sorted(query.feed_purposes) } : {}),
    ...(query.health ? { health: sorted(query.health) } : {}),
    ...(query.finality ? { finality: sorted(query.finality) } : {}),
    ...(query.reporting_revision_id ? { reporting_revision_id: query.reporting_revision_id } : {}),
    ...(query.period ? { period: query.period } : {}),
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}
