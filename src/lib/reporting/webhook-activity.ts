import type { WebhookActivityRecord } from '../types/core.generated';
import type { ListAccountsRequest } from '../types/tools.generated';
import type {
  NotificationDeliveryAttemptCheckpoint,
  NotificationDeliveryAttemptCheckpointInput,
  NotificationSubscriptionScope,
} from '../server/notification-subscriptions';
import type { WebhookEmitAttempt, WebhookEmitAttemptResult, WebhookEmitterOptions } from '../server/webhook-emitter';
import { canonicalJsonSha256 } from '../utils/jcs';
import type { ReportingConsumerPostgresQueryable } from './consumer-postgres';

const DEFAULT_TABLE = 'adcp_reporting_webhook_attempts';
const DEFAULT_RETENTION_DAYS = 30;
const REPORTING_EVENTS = new Set(['reporting.delivery_ready', 'reporting.status_changed', 'reporting.ledger_changed']);
const PUBLIC_PATH_SEGMENTS = new Set([
  '',
  'api',
  'adcp',
  'webhook',
  'webhooks',
  'reporting',
  'reports',
  'report',
  'callback',
  'callbacks',
  'notify',
  'notifications',
  'events',
  'delivery',
  'redacted',
  'hook',
  'hooks',
  'ingest',
  'endpoint',
]);

export interface CreatePostgresReportingWebhookActivityOptionsV1 {
  db: ReportingConsumerPostgresQueryable;
  namespace: string;
  tableName?: string;
  /** Protocol minimum is 30 days. */
  retentionDays?: number;
}

export interface ReportingWebhookActivityScopeV1 {
  tenantId: string;
  principalId: string;
  accountId: string;
}

export interface PostgresReportingWebhookActivityV1 {
  readonly checkpointDeliveryAttempt: NotificationDeliveryAttemptCheckpoint;
  readonly emitterObservers: Pick<WebhookEmitterOptions, 'onAttemptResult'>;
  readonly migrations: { activity: string; all: readonly [string] };
  probe(): Promise<void>;
  listActivity(input: ReportingWebhookActivityScopeV1 & { limit?: number }): Promise<WebhookActivityRecord[]>;
  listActivityBatch(input: {
    tenantId: string;
    principalId: string;
    accountIds: readonly string[];
    limit?: number;
  }): Promise<ReadonlyMap<string, WebhookActivityRecord[]>>;
  pruneCompleted(options?: { limit?: number }): Promise<number>;
}

export interface ReportingWebhookActivityReaderV1 {
  listActivity(input: ReportingWebhookActivityScopeV1 & { limit?: number }): Promise<WebhookActivityRecord[]>;
  listActivityBatch?(input: {
    tenantId: string;
    principalId: string;
    accountIds: readonly string[];
    limit?: number;
  }): Promise<ReadonlyMap<string, WebhookActivityRecord[]>>;
}

export interface ProjectListAccountsReportingWebhookActivityOptionsV1<TResponse> {
  response: TResponse;
  request: Pick<ListAccountsRequest, 'include_webhook_activity' | 'webhook_activity_limit'>;
  /** Trusted authenticated scope, never request-body data. */
  tenantId: string;
  /** Trusted authenticated principal whose registered endpoints are visible. */
  principalId: string;
  activity: ReportingWebhookActivityReaderV1;
  maxConcurrency?: number;
}

export class ReportingWebhookActivityConflictError extends Error {
  override readonly name = 'ReportingWebhookActivityConflictError';
}

