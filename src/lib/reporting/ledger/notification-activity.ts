import { randomUUID } from 'node:crypto';

import type { NotificationRecipientRef, PersistentNotificationRuntime } from '../../server/notification-subscriptions';
import { notificationSuppressionDisposition } from '../../server/notification-subscriptions';
import type { WebhookAttemptSuppressionReason } from '../../server/webhook-emitter';
import type { ReportingStatusChangedWebhook } from '../../types/core.generated';
import { canonicalJsonSha256 } from '../../utils/jcs';
import type {
  ReportingHealthV1,
  ReportingLedgerNotificationActivityPortV1,
  ReportingLedgerObligationV1,
  ReportingLedgerStatusTransitionV1,
  ReportingLedgerTransactionV1,
  ReportingObservedFinalityV1,
} from './types';

const DEFAULT_TABLE = 'adcp_reporting_notification_activity';
const DEFAULT_NAMESPACE = 'adcp-reporting';
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PENDING_PER_TENANT = 100_000;
const MAX_ACTIVITY_BYTES = 64 * 1024;
const MAX_CURSOR_BYTES = 16 * 1024;

export interface ReportingAccountActivityV1 {
  activityId: string;
  transitionId: string;
  activityType: 'reporting.lifecycle_changed';
  notificationType?: 'reporting.status_changed';
  tenantId: string;
  accountId: string;
  reporting_obligation_id: string;
  previousHealth: ReportingHealthV1;
  health: ReportingHealthV1;
  previousFinality: ReportingObservedFinalityV1;
  finality: ReportingObservedFinalityV1;
  issueIds: string[];
  occurredAt: string;
  correlation: {
    delivery_config_id: string;
    delivery_config_version: number;
    report_definition_id: string;
    feed_purpose: ReportingLedgerObligationV1['feedPurpose'];
    period: { start: string; end: string };
  };
}

export interface ReportingAccountActivityRecordV1 extends ReportingAccountActivityV1 {
  recordedAt: string;
  notificationProjectedAt?: string;
}

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
  notifications: Pick<PersistentNotificationRuntime, 'emit'>;
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
   * Largest recipient fanout whose frozen intent this runtime will store.
   * Defaults to 10,000 — the ceiling the persistent notification runtime
   * enforces on `maxFanoutCandidates` — so a valid fanout can never exceed it.
   * Lower it only below that runtime's configured `maxFanoutCandidates`, never
   * above: a fanout larger than this cannot be committed and would retry until
   * it aged out.
   */
  maxRecipients?: number;
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
  delivery_intent_round  INTEGER NOT NULL DEFAULT 0,
  delivery_intent_at     TIMESTAMPTZ,
  delivery_attempt_at    TIMESTAMPTZ,
  PRIMARY KEY (namespace, transition_id),
  CONSTRAINT ${raw}_valid_state CHECK (state IN ('pending', 'projected')),
  CONSTRAINT ${raw}_valid_fingerprint CHECK (intent_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ${raw}_valid_activity CHECK (jsonb_typeof(activity) = 'object'),
  CONSTRAINT ${raw}_valid_projection CHECK (
    (state = 'pending' AND notification_required AND projected_at IS NULL AND retain_until IS NULL) OR
    (state = 'projected' AND projected_at IS NOT NULL AND retain_until IS NOT NULL)
  ),
  CONSTRAINT ${raw}_valid_delivery_intent CHECK (
    (delivery_intent_round = 0 AND delivery_intent_at IS NULL AND delivery_attempt_at IS NULL) OR
    (delivery_intent_round > 0 AND delivery_intent_at IS NOT NULL)
  ),
  CONSTRAINT ${raw}_attempt_follows_intent CHECK (
    delivery_attempt_at IS NULL OR delivery_intent_at IS NOT NULL
  )
);

ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS delivery_intent_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS delivery_intent_at TIMESTAMPTZ;
ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS delivery_attempt_at TIMESTAMPTZ;

