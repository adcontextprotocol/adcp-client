#!/usr/bin/env tsx

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  ADCP_VERSION,
  AgentClient,
  canonicalJsonSha256,
  getWebhookRegistrationMigration,
  pgWebhookRegistrationStore,
  WebhookDispatchError,
  type AgentConfig,
  type BuyProductsResponse,
  type BuyProductsRequest,
  type DeferredTaskStorage,
  type TaskResult,
  type TaskStatus,
  type WebhookMetadata,
  type WebhookRegistration,
  type WebhookRegistrationStore,
} from '@adcp/sdk';
import { getIdempotencyMigration, pgBackend, type PgQueryable } from '@adcp/sdk/server';
import { BuyProductsResponseSchema } from '@adcp/sdk/schemas';
import { getReplayStoreMigration, PostgresReplayStore } from '@adcp/sdk/signing/server';

export const STORE_NAMES = {
  deployment: 'buyer_prod_v1',
  operations: 'buyer_adcp_operations',
  operationRoutes: 'buyer_adcp_operation_routes',
  publications: 'buyer_adcp_publications',
  registrations: 'buyer_adcp_webhook_registrations',
  webhookReplay: 'buyer_adcp_webhook_replays',
  webhookDedup: 'buyer_adcp_webhook_dedup',
} as const;

// Seven days is both the SDK 14 default registration horizon and the maximum
// webhook retry horizon advertised by the pinned AdCP 3.2 schema.
export const RECEIVER_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export const HOST_OPERATION_MIGRATION = `
CREATE TABLE IF NOT EXISTS ${STORE_NAMES.operations} (
  deployment_namespace   TEXT NOT NULL,
  logical_operation_id   TEXT NOT NULL,
  natural_key            TEXT NOT NULL,
  tenant_id              TEXT NOT NULL,
  principal_id           TEXT NOT NULL,
  seller_id              TEXT NOT NULL,
  seller_url             TEXT NOT NULL,
  seller_protocol        TEXT NOT NULL CHECK (seller_protocol IN ('mcp', 'a2a')),
  seller_account_id      TEXT NOT NULL,
  request_idempotency_key TEXT NOT NULL,
  request_payload        JSONB NOT NULL,
  request_fingerprint    TEXT NOT NULL,
  seller_task_id         TEXT,
  deferred_token         TEXT,
  continuation_claim_token TEXT,
  continuation_claim_expires_at TIMESTAMPTZ,
  status                 TEXT NOT NULL DEFAULT 'staged',
  terminal_fingerprint   TEXT,
  terminal_result        JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_namespace, logical_operation_id),
  UNIQUE (deployment_namespace, request_idempotency_key)
);

CREATE INDEX IF NOT EXISTS buyer_adcp_operations_natural_key
  ON ${STORE_NAMES.operations} (
    deployment_namespace, tenant_id, seller_id, seller_account_id, natural_key
  );

CREATE TABLE IF NOT EXISTS ${STORE_NAMES.operationRoutes} (
  deployment_namespace TEXT NOT NULL,
  seller_id            TEXT NOT NULL,
  sdk_operation_id     TEXT NOT NULL,
  logical_operation_id TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_namespace, seller_id, sdk_operation_id),
  FOREIGN KEY (deployment_namespace, logical_operation_id)
    REFERENCES ${STORE_NAMES.operations} (deployment_namespace, logical_operation_id)
);

CREATE INDEX IF NOT EXISTS buyer_adcp_operation_routes_logical_operation
  ON ${STORE_NAMES.operationRoutes} (deployment_namespace, logical_operation_id);

CREATE TABLE IF NOT EXISTS ${STORE_NAMES.publications} (
  deployment_namespace TEXT NOT NULL,
  logical_operation_id TEXT NOT NULL,
  terminal_fingerprint TEXT NOT NULL,
  payload               JSONB NOT NULL,
  claim_token           TEXT,
  claim_expires_at      TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  attempts              INTEGER NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (deployment_namespace, logical_operation_id),
  FOREIGN KEY (deployment_namespace, logical_operation_id)
    REFERENCES ${STORE_NAMES.operations} (deployment_namespace, logical_operation_id)
);

CREATE INDEX IF NOT EXISTS buyer_adcp_publications_unpublished
  ON ${STORE_NAMES.publications} (deployment_namespace, updated_at)
  WHERE published_at IS NULL;
`;

