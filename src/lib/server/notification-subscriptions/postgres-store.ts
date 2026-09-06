import { canonicalJsonSha256 } from '../../utils/jcs';
import type { PgQueryable } from '../postgres-task-store';
import type {
  NotificationSubscriptionMatch,
  NotificationSubscriptionScope,
  NotificationSubscriptionSet,
  NotificationSubscriptionStore,
  NotificationSubscriptionStoreReplaceResult,
  StoredNotificationSubscription,
} from './types';

const DEFAULT_TABLE = 'adcp_notification_subscriptions';
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface PostgresNotificationSubscriptionStoreOptions {
  tableName?: string;
  /** Assert that the database/schema is dedicated to this deployment. */
  acknowledgeIsolatedDatabase?: boolean;
}

function quoteTable(raw: string): string {
  if (!VALID_IDENTIFIER.test(raw) || Buffer.byteLength(raw, 'utf8') > 42) {
    throw new Error(`Invalid notification subscription table name ${JSON.stringify(raw)}`);
  }
  return `"${raw}"`;
}

export function getNotificationSubscriptionMigration(
  options: PostgresNotificationSubscriptionStoreOptions = {}
): string {
  const raw = options.tableName ?? DEFAULT_TABLE;
  const table = quoteTable(raw);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  tenant_scope        TEXT NOT NULL,
  principal_id       TEXT NOT NULL,
  anchor_kind        TEXT NOT NULL CHECK (anchor_kind IN ('caller','account')),
  account_id         TEXT NOT NULL DEFAULT '',
  generation         TEXT NOT NULL,
  subscriptions      JSONB NOT NULL,
  content_fingerprint TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_scope, principal_id, anchor_kind, account_id),
  CONSTRAINT ${raw}_account_anchor CHECK (
    (anchor_kind = 'caller' AND account_id = '') OR
    (anchor_kind = 'account' AND account_id <> '')
  ),
  CONSTRAINT ${raw}_subscriptions_array CHECK (jsonb_typeof(subscriptions) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_${raw}_account_fanout
  ON ${table}(tenant_scope, account_id, principal_id) WHERE anchor_kind = 'account';
CREATE INDEX IF NOT EXISTS idx_${raw}_caller_fanout
  ON ${table}(tenant_scope, principal_id) WHERE anchor_kind = 'caller';
`.trim();
}

export const NOTIFICATION_SUBSCRIPTION_MIGRATION = getNotificationSubscriptionMigration();

export function pgNotificationSubscriptionStore(
  db: PgQueryable,
  options: PostgresNotificationSubscriptionStoreOptions = {}
): NotificationSubscriptionStore {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const table = quoteTable(tableName);
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!development && tableName === DEFAULT_TABLE && !options.acknowledgeIsolatedDatabase) {
    throw new Error(
      'pgNotificationSubscriptionStore: production requires a deployment-unique tableName or acknowledgeIsolatedDatabase: true'
    );
  }

  async function query(operation: string, text: string, values?: unknown[]) {
    try {
      return await db.query(text, values);
    } catch (cause) {
      throw new Error(`pgNotificationSubscriptionStore.${operation}: database operation failed`, { cause });
    }
  }

  return {
    durability: 'durable',
    async probe() {
      try {
        await db.query(
          `SELECT tenant_scope, principal_id, anchor_kind, account_id, generation,
                  subscriptions, content_fingerprint FROM ${table} LIMIT 0`
        );
      } catch (cause) {
        throw new Error(
          `Notification subscription store probe failed: run getNotificationSubscriptionMigration() for "${tableName}" before serving`,
          { cause }
        );
      }
    },
    async get(scope) {
      const key = scopeValues(scope);
      const result = await query(
        'get',
        `SELECT tenant_scope, principal_id, anchor_kind, account_id, generation,
                subscriptions, content_fingerprint
         FROM ${table}
         WHERE tenant_scope=$1 AND principal_id=$2 AND anchor_kind=$3 AND account_id=$4`,
        key
      );
      return result.rows[0] ? rowToSet(result.rows[0]) : null;
    },
    async replace(args): Promise<NotificationSubscriptionStoreReplaceResult> {
      const key = scopeValues(args.scope);
      const subscriptions = structuredClone(args.subscriptions);
      const contentFingerprint = canonicalJsonSha256(subscriptions);
      const result = await query(
        'replace',
        `INSERT INTO ${table} (
           tenant_scope, principal_id, anchor_kind, account_id,
           generation, subscriptions, content_fingerprint
         )
         SELECT $1, $2, $3, $4, $5, $6::jsonb, $7
         WHERE $8::text IS NULL OR EXISTS (
           SELECT 1 FROM ${table}
           WHERE tenant_scope=$1 AND principal_id=$2 AND anchor_kind=$3 AND account_id=$4
             AND generation=$8
         )
         ON CONFLICT (tenant_scope, principal_id, anchor_kind, account_id) DO UPDATE SET
           generation = CASE
             WHEN ${table}.content_fingerprint = EXCLUDED.content_fingerprint THEN ${table}.generation
             ELSE EXCLUDED.generation
           END,
           subscriptions = CASE
             WHEN ${table}.content_fingerprint = EXCLUDED.content_fingerprint THEN ${table}.subscriptions
             ELSE EXCLUDED.subscriptions
           END,
           content_fingerprint = EXCLUDED.content_fingerprint,
           updated_at = CASE
             WHEN ${table}.content_fingerprint = EXCLUDED.content_fingerprint THEN ${table}.updated_at
             ELSE clock_timestamp()
           END
         WHERE $8::text IS NOT NULL AND ${table}.generation=$8
         RETURNING tenant_scope, principal_id, anchor_kind, account_id, generation,
                   subscriptions, content_fingerprint`,
        [...key, args.nextGeneration, JSON.stringify(subscriptions), contentFingerprint, args.expectedGeneration]
      );
      const row = result.rows[0];
      if (!row) {
        const current = await this.get(args.scope);
        return {
          outcome: 'conflict',
          ...(current && { currentGeneration: current.generation }),
        };
      }
      const set = rowToSet(row);
      return {
        outcome: set.generation === args.nextGeneration ? 'applied' : 'unchanged',
        set,
      };
    },
    async findCandidates(match, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
        throw new TypeError('notification subscription candidate limit must be 1 through 10000');
      }
      const values: unknown[] = [match.tenantId, match.eventType, limit + 1, match.futureCallerInvalidation === true];
      let scopePredicate: string;
      if (match.anchor === 'caller') {
        scopePredicate = `anchor_kind='caller'`;
      } else {
        if (!match.accountId) throw new TypeError('accountId is required for account notification matching');
        values.push(match.accountId);
        scopePredicate = `(anchor_kind='caller' OR (anchor_kind='account' AND account_id=$${values.length}))`;
      }
      if (match.principalId !== undefined) {
        values.push(match.principalId);
        scopePredicate += ` AND principal_id=$${values.length}`;
      }
      const result = await query(
        'findCandidates',
        `SELECT tenant_scope, principal_id, anchor_kind, account_id, generation,
                subscriptions, content_fingerprint
         FROM ${table}
         WHERE tenant_scope=$1 AND ${scopePredicate}
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(subscriptions) AS subscription
             WHERE subscription->>'active' = 'true'
               AND subscription->>'proofGeneration' = subscription->>'destinationGeneration'
               AND (
                 subscription->'eventTypes' ? $2
                 OR ($4::boolean AND subscription->>'includeFutureEventTypes' = 'true')
               )
           )
         ORDER BY principal_id, anchor_kind, account_id
         LIMIT $3`,
        values
      );
      return result.rows.map(rowToSet);
    },
  };
}

function scopeValues(scope: Readonly<NotificationSubscriptionScope>): [string, string, 'caller' | 'account', string] {
  return [scope.tenantId, scope.principalId, scope.kind, scope.kind === 'account' ? scope.accountId : ''];
}

function rowToSet(row: Record<string, unknown>): NotificationSubscriptionSet {
  if (row.anchor_kind !== 'caller' && row.anchor_kind !== 'account') {
    throw new Error('pgNotificationSubscriptionStore: corrupt anchor kind');
  }
  if (!Array.isArray(row.subscriptions)) {
    throw new Error('pgNotificationSubscriptionStore: corrupt subscriptions document');
  }
  const subscriptions = row.subscriptions as StoredNotificationSubscription[];
  const fingerprint = canonicalJsonSha256(subscriptions);
  if (typeof row.content_fingerprint !== 'string' || fingerprint !== row.content_fingerprint) {
    throw new Error('pgNotificationSubscriptionStore: subscription fingerprint mismatch');
  }
  const scope: NotificationSubscriptionScope =
    row.anchor_kind === 'account'
      ? {
          kind: 'account',
          tenantId: String(row.tenant_scope),
          principalId: String(row.principal_id),
          accountId: String(row.account_id),
        }
      : {
          kind: 'caller',
          tenantId: String(row.tenant_scope),
          principalId: String(row.principal_id),
        };
  return {
    scope,
    generation: String(row.generation),
    subscriptions: structuredClone(subscriptions),
  };
}