export function getReportingWebhookActivityMigration(options: { tableName?: string } = {}): string {
  const raw = tableName(options.tableName);
  const table = quoteIdentifier(raw);
  const ordinals = quoteIdentifier(`${raw}_ordinals`);
  const metadata = quoteIdentifier(`${raw}_metadata`);
  return `
CREATE TABLE IF NOT EXISTS ${metadata} (
  migration_key       TEXT PRIMARY KEY,
  completed_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS ${ordinals} (
  namespace           TEXT NOT NULL,
  tenant_key          TEXT NOT NULL,
  principal_key       TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  subscriber_id       TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  next_attempt        INTEGER NOT NULL DEFAULT 2,
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key),
  CHECK (tenant_key ~ '^[a-f0-9]{64}$'),
  CHECK (principal_key ~ '^[a-f0-9]{64}$'),
  CHECK (next_attempt > 1 AND next_attempt <= 1000001)
);
CREATE INDEX IF NOT EXISTS ${raw}_ord_ret
  ON ${ordinals}(namespace, changed_at);

CREATE TABLE IF NOT EXISTS ${table} (
  namespace           TEXT NOT NULL,
  tenant_key          TEXT NOT NULL,
  principal_key       TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  subscriber_id       TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  attempt             INTEGER NOT NULL,
  notification_id     TEXT NOT NULL,
  notification_type   TEXT NOT NULL,
  immutable_sha256    TEXT NOT NULL,
  fired_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at        TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending',
  url                 TEXT NOT NULL,
  http_status_code    INTEGER,
  response_time_ms    INTEGER,
  payload_size_bytes  INTEGER NOT NULL,
  error_message       TEXT,
  PRIMARY KEY (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, attempt),
  CHECK (tenant_key ~ '^[a-f0-9]{64}$'),
  CHECK (principal_key ~ '^[a-f0-9]{64}$'),
  CHECK (immutable_sha256 ~ '^[a-f0-9]{64}$'),
  CHECK (attempt > 0),
  CHECK (payload_size_bytes >= 0),
  CHECK (status IN ('pending', 'success', 'failed', 'timeout', 'connection_error')),
  CHECK ((status = 'pending') = (completed_at IS NULL)),
  CHECK ((status IN ('success', 'failed')) = (http_status_code IS NOT NULL)),
  CHECK ((status IN ('success', 'failed')) = (response_time_ms IS NOT NULL)),
  CHECK ((status IN ('pending', 'success')) = (error_message IS NULL)),
  CHECK (notification_type IN ('reporting.delivery_ready', 'reporting.status_changed', 'reporting.ledger_changed'))
);
CREATE INDEX IF NOT EXISTS ${raw}_newest
  ON ${table}(namespace, tenant_key, principal_key, account_id, fired_at DESC, attempt DESC);
CREATE INDEX IF NOT EXISTS ${raw}_retention
  ON ${table}(namespace, completed_at) WHERE completed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ${raw}_pending_retention
  ON ${table}(namespace, fired_at) WHERE completed_at IS NULL;
WITH first_backfill AS (
  INSERT INTO ${metadata} (migration_key) VALUES ('attempt-ordinal-backfill-v1')
  ON CONFLICT DO NOTHING RETURNING migration_key
)
INSERT INTO ${ordinals}
  (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, next_attempt)
SELECT namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key,
       LEAST(MAX(attempt) + 1, 1000001)
  FROM ${table}, first_backfill
 GROUP BY namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key
ON CONFLICT (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key)
DO UPDATE SET next_attempt = GREATEST(${ordinals}.next_attempt, EXCLUDED.next_attempt),
              changed_at = clock_timestamp();
`.trim();
}

export const REPORTING_WEBHOOK_ACTIVITY_POSTGRES_MIGRATION = getReportingWebhookActivityMigration();