export interface AuthorizedSellerSession {
  tenantId: string;
  principalId: string;
  sellerId: string;
  sellerUrl: string;
  sellerProtocol: 'mcp' | 'a2a';
  sellerAccountId: string;
  /** Request-local secret. The operation ledger never persists it. */
  authToken: string;
}

export interface DurableBuyerPgClient extends PgQueryable {
  release(): void;
}

export interface DurableBuyerPgPool extends PgQueryable {
  connect(): Promise<DurableBuyerPgClient>;
}

export interface StoredOperation {
  logicalOperationId: string;
  naturalKey: string;
  tenantId: string;
  principalId: string;
  sellerId: string;
  sellerUrl: string;
  sellerProtocol: 'mcp' | 'a2a';
  sellerAccountId: string;
  request: BuyProductsRequest;
  requestFingerprint: string;
  sellerTaskId?: string;
  deferredToken?: string;
  status: string;
  terminalFingerprint?: string;
  terminalResult?: unknown;
}

export interface DurableBuyerDependencies {
  pool: DurableBuyerPgPool;
  /** Host implementation of the SDK's atomic DeferredTaskStorage contract. */
  deferredStorage: DeferredTaskStorage;
  /** Re-derive current credentials and authorization; never load them from the operation row. */
  resolveSellerSession(operation: StoredOperation): Promise<AuthorizedSellerSession | undefined>;
  callbackUrlTemplate: string;
  /** Five-minute minimum; the worker renews this lease while resume is active. */
  continuationClaimSeconds?: number;
}

interface DispatchContext {
  logicalOperationId: string;
  session: AuthorizedSellerSession;
}

const dispatchContext = new AsyncLocalStorage<DispatchContext>();
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'governance-denied',
  'aborted',
]);
export const DEFAULT_CONTINUATION_CLAIM_SECONDS = 5 * 60;
const SAFE_ROUTE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export class TerminalObservationConflictError extends Error {}
export class TerminalObservationInProgressError extends Error {}

function normalizeTaskStatus(status: string): string {
  return status === 'cancelled' ? 'canceled' : status;
}

function canonicalTerminalPayload(status: string, value: unknown): unknown | undefined {
  if (!TERMINAL_TASK_STATUSES.has(status) || value === undefined) return undefined;
  // Webhook and tasks/get envelopes may carry task status beside a result
  // object that omits the commitment discriminant. Preserve an explicit
  // result status; otherwise derive only the schema's completed/failed arm.
  const candidate =
    typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.hasOwn(value, 'status')
      ? { ...value, status: status === 'completed' ? 'completed' : 'failed' }
      : value;
  const parsed = BuyProductsResponseSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.status === 'submitted') return undefined;
  return parsed.data;
}

function terminalOutcomeFingerprintPayload(value: unknown): unknown {
  const response = value as BuyProductsResponse;
  // Explicitly exclude channel/envelope fields (`replayed`, `context`, `ext`)
  // so a retry, callback, and poll of the same commitment have one identity.
  if (response.status === 'failed') return { status: response.status, errors: response.errors };
  if (response.status !== 'completed') throw new Error('A submitted response is not a terminal outcome.');
  return {
    status: response.status,
    media_buy_id: response.media_buy_id,
    revision: response.revision,
    accepted_proposal: response.accepted_proposal,
    purchase_bindings: response.purchase_bindings,
  };
}

function rowToOperation(row: Record<string, unknown>): StoredOperation {
  return {
    logicalOperationId: String(row.logical_operation_id),
    naturalKey: String(row.natural_key),
    tenantId: String(row.tenant_id),
    principalId: String(row.principal_id),
    sellerId: String(row.seller_id),
    sellerUrl: String(row.seller_url),
    sellerProtocol: row.seller_protocol === 'a2a' ? 'a2a' : 'mcp',
    sellerAccountId: String(row.seller_account_id),
    request: row.request_payload as BuyProductsRequest,
    requestFingerprint: String(row.request_fingerprint),
    ...(row.seller_task_id ? { sellerTaskId: String(row.seller_task_id) } : {}),
    ...(row.deferred_token ? { deferredToken: String(row.deferred_token) } : {}),
    status: String(row.status),
    ...(row.terminal_fingerprint ? { terminalFingerprint: String(row.terminal_fingerprint) } : {}),
    ...(row.terminal_result !== null && row.terminal_result !== undefined
      ? { terminalResult: row.terminal_result }
      : {}),
  };
}