-- One row per frozen recipient. A relational representation is what lets a
-- maximum fanout (10,000 recipients, each with maximum-length scope,
-- subscriber and destination-generation identifiers) be stored at all: a single
-- serialized document would need a size cap, and a fanout that legitimately
-- exceeded it could never be committed and would retry until it aged out.
-- Only the bounded 64-hex fingerprint enters the index, so an individual
-- recipient reference has no length limit of its own.
CREATE TABLE IF NOT EXISTS ${recipientTable} (
  namespace              TEXT NOT NULL,
  transition_id          TEXT NOT NULL,
  intent_round           INTEGER NOT NULL,
  recipient_fingerprint  TEXT NOT NULL,
  recipient              JSONB NOT NULL,
  PRIMARY KEY (namespace, transition_id, intent_round, recipient_fingerprint),
  CONSTRAINT ${rawRecipients}_fk FOREIGN KEY (namespace, transition_id)
    REFERENCES ${table}(namespace, transition_id) ON DELETE CASCADE,
  CONSTRAINT ${rawRecipients}_fp CHECK (recipient_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT ${rawRecipients}_obj CHECK (jsonb_typeof(recipient) = 'object'),
  CONSTRAINT ${rawRecipients}_rnd CHECK (intent_round > 0)
);

CREATE INDEX IF NOT EXISTS idx_${raw}_pending
  ON ${table}(namespace, next_attempt_at, lease_expires_at, activity_sequence)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_${raw}_pending_tenant
  ON ${table}(namespace, tenant_scope)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_${raw}_account_activity
  ON ${table}(namespace, tenant_scope, account_id, activity_sequence DESC);
CREATE INDEX IF NOT EXISTS idx_${raw}_retention
  ON ${table}(namespace, retain_until, activity_sequence)
  WHERE state = 'projected';
`.trim();
}

/** Child table holding one row per frozen recipient. */
export function recipientTableName(tableName: string = DEFAULT_TABLE): string {
  return `${tableName}_recipients`;
}

export const REPORTING_NOTIFICATION_ACTIVITY_MIGRATION = getReportingNotificationActivityMigration();

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
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
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

  const port: ReportingLedgerNotificationActivityPortV1<ReportingLedgerTransactionV1> = {
    async recordTransition(input, transaction) {
      if (!transaction || typeof transaction.query !== 'function') {
        throw new TypeError('Reporting notification/activity persistence requires the active ledger transaction');
      }
      const accountId = input.obligation.account.account_id;
      assertIdentifier(accountId, 'accountId', 512);
      assertIdentifier(input.transition.transitionId, 'transitionId', MAX_TRANSITION_ID_BYTES);
      const tenantId = options.tenantScopeForAccount(accountId);
      if (isPromiseLike(tenantId)) {
        throw new TypeError('tenantScopeForAccount must be synchronous and side-effect free');
      }
      assertIdentifier(tenantId, 'tenantId', 512);
      if (input.transition.reporting_obligation_id !== input.obligation.reporting_obligation_id) {
        throw new Error('Reporting transition and authoritative obligation identities disagree');
      }
      const activity = buildActivity(namespace, tenantId, input.transition, input.obligation);
      const notificationRequired = input.transition.previousHealth !== input.transition.health;
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
            [namespace, input.transition.transitionId]
          );
          const existingIntent = existing.rows[0];
          if (existingIntent) {
            if (
              existingIntent.intent_fingerprint !== fingerprint ||
              existingIntent.tenant_scope !== tenantId ||
              existingIntent.account_id !== accountId ||
              existingIntent.obligation_id !== input.obligation.reporting_obligation_id
            ) {
              throw new Error('Reporting transition identity conflicts with existing notification/activity intent');
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
            input.transition.transitionId,
            tenantId,
            accountId,
            input.obligation.reporting_obligation_id,
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
        throw new Error('Reporting transition identity conflicts with existing notification/activity intent');
      }
    },
  };

  return {
    port,
    migrations: {
      activity: getReportingNotificationActivityMigration({ tableName: rawTable }),
      all: [getReportingNotificationActivityMigration({ tableName: rawTable })],
    },
    async probe() {
      try {
        await options.db.query(
          `SELECT namespace, transition_id, tenant_scope, account_id, obligation_id,
                  activity, intent_fingerprint, state, notification_required, lease_owner, lease_version,
                  lease_expires_at, projected_at, retain_until, delivery_intent_round, delivery_intent_at,
                  delivery_attempt_at
             FROM ${table} LIMIT 0`
        );
        await options.db.query(
          `SELECT namespace, transition_id, intent_round, recipient_fingerprint, recipient
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
          if (claim.activity.notificationType !== 'reporting.status_changed') {
            throw new Error('Pending reporting activity is not a health-transition notification');
          }
          const result = await options.notifications.emit({
            emissionId: claim.activity.activityId,
            notificationId: claim.activity.transitionId,
            notificationType: 'reporting.status_changed',
            anchor: 'account',
            tenantId: claim.tenantId,
            accountId: claim.accountId,
            payload: notificationPayload(claim.activity),
            // Commit the recipient set under this lease before anything leaves
            // the process. Revisable until the first attempt, immutable after.
            freezeRecipients: candidates =>
              freezeClaimRecipients(options.db, table, recipientTable, namespace, claim, maxRecipients, candidates),
            beforeExternalAttempt: () => markClaimAttempted(options.db, table, namespace, claim),
          });
          metrics.matched += result.matched;
          if (result.deliveries.some(delivery => delivery.failure !== undefined)) {
            throw new Error('Persistent notification runtime could not durably bind every matched delivery');
          }
          // A suppression is the live delivery authority failing closed before
          // any external attempt. Deliberate suppressions settle the emission;
          // operational ones say nothing about the subscriber, so recording the
          // notification as delivered would silently drop it.
          const retryableSuppression = result.deliveries.find(
            delivery =>
              delivery.result?.suppression !== undefined &&
              notificationSuppressionDisposition(delivery.result.suppression.reason) === 'retryable'
          );
          if (retryableSuppression?.result?.suppression) {
            throw new ReportingNotificationRetryableSuppressionError(retryableSuppression.result.suppression.reason);
          }
          const projected = !leaseLost && (await projectClaim(options.db, table, namespace, claim, retentionMs));
          if (projected) metrics.projected += 1;
          else metrics.leaseLost += 1;
        } catch (error) {
          reportProjectionError(recoveryOptions.onError, error, claim);
          const released = !leaseLost && (await releaseClaim(options.db, table, namespace, claim, retryAfterMs));
          if (released) metrics.retried += 1;
          else metrics.leaseLost += 1;
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
          `SELECT activity, state, created_at, projected_at, activity_sequence
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
            WHERE namespace = $1 AND state = 'projected' AND retain_until <= clock_timestamp()
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
  state: 'pending' | 'projected';
  created_at: Date | string;
  projected_at: Date | string | null;
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

type ReportingStatusChangedPayload = Omit<
  ReportingStatusChangedWebhook,
  'idempotency_key' | 'notification_id' | 'notification_type' | 'subscriber_id' | 'account_id'
>;

function notificationPayload(activity: Readonly<ReportingAccountActivityV1>): ReportingStatusChangedPayload {
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
 * Commits — or, while nothing has been sent, re-resolves — the recipient set for
 * a claim, and returns the set the emission must use.
 *
 * The set is revisable until the first external attempt and immutable after it.
 * That closes the window between candidate enumeration and the first POST: if a
 * buyer replaces its destination in that window, the emission is suppressed as
 * `subscription_stale` with no attempt, the claim is released, and the next pass
 * commits a fresh round for the new generation. Once `delivery_attempt_at` is
 * set, a crash is an ambiguous send, so the committed round is replayed verbatim
 * and a replacement can never be added as a second delivery.
 *
 * Each commit bumps `delivery_intent_round` and writes its own recipient rows.
 * Rounds are never mutated in place, so a crash midway through writing one
 * leaves a partial round that is simply never read — the attempt marker is only
 * set after this function returns, so an unfinished round can never be attempted.
 */
async function freezeClaimRecipients(
  db: ReportingLedgerTransactionV1,
  table: string,
  recipientTable: string,
  namespace: string,
  claim: ClaimedActivity,
  maxRecipients: number,
  candidates: readonly NotificationRecipientRef[]
): Promise<readonly NotificationRecipientRef[]> {
  if (candidates.length > maxRecipients) {
    throw new Error(
      `Reporting notification fanout of ${candidates.length} recipients exceeds maxRecipients ${maxRecipients}; ` +
        'raise maxRecipients to at least the notification runtime maxFanoutCandidates'
    );
  }
  const committed = await reportingActivityDatabaseOperation(
    'Reporting notification recipient intent could not be committed',
    () =>
      db.query<{ intent_round: number }>(
        `UPDATE ${table} SET
         delivery_intent_round = ${table}.delivery_intent_round + 1,
         delivery_intent_at = clock_timestamp()
       WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
         AND lease_owner = $3 AND lease_version = $4::bigint
         AND lease_expires_at >= clock_timestamp()
         AND delivery_attempt_at IS NULL
       RETURNING delivery_intent_round AS intent_round`,
        [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion]
      )
  );
  const round = committed.rows[0]?.intent_round;
  if (round === undefined) {
    // Either an attempt already happened — in which case the committed round is
    // authoritative and must be replayed — or the lease is gone.
    return replayCommittedRecipients(db, table, recipientTable, namespace, claim);
  }
  const rows = canonicalRecipients(candidates);
  // Chunked so a maximum fanout never builds one oversized statement. A partial
  // round is unreachable, so chunking cannot expose a half-frozen intent.
  for (let index = 0; index < rows.length; index += RECIPIENT_INSERT_CHUNK) {
    const chunk = rows.slice(index, index + RECIPIENT_INSERT_CHUNK);
    await reportingActivityDatabaseOperation('Reporting notification recipient intent could not be committed', () =>
      db.query(
        `INSERT INTO ${recipientTable} (namespace, transition_id, intent_round, recipient_fingerprint, recipient)
         SELECT $1, $2, $3::integer, entry.fingerprint, entry.recipient::jsonb
           FROM unnest($4::text[], $5::text[]) AS entry(fingerprint, recipient)
         ON CONFLICT DO NOTHING`,
        [
          namespace,
          claim.transitionId,
          round,
          chunk.map(entry => entry.fingerprint),
          chunk.map(entry => JSON.stringify(entry.recipient)),
        ]
      )
    );
  }
  return rows.map(entry => entry.recipient);
}

/** Reads back the authoritative committed round after an attempt has started. */
async function replayCommittedRecipients(
  db: ReportingLedgerTransactionV1,
  table: string,
  recipientTable: string,
  namespace: string,
  claim: ClaimedActivity
): Promise<readonly NotificationRecipientRef[]> {
  const result = await reportingActivityDatabaseOperation(
    'Reporting notification recipient intent could not be read',
    () =>
      db.query<{ recipient: NotificationRecipientRef }>(
        `SELECT recipient.recipient FROM ${recipientTable} recipient
           JOIN ${table} activity
             ON activity.namespace = recipient.namespace
            AND activity.transition_id = recipient.transition_id
            AND activity.delivery_intent_round = recipient.intent_round
          WHERE recipient.namespace = $1 AND recipient.transition_id = $2
            AND activity.delivery_intent_at IS NOT NULL
            AND activity.lease_owner = $3 AND activity.lease_version = $4::bigint
          ORDER BY recipient.recipient_fingerprint`,
        [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion]
      )
  );
  if (result.rowCount === 0) {
    throw new Error('Reporting notification recipient intent was not committed; the recovery lease was lost');
  }
  return result.rows.map(row => row.recipient);
}

/**
 * Durably records that an external attempt is about to happen, freezing the
 * committed round. Fenced on the lease so a worker that lost it cannot send.
 */
async function markClaimAttempted(
  db: ReportingLedgerTransactionV1,
  table: string,
  namespace: string,
  claim: ClaimedActivity
): Promise<void> {
  const result = await reportingActivityDatabaseOperation(
    'Reporting notification delivery attempt could not be recorded',
    () =>
      db.query(
        `UPDATE ${table} SET delivery_attempt_at = COALESCE(delivery_attempt_at, clock_timestamp())
       WHERE namespace = $1 AND transition_id = $2 AND state = 'pending'
         AND lease_owner = $3 AND lease_version = $4::bigint
         AND lease_expires_at >= clock_timestamp()
         AND delivery_intent_at IS NOT NULL`,
        [namespace, claim.transitionId, claim.leaseOwner, claim.leaseVersion]
      )
  );
  if (result.rowCount !== 1) {
    throw new Error('Reporting notification delivery attempt was not recorded; the recovery lease was lost');
  }
}

const RECIPIENT_INSERT_CHUNK = 500;

/** Deterministic ordering so a committed round is byte-stable across replays. */
function canonicalRecipients(
  candidates: readonly NotificationRecipientRef[]
): { fingerprint: string; recipient: NotificationRecipientRef }[] {
  return candidates
    .map(candidate => {
      const recipient = {
        scope: candidate.scope,
        subscriberId: candidate.subscriberId,
        destinationGeneration: candidate.destinationGeneration,
      };
      return { fingerprint: canonicalJsonSha256(recipient), recipient };
    })
    .sort((left, right) => (left.fingerprint < right.fingerprint ? -1 : 1));
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