export function createPostgresReportingWebhookActivityV1(
  options: CreatePostgresReportingWebhookActivityOptionsV1
): PostgresReportingWebhookActivityV1 {
  if (!options?.db || typeof options.db.query !== 'function') {
    throw new TypeError('createPostgresReportingWebhookActivityV1 requires a PostgreSQL queryable');
  }
  boundedString(options.namespace, 'namespace', 255);
  const rawTable = tableName(options.tableName);
  const table = quoteIdentifier(rawTable);
  const ordinals = quoteIdentifier(`${rawTable}_ordinals`);
  const metadata = quoteIdentifier(`${rawTable}_metadata`);
  const namespace = options.namespace;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  boundedInteger(retentionDays, 'retentionDays', 30, 3_650);

  const allocateAttemptOrdinal = async (attempt: Readonly<WebhookEmitAttempt>): Promise<number> => {
    const context = parseEmitterContext(attempt.attemptAuthorizationContext);
    if (!context || !REPORTING_EVENTS.has(context.eventType)) return attempt.attempt;
    boundedString(attempt.idempotency_key, 'idempotency_key', 255);
    boundedInteger(attempt.payload_size_bytes, 'payload_size_bytes', 0, 1_073_741_824);
    sanitizeReportingWebhookActivityUrl(attempt.url);
    const result = await query<{ attempt: string }>(
      'allocate attempt ordinal',
      `INSERT INTO ${ordinals}
         (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, next_attempt)
       VALUES ($1,$2,$3,$4,$5,$6,2)
       ON CONFLICT (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key)
       DO UPDATE SET next_attempt = ${ordinals}.next_attempt + 1, changed_at = clock_timestamp()
         WHERE ${ordinals}.next_attempt <= 1000000
       RETURNING (next_attempt - 1)::text AS attempt`,
      [
        namespace,
        scopeDigest(context.scope.tenantId),
        scopeDigest(context.scope.principalId),
        context.accountId,
        context.subscriberId,
        attempt.idempotency_key,
      ]
    );
    const next = Number(result.rows[0]?.attempt);
    boundedInteger(next, 'attempt ordinal', 1, 1_000_000);
    return next;
  };

  const checkpointDeliveryAttempt: NotificationDeliveryAttemptCheckpoint = async input => {
    if (!REPORTING_EVENTS.has(input.eventType)) return;
    const context = attemptContext(input);
    const candidate = input.attempt;
    if (!candidate) throw new TypeError('Reporting webhook activity requires runtime attempt diagnostics');
    const resolvedAttempt = await allocateAttemptOrdinal({
      ...candidate,
      attemptAuthorizationContext: {
        kind: 'adcp_notification_subscription',
        version: 1,
        scope: context.scope,
        accountId: context.accountId,
        subscriberId: context.subscriberId,
        eventType: context.eventType,
        notificationId: context.notificationId,
      },
    });
    const attempt = { ...candidate, attempt: resolvedAttempt };
    const url = sanitizeReportingWebhookActivityUrl(attempt.url);
    boundedInteger(attempt.payload_size_bytes, 'payload_size_bytes', 0, 1_073_741_824);
    boundedString(attempt.idempotency_key, 'idempotency_key', 255);
    const immutable = {
      accountId: context.accountId,
      subscriberId: context.subscriberId,
      idempotencyKey: attempt.idempotency_key,
      attempt: attempt.attempt,
      notificationId: context.notificationId,
      notificationType: context.eventType,
      url,
      payloadSizeBytes: attempt.payload_size_bytes,
    };
    const fingerprint = canonicalJsonSha256(immutable);
    const result = await query<{ immutable_sha256: string }>(
      'reserve attempt',
      `INSERT INTO ${table}
         (namespace, tenant_key, principal_key, account_id, subscriber_id,
          idempotency_key, attempt, notification_id, notification_type,
          immutable_sha256, url, payload_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, attempt)
       DO UPDATE SET immutable_sha256 = ${table}.immutable_sha256
       RETURNING immutable_sha256`,
      [
        namespace,
        scopeDigest(context.scope.tenantId),
        scopeDigest(context.scope.principalId),
        context.accountId,
        context.subscriberId,
        attempt.idempotency_key,
        attempt.attempt,
        context.notificationId,
        context.eventType,
        fingerprint,
        url,
        attempt.payload_size_bytes,
      ]
    );
    if (result.rows[0]?.immutable_sha256 !== fingerprint) {
      throw new ReportingWebhookActivityConflictError('Webhook attempt identity is already bound to different facts');
    }
    return resolvedAttempt;
  };

  const onAttemptResult = async (result: WebhookEmitAttemptResult): Promise<void> => {
    const context = parseEmitterContext(result.attemptAuthorizationContext);
    if (!context || !REPORTING_EVENTS.has(context.eventType)) return;
    const outcome = activityOutcome(result);
    const completion = await query(
      'complete attempt',
      `UPDATE ${table} SET
         completed_at = clock_timestamp(), status = $8, http_status_code = $9,
         response_time_ms = $10, error_message = $11
       WHERE namespace = $1 AND tenant_key = $2 AND principal_key = $3
         AND account_id = $4 AND subscriber_id = $5 AND idempotency_key = $6 AND attempt = $7
         AND status = 'pending'`,
      [
        namespace,
        scopeDigest(context.scope.tenantId),
        scopeDigest(context.scope.principalId),
        context.accountId,
        context.subscriberId,
        result.idempotency_key,
        result.attempt,
        outcome.status,
        outcome.httpStatusCode,
        outcome.responseTimeMs,
        outcome.errorMessage,
      ]
    );
    if (completion.rowCount === 0) {
      const existing = await query<{ status: string }>(
        'verify completed attempt',
        `SELECT status FROM ${table}
          WHERE namespace = $1 AND tenant_key = $2 AND principal_key = $3
            AND account_id = $4 AND subscriber_id = $5 AND idempotency_key = $6 AND attempt = $7`,
        [
          namespace,
          scopeDigest(context.scope.tenantId),
          scopeDigest(context.scope.principalId),
          context.accountId,
          context.subscriberId,
          result.idempotency_key,
          result.attempt,
        ]
      );
      if (!existing.rows[0] || existing.rows[0].status === 'pending') {
        throw new Error('Webhook attempt result has no matching durable reservation');
      }
    }
  };

  async function query<Row extends Record<string, unknown> = Record<string, unknown>>(
    operation: string,
    text: string,
    values?: unknown[]
  ) {
    try {
      return await options.db.query<Row>(text, values);
    } catch (cause) {
      throw new Error(`PostgreSQL reporting webhook activity ${operation} failed`, { cause });
    }
  }

  const migration = getReportingWebhookActivityMigration({ tableName: rawTable });
  return {
    checkpointDeliveryAttempt,
    emitterObservers: { onAttemptResult },
    migrations: { activity: migration, all: [migration] },
    async probe() {
      await query('metadata probe', `SELECT migration_key, completed_at FROM ${metadata} LIMIT 0`);
      await query(
        'ordinal probe',
        `SELECT namespace, tenant_key, principal_key, account_id, subscriber_id, idempotency_key, next_attempt
           FROM ${ordinals} LIMIT 0`
      );
      await query(
        'probe',
        `SELECT namespace, tenant_key, principal_key, account_id, subscriber_id,
                idempotency_key, attempt, notification_id, notification_type,
                fired_at, completed_at, status, url, http_status_code,
                response_time_ms, payload_size_bytes, error_message
           FROM ${table} LIMIT 0`
      );
    },
    async listActivity(input) {
      const scope = validatedScope(input);
      const limit = input.limit ?? 50;
      boundedInteger(limit, 'limit', 1, 200);
      const result = await query<ActivityRow>(
        'list attempts',
        `SELECT idempotency_key, notification_id, subscriber_id, notification_type,
                fired_at, completed_at, status, url, http_status_code,
                response_time_ms, payload_size_bytes, error_message, attempt
           FROM ${table}
          WHERE namespace = $1 AND tenant_key = $2 AND principal_key = $3 AND account_id = $4
            AND (completed_at IS NULL OR completed_at >= clock_timestamp() - ($6::integer * INTERVAL '1 day'))
          ORDER BY fired_at DESC, attempt DESC, idempotency_key DESC
          LIMIT $5`,
        [namespace, scopeDigest(scope.tenantId), scopeDigest(scope.principalId), scope.accountId, limit, retentionDays]
      );
      return result.rows.map(activityRecord);
    },
    async listActivityBatch(input) {
      boundedString(input.tenantId, 'tenantId', 512);
      boundedString(input.principalId, 'principalId', 512);
      const limit = input.limit ?? 50;
      boundedInteger(limit, 'limit', 1, 200);
      if (!Array.isArray(input.accountIds) || input.accountIds.length > 10_000) {
        throw new TypeError('accountIds must be an array of at most 10000 account IDs');
      }
      const accountIds = [...new Set(input.accountIds)];
      for (const accountId of accountIds) boundedString(accountId, 'accountId', 512);
      if (accountIds.length * limit > 100_000) {
        throw new RangeError('accountIds multiplied by limit must not exceed 100000 activity records');
      }
      const byAccount = new Map<string, WebhookActivityRecord[]>(accountIds.map(accountId => [accountId, []]));
      if (accountIds.length === 0) return byAccount;
      const result = await query<ActivityRow & { account_id: string }>(
        'list attempts batch',
        `SELECT requested.account_id, recent.idempotency_key, recent.notification_id,
                recent.subscriber_id, recent.notification_type, recent.fired_at,
                recent.completed_at, recent.status, recent.url, recent.http_status_code,
                recent.response_time_ms, recent.payload_size_bytes, recent.error_message, recent.attempt
           FROM unnest($4::text[]) AS requested(account_id)
           CROSS JOIN LATERAL (
             SELECT idempotency_key, notification_id, subscriber_id, notification_type,
                    fired_at, completed_at, status, url, http_status_code,
                    response_time_ms, payload_size_bytes, error_message, attempt
               FROM ${table}
              WHERE namespace = $1 AND tenant_key = $2 AND principal_key = $3
                AND account_id = requested.account_id
                AND (completed_at IS NULL OR completed_at >= clock_timestamp() - ($6::integer * INTERVAL '1 day'))
              ORDER BY fired_at DESC, attempt DESC, idempotency_key DESC
              LIMIT $5
           ) recent
          ORDER BY requested.account_id, recent.fired_at DESC, recent.attempt DESC, recent.idempotency_key DESC`,
        [namespace, scopeDigest(input.tenantId), scopeDigest(input.principalId), accountIds, limit, retentionDays]
      );
      for (const row of result.rows) byAccount.get(row.account_id)?.push(activityRecord(row));
      return byAccount;
    },
    async pruneCompleted(pruneOptions = {}) {
      const limit = pruneOptions.limit ?? 1_000;
      boundedInteger(limit, 'limit', 1, 10_000);
      // A process can die after the pre-POST reservation and before the result
      // observer. Preserve the truthful `pending` record for the full retention
      // window, then prune it instead of inventing a timeout outcome.
      const orphaned = await query(
        'prune orphaned attempts',
        `WITH expired AS (
           SELECT ctid FROM ${table}
            WHERE namespace = $1 AND completed_at IS NULL
              AND fired_at < clock_timestamp() - ($2::integer * INTERVAL '1 day')
            ORDER BY fired_at FOR UPDATE SKIP LOCKED LIMIT $3
         )
         DELETE FROM ${table} target USING expired WHERE target.ctid = expired.ctid`,
        [namespace, retentionDays, limit]
      );
      const result = await query(
        'prune attempts',
        `WITH expired AS (
           SELECT ctid FROM ${table}
            WHERE namespace = $1
              AND completed_at < clock_timestamp() - ($2::integer * INTERVAL '1 day')
            ORDER BY completed_at FOR UPDATE SKIP LOCKED LIMIT $3
         )
         DELETE FROM ${table} target USING expired WHERE target.ctid = expired.ctid`,
        [namespace, retentionDays, limit]
      );
      const remaining = Math.max(0, limit - (orphaned.rowCount ?? 0) - (result.rowCount ?? 0));
      let prunedOrdinals = 0;
      if (remaining > 0) {
        const ordinalResult = await query(
          'prune attempt ordinals',
          `WITH expired AS (
             SELECT ordinal.ctid FROM ${ordinals} ordinal
              WHERE ordinal.namespace = $1
                AND ordinal.changed_at < clock_timestamp() - ($2::integer * INTERVAL '1 day')
                AND NOT EXISTS (
                  SELECT 1 FROM ${table} activity
                   WHERE activity.namespace = ordinal.namespace
                     AND activity.tenant_key = ordinal.tenant_key
                     AND activity.principal_key = ordinal.principal_key
                     AND activity.account_id = ordinal.account_id
                     AND activity.subscriber_id = ordinal.subscriber_id
                     AND activity.idempotency_key = ordinal.idempotency_key
                )
              ORDER BY ordinal.changed_at FOR UPDATE SKIP LOCKED LIMIT $3
           )
           DELETE FROM ${ordinals} target USING expired WHERE target.ctid = expired.ctid`,
          [namespace, retentionDays, remaining]
        );
        prunedOrdinals = ordinalResult.rowCount ?? 0;
      }
      return (orphaned.rowCount ?? 0) + (result.rowCount ?? 0) + prunedOrdinals;
    },
  };
}

