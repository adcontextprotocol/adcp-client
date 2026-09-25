import { randomUUID } from 'node:crypto';

import type {
  NotificationDeliveryAttemptCheckpointInput,
  NotificationRecipientRef,
  PersistentNotificationRuntime,
} from '../../server/notification-subscriptions';
import { notificationSuppressionDisposition } from '../../server/notification-subscriptions';
import type { WebhookAttemptSuppressionReason } from '../../server/webhook-emitter';
import type {
  ReportingDeliveryReadyWebhook,
  ReportingLedgerChangedWebhook,
  ReportingStatusChangedWebhook,
} from '../../types/core.generated';
import type { ReportingMaterialization } from '../../types';
import { canonicalJsonSha256 } from '../../utils/jcs';
import type {
  ReportingHealthV1,
  ReportingLedgerAdjustmentV1,
  ReportingLedgerNotificationActivityPortV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionV1,
  ReportingLedgerStatusTransitionV1,
  ReportingLedgerTransactionV1,
  ReportingObservedFinalityV1,
} from './types';

const DEFAULT_TABLE = 'adcp_reporting_notification_activity';
const REPORTING_STATUS_EVENT_TYPE = 'reporting.status_changed';
const REPORTING_LEDGER_EVENT_TYPE = 'reporting.ledger_changed';
const REPORTING_DELIVERY_EVENT_TYPE = 'reporting.delivery_ready';
const DEFAULT_NAMESPACE = 'adcp-reporting';
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PER_TENANT = 100_000;
const DEFAULT_MAX_ATTEMPTS = 100;
const MAX_ACTIVITY_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 16 * 1024;

interface ReportingAccountActivityBaseV1 {
  activityId: string;
  transitionId: string;
  tenantId: string;
  accountId: string;
  reporting_obligation_id: string;
  occurredAt: string;
}

export interface ReportingLifecycleActivityV1 extends ReportingAccountActivityBaseV1 {
  activityType: 'reporting.lifecycle_changed';
  notificationType?: 'reporting.status_changed';
  previousHealth: ReportingHealthV1;
  health: ReportingHealthV1;
  previousFinality: ReportingObservedFinalityV1;
  finality: ReportingObservedFinalityV1;
  issueIds: string[];
  correlation: {
    delivery_config_id: string;
    delivery_config_version: number;
    report_definition_id: string;
    feed_purpose: ReportingLedgerObligationV1['feedPurpose'];
    period: { start: string; end: string };
  };
}

export interface ReportingLedgerChangedActivityV1 extends ReportingAccountActivityBaseV1 {
  activityType: 'reporting.ledger_changed';
  notificationType: 'reporting.ledger_changed';
  changeKind: 'revision_published' | 'adjustment_published';
  reporting_revision_id?: string;
  supersedes_reporting_revision_id?: string;
  finality?: ReportingLedgerRevisionV1['finality'];
  reporting_adjustment_id?: string;
  adjusts_reporting_revision_id?: string;
}

export interface ReportingDeliveryReadyActivityV1 extends ReportingAccountActivityBaseV1 {
  activityType: 'reporting.delivery_ready';
  notificationType: 'reporting.delivery_ready';
  delivery_config_id: string;
  delivery_config_version: number;
  feed_purpose: ReportingLedgerObligationV1['feedPurpose'];
  reporting_revision_id: string;
  reporting_materialization_id: string;
  readiness: 'available' | 'delivered';
  finality: ReportingLedgerRevisionV1['finality'];
  data_through: string | null;
}

export type ReportingAccountActivityV1 =
  | ReportingLifecycleActivityV1
  | ReportingLedgerChangedActivityV1
  | ReportingDeliveryReadyActivityV1;

export type ReportingAccountActivityRecordV1 = ReportingAccountActivityV1 & {
  recordedAt: string;
  notificationProjectedAt?: string;
  /** Set when the claim was bounded out of the pending set without delivering. */
  notificationAbandonedAt?: string;
};