export class PostgresOperationLedger {
  constructor(readonly pool: DurableBuyerPgPool) {}

  async stage(
    logicalOperationId: string,
    naturalKey: string,
    session: AuthorizedSellerSession,
    requestWithoutKey: Omit<BuyProductsRequest, 'idempotency_key'>,
    idempotencyKey?: string
  ): Promise<StoredOperation> {
    if (!naturalKey.trim()) throw new Error('The business natural key must be non-empty.');
    if (
      !('account_id' in requestWithoutKey.account) ||
      requestWithoutKey.account.account_id !== session.sellerAccountId
    ) {
      throw new Error('The request account must match the currently authorized seller account.');
    }
    const candidateKey = idempotencyKey ?? randomUUID();
    const candidateRequest = structuredClone({
      ...requestWithoutKey,
      idempotency_key: candidateKey,
    }) as BuyProductsRequest;
    const candidateFingerprint = canonicalJsonSha256(candidateRequest);
    await this.pool.query(
      `INSERT INTO ${STORE_NAMES.operations} (
         deployment_namespace, logical_operation_id, natural_key, tenant_id, principal_id,
         seller_id, seller_url, seller_protocol, seller_account_id,
         request_idempotency_key, request_payload, request_fingerprint
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       ON CONFLICT DO NOTHING`,
      [
        STORE_NAMES.deployment,
        logicalOperationId,
        naturalKey,
        session.tenantId,
        session.principalId,
        session.sellerId,
        session.sellerUrl,
        session.sellerProtocol,
        session.sellerAccountId,
        candidateKey,
        JSON.stringify(candidateRequest),
        candidateFingerprint,
      ]
    );
    const stored = await this.get(logicalOperationId);
    if (!stored) {
      throw new Error('The request idempotency key is already bound to a different logical operation.');
    }
    const expectedRequest = structuredClone({
      ...requestWithoutKey,
      idempotency_key: idempotencyKey ?? stored.request.idempotency_key,
    }) as BuyProductsRequest;
    if (
      stored.naturalKey !== naturalKey ||
      stored.requestFingerprint !== canonicalJsonSha256(expectedRequest) ||
      stored.tenantId !== session.tenantId ||
      stored.principalId !== session.principalId ||
      stored.sellerId !== session.sellerId ||
      stored.sellerUrl !== session.sellerUrl ||
      stored.sellerProtocol !== session.sellerProtocol ||
      stored.sellerAccountId !== session.sellerAccountId
    ) {
      throw new Error(
        'Logical operation already exists with a different natural key, canonical request, or authorization binding; create a new operation.'
      );
    }
    return stored;
  }