export function composeNotificationDeliveryAttemptCheckpoints(
  ...checkpoints: readonly NotificationDeliveryAttemptCheckpoint[]
): NotificationDeliveryAttemptCheckpoint {
  if (checkpoints.length === 0) throw new TypeError('At least one notification attempt checkpoint is required');
  return async input => {
    let attemptOrdinal: number | undefined;
    for (const checkpoint of checkpoints) {
      const candidate = await checkpoint(input);
      if (candidate === undefined) continue;
      boundedInteger(candidate, 'checkpoint attempt ordinal', 1, 1_000_000);
      if (attemptOrdinal !== undefined && attemptOrdinal !== candidate) {
        throw new Error('Notification attempt checkpoints returned conflicting durable ordinals');
      }
      attemptOrdinal = candidate;
    }
    return attemptOrdinal;
  };
}

/** Compose attempt-result observers without silently replacing an adopter hook. */
export function composeWebhookAttemptResultObservers(
  ...observers: ReadonlyArray<WebhookEmitterOptions['onAttemptResult'] | undefined>
): NonNullable<WebhookEmitterOptions['onAttemptResult']> {
  return async result => {
    const failures: unknown[] = [];
    for (const observer of observers) {
      if (!observer) continue;
      try {
        await observer(result);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Webhook attempt-result observers failed');
  };
}

/**
 * Decorate only accounts the authoritative list handler already returned.
 * Adopter-supplied activity is always stripped first so unsupported or
 * unrequested diagnostics can never leak through a permissive response shape.
 */
export async function projectListAccountsReportingWebhookActivityV1<
  TResponse extends { accounts?: readonly unknown[] },
>(options: ProjectListAccountsReportingWebhookActivityOptionsV1<TResponse>): Promise<TResponse> {
  boundedString(options.tenantId, 'tenantId', 512);
  boundedString(options.principalId, 'principalId', 512);
  if (!Array.isArray(options.response.accounts)) return options.response;
  const include = options.request.include_webhook_activity === true;
  const limit = options.request.webhook_activity_limit ?? 50;
  if (include) boundedInteger(limit, 'webhook_activity_limit', 1, 200);
  const maxConcurrency = options.maxConcurrency ?? 8;
  boundedInteger(maxConcurrency, 'maxConcurrency', 1, 64);
  const accounts = options.response.accounts.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { webhook_activity: _untrustedActivity, ...account } = value as Record<string, unknown>;
    return account;
  });
  if (include) {
    const identified = accounts.flatMap(account => {
      if (!account || typeof account !== 'object' || Array.isArray(account)) return [];
      const accountId = (account as Record<string, unknown>).account_id;
      return typeof accountId === 'string' && accountId.length > 0 ? [{ account, accountId }] : [];
    });
    if (options.activity.listActivityBatch) {
      const activity = new Map<string, WebhookActivityRecord[]>();
      const maxBatchAccounts = Math.min(10_000, Math.max(1, Math.floor(100_000 / limit)));
      for (let offset = 0; offset < identified.length; offset += maxBatchAccounts) {
        const batch = await options.activity.listActivityBatch({
          tenantId: options.tenantId,
          principalId: options.principalId,
          accountIds: identified.slice(offset, offset + maxBatchAccounts).map(value => value.accountId),
          limit,
        });
        for (const [accountId, records] of batch) activity.set(accountId, records);
      }
      for (const { account, accountId } of identified) {
        (account as Record<string, unknown>).webhook_activity = activity.get(accountId) ?? [];
      }
    } else {
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(maxConcurrency, identified.length) }, async () => {
          while (true) {
            const item = identified[next++];
            if (!item) return;
            (item.account as Record<string, unknown>).webhook_activity = await options.activity.listActivity({
              tenantId: options.tenantId,
              principalId: options.principalId,
              accountId: item.accountId,
              limit,
            });
          }
        })
      );
    }
  }
  return { ...options.response, accounts } as TResponse;
}