export interface ReportingAccountActivityPageV1 {
  activities: ReportingAccountActivityRecordV1[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ReportingNotificationRecoveryMetricsV1 {
  claimed: number;
  matched: number;
  projected: number;
  retried: number;
  leaseLost: number;
  /** Claims bounded out of the pending set after `maxAttempts`; never delivered. */
  abandoned: number;
}

/**
 * Raised when live delivery authority failed closed for an operational reason
 * rather than a deliberate one. The claim is released and retried; the activity
 * is never projected as delivered.
 */
export class ReportingNotificationRetryableSuppressionError extends Error {
  override readonly name = 'ReportingNotificationRetryableSuppressionError';
  constructor(readonly reason: WebhookAttemptSuppressionReason) {
    super(`Reporting notification delivery authority failed closed (${reason}); no external attempt was made`);
  }
}

export interface ReportingNotificationProjectionErrorV1 {
  transitionId: string;
  tenantId: string;
  accountId: string;
  attemptCount: number;
}

export interface PostgresReportingNotificationActivityOptions {
  db: ReportingLedgerTransactionV1;
  /**
   * Notification port. A custom `{ emit }` must also set
   * `hasDeliveryAttemptCheckpoint: true`, which asserts that it forwards the
   * event it is handed to a runtime that runs the durable pre-POST checkpoint.
   */
  notifications: Pick<PersistentNotificationRuntime, 'emit'> &
    Partial<Pick<PersistentNotificationRuntime, 'hasDeliveryAttemptCheckpoint' | 'deliveryAttemptCheckpoint'>>;
  /** Stable deployment namespace. Defaults to `adcp-reporting`. */
  namespace?: string;
  /** Assert that the supplied database/schema is isolated to this deployment. */
  acknowledgeIsolatedDatabase?: boolean;
  /** Defaults to `adcp_reporting_notification_activity`. */
  tableName?: string;
  /**
   * Pure trusted mapping from the authoritative internal ledger account to a
   * tenant. It runs while the ledger transaction is open and must not perform
   * I/O or consult caller-controlled transition data.
   */
  tenantScopeForAccount(accountId: string): string;
  /** Retention for projected operator activity. Defaults to 90 days. */
  retentionMs?: number;
  /** Atomic pending-intent backpressure per tenant. Defaults to 100,000. */
  maxPendingPerTenant?: number;
  /**
   * Acknowledge a notification port that cannot prove it runs the durable
   * pre-POST checkpoint. Without it a crash plus a destination replacement
   * re-addresses the same notification under a second generation and a second
   * idempotency key, so this is refused by default and exists only for tests
   * that deliberately demonstrate that hazard.
   */
  acknowledgeMissingAttemptCheckpoint?: boolean;
  /**
   * The very checkpoint wired into the notification runtime.
   *
   * Required, because the checkpoint writes to a `(queryable, namespace,
   * table)` triple of its own and a mismatch is otherwise undetectable at
   * runtime: its update would match no row, every attempt would be suppressed
   * as retryable, the delivery binding would eventually retire, the recipient
   * would settle terminal and the activity would project — losing the
   * notification silently. Passing the same object lets that be refused at
   * construction instead.
   */
  attemptCheckpoint?: ReportingNotificationAttemptCheckpointV1;
  /**
   * Largest recipient fanout whose frozen intent this runtime will store.
   *
   * Must be **at least** the notification runtime's `maxFanoutCandidates`, plus
   * headroom for the distinct subscribers one notification can accumulate as
   * destinations churn. Defaults to 10,000 — the ceiling that runtime enforces
   * on `maxFanoutCandidates` — so the default can never be exceeded by a valid
   * fanout. Setting it *below* `maxFanoutCandidates` is a misconfiguration: a
   * legitimate fanout then cannot be committed and the claim retries until
   * `maxAttempts` abandons it.
   */
  maxRecipients?: number;
  /**
   * Total recipient rows one notification may retain: the current fanout plus
   * the pinned identities of subscribers that were addressed and then replaced
   * or removed.
   *
   * Separate from `maxRecipients` because they bound different things. A
   * maximum fanout of 10,000 that also has one former subscriber pinned needs
   * 10,001 rows, which a single bound capped at the fanout ceiling could never
   * express — the claim would be unsatisfiable and abandon undelivered.
   * Defaults to twice `maxRecipients`, and must be at least `maxRecipients`.
   */
  maxRetainedRecipients?: number;
  /**
   * Attempts after which a claim that keeps failing is abandoned rather than
   * retried forever. Defaults to 100.
   *
   * Without a bound, a claim that can never succeed — an over-fanout
   * configuration, a permanently unreachable dependency — stays pending
   * indefinitely, and enough of them reach `maxPendingPerTenant` and start
   * refusing new activity writes for the whole tenant. An abandoned claim stops
   * consuming that capacity while staying visible for operators; it is never
   * recorded as delivered.
   */
  maxAttempts?: number;
}

export interface PostgresReportingNotificationActivityRuntime {
  readonly port: ReportingLedgerNotificationActivityPortV1<ReportingLedgerTransactionV1>;
  readonly migrations: { activity: string; all: readonly string[] };
  probe(): Promise<void>;
  recoverOnce(options?: {
    ownerToken?: string;
    leaseMs?: number;
    limit?: number;
    retryAfterMs?: number;
    /** Operational observer; hook failures never change durable lease semantics. */
    onError?: (error: unknown, claim: Readonly<ReportingNotificationProjectionErrorV1>) => void | Promise<void>;
  }): Promise<ReportingNotificationRecoveryMetricsV1>;
  listActivity(input: {
    /** Trusted authenticated scope; never copy these values from an event payload. */
    tenantId: string;
    accountId: string;
    cursor?: string;
    limit?: number;
  }): Promise<ReportingAccountActivityPageV1>;
  pruneProjected(options?: { limit?: number }): Promise<number>;
}

/**
 * Largest fanout the persistent notification runtime will ever resolve; its
 * `maxFanoutCandidates` is validated to 1..10,000. Defaulting to the ceiling
 * means a valid fanout can never exceed what the activity runtime will store.
 */
const MAX_SUPPORTED_RECIPIENTS = 10_000;
/**
 * Ceiling on retained rows per notification: the fanout ceiling plus room for
 * the pinned identities of subscribers replaced during one notification's life.
 */
const MAX_SUPPORTED_RETAINED_RECIPIENTS = 100_000;
/**
 * PostgreSQL refuses a btree entry wider than roughly a third of a page. Only
 * the recipient primary key is indexed, so this is what has to fit — and it is
 * fixed-width in everything except the namespace and transition id, both of
 * which the parent table's own primary key already bounds.
 */
const MAX_BTREE_ENTRY_BYTES = 2_704;
const RECIPIENT_FINGERPRINT_BYTES = 64;
const RECIPIENT_ROUND_BYTES = 4;
/** Transition ids are ledger-generated `rst_<32 base64url>`; bounded generously. */
const MAX_TRANSITION_ID_BYTES = 512;
/**
 * The derived recipient table adds `_recipients` to a base name already capped
 * at 42 bytes. Its own constraints use three-byte suffixes, so the longest
 * identifier stays inside PostgreSQL's 63-byte limit without truncation.
 */
const MAX_RECIPIENT_TABLE_BYTES = 53;

export function getReportingNotificationActivityMigration(options: { tableName?: string } = {}): string {
  const raw = options.tableName ?? DEFAULT_TABLE;
  const table = quoteIdentifier(raw);
  const rawRecipients = recipientTableName(raw);
  const recipientTable = quoteIdentifier(rawRecipients, MAX_RECIPIENT_TABLE_BYTES);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  namespace              TEXT NOT NULL,
  transition_id          TEXT NOT NULL,
  activity_sequence      BIGSERIAL NOT NULL UNIQUE,
  tenant_scope           TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  obligation_id          TEXT NOT NULL,
  activity               JSONB NOT NULL,
  intent_fingerprint     TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'pending',
  notification_required  BOOLEAN NOT NULL,
  attempt_count          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner            TEXT,
  lease_version          BIGINT NOT NULL DEFAULT 0,
  lease_expires_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  projected_at           TIMESTAMPTZ,
  retain_until           TIMESTAMPTZ,
  delivery_intent_at     TIMESTAMPTZ,
  abandoned_at           TIMESTAMPTZ,
  PRIMARY KEY (namespace, transition_id),
  CONSTRAINT ${raw}_valid_state CHECK (state IN ('pending', 'projected', 'abandoned')),
  CONSTRAINT ${raw}_valid_fingerprint CHECK (intent_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ${raw}_valid_activity CHECK (jsonb_typeof(activity) = 'object'),
  CONSTRAINT ${raw}_valid_projection CHECK (
    (state = 'pending' AND notification_required AND projected_at IS NULL AND retain_until IS NULL) OR
    (state = 'projected' AND projected_at IS NOT NULL AND retain_until IS NOT NULL) OR
    -- Abandoned: bounded out of the pending set without ever being recorded as
    -- delivered, so it stops consuming tenant capacity but stays auditable.
    (state = 'abandoned' AND projected_at IS NULL AND retain_until IS NOT NULL AND abandoned_at IS NOT NULL)
  )
);

-- Upgrade in place, once, and touch nothing on a rerun.
--
-- Every statement here is guarded on the catalog, including the column adds:
-- \`ADD COLUMN IF NOT EXISTS\` still takes ACCESS EXCLUSIVE to discover the
-- column already exists, so a rerun during normal traffic blocks behind ordinary
-- readers and fails outright under a lock_timeout. An already-upgraded rerun now
-- issues no table-locking statement at all.
--
-- Every guard is scoped to this schema's table by resolving it once to a
-- regclass. A database-wide lookup by index name would see an upgraded index in
-- another schema and skip the upgrade here, leaving that deployment with a
-- projected-only retention index that cannot serve abandonment pruning.
DO $$
DECLARE
  activity_table regclass := to_regclass('${raw}');
  stale_index oid;
BEGIN
  IF activity_table IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = activity_table AND attname = 'delivery_intent_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE ${table} ADD COLUMN delivery_intent_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = activity_table AND attname = 'abandoned_at' AND NOT attisdropped
  ) THEN
    ALTER TABLE ${table} ADD COLUMN abandoned_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = activity_table AND conname = '${raw}_valid_state'
       AND pg_get_constraintdef(oid) LIKE '%abandoned%'
  ) THEN
    ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${raw}_valid_state;
    ALTER TABLE ${table} ADD CONSTRAINT ${raw}_valid_state
      CHECK (state IN ('pending', 'projected', 'abandoned'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = activity_table AND conname = '${raw}_valid_projection'
       AND pg_get_constraintdef(oid) LIKE '%abandoned_at%'
  ) THEN
    ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${raw}_valid_projection;
    ALTER TABLE ${table} ADD CONSTRAINT ${raw}_valid_projection CHECK (
      (state = 'pending' AND notification_required AND projected_at IS NULL AND retain_until IS NULL) OR
      (state = 'projected' AND projected_at IS NOT NULL AND retain_until IS NOT NULL) OR
      (state = 'abandoned' AND projected_at IS NULL AND retain_until IS NOT NULL AND abandoned_at IS NOT NULL)
    );
  END IF;
  SELECT index_class.oid INTO stale_index
    FROM pg_index
    JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
   WHERE pg_index.indrelid = activity_table
     AND index_class.relname = 'idx_${raw}_retention'
     AND pg_get_indexdef(pg_index.indexrelid) NOT LIKE '%abandoned%';
  IF stale_index IS NOT NULL THEN
    EXECUTE format('DROP INDEX %s', stale_index::regclass);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_${raw}_retention'
  ) THEN
    CREATE INDEX idx_${raw}_retention
      ON ${table}(namespace, retain_until, activity_sequence)
      WHERE state IN ('projected', 'abandoned');
  END IF;
END $$;

-- One row per frozen recipient, carrying that recipient's own delivery state.
--
-- Relational rather than one serialized document: a document needs a size cap,
-- and a fanout that legitimately exceeded it could never be committed and would
-- retry until it aged out. Only the bounded 64-hex fingerprint enters the index,
-- so an individual recipient reference has no length limit of its own.
--
-- Per-recipient rather than per-emission: attempt_at is the durable pre-POST
-- checkpoint for exactly one recipient, so one recipient's attempt cannot pin a
-- sibling that was suppressed before its own first POST. Rows with no
-- attempt_at are revisable and replaced in place, so a pre-attempt retry can
-- never accumulate superseded state.
--
-- subscriber_key identifies the subscriber independently of its destination
-- generation. Pinning is per subscriber: once a subscriber has been addressed,
-- a later generation of the same subscriber is never addressed for this
-- notification, because that would be the same logical delivery under a new
-- idempotency key. A different subscriber is unaffected.
CREATE TABLE IF NOT EXISTS ${recipientTable} (
  namespace              TEXT NOT NULL,
  transition_id          TEXT NOT NULL,
  recipient_fingerprint  TEXT NOT NULL,
  subscriber_key         TEXT NOT NULL,
  recipient              JSONB NOT NULL,
  frozen_at              TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  attempt_at             TIMESTAMPTZ,
  settled_at             TIMESTAMPTZ,
  disposition            TEXT,
  PRIMARY KEY (namespace, transition_id, recipient_fingerprint),
  CONSTRAINT ${rawRecipients}_fk FOREIGN KEY (namespace, transition_id)
    REFERENCES ${table}(namespace, transition_id) ON DELETE CASCADE,
  CONSTRAINT ${rawRecipients}_fp CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ${rawRecipients}_sk CHECK (subscriber_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ${rawRecipients}_obj CHECK (jsonb_typeof(recipient) = 'object'),
  CONSTRAINT ${rawRecipients}_set CHECK (
    (settled_at IS NULL AND disposition IS NULL) OR
    (settled_at IS NOT NULL AND disposition IN ('delivered', 'terminal'))
  )
);
-- Indexes are catalog-guarded too. CREATE INDEX IF NOT EXISTS still takes a
-- ShareLock to discover the index already exists, which conflicts with the
-- RowExclusiveLock every ordinary writer holds — so an already-current rerun
-- would stall live traffic, or fail under a lock_timeout, despite creating
-- nothing. Scoped to this schema's tables by regclass, like every other guard.
DO $$
DECLARE
  activity_table regclass := to_regclass('${raw}');
  recipient_table regclass := to_regclass('${rawRecipients}');
BEGIN
  IF activity_table IS NULL OR recipient_table IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = recipient_table AND index_class.relname = 'idx_${rawRecipients}_unsettled'
  ) THEN
    CREATE INDEX idx_${rawRecipients}_unsettled
      ON ${recipientTable}(namespace, transition_id)
      WHERE settled_at IS NULL;
  END IF;
  -- At most one addressed generation per subscriber, enforced by the database.
  --
  -- The checkpoint and a concurrent recipient replacement run as separate
  -- statements against a connection pool, so neither sees the other's
  -- uncommitted work: a freeze can propose a replacement generation while the
  -- original is being checkpointed, and PostgreSQL will keep both rows. This
  -- index is the serialization point. The second generation's checkpoint fails,
  -- so it is never POSTed, and the next freeze drops it because its subscriber
  -- is already claimed. One logical delivery, one idempotency key.
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = recipient_table
      AND index_class.relname = 'idx_${rawRecipients}_attempted_subscriber'
  ) THEN
    CREATE UNIQUE INDEX idx_${rawRecipients}_attempted_subscriber
      ON ${recipientTable}(namespace, transition_id, subscriber_key)
      WHERE attempt_at IS NOT NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_${raw}_pending'
  ) THEN
    CREATE INDEX idx_${raw}_pending
      ON ${table}(namespace, next_attempt_at, lease_expires_at, activity_sequence)
      WHERE state = 'pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_${raw}_pending_tenant'
  ) THEN
    CREATE INDEX idx_${raw}_pending_tenant
      ON ${table}(namespace, tenant_scope)
      WHERE state = 'pending';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index
     JOIN pg_class index_class ON index_class.oid = pg_index.indexrelid
    WHERE pg_index.indrelid = activity_table AND index_class.relname = 'idx_${raw}_account_activity'
  ) THEN
    CREATE INDEX idx_${raw}_account_activity
      ON ${table}(namespace, tenant_scope, account_id, activity_sequence DESC);
  END IF;
END $$;
`.trim();
}

/** Child table holding one row per frozen recipient. */
export function recipientTableName(tableName: string = DEFAULT_TABLE): string {
  return `${tableName}_recipients`;
}

export const REPORTING_NOTIFICATION_ACTIVITY_MIGRATION = getReportingNotificationActivityMigration();

/**
 * Builds the durable pre-POST attempt checkpoint for the reporting activity
 * recipient table.
 *
 * Pass the result to `createPostgresPersistentNotificationRuntime`'s
 * `checkpointDeliveryAttempt`. It is a standalone factory rather than a method
 * on the activity runtime so it can be constructed before the notification
 * runtime it has to be wired into, and it is keyed purely on the durable attempt
 * context so a recovered outbox attempt — the path most likely to produce an
 * ambiguous send — records the same checkpoint as the original emission.
 *
 * The write is monotonic and idempotent and deliberately takes no recovery
 * lease: a checkpoint only ever makes a recipient less revisable, which is the
 * safe direction, and an outbox worker legitimately holds no activity lease.
 */
/** Durable store a checkpoint is bound to, so a mismatched pairing cannot be silent. */
export interface ReportingNotificationAttemptCheckpointV1 {
  (input: Readonly<NotificationDeliveryAttemptCheckpointInput>): Promise<void>;
  /**
   * Exact `(queryable, namespace, table)` this checkpoint writes to. Present on
   * anything this module builds; absent on an adopter's own forwarder, which is
   * then only acceptable when the runtime it is wired into exposes the
   * checkpoint it invokes so identity can be compared directly.
   */
  readonly activityStore?: Readonly<{ db: ReportingLedgerTransactionV1; namespace: string; tableName: string }>;
}

export function createPostgresReportingNotificationAttemptCheckpoint(options: {
  db: ReportingLedgerTransactionV1;
  namespace?: string;
  tableName?: string;
  /**
   * Additional event types this checkpoint owns, on top of all three Reliable
   * Reporting events. Anything it does not own is another
   * subsystem's notification and is passed through untouched — the runtime hook
   * is global, and failing closed on an event that was never frozen here would
   * suppress every attempt of that event until its retry horizon expired. This
   * extends the owned set; it can never remove the reporting event.
   */
  eventTypes?: readonly string[];
}): ReportingNotificationAttemptCheckpointV1 {
  if (!options?.db || typeof options.db.query !== 'function') {
    throw new TypeError('createPostgresReportingNotificationAttemptCheckpoint requires a PostgreSQL queryable');
  }
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  assertIdentifier(namespace, 'namespace', 255);
  const rawTable = options.tableName ?? DEFAULT_TABLE;
  const recipientTable = quoteIdentifier(recipientTableName(rawTable), MAX_RECIPIENT_TABLE_BYTES);
  // Always owns all Reliable Reporting events. Letting configuration replace
  // the set would silently stop checkpointing one delivery family while the
  // runtime still advertises checkpoint support.
  const owned = new Set([
    REPORTING_STATUS_EVENT_TYPE,
    REPORTING_LEDGER_EVENT_TYPE,
    REPORTING_DELIVERY_EVENT_TYPE,
    ...(options.eventTypes ?? []),
  ]);
  const checkpoint = async (input: Readonly<NotificationDeliveryAttemptCheckpointInput>): Promise<void> => {
    if (!owned.has(input.eventType)) return;
    const fingerprint = recipientFingerprint({
      scope: input.scope,
      subscriberId: input.subscriberId,
      destinationGeneration: input.destinationGeneration,
    });
    const marked = await reportingActivityDatabaseOperation(
      'Reporting notification delivery attempt could not be checkpointed',
      () =>
        options.db.query(
          `UPDATE ${recipientTable} SET attempt_at = COALESCE(attempt_at, clock_timestamp())
            WHERE namespace = $1 AND transition_id = $2 AND recipient_fingerprint = $3`,
          [namespace, input.notificationId, fingerprint]
        )
    );
    if (marked.rowCount !== 1) {
      throw new Error(
        'Reporting notification delivery attempt has no frozen recipient to checkpoint; ' +
          'the emission owner must freeze its recipient set before any external attempt'
      );
    }
  };
  return Object.assign(checkpoint, {
    activityStore: Object.freeze({ db: options.db, namespace, tableName: rawTable }),
  }) as ReportingNotificationAttemptCheckpointV1;
}

export function createPostgresReportingNotificationActivityRuntime(
  options: PostgresReportingNotificationActivityOptions
): PostgresReportingNotificationActivityRuntime {
  if (!options?.db || typeof options.db.query !== 'function') {
    throw new TypeError('createPostgresReportingNotificationActivityRuntime requires a PostgreSQL queryable');
  }
  if (!options.notifications || typeof options.notifications.emit !== 'function') {
    throw new TypeError(
      'createPostgresReportingNotificationActivityRuntime requires the persistent notification runtime'
    );
  }
  if (typeof options.tenantScopeForAccount !== 'function') {
    throw new TypeError('tenantScopeForAccount must be a function');
  }
  if (options.notifications.hasDeliveryAttemptCheckpoint !== true && !options.acknowledgeMissingAttemptCheckpoint) {
    throw new TypeError(
      'createPostgresReportingNotificationActivityRuntime requires a notification port that runs the durable ' +
        'pre-POST attempt checkpoint. Build createPostgresReportingNotificationAttemptCheckpoint() and pass it as ' +
        'checkpointDeliveryAttempt; a custom port must set hasDeliveryAttemptCheckpoint: true to prove it forwards ' +
        'the event it is given.'
    );
  }
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  if (!options.attemptCheckpoint && !options.acknowledgeMissingAttemptCheckpoint) {
    throw new TypeError(
      'createPostgresReportingNotificationActivityRuntime requires attemptCheckpoint: pass the very checkpoint ' +
        'wired into the notification runtime so its durable store can be verified against this one.'
    );
  }
  // Two tiers, because each covers what the other cannot. When the runtime
  // exposes the checkpoint it invokes, identity is the strongest possible
  // check: two checkpoints can each be correctly built and still target
  // different stores, and only identity catches that. When it does not — a
  // custom port — the declared store binding is all there is to verify, so it
  // becomes mandatory.
  const wired = options.notifications.deliveryAttemptCheckpoint;
  if (wired !== undefined && options.attemptCheckpoint && wired !== options.attemptCheckpoint) {
    throw new TypeError(
      'createPostgresReportingNotificationActivityRuntime: the notification runtime invokes a different ' +
        'checkpoint than the one passed as attemptCheckpoint. Each can be correctly built and still target a ' +
        'different store, in which case every delivery checkpoints nothing and is abandoned undelivered. Pass ' +
        'the very object wired into checkpointDeliveryAttempt.'
    );
  }
  if (options.attemptCheckpoint && wired === undefined && !options.attemptCheckpoint.activityStore) {
    throw new TypeError(
      'createPostgresReportingNotificationActivityRuntime: attemptCheckpoint declares no durable store and the ' +
        'notification port does not expose the checkpoint it invokes, so neither its identity nor its target can ' +
        'be verified. Build it with createPostgresReportingNotificationAttemptCheckpoint().'
    );
  }
  if (options.attemptCheckpoint?.activityStore) {
    const bound = options.attemptCheckpoint.activityStore;
    const mismatch =
      bound.db !== options.db ||
      bound.namespace !== namespace ||
      bound.tableName !== (options.tableName ?? DEFAULT_TABLE);
    if (mismatch) {
      throw new TypeError(
        'createPostgresReportingNotificationActivityRuntime: attemptCheckpoint is bound to a different durable ' +
          `store (namespace ${JSON.stringify(bound.namespace)}, table ${JSON.stringify(bound.tableName)}` +
          `${bound.db === options.db ? '' : ', different queryable'}) than this runtime (namespace ` +
          `${JSON.stringify(namespace)}, table ${JSON.stringify(options.tableName ?? DEFAULT_TABLE)}). ` +
          'A mismatched pair checkpoints nothing, so every delivery is suppressed until its binding retires and the ' +
          'notification is lost silently.'
      );
    }
  }
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!development && options.namespace === undefined && !options.acknowledgeIsolatedDatabase) {
    throw new TypeError(
      'Production reporting notification activity requires an explicit deployment namespace or acknowledgeIsolatedDatabase: true'
    );
  }
  assertIdentifier(namespace, 'namespace', 255);
  const rawTable = options.tableName ?? DEFAULT_TABLE;
  const table = quoteIdentifier(rawTable);
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  positiveInteger(retentionMs, 'retentionMs');
  const maxPendingPerTenant = options.maxPendingPerTenant ?? DEFAULT_MAX_PENDING_PER_TENANT;
  boundedInteger(maxPendingPerTenant, 'maxPendingPerTenant', 1, 1_000_000);
  const maxRecipients = options.maxRecipients ?? MAX_SUPPORTED_RECIPIENTS;
  boundedInteger(maxRecipients, 'maxRecipients', 1, MAX_SUPPORTED_RECIPIENTS);
  const maxRetainedRecipients = options.maxRetainedRecipients ?? maxRecipients * 2;
  boundedInteger(maxRetainedRecipients, 'maxRetainedRecipients', 1, MAX_SUPPORTED_RETAINED_RECIPIENTS);
  if (maxRetainedRecipients < maxRecipients) {
    throw new TypeError(
      `maxRetainedRecipients ${maxRetainedRecipients} is below maxRecipients ${maxRecipients}; a full fanout ` +
        'could then never be retained and every claim at that size would abandon undelivered'
    );
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  boundedInteger(maxAttempts, 'maxAttempts', 1, 100_000);
  const recipientRawTable = recipientTableName(rawTable);
  const recipientTable = quoteIdentifier(recipientRawTable, MAX_RECIPIENT_TABLE_BYTES);
  // Reject an unstorable configuration at construction instead of discovering it
  // as a poisoned claim under load. Only the recipient primary key is indexed,
  // and everything in it except namespace and transition id is fixed width.
  const worstCaseIndexBytes =
    Buffer.byteLength(namespace, 'utf8') +
    MAX_TRANSITION_ID_BYTES +
    RECIPIENT_ROUND_BYTES +
    RECIPIENT_FINGERPRINT_BYTES;
  if (worstCaseIndexBytes > MAX_BTREE_ENTRY_BYTES) {
    throw new TypeError(
      `Reporting notification activity namespace is too long to index recipient intent ` +
        `(${worstCaseIndexBytes} of ${MAX_BTREE_ENTRY_BYTES} bytes); shorten namespace`
    );
  }

  const persistActivity = async (
    transaction: ReportingLedgerTransactionV1,
    input: {
      eventId: string;
      obligation: Readonly<ReportingLedgerObligationV1>;
      activity: ReportingAccountActivityV1;
      notificationRequired: boolean;
    }
  ): Promise<void> => {
    const { activity, eventId, notificationRequired, obligation } = input;
    const accountId = obligation.account.account_id;
    const tenantId = activity.tenantId;
    if (Buffer.byteLength(JSON.stringify(activity), 'utf8') > MAX_ACTIVITY_BYTES) {
      throw new RangeError('Reporting notification/activity intent exceeds 64 KiB');
    }
    const fingerprint = canonicalJsonSha256(activity);
    if (notificationRequired) {
      await reportingActivityDatabaseOperation('Reporting notification/activity capacity check failed', async () => {
        await transaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `adcp-reporting-activity-cap:${namespace}:${tenantId}`,
        ]);
        const existing = await transaction.query<{
          intent_fingerprint: string;
          tenant_scope: string;
          account_id: string;
          obligation_id: string;
        }>(
          `SELECT intent_fingerprint, tenant_scope, account_id, obligation_id
             FROM ${table}
            WHERE namespace = $1 AND transition_id = $2`,
          [namespace, eventId]
        );
        const existingIntent = existing.rows[0];
        if (existingIntent) {
          if (
            existingIntent.intent_fingerprint !== fingerprint ||
            existingIntent.tenant_scope !== tenantId ||
            existingIntent.account_id !== accountId ||
            existingIntent.obligation_id !== obligation.reporting_obligation_id
          ) {
            throw new Error('Reporting event identity conflicts with existing notification/activity intent');
          }
          return;
        }
        const pending = await transaction.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count FROM ${table}
            WHERE namespace = $1 AND tenant_scope = $2 AND state = 'pending'`,
          [namespace, tenantId]
        );
        if ((pending.rows[0]?.count ?? 0) >= maxPendingPerTenant) {
          throw new Error('Reporting notification activity pending capacity reached; recovery must catch up');
        }
      });
    }
    let write: { rowCount: number | null };
    try {
      write = await transaction.query(
        `INSERT INTO ${table} (
         namespace, transition_id, tenant_scope, account_id, obligation_id,
         activity, intent_fingerprint, notification_required, state,
         projected_at, retain_until
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
                 CASE WHEN $8 THEN 'pending' ELSE 'projected' END,
                 CASE WHEN $8 THEN NULL ELSE clock_timestamp() END,
                 CASE WHEN $8 THEN NULL ELSE clock_timestamp() + ($9::bigint * INTERVAL '1 millisecond') END)
       ON CONFLICT (namespace, transition_id) DO UPDATE SET
         transition_id = EXCLUDED.transition_id
       WHERE ${table}.intent_fingerprint = EXCLUDED.intent_fingerprint
         AND ${table}.tenant_scope = EXCLUDED.tenant_scope
         AND ${table}.account_id = EXCLUDED.account_id
         AND ${table}.obligation_id = EXCLUDED.obligation_id
       RETURNING transition_id`,
        [
          namespace,
          eventId,
          tenantId,
          accountId,
          obligation.reporting_obligation_id,
          JSON.stringify(activity),
          fingerprint,
          notificationRequired,
          retentionMs,
        ]
      );
    } catch (cause) {
      if (isPostgresUndefinedTable(cause)) {
        throw new Error(
          'Reporting notification/activity persistence failed: run getReportingNotificationActivityMigration() before serving',
          { cause }
        );
      }
      throw new Error('Reporting notification/activity persistence failed', { cause });
    }
    if (write.rowCount !== 1) {
      throw new Error('Reporting event identity conflicts with existing notification/activity intent');
    }
  };

  const activityScope = (
    transaction: ReportingLedgerTransactionV1,
    obligation: Readonly<ReportingLedgerObligationV1>,
    eventId: string
  ): { accountId: string; tenantId: string } => {
    if (!transaction || typeof transaction.query !== 'function') {
      throw new TypeError('Reporting notification/activity persistence requires the active ledger transaction');
    }
    const accountId = obligation.account.account_id;
    assertIdentifier(accountId, 'accountId', 512);
    assertIdentifier(eventId, 'eventId', MAX_TRANSITION_ID_BYTES);
    const tenantId = options.tenantScopeForAccount(accountId);
    if (isPromiseLike(tenantId)) {
      throw new TypeError('tenantScopeForAccount must be synchronous and side-effect free');
    }
    assertIdentifier(tenantId, 'tenantId', 512);
    return { accountId, tenantId };
  };

  const databaseNow = async (transaction: ReportingLedgerTransactionV1): Promise<string> => {
    const result = await transaction.query<{ now: Date | string }>('SELECT clock_timestamp() AS now');
    if (!result.rows[0]) throw new Error('Reporting notification/activity database clock is unavailable');
    return asIso(result.rows[0].now);
  };

  const port: ReportingLedgerNotificationActivityPortV1<ReportingLedgerTransactionV1> = {
    async recordTransition(input, transaction) {
      const { tenantId } = activityScope(transaction, input.obligation, input.transition.transitionId);
      if (input.transition.reporting_obligation_id !== input.obligation.reporting_obligation_id) {
        throw new Error('Reporting transition and authoritative obligation identities disagree');
      }
      const activity = buildActivity(namespace, tenantId, input.transition, input.obligation);
      const notificationRequired = input.transition.previousHealth !== input.transition.health;
      await persistActivity(transaction, {
        eventId: input.transition.transitionId,
        obligation: input.obligation,
        activity,
        notificationRequired,
      });
    },
    async recordLedgerChanged(input, transaction) {
      const record = 'revision' in input ? input.revision : input.adjustment;
      const eventId =
        'revision' in input ? input.revision.reporting_revision_id : input.adjustment.reporting_adjustment_id;
      const { tenantId } = activityScope(transaction, input.obligation, eventId);
      if (record.reporting_obligation_id !== input.obligation.reporting_obligation_id) {
        throw new Error('Reporting ledger record and authoritative obligation identities disagree');
      }
      const occurredAt = await databaseNow(transaction);
      const activity = buildLedgerChangedActivity(namespace, tenantId, occurredAt, input);
      await persistActivity(transaction, {
        eventId,
        obligation: input.obligation,
        activity,
        notificationRequired: true,
      });
    },
    async recordDeliveryReady(input, transaction) {
      const eventId = input.materialization.reporting_materialization_id;
      const { tenantId } = activityScope(transaction, input.obligation, eventId);
      if (
        input.revision.reporting_obligation_id !== input.obligation.reporting_obligation_id ||
        input.materialization.reporting_revision_id !== input.revision.reporting_revision_id
      ) {
        throw new Error('Reporting delivery-ready records do not share one authoritative ledger identity');
      }
      if (input.materialization.status !== 'available' && input.materialization.status !== 'delivered') {
        throw new Error('Reporting delivery-ready activity requires a successful materialization');
      }
      const occurredAt = await databaseNow(transaction);
      const activity = buildDeliveryReadyActivity(namespace, tenantId, occurredAt, input);
      await persistActivity(transaction, {
        eventId,
        obligation: input.obligation,
        activity,
        notificationRequired: true,
      });
    },
  };

  return {
    port,
    migrations: {
      activity: getReportingNotificationActivityMigration({ tableName: rawTable }),
      all: [getReportingNotificationActivityMigration({ tableName: rawTable })],
    },
    async probe() {
      // Fails closed for any port, including a custom `{ emit }`: a port that
      // cannot prove it checkpoints lets a recovered outbox delivery send under
      // a recipient this runtime still believes unaddressed.
      if (options.notifications.hasDeliveryAttemptCheckpoint !== true) {
        throw new Error(
          'Reporting notification/activity probe failed: the notification port does not prove it runs the durable ' +
            'pre-POST attempt checkpoint. Wire createPostgresReportingNotificationAttemptCheckpoint() into ' +
            'checkpointDeliveryAttempt, or set hasDeliveryAttemptCheckpoint: true on a custom port that forwards ' +
            'the event it is given.'
        );
      }
      try {
        await options.db.query(
          `SELECT namespace, transition_id, tenant_scope, account_id, obligation_id,
                  activity, intent_fingerprint, state, notification_required, lease_owner, lease_version,
                  lease_expires_at, projected_at, retain_until, delivery_intent_at, abandoned_at
             FROM ${table} LIMIT 0`
        );
        await options.db.query(
          `SELECT namespace, transition_id, recipient_fingerprint, recipient, frozen_at,
                  attempt_at, settled_at, disposition
             FROM ${recipientTable} LIMIT 0`
        );
      } catch (cause) {
        throw new Error(
          'Reporting notification/activity probe failed: run getReportingNotificationActivityMigration() before serving',
          { cause }
        );
      }
    },
    async recoverOnce(recoveryOptions = {}) {
      const ownerToken = recoveryOptions.ownerToken ?? randomUUID();
      assertIdentifier(ownerToken, 'ownerToken', 255);
      if (ownerToken.length < 8) throw new TypeError('ownerToken must contain at least 8 characters');
      const leaseMs = recoveryOptions.leaseMs ?? 60_000;
      const limit = recoveryOptions.limit ?? 50;
      const retryAfterMs = recoveryOptions.retryAfterMs ?? 30_000;
      boundedInteger(leaseMs, 'leaseMs', 1_000, 300_000);
      boundedInteger(limit, 'limit', 1, 1_000);
      boundedInteger(retryAfterMs, 'retryAfterMs', 1, 604_800_000);
      const metrics: ReportingNotificationRecoveryMetricsV1 = {
        claimed: 0,
        matched: 0,
        projected: 0,
        retried: 0,
        leaseLost: 0,
        abandoned: 0,
      };
      // Claim one row at a time. Pre-claiming a batch would let later leases
      // expire while an earlier subscriber fanout is still running.
      for (let index = 0; index < limit; index += 1) {
        const [claim] = await claimPending(options.db, table, namespace, ownerToken, leaseMs, 1);
        if (!claim) break;
        metrics.claimed += 1;
        let leaseLost = false;
        let renewing = false;
        const heartbeat = setInterval(
          () => {
            if (renewing || leaseLost) return;
            renewing = true;
            void renewClaim(options.db, table, namespace, claim, leaseMs)
              .then(renewed => {
                if (!renewed) leaseLost = true;
              })
              .catch(() => {
                leaseLost = true;
              })
              .finally(() => {
                renewing = false;
              });
          },
          Math.max(250, Math.floor(leaseMs / 3))
        );
        heartbeat.unref?.();
        try {
          const notificationType = claim.activity.notificationType;
          if (!notificationType) throw new Error('Pending reporting activity has no notification type');
          let frozen: readonly NotificationRecipientRef[] = [];
          let froze = false;
          const result = await options.notifications.emit({
            emissionId: claim.activity.activityId,
            notificationId: claim.activity.transitionId,
            notificationType,
            anchor: 'account',
            tenantId: claim.tenantId,
            accountId: claim.accountId,
            payload: notificationPayload(claim.activity),
            // Commit the recipient set under this lease before anything leaves
            // the process. Each recipient is revisable until its own durable
            // pre-POST checkpoint and pinned afterwards.
            freezeRecipients: async candidates => {
              froze = true;
              frozen = await freezeClaimRecipients(
                options.db,
                table,
                recipientTable,
                namespace,
                claim,
                maxRecipients,
                maxRetainedRecipients,
                candidates
              );
              return frozen;
            },
          });
          // Declaring checkpoint support is not enough: a port that never calls
          // freezeRecipients leaves no frozen recipient, so the checkpoint
          // suppresses every delivery and settlement would then see nothing
          // outstanding and project the activity as delivered although nothing
          // was sent. The freeze is the contract, and it is verified, not
          // assumed.
          if (!froze) {
            throw new Error(
              'Reporting notification port did not freeze its recipient set; it must forward the emitted event, ' +
                'including freezeRecipients, to a runtime that honours it. Nothing was projected.'
            );
          }
          metrics.matched += result.matched;
          const outcomes = result.deliveries.map(delivery => classifyDelivery(delivery));
          const settlement = await settleClaimRecipients(
            options.db,
            table,
            recipientTable,
            namespace,
            claim,
            frozen,
            outcomes
          );
          if (!settlement.settled) {
            // Something that never reached a subscriber is still outstanding, so
            // the activity must not be recorded as delivered.
            const retryable = outcomes.find(outcome => outcome.disposition === 'retryable');
            throw retryable?.suppression
              ? new ReportingNotificationRetryableSuppressionError(retryable.suppression)
              : new Error(
                  `Reporting notification delivery is not settled for ${settlement.unsettled} recipient(s); retrying`
                );
          }
          const projected = !leaseLost && (await projectClaim(options.db, table, namespace, claim, retentionMs));
          if (projected) metrics.projected += 1;
          else metrics.leaseLost += 1;
        } catch (error) {
          reportProjectionError(recoveryOptions.onError, error, claim);
          // `attemptCount` is this claim's own attempt, so the bound is reached
          // when it equals maxAttempts.
          if (!leaseLost && claim.attemptCount >= maxAttempts) {
            const abandoned = await abandonClaim(options.db, table, namespace, claim, retentionMs);
            if (abandoned) metrics.abandoned += 1;
            else metrics.leaseLost += 1;
          } else {
            const released = !leaseLost && (await releaseClaim(options.db, table, namespace, claim, retryAfterMs));
            if (released) metrics.retried += 1;
            else metrics.leaseLost += 1;
          }
        } finally {
          clearInterval(heartbeat);
        }
      }
      return metrics;
    },
    async listActivity(input) {
      assertIdentifier(input.tenantId, 'tenantId', 512);
      assertIdentifier(input.accountId, 'accountId', 512);
      const expectedTenantId = options.tenantScopeForAccount(input.accountId);
      if (isPromiseLike(expectedTenantId)) {
        throw new TypeError('tenantScopeForAccount must be synchronous and side-effect free');
      }
      assertIdentifier(expectedTenantId, 'tenantId', 512);
      if (expectedTenantId !== input.tenantId) {
        throw new TypeError('Reporting account activity scope does not match the trusted account directory');
      }
      const limit = input.limit ?? 100;
      boundedInteger(limit, 'limit', 1, 200);
      const before = decodeCursor(input.cursor, namespace, input.tenantId, input.accountId);
      const result = await reportingActivityDatabaseOperation('Reporting account activity read failed', () =>
        options.db.query<ActivityRow>(
          `SELECT activity, state, created_at, projected_at, abandoned_at, activity_sequence
           FROM ${table}
          WHERE namespace = $1 AND tenant_scope = $2 AND account_id = $3
            AND ($4::bigint IS NULL OR activity_sequence < $4)
          ORDER BY activity_sequence DESC
          LIMIT $5`,
          [namespace, input.tenantId, input.accountId, before ?? null, limit + 1]
        )
      );
      const selected = result.rows.slice(0, limit);
      const activities = selected.map(row => ({
        ...structuredClone(row.activity),
        recordedAt: asIso(row.created_at),
        ...(row.projected_at ? { notificationProjectedAt: asIso(row.projected_at) } : {}),
        ...(row.abandoned_at ? { notificationAbandonedAt: asIso(row.abandoned_at) } : {}),
      }));
      const hasMore = result.rows.length > limit;
      return {
        activities,
        hasMore,
        ...(hasMore && selected.length > 0
          ? {
              nextCursor: encodeCursor(
                namespace,
                input.tenantId,
                input.accountId,
                String(selected[selected.length - 1]!.activity_sequence)
              ),
            }
          : {}),
      };
    },
    async pruneProjected(pruneOptions = {}) {
      const limit = pruneOptions.limit ?? 1_000;
      boundedInteger(limit, 'limit', 1, 10_000);
      const result = await reportingActivityDatabaseOperation('Reporting account activity pruning failed', () =>
        options.db.query(
          `WITH expired AS (
           SELECT namespace, transition_id FROM ${table}
            WHERE namespace = $1 AND state IN ('projected', 'abandoned')
              AND retain_until <= clock_timestamp()
            ORDER BY retain_until, activity_sequence
            FOR UPDATE SKIP LOCKED LIMIT $2
         )
         DELETE FROM ${table} target USING expired
          WHERE target.namespace = expired.namespace AND target.transition_id = expired.transition_id`,
          [namespace, limit]
        )
      );
      return result.rowCount ?? 0;
    },
  };
}

interface ActivityRow extends Record<string, unknown> {
  activity: ReportingAccountActivityV1;
  state: 'pending' | 'projected' | 'abandoned';
  created_at: Date | string;
  projected_at: Date | string | null;
  abandoned_at: Date | string | null;
  activity_sequence: string | number;
}

interface ClaimedActivity {
  transitionId: string;
  tenantId: string;
  accountId: string;
  activity: ReportingAccountActivityV1;
  leaseOwner: string;
  leaseVersion: string;
  attemptCount: number;
}

function buildActivity(
  namespace: string,
  tenantId: string,
  transition: Readonly<ReportingLedgerStatusTransitionV1>,
  obligation: Readonly<ReportingLedgerObligationV1>
): ReportingAccountActivityV1 {
  const identity = canonicalJsonSha256({
    namespace,
    tenantId,
    accountId: obligation.account.account_id,
    transitionId: transition.transitionId,
  });
  return {
    activityId: `ract_${identity.slice(0, 32)}`,
    transitionId: transition.transitionId,
    activityType: 'reporting.lifecycle_changed',
    ...(transition.previousHealth === transition.health
      ? {}
      : { notificationType: 'reporting.status_changed' as const }),
    tenantId,
    accountId: obligation.account.account_id,
    reporting_obligation_id: obligation.reporting_obligation_id,
    previousHealth: transition.previousHealth,
    health: transition.health,
    previousFinality: transition.previousFinality ?? 'none',
    finality: transition.finality ?? 'none',
    issueIds: [...transition.issueIds],
    occurredAt: transition.occurredAt,
    correlation: {
      delivery_config_id: obligation.delivery_config_id,
      delivery_config_version: obligation.delivery_config_version,
      report_definition_id: obligation.report_definition_id,
      feed_purpose: obligation.feedPurpose,
      period: { start: obligation.period.start, end: obligation.period.end },
    },
  };
}

function activityIdentity(
  namespace: string,
  tenantId: string,
  accountId: string,
  eventId: string,
  eventType: string
): string {
  return `ract_${canonicalJsonSha256({ namespace, tenantId, accountId, eventId, eventType }).slice(0, 32)}`;
}

function buildLedgerChangedActivity(
  namespace: string,
  tenantId: string,
  occurredAt: string,
  input:
    | {
        obligation: Readonly<ReportingLedgerObligationV1>;
        revision: Readonly<ReportingLedgerRevisionV1>;
      }
    | {
        obligation: Readonly<ReportingLedgerObligationV1>;
        adjustment: Readonly<ReportingLedgerAdjustmentV1>;
      }
): ReportingLedgerChangedActivityV1 {
  const accountId = input.obligation.account.account_id;
  if ('revision' in input) {
    const eventId = input.revision.reporting_revision_id;
    return {
      activityId: activityIdentity(namespace, tenantId, accountId, eventId, REPORTING_LEDGER_EVENT_TYPE),
      transitionId: eventId,
      activityType: REPORTING_LEDGER_EVENT_TYPE,
      notificationType: REPORTING_LEDGER_EVENT_TYPE,
      tenantId,
      accountId,
      reporting_obligation_id: input.obligation.reporting_obligation_id,
      occurredAt,
      changeKind: 'revision_published',
      reporting_revision_id: eventId,
      ...(input.revision.supersedes_reporting_revision_id
        ? { supersedes_reporting_revision_id: input.revision.supersedes_reporting_revision_id }
        : {}),
      finality: input.revision.finality,
    };
  }
  const eventId = input.adjustment.reporting_adjustment_id;
  return {
    activityId: activityIdentity(namespace, tenantId, accountId, eventId, REPORTING_LEDGER_EVENT_TYPE),
    transitionId: eventId,
    activityType: REPORTING_LEDGER_EVENT_TYPE,
    notificationType: REPORTING_LEDGER_EVENT_TYPE,
    tenantId,
    accountId,
    reporting_obligation_id: input.obligation.reporting_obligation_id,
    occurredAt,
    changeKind: 'adjustment_published',
    reporting_adjustment_id: eventId,
    adjusts_reporting_revision_id: input.adjustment.adjusts_reporting_revision_id,
  };
}

function buildDeliveryReadyActivity(
  namespace: string,
  tenantId: string,
  occurredAt: string,
  input: {
    obligation: Readonly<ReportingLedgerObligationV1>;
    revision: Readonly<ReportingLedgerRevisionV1>;
    materialization: Readonly<ReportingMaterialization>;
  }
): ReportingDeliveryReadyActivityV1 {
  const accountId = input.obligation.account.account_id;
  const eventId = input.materialization.reporting_materialization_id;
  const readiness = input.materialization.status;
  if (readiness !== 'available' && readiness !== 'delivered') {
    throw new Error('Reporting delivery-ready activity requires a successful materialization');
  }
  return {
    activityId: activityIdentity(namespace, tenantId, accountId, eventId, REPORTING_DELIVERY_EVENT_TYPE),
    transitionId: eventId,
    activityType: REPORTING_DELIVERY_EVENT_TYPE,
    notificationType: REPORTING_DELIVERY_EVENT_TYPE,
    tenantId,
    accountId,
    reporting_obligation_id: input.obligation.reporting_obligation_id,
    occurredAt,
    delivery_config_id: input.obligation.delivery_config_id,
    delivery_config_version: input.obligation.delivery_config_version,
    feed_purpose: input.obligation.feedPurpose,
    reporting_revision_id: input.revision.reporting_revision_id,
    reporting_materialization_id: eventId,
    readiness,
    finality: input.revision.finality,
    data_through: input.revision.dataThrough,
  };
}

type ReportingStatusChangedPayload = Omit<
  ReportingStatusChangedWebhook,
  'idempotency_key' | 'notification_id' | 'notification_type' | 'subscriber_id' | 'account_id'
>;

type ReportingLedgerChangedPayload = Omit<
  ReportingLedgerChangedWebhook,
  'idempotency_key' | 'notification_id' | 'notification_type' | 'subscriber_id' | 'account_id'
>;

type ReportingDeliveryReadyPayload = Omit<
  ReportingDeliveryReadyWebhook,
  'idempotency_key' | 'notification_id' | 'notification_type' | 'subscriber_id' | 'account_id'
>;

function notificationPayload(
  activity: Readonly<ReportingAccountActivityV1>
): ReportingStatusChangedPayload | ReportingLedgerChangedPayload | ReportingDeliveryReadyPayload {
  if (activity.activityType === 'reporting.lifecycle_changed') {
    return {
      reporting_obligation_id: activity.reporting_obligation_id,
      previous_health: activity.previousHealth,
      health: activity.health,
      issue_ids: [...activity.issueIds],
      fired_at: activity.occurredAt,
      delivery_config_id: activity.correlation.delivery_config_id,
      delivery_config_version: activity.correlation.delivery_config_version,
      feed_purpose: activity.correlation.feed_purpose,
    };
  }
  if (activity.activityType === REPORTING_LEDGER_EVENT_TYPE) {
    return {
      fired_at: activity.occurredAt,
      change_kind: activity.changeKind,
      ...(activity.reporting_revision_id ? { reporting_revision_id: activity.reporting_revision_id } : {}),
      ...(activity.supersedes_reporting_revision_id
        ? { supersedes_reporting_revision_id: activity.supersedes_reporting_revision_id }
        : {}),
      ...(activity.finality ? { finality: activity.finality } : {}),
      ...(activity.reporting_adjustment_id ? { reporting_adjustment_id: activity.reporting_adjustment_id } : {}),
      ...(activity.adjusts_reporting_revision_id
        ? { adjusts_reporting_revision_id: activity.adjusts_reporting_revision_id }
        : {}),
    };
  }
  return {
    fired_at: activity.occurredAt,
    delivery_config_id: activity.delivery_config_id,
    delivery_config_version: activity.delivery_config_version,
    feed_purpose: activity.feed_purpose,
    reporting_revision_id: activity.reporting_revision_id,
    reporting_materialization_id: activity.reporting_materialization_id,
    readiness: activity.readiness,
    finality: activity.finality,
    data_through: activity.data_through,
  };
}

async function claimPending(
  db: ReportingLedgerTransactionV1,
  table: string,
  namespace: string,
  ownerToken: string,
  leaseMs: number,
  limit: number
): Promise<ClaimedActivity[]> {
  const result = await reportingActivityDatabaseOperation('Reporting notification recovery claim failed', () =>
    db.query<
      Record<string, unknown> & {
        transition_id: string;
        tenant_scope: string;
        account_id: string;
        activity: ReportingAccountActivityV1;
        lease_version: string;
        attempt_count: number;
      }
    >(
      `WITH candidates AS (
       SELECT namespace, transition_id FROM ${table}
        WHERE namespace = $1 AND state = 'pending' AND next_attempt_at <= clock_timestamp()
          AND (lease_expires_at IS NULL OR lease_expires_at < clock_timestamp())
        ORDER BY next_attempt_at, activity_sequence
        FOR UPDATE SKIP LOCKED LIMIT $4
     )
     UPDATE ${table} target SET
       lease_owner = $2,
       lease_version = target.lease_version + 1,
       lease_expires_at = clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
       attempt_count = target.attempt_count + 1
     FROM candidates
     WHERE target.namespace = candidates.namespace AND target.transition_id = candidates.transition_id
     RETURNING target.transition_id, target.tenant_scope, target.account_id,
               target.activity, target.lease_version::text, target.attempt_count`,
      [namespace, ownerToken, leaseMs, limit]
    )
  );
  return result.rows.map(row => ({
    transitionId: row.transition_id,
    tenantId: row.tenant_scope,
    accountId: row.account_id,
    activity: structuredClone(row.activity),
    leaseOwner: ownerToken,
    leaseVersion: row.lease_version,
    attemptCount: row.attempt_count,
  }));
}

/**
 * Freezes the recipient set for a claim, replacing every recipient that has not
 * yet been addressed and pinning every recipient that has.
 *
 * Revisability is per recipient, because an attempt is per recipient. A
 * recipient with no `attempt_at` provably never received a POST — live delivery
 * authority fails closed before the checkpoint — so it can be dropped when it
 * goes stale, which closes the window where a destination is replaced between
 * candidate enumeration and the first POST. A recipient that has been
 * checkpointed is pinned forever, so a crash after an ambiguous send can never
 * be turned into a second delivery under a new destination generation. One
 * recipient's attempt never pins a sibling.
 *
 * Unattempted rows are replaced rather than superseded, so a claim that retries
 * many times before any send cannot accumulate rows. A recipient that has
 * already reached a terminal disposition is left out of the returned set: it
 * still gates projection, but re-addressing it would be redundant traffic.
 */
async function freezeClaimRecipients(
  db: ReportingLedgerTransactionV1,
  table: string,
  recipientTable: string,
  namespace: string,
  claim: ClaimedActivity,
  maxRecipients: number,
  maxRetainedRecipients: number,
  candidates: readonly NotificationRecipientRef[]
): Promise<readonly NotificationRecipientRef[]> {
  if (candidates.length > maxRecipients) {
    throw new Error(
      `Reporting notification fanout of ${candidates.length} recipients exceeds maxRecipients ${maxRecipients}; ` +
        'raise maxRecipients to at least the notification runtime maxFanoutCandidates'
    );
  }
  const fenced = await reportingActivityDatabaseOperation(
    'Reporting notification recipient intent could not be committed',
    () =>
      db.query(
        `UPDATE ${table} SET delivery_intent_at = COALESCE(delivery_intent_at, clock_timestamp())
          WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
            AND lease_owner = $3 AND lease_version = $4::bigint
            AND lease_expires_at >= clock_timestamp()`,
        [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion]
      )
  );
  if (fenced.rowCount !== 1) {
    throw new Error('Reporting notification recipient intent was not committed; the recovery lease was lost');
  }
  const rows = canonicalRecipients(candidates);
  // Reclaim before measuring. Settled duplicates of one subscriber carry no
  // further meaning, and refusing on a bound that compaction could have
  // satisfied would strand the notification permanently.
  await compactSettledRecipients(db, table, recipientTable, namespace, claim);
  // Budget and mutation are one statement. Measuring separately let a
  // concurrent checkpoint turn a revisable row into a pinned one between the
  // measurement and the write, pushing the retained set past the bound; a
  // single statement either applies the whole replacement or mutates nothing.
  const committed = await reportingActivityDatabaseOperation(
    'Reporting notification recipient intent could not be committed',
    () =>
      db.query<{ leased: boolean; ok: boolean; retained: number; recipient: NotificationRecipientRef | null }>(
        `WITH leased AS MATERIALIZED (
           -- The parent row is the serialization point, and MATERIALIZED makes
           -- its lock the statement's first act. Reading the lease without
           -- locking it only proved the lease was live when the snapshot was
           -- taken: a statement that then blocked on a recipient lock could
           -- resume long after a successor had claimed, still see its own lease
           -- in the cached snapshot, and mutate the successor's rows. Holding
           -- this lock means a takeover cannot complete while this statement
           -- runs, and a statement that starts after one sees the new lease and
           -- matches nothing.
           SELECT transition_id FROM ${table}
            WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
              AND lease_owner = $3 AND lease_version = $4::bigint
              AND lease_expires_at >= clock_timestamp()
              FOR UPDATE
         ), existing AS (
           -- FOR UPDATE is what serializes this statement against a concurrent
           -- checkpoint. Without it the budget is computed from a snapshot in
           -- which a row is still revisable, the DELETE then re-checks the
           -- locked row, finds it attempted and skips it, and the retained set
           -- lands one row above the budget that approved the write.
           SELECT current.recipient_fingerprint, current.subscriber_key, current.recipient,
                  current.attempt_at, current.settled_at
             FROM ${recipientTable} current, leased
            WHERE current.namespace = $1 AND current.transition_id = $2
            FOR UPDATE OF current
         ), claimed AS (
           SELECT subscriber_key FROM existing
            WHERE attempt_at IS NOT NULL OR settled_at IS NOT NULL
         ), proposed AS (
           SELECT entry.fingerprint, entry.subscriber_key, entry.recipient::jsonb AS recipient
             FROM leased, unnest($5::text[], $6::text[], $7::text[])
                    AS entry(fingerprint, subscriber_key, recipient)
            WHERE NOT EXISTS (SELECT 1 FROM claimed WHERE claimed.subscriber_key = entry.subscriber_key)
         ), budget AS (
           SELECT
             (SELECT count(*) FROM existing
               WHERE attempt_at IS NOT NULL OR settled_at IS NOT NULL
                  OR recipient_fingerprint IN (SELECT fingerprint FROM proposed))
             + (SELECT count(*) FROM proposed
                 WHERE fingerprint NOT IN (SELECT recipient_fingerprint FROM existing)) AS retained
         ), gate AS (
           -- The lease is part of the gate, not just of the row sources. A
           -- stale worker sees an empty \`leased\`, which makes every source
           -- empty and the budget zero; without this predicate the budget would
           -- be satisfied and the delete below would reap the rows the
           -- successor had already frozen under its own lease.
           SELECT retained, retained <= $8::integer AND EXISTS (SELECT 1 FROM leased) AS ok FROM budget
         ), dropped AS (
           DELETE FROM ${recipientTable} stale USING gate, leased
            WHERE gate.ok AND stale.namespace = $1 AND stale.transition_id = $2
              AND stale.attempt_at IS NULL AND stale.settled_at IS NULL
              AND NOT (stale.recipient_fingerprint IN (SELECT fingerprint FROM proposed))
         ), added AS (
           INSERT INTO ${recipientTable}
             (namespace, transition_id, recipient_fingerprint, subscriber_key, recipient)
           SELECT $1, $2, proposed.fingerprint, proposed.subscriber_key, proposed.recipient
             FROM proposed, gate, leased WHERE gate.ok
           ON CONFLICT (namespace, transition_id, recipient_fingerprint) DO NOTHING
         ), pinned AS (
           SELECT recipient FROM existing WHERE attempt_at IS NOT NULL AND settled_at IS NULL
         )
         SELECT (SELECT count(*) FROM leased) = 1 AS leased, gate.ok, gate.retained, entry.recipient
           FROM gate
           LEFT JOIN (SELECT recipient FROM proposed UNION ALL SELECT recipient FROM pinned) entry ON TRUE`,
        [
          namespace,
          claim.transitionId,
          claim.leaseOwner,
          claim.leaseVersion,
          rows.map(entry => entry.fingerprint),
          rows.map(entry => entry.subscriberKey),
          rows.map(entry => JSON.stringify(entry.recipient)),
          maxRetainedRecipients,
        ]
      )
  );
  const verdict = committed.rows[0];
  if (!verdict?.leased) {
    throw new Error('Reporting notification recipient intent was not committed; the recovery lease was lost');
  }
  if (!verdict.ok) {
    throw new Error(
      `Reporting notification recipient intent would hold ${verdict.retained} recipients, above ` +
        `maxRetainedRecipients ${maxRetainedRecipients}; nothing was changed. Raise maxRetainedRecipients to at ` +
        'least the fanout plus the distinct subscribers this notification can replace, or reduce its destination churn'
    );
  }
  return committed.rows.flatMap(row => (row.recipient === null ? [] : [row.recipient]));
}

/**
 * Records each recipient's outcome and reports whether the emission may settle.
 *
 * Projection requires every stored recipient to have reached a terminal
 * disposition — delivered, or deliberately not delivered. A recipient whose
 * delivery is still retryable leaves the claim unsettled, so the notification is
 * not recorded as delivered on the strength of an outcome that never reached the
 * subscriber.
 */
async function settleClaimRecipients(
  db: ReportingLedgerTransactionV1,
  table: string,
  recipientTable: string,
  namespace: string,
  claim: ClaimedActivity,
  frozen: readonly NotificationRecipientRef[],
  deliveries: readonly ReportingRecipientOutcome[]
): Promise<{ settled: boolean; unsettled: number }> {
  const outcomes = new Map(deliveries.map(delivery => [recipientFingerprint(delivery.recipient), delivery]));
  const terminal: string[] = [];
  const delivered: string[] = [];
  for (const recipient of frozen) {
    const fingerprint = recipientFingerprint(recipient);
    const outcome = outcomes.get(fingerprint);
    if (outcome === undefined) {
      // Frozen but not addressed this pass: the destination generation no longer
      // resolves. An unattempted recipient was already replaced by the freeze,
      // so this is a pinned recipient whose generation the buyer superseded
      // after it was addressed. Nothing further can be delivered to it.
      terminal.push(fingerprint);
      continue;
    }
    if (outcome.disposition === 'delivered') delivered.push(fingerprint);
    else if (outcome.disposition === 'terminal') terminal.push(fingerprint);
  }
  if (delivered.length > 0 || terminal.length > 0) {
    await reportingActivityDatabaseOperation('Reporting notification recipient settlement failed', () =>
      db.query(
        `WITH leased AS MATERIALIZED (
           SELECT transition_id FROM ${table}
            WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
              AND lease_owner = $5 AND lease_version = $6::bigint
              AND lease_expires_at >= clock_timestamp()
              FOR UPDATE
         )
         UPDATE ${recipientTable} AS target SET settled_at = clock_timestamp(),
           disposition = CASE WHEN target.recipient_fingerprint = ANY($3::text[]) THEN 'delivered' ELSE 'terminal' END
          FROM leased
          WHERE target.namespace = $1 AND target.transition_id = $2 AND target.settled_at IS NULL
            AND (target.recipient_fingerprint = ANY($3::text[]) OR target.recipient_fingerprint = ANY($4::text[]))`,
        [namespace, claim.transitionId, delivered, terminal, claim.leaseOwner, claim.leaseVersion]
      )
    );
    await compactSettledRecipients(db, table, recipientTable, namespace, claim);
  }
  const remaining = await reportingActivityDatabaseOperation('Reporting notification recipient settlement failed', () =>
    db.query<{ unsettled: number }>(
      `SELECT count(*)::integer AS unsettled FROM ${recipientTable}
          WHERE namespace = $1 AND transition_id = $2 AND settled_at IS NULL`,
      [namespace, claim.transitionId]
    )
  );
  const unsettled = remaining.rows[0]?.unsettled ?? 0;
  return { settled: unsettled === 0, unsettled };
}

/**
 * Compacts terminal history to one row per subscriber.
 *
 * Superseded generations of a settled subscriber carry no further meaning: the
 * surviving row still gates projection, still records a disposition for audit,
 * and still stops that subscriber being addressed again. Only rows that are
 * already settled are touched, so nothing in flight is disturbed and a crash
 * simply repeats an idempotent delete.
 */
async function compactSettledRecipients(
  db: ReportingLedgerTransactionV1,
  table: string,
  recipientTable: string,
  namespace: string,
  claim: ClaimedActivity
): Promise<void> {
  await reportingActivityDatabaseOperation('Reporting notification recipient compaction failed', () =>
    db.query(
      `WITH leased AS MATERIALIZED (
         SELECT transition_id FROM ${table}
          WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
            AND lease_owner = $3 AND lease_version = $4::bigint
            AND lease_expires_at >= clock_timestamp()
            FOR UPDATE
       )
       DELETE FROM ${recipientTable} superseded USING leased
        WHERE superseded.namespace = $1 AND superseded.transition_id = $2
          AND superseded.settled_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${recipientTable} survivor
             WHERE survivor.namespace = superseded.namespace
               AND survivor.transition_id = superseded.transition_id
               AND survivor.subscriber_key = superseded.subscriber_key
               AND survivor.settled_at IS NOT NULL
               AND (survivor.disposition, survivor.recipient_fingerprint)
                   > (superseded.disposition, superseded.recipient_fingerprint)
          )`,
      [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion]
    )
  );
}

/** Per-recipient disposition derived from one fanout delivery. */
interface ReportingRecipientOutcome {
  recipient: NotificationRecipientRef;
  disposition: 'delivered' | 'terminal' | 'retryable';
  suppression?: WebhookAttemptSuppressionReason;
}

/**
 * Classifies one fanout delivery.
 *
 * A suppression is live delivery authority failing closed before any POST:
 * deliberate suppressions are terminal, operational ones are retryable and say
 * nothing about the subscriber. Everything else follows the emitter's own
 * terminality, so an exhausted-but-retryable HTTP outcome stays pending for the
 * outbox worker rather than being recorded as delivered.
 */
function classifyDelivery(delivery: {
  scope: NotificationRecipientRef['scope'];
  subscriberId: string;
  destinationGeneration: string;
  result?: { delivered: boolean; terminal?: boolean; suppression?: { reason: WebhookAttemptSuppressionReason } };
  failure?: { reason?: string; terminal?: boolean };
}): ReportingRecipientOutcome {
  const recipient: NotificationRecipientRef = {
    scope: delivery.scope,
    subscriberId: delivery.subscriberId,
    destinationGeneration: delivery.destinationGeneration,
  };
  if (delivery.failure !== undefined || !delivery.result) {
    // A retired delivery binding or an exhausted retry horizon can never
    // succeed. Retrying it holds the claim open until the tenant's own pending
    // capacity is exhausted, so it settles under explicit terminal policy.
    return { recipient, disposition: delivery.failure?.terminal === true ? 'terminal' : 'retryable' };
  }
  const suppression = delivery.result.suppression;
  if (suppression) {
    return {
      recipient,
      disposition: notificationSuppressionDisposition(suppression.reason) === 'retryable' ? 'retryable' : 'terminal',
      suppression: suppression.reason,
    };
  }
  if (delivery.result.delivered) return { recipient, disposition: 'delivered' };
  return { recipient, disposition: delivery.result.terminal === true ? 'terminal' : 'retryable' };
}

function recipientFingerprint(recipient: Readonly<NotificationRecipientRef>): string {
  return canonicalJsonSha256({
    scope: recipient.scope,
    subscriberId: recipient.subscriberId,
    destinationGeneration: recipient.destinationGeneration,
  });
}

/** Deterministic ordering so a frozen set is byte-stable across replays. */
function canonicalRecipients(
  candidates: readonly NotificationRecipientRef[]
): { fingerprint: string; subscriberKey: string; recipient: NotificationRecipientRef }[] {
  return candidates
    .map(candidate => {
      const recipient = {
        scope: candidate.scope,
        subscriberId: candidate.subscriberId,
        destinationGeneration: candidate.destinationGeneration,
      };
      return {
        fingerprint: recipientFingerprint(recipient),
        subscriberKey: subscriberKey(recipient),
        recipient,
      };
    })
    .sort((left, right) => (left.fingerprint < right.fingerprint ? -1 : 1));
}

/**
 * Identifies the subscriber independently of its destination generation, so a
 * subscriber that has already been addressed is never addressed again under a
 * replacement generation — that would be one logical delivery under two
 * idempotency keys.
 */
function subscriberKey(recipient: Readonly<NotificationRecipientRef>): string {
  return canonicalJsonSha256({ scope: recipient.scope, subscriberId: recipient.subscriberId });
}

async function renewClaim(
  db: ReportingLedgerTransactionV1,
  table: string,
  namespace: string,
  claim: ClaimedActivity,
  leaseMs: number
): Promise<boolean> {
  const result = await reportingActivityDatabaseOperation('Reporting notification lease renewal failed', () =>
    db.query(
      `UPDATE ${table} SET lease_expires_at = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond')
      WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
        AND lease_owner = $3 AND lease_version = $4::bigint
        AND lease_expires_at >= clock_timestamp()`,
      [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion, leaseMs]
    )
  );
  return result.rowCount === 1;
}

async function projectClaim(
  db: ReportingLedgerTransactionV1,
  table: string,
  namespace: string,
  claim: ClaimedActivity,
  retentionMs: number
): Promise<boolean> {
  const result = await reportingActivityDatabaseOperation('Reporting notification projection settlement failed', () =>
    db.query(
      `UPDATE ${table} SET state = 'projected', projected_at = clock_timestamp(),
       retain_until = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond'),
       lease_owner = NULL, lease_expires_at = NULL
      WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
        AND lease_owner = $3 AND lease_version = $4::bigint
        AND lease_expires_at >= clock_timestamp()`,
      [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion, retentionMs]
    )
  );
  return result.rowCount === 1;
}

async function releaseClaim(
  db: ReportingLedgerTransactionV1,
  table: string,
  namespace: string,
  claim: ClaimedActivity,
  retryAfterMs: number
): Promise<boolean> {
  const result = await reportingActivityDatabaseOperation('Reporting notification lease release failed', () =>
    db.query(
      `UPDATE ${table} SET lease_owner = NULL, lease_expires_at = NULL,
       next_attempt_at = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond')
      WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
        AND lease_owner = $3 AND lease_version = $4::bigint
        AND lease_expires_at >= clock_timestamp()`,
      [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion, retryAfterMs]
    )
  );
  return result.rowCount === 1;
}

/**
 * Bounds a claim that cannot succeed.
 *
 * A claim with no terminal bound retries forever, and enough of them reach
 * `maxPendingPerTenant` and start refusing new activity writes for the whole
 * tenant. Abandoning leaves the pending set — so it cannot poison capacity —
 * without ever being recorded as delivered, and it is retained so an operator
 * can see it. Lease-fenced like every other settlement.
 */
async function abandonClaim(
  db: ReportingLedgerTransactionV1,
  table: string,
  namespace: string,
  claim: ClaimedActivity,
  retentionMs: number
): Promise<boolean> {
  const result = await reportingActivityDatabaseOperation('Reporting notification abandonment failed', () =>
    db.query(
      `UPDATE ${table} SET state = 'abandoned',
         abandoned_at = clock_timestamp(),
         retain_until = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond'),
         lease_owner = NULL, lease_expires_at = NULL
      WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
        AND lease_owner = $3 AND lease_version = $4::bigint
        AND lease_expires_at >= clock_timestamp()`,
      [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion, retentionMs]
    )
  );
  return result.rowCount === 1;
}

function encodeCursor(namespace: string, tenantId: string, accountId: string, before: string): string {
  const cursor = `ract1.${Buffer.from(JSON.stringify({ namespace, tenantId, accountId, before })).toString('base64url')}`;
  if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
    throw new Error('Reporting account activity cursor exceeds its internal bound');
  }
  return cursor;
}

function decodeCursor(
  cursor: string | undefined,
  namespace: string,
  tenantId: string,
  accountId: string
): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) throw new Error();
    if (!cursor.startsWith('ract1.')) throw new Error();
    const value = JSON.parse(Buffer.from(cursor.slice(6), 'base64url').toString('utf8')) as Record<string, unknown>;
    if (
      value.namespace !== namespace ||
      value.tenantId !== tenantId ||
      value.accountId !== accountId ||
      typeof value.before !== 'string' ||
      !/^[1-9][0-9]*$/.test(value.before)
    ) {
      throw new Error();
    }
    if (BigInt(value.before) > 9_223_372_036_854_775_807n) throw new Error();
    return value.before;
  } catch {
    throw new TypeError('Reporting account activity cursor is invalid for the authenticated scope');
  }
}

function quoteIdentifier(value: string, maxBytes = 42): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new TypeError(
      `Invalid reporting activity table name ${JSON.stringify(value)}: use at most ${maxBytes} lowercase characters`
    );
  }
  return `"${value}"`;
}

function assertIdentifier(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${name} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL`);
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value != null && typeof value === 'object' && typeof (value as { then?: unknown }).then === 'function';
}

function isPostgresUndefinedTable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { code?: unknown }).code === '42P01';
}

function reportProjectionError(
  observer:
    | ((error: unknown, claim: Readonly<ReportingNotificationProjectionErrorV1>) => void | Promise<void>)
    | undefined,
  error: unknown,
  claim: Readonly<ClaimedActivity>
): void {
  try {
    const result = observer?.(error, {
      transitionId: claim.transitionId,
      tenantId: claim.tenantId,
      accountId: claim.accountId,
      attemptCount: claim.attemptCount,
    });
    if (isPromiseLike(result)) void Promise.resolve(result).catch(() => {});
  } catch {
    // Observability integrations must not change durable lease semantics.
  }
}

async function reportingActivityDatabaseOperation<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new Error(message, { cause });
  }
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
