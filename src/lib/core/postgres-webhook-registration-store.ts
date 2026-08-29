/**
 * PostgreSQL-backed webhook registration provenance for multi-replica clients.
 *
 * The store deliberately accepts the structural `PgQueryable` interface rather
 * than depending on `pg`, so pools, clients, and transaction wrappers can all
 * be supplied by adopters without adding a runtime dependency to the SDK.
 */

import { ConfigurationError } from '../errors';
import type { PgQueryable } from '../server/postgres-task-store';
import {
  parseWebhookRegistration,
  sameWebhookRegistration,
  validateWebhookRegistrationKey,
  webhookRegistrationFingerprint,
  WebhookRegistrationIntegrityError,
  type WebhookRegistration,
  type WebhookRegistrationStore,
} from './webhook-registration';

const DEFAULT_TABLE = 'adcp_webhook_registrations';
const VALID_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// Keeps every table-derived PostgreSQL constraint/index identifier below the
// server's 63-byte identifier limit.
const MAX_TABLE_NAME_LENGTH = 40;

export interface PgWebhookRegistrationStoreOptions {
  /** Defaults to `adcp_webhook_registrations`. */
  tableName?: string;
  /** Assert that the database/schema is dedicated to this deployment. */
  acknowledgeIsolatedDatabase?: boolean;
}

export interface CleanupExpiredWebhookRegistrationsOptions extends PgWebhookRegistrationStoreOptions {
  /** Limit work per call. When omitted, all expired registrations are deleted. */
  batchSize?: number;
}

function quoteTableName(tableName: string): string {
  if (!VALID_IDENTIFIER.test(tableName) || tableName.length > MAX_TABLE_NAME_LENGTH) {
    throw new Error(
      `Invalid webhook registration table name: must match ${VALID_IDENTIFIER} and be at most ${MAX_TABLE_NAME_LENGTH} characters.`
    );
  }
  return `"${tableName}"`;
}

function assertDeploymentNamespace(
  api: string,
  tableName: string,
  options: Pick<PgWebhookRegistrationStoreOptions, 'acknowledgeIsolatedDatabase'>
): void {
  const development = process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development';
  if (!development && tableName === DEFAULT_TABLE && !options.acknowledgeIsolatedDatabase) {
    throw new Error(`${api}: production requires a deployment-unique tableName or acknowledgeIsolatedDatabase: true`);
  }
}

function databaseOperationError(operation: string, cause: unknown): Error {
  return new Error(`pgWebhookRegistrationStore.${operation}: database operation failed`, { cause });
}

/**
 * Render the idempotent migration for a durable webhook-registration table.
 * Run this before constructing the store, and rerun it on every deployment so
 * a future additive migration can upgrade existing installations.
 */