export function sanitizeReportingWebhookActivityUrl(value: string): string {
  boundedString(value, 'webhook URL', 8_192);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Webhook activity URL is invalid');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw new TypeError('Webhook activity URL is invalid');
  }
  const path = parsed.pathname
    .split('/')
    .map(segment => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return 'redacted';
      }
      return PUBLIC_PATH_SEGMENTS.has(decoded) || /^v[0-9]{1,3}$/.test(decoded) ? decoded : 'redacted';
    })
    .join('/');
  return `${parsed.protocol}//${parsed.host}${path || '/'}`;
}

interface ActivityContext {
  scope: NotificationSubscriptionScope;
  accountId: string;
  subscriberId: string;
  eventType: string;
  notificationId: string;
}

interface ActivityRow extends Record<string, unknown> {
  idempotency_key: string;
  notification_id: string;
  subscriber_id: string;
  notification_type: string;
  fired_at: Date | string;
  completed_at: Date | string | null;
  status: WebhookActivityRecord['status'];
  url: string;
  http_status_code: number | null;
  response_time_ms: number | null;
  payload_size_bytes: number;
  error_message: string | null;
  attempt: number;
}

function activityRecord(row: ActivityRow): WebhookActivityRecord {
  return {
    idempotency_key: row.idempotency_key,
    notification_id: row.notification_id,
    subscriber_id: row.subscriber_id,
    fired_at: asIso(row.fired_at),
    completed_at: row.completed_at ? asIso(row.completed_at) : null,
    notification_type: row.notification_type as WebhookActivityRecord['notification_type'],
    attempt: row.attempt,
    status: row.status,
    url: row.url,
    http_status_code: row.http_status_code,
    response_time_ms: row.response_time_ms,
    payload_size_bytes: row.payload_size_bytes,
    error_message: row.error_message,
  };
}