  async get(logicalOperationId: string): Promise<StoredOperation | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${STORE_NAMES.operations}
       WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
      [STORE_NAMES.deployment, logicalOperationId]
    );
    return rows[0] ? rowToOperation(rows[0]) : undefined;
  }

  async getBySdkOperation(sellerId: string, sdkOperationId: string): Promise<StoredOperation | undefined> {
    const { rows } = await this.pool.query(
      `SELECT operation.*
       FROM ${STORE_NAMES.operationRoutes} AS route
       JOIN ${STORE_NAMES.operations} AS operation
         ON operation.deployment_namespace = route.deployment_namespace
        AND operation.logical_operation_id = route.logical_operation_id
       WHERE route.deployment_namespace = $1
         AND route.seller_id = $2 AND route.sdk_operation_id = $3`,
      [STORE_NAMES.deployment, sellerId, sdkOperationId]
    );
    return rows[0] ? rowToOperation(rows[0]) : undefined;
  }

  async markDispatchUncertain(logicalOperationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${STORE_NAMES.operations}
       SET status = 'dispatch-uncertain', updated_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2
         AND terminal_fingerprint IS NULL`,
      [STORE_NAMES.deployment, logicalOperationId]
    );
  }

  async bindRegistration(
    tx: DurableBuyerPgClient,
    registration: WebhookRegistration,
    context: DispatchContext
  ): Promise<void> {
    if (registration.agentId !== context.session.sellerId)
      throw new Error('Webhook seller binding changed before dispatch.');
    const bound = await tx.query(
      `INSERT INTO ${STORE_NAMES.operationRoutes} (
         deployment_namespace, seller_id, sdk_operation_id, logical_operation_id
       )
       SELECT $1, $6, $3, logical_operation_id
       FROM ${STORE_NAMES.operations}
       WHERE deployment_namespace = $1 AND logical_operation_id = $2
         AND tenant_id = $4 AND principal_id = $5 AND seller_id = $6
         AND seller_url = $7 AND seller_protocol = $8 AND seller_account_id = $9
       ON CONFLICT (deployment_namespace, seller_id, sdk_operation_id) DO NOTHING
       RETURNING logical_operation_id`,
      [
        STORE_NAMES.deployment,
        context.logicalOperationId,
        registration.operationId,
        context.session.tenantId,
        context.session.principalId,
        context.session.sellerId,
        context.session.sellerUrl,
        context.session.sellerProtocol,
        context.session.sellerAccountId,
      ]
    );
    if (bound.rowCount === 1) return;
    const proof = await tx.query(
      `SELECT logical_operation_id FROM ${STORE_NAMES.operationRoutes}
       WHERE deployment_namespace = $1 AND seller_id = $2 AND sdk_operation_id = $3`,
      [STORE_NAMES.deployment, context.session.sellerId, registration.operationId]
    );
    if (proof.rows[0]?.logical_operation_id !== context.logicalOperationId) {
      throw new Error('Could not atomically bind the SDK operation to the authorized host operation.');
    }
  }

  async observeByLogicalOperation(
    logicalOperationId: string,
    result: TaskResult<unknown>,
    continuationClaimToken?: string
  ): Promise<void> {
    // TaskExecutor also uses `failed` for transport exceptions. Without a
    // seller payload, delivery is uncertain and must be reconciled/retried
    // with the stored request key instead of becoming the terminal winner.
    const status =
      TERMINAL_TASK_STATUSES.has(result.status) && result.data === undefined ? 'dispatch-uncertain' : result.status;
    await this.observe(
      logicalOperationId,
      status,
      result.data,
      result.metadata.serverTaskId,
      result.deferred?.token,
      continuationClaimToken
    );
  }

  async observeBySdkOperation(response: unknown, metadata: WebhookMetadata): Promise<void> {
    const operation = await this.getBySdkOperation(metadata.agent_id, metadata.operation_id);
    if (!operation) throw new Error('No authorized host operation owns this callback route.');
    if (
      TERMINAL_TASK_STATUSES.has(normalizeTaskStatus(metadata.status)) &&
      canonicalTerminalPayload(normalizeTaskStatus(metadata.status), response) === undefined
    ) {
      throw new WebhookDispatchError(
        'webhook_publication_in_progress',
        'A terminal callback did not contain a canonical buy_products result; retry or reconcile by polling.'
      );
    }
    try {
      await this.observe(operation.logicalOperationId, metadata.status, response, metadata.task_id);
    } catch (error) {
      if (error instanceof TerminalObservationConflictError) {
        throw new WebhookDispatchError('webhook_idempotency_conflict', error.message, error);
      }
      if (error instanceof TerminalObservationInProgressError) {
        throw new WebhookDispatchError('webhook_publication_in_progress', error.message, error);
      }
      throw error;
    }
  }

  async observe(
    logicalOperationId: string,
    status: string,
    value: unknown,
    sellerTaskId?: string,
    deferredToken?: string,
    continuationClaimToken?: string
  ): Promise<void> {
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      const { rows } = await tx.query(
        `SELECT *,
                continuation_claim_token IS NOT NULL
                  AND continuation_claim_expires_at > clock_timestamp()
                  AS continuation_claim_is_active
         FROM ${STORE_NAMES.operations}
         WHERE deployment_namespace = $1 AND logical_operation_id = $2 FOR UPDATE`,
        [STORE_NAMES.deployment, logicalOperationId]
      );
      const currentRow = rows[0] as Record<string, unknown> | undefined;
      const current = currentRow ? rowToOperation(currentRow) : undefined;
      if (!current) throw new Error('Unknown logical operation.');
      if (current.sellerTaskId && sellerTaskId && current.sellerTaskId !== sellerTaskId) {
        throw new TerminalObservationConflictError('Seller task identity conflict.');
      }

      const normalizedStatus = normalizeTaskStatus(status);
      const terminalPayload = canonicalTerminalPayload(normalizedStatus, value);
      const terminalFingerprint =
        terminalPayload !== undefined
          ? canonicalJsonSha256({
              task_type: 'buy_products',
              value: terminalOutcomeFingerprintPayload(terminalPayload),
            })
          : undefined;
      const claimIsActive = currentRow?.continuation_claim_is_active === true;
      if (
        continuationClaimToken !== undefined &&
        (!claimIsActive || currentRow?.continuation_claim_token !== continuationClaimToken)
      ) {
        throw new TerminalObservationInProgressError('The continuation settlement lease was lost.');
      }
      if (terminalFingerprint && claimIsActive && currentRow?.continuation_claim_token !== continuationClaimToken) {
        throw new TerminalObservationInProgressError('A continuation resume currently owns terminal settlement.');
      }
      if (current.terminalFingerprint) {
        if (terminalFingerprint && current.terminalFingerprint !== terminalFingerprint) {
          throw new TerminalObservationConflictError(
            'Conflicting terminal observation; the recorded winner was preserved.'
          );
        }
        if (!terminalFingerprint) {
          await tx.query('COMMIT');
          return;
        }
      }

      await tx.query(
        `UPDATE ${STORE_NAMES.operations}
         SET seller_task_id = COALESCE(seller_task_id, $3),
             deferred_token = CASE WHEN $6::text IS NOT NULL THEN NULL ELSE COALESCE($4, deferred_token) END,
             status = CASE WHEN terminal_fingerprint IS NULL THEN $5 ELSE status END,
             terminal_fingerprint = COALESCE(terminal_fingerprint, $6::text),
             terminal_result = CASE WHEN terminal_fingerprint IS NULL AND $6::text IS NOT NULL THEN $7::jsonb ELSE terminal_result END,
             updated_at = clock_timestamp()
         WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
        [
          STORE_NAMES.deployment,
          logicalOperationId,
          sellerTaskId ?? null,
          deferredToken ?? null,
          terminalFingerprint || !TERMINAL_TASK_STATUSES.has(normalizedStatus)
            ? normalizedStatus
            : 'terminal-result-pending',
          terminalFingerprint ?? null,
          terminalFingerprint ? JSON.stringify(terminalPayload) : null,
        ]
      );
      if (terminalFingerprint) {
        await tx.query(
          `INSERT INTO ${STORE_NAMES.publications} (
             deployment_namespace, logical_operation_id, terminal_fingerprint, payload
           ) VALUES ($1,$2,$3,$4::jsonb)
           ON CONFLICT (deployment_namespace, logical_operation_id) DO NOTHING`,
          [STORE_NAMES.deployment, logicalOperationId, terminalFingerprint, JSON.stringify(terminalPayload)]
        );
        const proof = await tx.query(
          `SELECT terminal_fingerprint FROM ${STORE_NAMES.publications}
           WHERE deployment_namespace = $1 AND logical_operation_id = $2`,
          [STORE_NAMES.deployment, logicalOperationId]
        );
        if (proof.rows[0]?.terminal_fingerprint !== terminalFingerprint) {
          throw new TerminalObservationConflictError('Publication outbox conflicts with the terminal winner.');
        }
      }
      await tx.query('COMMIT');
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        // Preserve the transaction's original failure; releasing the client
        // below discards any broken connection.
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  async claimContinuation(
    logicalOperationId: string,
    claimSeconds = DEFAULT_CONTINUATION_CLAIM_SECONDS
  ): Promise<string> {
    if (!Number.isSafeInteger(claimSeconds) || claimSeconds < 5 * 60 || claimSeconds > 24 * 60 * 60) {
      throw new RangeError('continuationClaimSeconds must be between 300 and 86400 seconds.');
    }
    const claimToken = randomUUID();
    const claimed = await this.pool.query(
      `UPDATE ${STORE_NAMES.operations}
       SET continuation_claim_token = $3,
           continuation_claim_expires_at = clock_timestamp() + ($4 * INTERVAL '1 second'),
           updated_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2
         AND terminal_fingerprint IS NULL
         AND (continuation_claim_token IS NULL OR continuation_claim_expires_at <= clock_timestamp())
       RETURNING logical_operation_id`,
      [STORE_NAMES.deployment, logicalOperationId, claimToken, claimSeconds]
    );
    if (claimed.rowCount !== 1) {
      throw new Error('The operation is already terminal or another continuation owns settlement.');
    }
    return claimToken;
  }

  async renewContinuationClaim(logicalOperationId: string, claimToken: string, claimSeconds: number): Promise<void> {
    const renewed = await this.pool.query(
      `UPDATE ${STORE_NAMES.operations}
       SET continuation_claim_expires_at = clock_timestamp() + ($4 * INTERVAL '1 second'),
           updated_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2
         AND continuation_claim_token = $3 AND terminal_fingerprint IS NULL
       RETURNING logical_operation_id`,
      [STORE_NAMES.deployment, logicalOperationId, claimToken, claimSeconds]
    );
    if (renewed.rowCount !== 1) throw new Error('The continuation settlement lease could not be renewed.');
  }

  async releaseContinuationClaim(logicalOperationId: string, claimToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${STORE_NAMES.operations}
       SET continuation_claim_token = NULL, continuation_claim_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2
         AND continuation_claim_token = $3`,
      [STORE_NAMES.deployment, logicalOperationId, claimToken]
    );
  }
}

class OperationBoundRegistrationStore implements WebhookRegistrationStore {
  private readonly shared: WebhookRegistrationStore;

  constructor(
    private readonly pool: DurableBuyerPgPool,
    private readonly ledger: PostgresOperationLedger
  ) {
    this.shared = pgWebhookRegistrationStore(pool, { tableName: STORE_NAMES.registrations });
  }

  get(agentId: string, operationId: string) {
    return this.shared.get(agentId, operationId);
  }

  async putIfAbsent(registration: WebhookRegistration): Promise<void> {
    const context = dispatchContext.getStore();
    if (!context) throw new Error('Outbound webhook registration has no host operation context.');
    const tx = await this.pool.connect();
    try {
      await tx.query('BEGIN');
      await pgWebhookRegistrationStore(tx, { tableName: STORE_NAMES.registrations }).putIfAbsent(registration);
      await this.ledger.bindRegistration(tx, registration, context);
      await tx.query('COMMIT');
    } catch (error) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        // Preserve the registration/binding failure.
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  markRequiresDurableSettlement(agentId: string, operationId: string) {
    if (!this.shared.markRequiresDurableSettlement)
      throw new Error('The registration store does not support durable-settlement marking.');
    return this.shared.markRequiresDurableSettlement(agentId, operationId);
  }

  delete(agentId: string, operationId: string) {
    if (!this.shared.delete) throw new Error('The registration store does not support registration deletion.');
    return this.shared.delete(agentId, operationId);
  }
}

export async function migrateDurableBuyer(pool: DurableBuyerPgPool): Promise<void> {
  await pool.query(getWebhookRegistrationMigration({ tableName: STORE_NAMES.registrations }));
  await pool.query(getReplayStoreMigration(STORE_NAMES.webhookReplay));
  await pool.query(getIdempotencyMigration({ tableName: STORE_NAMES.webhookDedup }));
  await pool.query(HOST_OPERATION_MIGRATION);
}

export async function probeDurableBuyerStores(pool: DurableBuyerPgPool): Promise<void> {
  const registrations = pgWebhookRegistrationStore(pool, { tableName: STORE_NAMES.registrations });
  const webhookDedup = pgBackend(pool, { tableName: STORE_NAMES.webhookDedup });
  if (!webhookDedup.probe) throw new Error('The selected webhook dedup backend has no readiness probe.');
  await Promise.all([
    registrations.probe(),
    webhookDedup.probe(),
    pool.query(`SELECT keyid, scope, nonce, expires_at FROM ${STORE_NAMES.webhookReplay} LIMIT 0`),
    pool.query(
      `SELECT logical_operation_id, request_idempotency_key, seller_task_id, deferred_token,
              terminal_fingerprint, continuation_claim_token
       FROM ${STORE_NAMES.operations} LIMIT 0`
    ),
    pool.query(`SELECT seller_id, sdk_operation_id, logical_operation_id FROM ${STORE_NAMES.operationRoutes} LIMIT 0`),
    pool.query(
      `SELECT logical_operation_id, terminal_fingerprint, payload, published_at
       FROM ${STORE_NAMES.publications} LIMIT 0`
    ),
  ]);
}

export function assertSameAuthorization(operation: StoredOperation, session: AuthorizedSellerSession): void {
  if (
    session.tenantId !== operation.tenantId ||
    session.principalId !== operation.principalId ||
    session.sellerId !== operation.sellerId ||
    session.sellerUrl !== operation.sellerUrl ||
    session.sellerProtocol !== operation.sellerProtocol ||
    session.sellerAccountId !== operation.sellerAccountId
  ) {
    throw new Error('Current seller/account authorization does not match the durable operation.');
  }
}

export async function createDurableAgent(
  dependencies: DurableBuyerDependencies,
  ledger: PostgresOperationLedger,
  session: AuthorizedSellerSession
): Promise<AgentClient> {
  if (
    !dependencies.callbackUrlTemplate.includes('{task_type}') ||
    !dependencies.callbackUrlTemplate.includes('{agent_id}') ||
    !dependencies.callbackUrlTemplate.includes('{operation_id}')
  ) {
    throw new Error('The trusted callback URL template must include {task_type}, {agent_id}, and {operation_id}.');
  }
  if (!SAFE_ROUTE_SEGMENT.test(session.sellerId)) {
    throw new Error('sellerId must be an RFC 3986 unreserved callback-route segment.');
  }
  const registrationStore = new OperationBoundRegistrationStore(dependencies.pool, ledger);
  const replayStore = new PostgresReplayStore(dependencies.pool, { tableName: STORE_NAMES.webhookReplay });
  const webhookDedup = pgBackend(dependencies.pool, { tableName: STORE_NAMES.webhookDedup });

  const agent: AgentConfig = {
    id: session.sellerId,
    name: session.sellerId,
    agent_uri: session.sellerUrl,
    protocol: session.sellerProtocol,
    auth_token: session.authToken,
  };
  const client = new AgentClient(agent, {
    adcpVersion: ADCP_VERSION,
    webhookUrlTemplate: { template: dependencies.callbackUrlTemplate, tools: ['buy_products'] },
    webhookRegistrationStore: registrationStore,
    webhookRegistrationTtlSeconds: RECEIVER_RETENTION_SECONDS,
    webhookVerification: { replayStore },
    deferredStorage: dependencies.deferredStorage,
    deferredTaskTtlSeconds: RECEIVER_RETENTION_SECONDS,
    handlers: {
      webhookDedup: { backend: webhookDedup, ttlSeconds: RECEIVER_RETENTION_SECONDS },
      onTaskStatusChange: async (response, metadata) => {
        await ledger.observeBySdkOperation(response, metadata);
      },
    },
  });
  return client;
}

/**
 * Outbound request process. Stage first, then always dispatch the stored value
 * and key. An uncertain retry calls this again with the same logical operation;
 * it never creates a replacement key automatically.
 */
export async function dispatchStagedBuy(
  dependencies: DurableBuyerDependencies,
  logicalOperationId: string
): Promise<TaskResult<unknown> | { alreadySettled: true; value: unknown }> {
  const ledger = new PostgresOperationLedger(dependencies.pool);
  const operation = await ledger.get(logicalOperationId);
  if (!operation) throw new Error('Stage the logical operation before dispatch.');
  const session = await dependencies.resolveSellerSession(operation);
  if (!session) throw new Error('The staged operation is no longer authorized.');
  assertSameAuthorization(operation, session);
  if (operation.terminalFingerprint) {
    return { alreadySettled: true, value: structuredClone(operation.terminalResult) };
  }
  const seller = await createDurableAgent(dependencies, ledger, session);
  let result: TaskResult<unknown>;
  try {
    result = (await dispatchContext.run({ logicalOperationId, session }, () =>
      seller.buyProducts(operation.request)
    )) as TaskResult<unknown>;
  } catch (error) {
    try {
      await ledger.markDispatchUncertain(logicalOperationId);
    } catch (ledgerError) {
      throw new AggregateError([error, ledgerError], 'Dispatch and durable uncertainty recording both failed.');
    }
    throw error;
  }
  await ledger.observeByLogicalOperation(logicalOperationId, result as TaskResult<unknown>);
  return result as TaskResult<unknown>;
}