export function getWebhookRegistrationMigration(options: PgWebhookRegistrationStoreOptions = {}): string {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const table = quoteTableName(tableName);
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  agent_id                         TEXT NOT NULL,
  operation_id                     TEXT NOT NULL,
  agent_url                        TEXT NOT NULL,
  protocol                         TEXT NOT NULL,
  task_type                        TEXT NOT NULL,
  callback_url                     TEXT NOT NULL,
  method                           TEXT NOT NULL,
  mode                             TEXT NOT NULL,
  authorization_context_version    SMALLINT,
  delegated_operator_authorization JSONB,
  preview_mode                     TEXT,
  requires_durable_settlement      BOOLEAN,
  created_at                       TIMESTAMPTZ NOT NULL,
  expires_at                       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (agent_id, operation_id),
  CONSTRAINT ${tableName}_valid_protocol CHECK (protocol IN ('mcp', 'a2a')),
  CONSTRAINT ${tableName}_valid_method CHECK (method = 'POST'),
  CONSTRAINT ${tableName}_valid_mode CHECK (mode IN ('hmac-sha256', 'rfc9421')),
  CONSTRAINT ${tableName}_valid_preview CHECK (preview_mode IS NULL OR preview_mode IN ('canonical', 'legacy')),
  CONSTRAINT ${tableName}_valid_auth_version CHECK (
    authorization_context_version IS NULL OR authorization_context_version = 1
  ),
  CONSTRAINT ${tableName}_valid_auth_context CHECK (
    delegated_operator_authorization IS NULL OR
    ((authorization_context_version = 1) IS TRUE AND jsonb_typeof(delegated_operator_authorization) = 'object')
  ),
  CONSTRAINT ${tableName}_valid_expiry CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_${tableName}_expires_at
  ON ${table}(expires_at);
`.trim();
}

/** Pre-rendered migration for the default table name. */
export const WEBHOOK_REGISTRATION_MIGRATION = getWebhookRegistrationMigration();

const RETURNING_REGISTRATION = `
  agent_id,
  operation_id,
  agent_url,
  protocol,
  task_type,
  callback_url,
  method,
  mode,
  authorization_context_version,
  delegated_operator_authorization,
  preview_mode,
  requires_durable_settlement,
  FLOOR(EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_at_ms,
  FLOOR(EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms
`;

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
  return value;
}

function epochMillis(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
  }
  return parsed;
}

function registrationFromRow(
  row: Record<string, unknown>,
  expectedKey: Readonly<{ agentId: string; operationId: string }>
): Readonly<WebhookRegistration> {
  try {
    const authorizationContextVersion = row.authorization_context_version;
    if (authorizationContextVersion !== null && authorizationContextVersion !== 1) {
      throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
    }
    const delegatedOperatorAuthorization = row.delegated_operator_authorization;
    if (
      delegatedOperatorAuthorization !== null &&
      (typeof delegatedOperatorAuthorization !== 'object' || Array.isArray(delegatedOperatorAuthorization))
    ) {
      throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
    }
    const requiresDurableSettlement = row.requires_durable_settlement;
    if (requiresDurableSettlement !== null && typeof requiresDurableSettlement !== 'boolean') {
      throw new TypeError('PostgreSQL returned an invalid webhook registration row.');
    }
    const previewMode = optionalString(row, 'preview_mode');

    return parseWebhookRegistration(
      {
        agentId: requiredString(row, 'agent_id'),
        operationId: requiredString(row, 'operation_id'),
        agentUrl: requiredString(row, 'agent_url'),
        protocol: requiredString(row, 'protocol'),
        taskType: requiredString(row, 'task_type'),
        callbackUrl: requiredString(row, 'callback_url'),
        method: requiredString(row, 'method'),
        mode: requiredString(row, 'mode'),
        ...(authorizationContextVersion === 1 && { authorizationContextVersion }),
        ...(delegatedOperatorAuthorization !== null && { delegatedOperatorAuthorization }),
        ...(previewMode !== undefined && { previewMode }),
        ...(requiresDurableSettlement !== null && { requiresDurableSettlement }),
        createdAt: epochMillis(row, 'created_at_ms'),
        expiresAt: epochMillis(row, 'expires_at_ms'),
      },
      expectedKey
    );
  } catch (cause) {
    // Never attach or interpolate the corrupt persisted row: it contains seller
    // and callback URLs that must not escape through public diagnostics. Parser
    // causes contain field labels only, so operators retain safe diagnostics.
    throw new WebhookRegistrationIntegrityError(
      'pgWebhookRegistrationStore: database returned invalid webhook registration state',
      { cause }
    );
  }
}

/** PostgreSQL implementation of trusted outbound webhook provenance. */
export function pgWebhookRegistrationStore(
  db: PgQueryable,
  options: PgWebhookRegistrationStoreOptions = {}
): WebhookRegistrationStore & { probe(): Promise<void> } {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const table = quoteTableName(tableName);
  assertDeploymentNamespace('pgWebhookRegistrationStore', tableName, options);

  async function query(operation: string, text: string, values?: unknown[]) {
    try {
      return await db.query(text, values);
    } catch (cause) {
      throw databaseOperationError(operation, cause);
    }
  }

  return {
    async probe(): Promise<void> {
      try {
        await db.query(`SELECT ${RETURNING_REGISTRATION} FROM ${table} LIMIT 0`);
      } catch (cause) {
        throw new Error(
          `webhook registration store probe failed: cannot use the "${tableName}" table. Run getWebhookRegistrationMigration() before serving.`,
          { cause }
        );
      }
    },

    async putIfAbsent(registration: WebhookRegistration): Promise<void> {
      // Parsing clones and freezes the caller-owned object before the first
      // await, preventing later mutation from changing the claimed provenance.
      const proposed = parseWebhookRegistration(registration);
      const proposedFingerprint = webhookRegistrationFingerprint(proposed);
      const delegatedAuthorization = proposed.delegatedOperatorAuthorization;

      // One backend clock and one upsert form the transaction boundary. The
      // conflict update locks the existing row. Expired rows are replaced in
      // full; live rows take a no-op update and are returned for exact comparison.
      const result = await query(
        'putIfAbsent',
        `WITH key_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended(json_build_array($1::text, $2::text)::text, 0)
           )
         ), backend_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
           FROM key_lock
         )
         INSERT INTO ${table} AS existing (
           agent_id, operation_id, agent_url, protocol, task_type, callback_url,
           method, mode, authorization_context_version, delegated_operator_authorization,
           preview_mode, requires_durable_settlement, created_at, expires_at
         )
         SELECT
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
           to_timestamp($13::double precision / 1000.0),
           to_timestamp($14::double precision / 1000.0)
         FROM backend_clock
         WHERE to_timestamp($14::double precision / 1000.0) > backend_clock.now
         ON CONFLICT (agent_id, operation_id) DO UPDATE SET (
           agent_url, protocol, task_type, callback_url, method, mode,
           authorization_context_version, delegated_operator_authorization,
           preview_mode, requires_durable_settlement, created_at, expires_at
         ) = (
           SELECT
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.agent_url
               ELSE existing.agent_url END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.protocol
               ELSE existing.protocol END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.task_type
               ELSE existing.task_type END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.callback_url
               ELSE existing.callback_url END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.method
               ELSE existing.method END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.mode
               ELSE existing.mode END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.authorization_context_version
               ELSE existing.authorization_context_version END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.delegated_operator_authorization
               ELSE existing.delegated_operator_authorization END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.preview_mode
               ELSE existing.preview_mode END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.requires_durable_settlement
               ELSE existing.requires_durable_settlement END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.created_at
               ELSE existing.created_at END,
             CASE WHEN existing.expires_at <= backend_clock.now THEN EXCLUDED.expires_at
               ELSE existing.expires_at END
           FROM backend_clock
         )
         RETURNING ${RETURNING_REGISTRATION},
                   (expires_at > (SELECT now FROM backend_clock)) AS registration_live`,
        [
          proposed.agentId,
          proposed.operationId,
          proposed.agentUrl,
          proposed.protocol,
          proposed.taskType,
          proposed.callbackUrl,
          proposed.method,
          proposed.mode,
          proposed.authorizationContextVersion ?? null,
          delegatedAuthorization === undefined ? null : JSON.stringify(delegatedAuthorization),
          proposed.previewMode ?? null,
          proposed.requiresDurableSettlement ?? null,
          proposed.createdAt,
          proposed.expiresAt,
        ]
      );
      const row = result.rows[0];
      // The INSERT source is empty for an already-expired proposal, so no row
      // is created and the operation fails atomically.
      if (!row) throw new ConfigurationError('Cannot persist an expired webhook registration.', 'expiresAt');
      if (row.registration_live !== true) {
        if (row.registration_live !== false) {
          throw new WebhookRegistrationIntegrityError(
            'pgWebhookRegistrationStore: database returned invalid webhook registration state'
          );
        }
        throw new ConfigurationError('Cannot persist an expired webhook registration.', 'expiresAt');
      }
      const persisted = registrationFromRow(row, proposed);
      if (
        webhookRegistrationFingerprint(persisted) !== proposedFingerprint ||
        !sameWebhookRegistration(persisted, proposed)
      ) {
        throw new ConfigurationError(
          'Webhook operation is already registered with different trusted provenance.',
          'operationId'
        );
      }
    },

    async get(agentId: string, operationId: string): Promise<Readonly<WebhookRegistration> | undefined> {
      validateWebhookRegistrationKey(agentId, operationId);
      const result = await query(
        'get',
        `SELECT ${RETURNING_REGISTRATION}
         FROM ${table}
         WHERE agent_id = $1 AND operation_id = $2
           AND expires_at > clock_timestamp()
         LIMIT 1`,
        [agentId, operationId]
      );
      const row = result.rows[0];
      return row ? registrationFromRow(row, { agentId, operationId }) : undefined;
    },

    async markRequiresDurableSettlement(agentId: string, operationId: string): Promise<void> {
      validateWebhookRegistrationKey(agentId, operationId);
      const result = await query(
        'markRequiresDurableSettlement',
        `WITH key_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended(json_build_array($1::text, $2::text)::text, 0)
           )
         ), backend_clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
           FROM key_lock
         )
         UPDATE ${table}
         SET requires_durable_settlement = TRUE
         FROM backend_clock
         WHERE agent_id = $1 AND operation_id = $2
           AND expires_at > backend_clock.now`,
        [agentId, operationId]
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new Error('Cannot mark a missing or expired webhook registration for durable settlement.');
      }
    },

    async delete(agentId: string, operationId: string): Promise<void> {
      validateWebhookRegistrationKey(agentId, operationId);
      await query(
        'delete',
        `WITH key_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(
             hashtextextended(json_build_array($1::text, $2::text)::text, 0)
           )
         )
         DELETE FROM ${table}
         USING key_lock
         WHERE agent_id = $1 AND operation_id = $2`,
        [agentId, operationId]
      );
    },
  };
}

/**
 * Delete expired registration rows. Expiry correctness does not depend on this
 * helper: all store operations independently use the PostgreSQL clock.
 */
export async function cleanupExpiredWebhookRegistrations(
  db: PgQueryable,
  options: CleanupExpiredWebhookRegistrationsOptions = {}
): Promise<{ deleted: number }> {
  const tableName = options.tableName ?? DEFAULT_TABLE;
  const table = quoteTableName(tableName);
  assertDeploymentNamespace('cleanupExpiredWebhookRegistrations', tableName, options);
  const { batchSize } = options;
  if (batchSize !== undefined && (!Number.isSafeInteger(batchSize) || batchSize <= 0)) {
    throw new TypeError('cleanupExpiredWebhookRegistrations batchSize must be a positive safe integer.');
  }

  try {
    if (batchSize === undefined) {
      const result = await db.query(`DELETE FROM ${table} WHERE expires_at <= clock_timestamp()`);
      return { deleted: result.rowCount ?? 0 };
    }

    const result = await db.query(
      `WITH backend_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS now
       ), expired AS MATERIALIZED (
         SELECT registrations.agent_id, registrations.operation_id
         FROM ${table} AS registrations
         CROSS JOIN backend_clock
         WHERE registrations.expires_at <= backend_clock.now
         ORDER BY registrations.expires_at, registrations.agent_id, registrations.operation_id
         FOR UPDATE OF registrations SKIP LOCKED
         LIMIT $1
       )
       DELETE FROM ${table} AS registrations
       USING expired, backend_clock
       WHERE registrations.agent_id = expired.agent_id
         AND registrations.operation_id = expired.operation_id
         AND registrations.expires_at <= backend_clock.now`,
      [batchSize]
    );
    return { deleted: result.rowCount ?? 0 };
  } catch (cause) {
    throw databaseOperationError('cleanupExpiredWebhookRegistrations', cause);
  }
}