function attemptContext(input: Readonly<NotificationDeliveryAttemptCheckpointInput>): ActivityContext {
  const context = {
    scope: input.scope,
    accountId: input.accountId,
    subscriberId: input.subscriberId,
    eventType: input.eventType,
    notificationId: input.notificationId,
  };
  return validateContext(context);
}

function parseEmitterContext(value: unknown): ActivityContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== 'adcp_notification_subscription' || input.version !== 1) return null;
  try {
    return validateContext({
      scope: input.scope,
      accountId: input.accountId,
      subscriberId: input.subscriberId,
      eventType: input.eventType,
      notificationId: input.notificationId,
    });
  } catch {
    return null;
  }
}

function validateContext(value: {
  scope: unknown;
  accountId: unknown;
  subscriberId: unknown;
  eventType: unknown;
  notificationId: unknown;
}): ActivityContext {
  if (!value.scope || typeof value.scope !== 'object' || Array.isArray(value.scope)) {
    throw new TypeError('Webhook activity scope is invalid');
  }
  const scope = value.scope as Partial<NotificationSubscriptionScope>;
  if (scope.kind !== 'account' && scope.kind !== 'caller') throw new TypeError('Webhook activity scope is invalid');
  boundedString(scope.tenantId, 'tenantId', 512);
  boundedString(scope.principalId, 'principalId', 512);
  boundedString(value.accountId, 'accountId', 512);
  boundedString(value.subscriberId, 'subscriberId', 64);
  boundedString(value.eventType, 'eventType', 128);
  boundedString(value.notificationId, 'notificationId', 255);
  if (scope.kind === 'account' && scope.accountId !== value.accountId) {
    throw new TypeError('Webhook activity account scope is invalid');
  }
  return {
    scope: structuredClone(scope) as NotificationSubscriptionScope,
    accountId: value.accountId,
    subscriberId: value.subscriberId,
    eventType: value.eventType,
    notificationId: value.notificationId,
  };
}

function activityOutcome(result: WebhookEmitAttemptResult): {
  status: Exclude<WebhookActivityRecord['status'], 'pending'>;
  httpStatusCode: number | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
} {
  if (result.status !== undefined) {
    const success = result.status >= 200 && result.status < 300;
    return {
      status: success ? 'success' : 'failed',
      httpStatusCode: result.status,
      responseTimeMs: Math.max(0, Math.floor(result.durationMs)),
      errorMessage: success ? null : 'HTTP non-success response',
    };
  }
  const timeout = /timed?\s*out|timeout|abort/i.test(result.error ?? '');
  return {
    status: timeout ? 'timeout' : 'connection_error',
    httpStatusCode: null,
    responseTimeMs: null,
    errorMessage: timeout ? 'HTTP attempt timed out' : 'Connection failed',
  };
}

function validatedScope(input: ReportingWebhookActivityScopeV1): ReportingWebhookActivityScopeV1 {
  boundedString(input.tenantId, 'tenantId', 512);
  boundedString(input.principalId, 'principalId', 512);
  boundedString(input.accountId, 'accountId', 512);
  return input;
}

function scopeDigest(value: string): string {
  return canonicalJsonSha256({ scope: value });
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Webhook activity timestamp is invalid');
  return date.toISOString();
}

function tableName(value: string | undefined): string {
  const name = value ?? DEFAULT_TABLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(name) || Buffer.byteLength(name) > 48) {
    throw new TypeError('tableName must be a lowercase PostgreSQL identifier of at most 48 bytes');
  }
  return name;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value) || Buffer.byteLength(value) > 63) {
    throw new TypeError('Webhook activity PostgreSQL identifier is invalid');
  }
  return `"${value}"`;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
}

function boundedString(value: unknown, name: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
    throw new TypeError(`${name} must be a non-empty UTF-8 string of at most ${maxBytes} bytes without NUL`);
  }
}
