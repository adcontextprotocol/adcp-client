#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';

import { ADCP_VERSION, TaskExecutor, type AgentConfig, type TaskResult, type WebhookHandlerRequest } from '@adcp/sdk';

import {
  STORE_NAMES,
  assertSameAuthorization,
  createDurableAgent,
  DEFAULT_CONTINUATION_CLAIM_SECONDS,
  PostgresOperationLedger,
  TERMINAL_TASK_STATUSES,
  type DurableBuyerDependencies,
} from './caller.js';

type PolledTask = Awaited<ReturnType<TaskExecutor['getTaskStatus']>>;

function registeredCallbackUrl(template: string, taskType: string, sellerId: string, operationId: string): string {
  return template
    .replaceAll('{task_type}', taskType)
    .replaceAll('{agent_id}', sellerId)
    .replaceAll('{operation_id}', operationId);
}

export interface WebhookResponse {
  status(code: number): { json(body: unknown): void };
  writeHead(code: number, headers: Record<string, string>): void;
  end(body: string): void;
}

function sendStaticError(response: WebhookResponse, status: number, message: string): void {
  response.status(status).json({ error: message });
}

/**
 * Fresh callback process. Route parameters are trusted only as lookup keys;
 * the SDK then verifies them against the durable registration and signature.
 */
export async function receiveTaskWebhook(
  dependencies: DurableBuyerDependencies,
  request: WebhookHandlerRequest,
  response: WebhookResponse
): Promise<void> {
  const sellerId = request.params?.['agent_id'];
  const taskType = request.params?.['task_type'];
  const operationId = request.params?.['operation_id'];
  if (!sellerId || !taskType || !operationId) {
    sendStaticError(response, 400, 'Invalid callback route.');
    return;
  }
  if (taskType !== 'buy_products') {
    sendStaticError(response, 404, 'Callback route not found.');
    return;
  }

  const ledger = new PostgresOperationLedger(dependencies.pool);
  const operation = await ledger.getBySdkOperation(sellerId, operationId);
  if (!operation) {
    sendStaticError(response, 404, 'Callback route not found.');
    return;
  }
  const session = await dependencies.resolveSellerSession(operation);
  if (!session) {
    sendStaticError(response, 404, 'Callback route not found.');
    return;
  }
  try {
    assertSameAuthorization(operation, session);
  } catch {
    sendStaticError(response, 404, 'Callback route not found.');
    return;
  }
  const seller = await createDurableAgent(dependencies, ledger, session);
  const handler = seller.createWebhookHandler({
    getTaskType: () => taskType,
    getOperationId: () => operationId,
    getRequestMethod: () => request.method,
    // Construct from server-owned configuration, never Host/X-Forwarded-*.
    getRequestUrl: () => registeredCallbackUrl(dependencies.callbackUrlTemplate, taskType, sellerId, operationId),
  });
  await handler(request, response);
}

/** Fresh polling process used when no callback arrives. */
export async function recoverByPolling(
  dependencies: DurableBuyerDependencies,
  logicalOperationId: string,
  signal?: AbortSignal
): Promise<PolledTask> {
  const ledger = new PostgresOperationLedger(dependencies.pool);
  const operation = await ledger.get(logicalOperationId);
  if (!operation) throw new Error('Unknown durable operation.');
  const session = await dependencies.resolveSellerSession(operation);
  if (!session) throw new Error('The durable operation is no longer authorized.');
  assertSameAuthorization(operation, session);
  if (!operation.sellerTaskId) throw new Error('The operation has no seller task handle to poll.');
  const seller: AgentConfig = {
    id: session.sellerId,
    name: session.sellerId,
    agent_uri: session.sellerUrl,
    protocol: session.sellerProtocol,
    auth_token: session.authToken,
  };
  const task = await new TaskExecutor({ adcpVersion: ADCP_VERSION }).getTaskStatus(
    seller,
    operation.sellerTaskId,
    undefined,
    signal
  );
  await ledger.observe(
    logicalOperationId,
    task.status === 'cancelled' ? 'canceled' : task.status,
    task.result,
    operation.sellerTaskId
  );
  return task;
}

/**
 * Fresh A2A continuation process. The injected DeferredTaskStorage must be the
 * same atomic, encrypted-at-rest store used by the caller. MCP pauses and A2A
 * pauses without native continuation identity are intentionally nonresumable.
 */
export async function resumePendingInput(
  dependencies: DurableBuyerDependencies,
  logicalOperationId: string,
  input: unknown
): Promise<TaskResult<unknown>> {
  const ledger = new PostgresOperationLedger(dependencies.pool);
  const operation = await ledger.get(logicalOperationId);
  if (!operation) throw new Error('Unknown durable operation.');
  const session = await dependencies.resolveSellerSession(operation);
  if (!session) throw new Error('The durable operation is no longer authorized.');
  assertSameAuthorization(operation, session);
  if (!operation.deferredToken) throw new Error('The operation has no resumable deferred token.');
  const seller = await createDurableAgent(dependencies, ledger, session);
  const claimSeconds = dependencies.continuationClaimSeconds ?? DEFAULT_CONTINUATION_CLAIM_SECONDS;
  const claimToken = await ledger.claimContinuation(logicalOperationId, claimSeconds);
  let renewalFailure: unknown;
  let renewal: Promise<void> | undefined;
  const renewalTimer = setInterval(
    () => {
      if (renewal) return;
      renewal = ledger
        .renewContinuationClaim(logicalOperationId, claimToken, claimSeconds)
        .catch(error => {
          renewalFailure = error;
        })
        .finally(() => {
          renewal = undefined;
        });
    },
    Math.floor((claimSeconds * 1000) / 3)
  );
  renewalTimer.unref();
  try {
    const result = await seller.resumeDeferredTask<unknown>(operation.deferredToken, input);
    clearInterval(renewalTimer);
    await renewal;
    if (renewalFailure) throw renewalFailure;
    await ledger.observeByLogicalOperation(logicalOperationId, result, claimToken);
    return result;
  } finally {
    clearInterval(renewalTimer);
    await renewal;
    await ledger.releaseContinuationClaim(logicalOperationId, claimToken);
  }
}

export interface Publication {
  logicalOperationId: string;
  terminalFingerprint: string;
  payload: unknown;
}

/**
 * Publish one host outbox row. The downstream sink must atomically deduplicate
 * logicalOperationId. That closes the unavoidable crash-after-send/before-ACK
 * window without pretending a database and an external sink share a transaction.
 */
export async function publishOne(
  dependencies: DurableBuyerDependencies,
  publishIdempotently: (publication: Publication) => Promise<void>
): Promise<boolean> {
  const claimToken = randomUUID();
  const claimed = await dependencies.pool.query(
    `WITH candidate AS (
       SELECT deployment_namespace, logical_operation_id
       FROM ${STORE_NAMES.publications}
       WHERE deployment_namespace = $1 AND published_at IS NULL
         AND (claim_expires_at IS NULL OR claim_expires_at <= clock_timestamp())
       ORDER BY updated_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE ${STORE_NAMES.publications} AS publication
     SET claim_token = $2,
         claim_expires_at = clock_timestamp() + INTERVAL '60 seconds',
         attempts = attempts + 1,
         updated_at = clock_timestamp()
     FROM candidate
     WHERE publication.deployment_namespace = candidate.deployment_namespace
       AND publication.logical_operation_id = candidate.logical_operation_id
     RETURNING publication.logical_operation_id, publication.terminal_fingerprint, publication.payload`,
    [STORE_NAMES.deployment, claimToken]
  );
  const row = claimed.rows[0];
  if (!row) return false;
  const publication: Publication = {
    logicalOperationId: String(row.logical_operation_id),
    terminalFingerprint: String(row.terminal_fingerprint),
    payload: row.payload,
  };
  try {
    await publishIdempotently(publication);
    const acknowledged = await dependencies.pool.query(
      `UPDATE ${STORE_NAMES.publications}
       SET published_at = clock_timestamp(), claim_token = NULL,
           claim_expires_at = NULL, updated_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2
         AND claim_token = $3 AND published_at IS NULL`,
      [STORE_NAMES.deployment, publication.logicalOperationId, claimToken]
    );
    if (acknowledged.rowCount !== 1) throw new Error('Publication lease was lost before acknowledgement.');
    return true;
  } catch (error) {
    await dependencies.pool.query(
      `UPDATE ${STORE_NAMES.publications}
       SET claim_token = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
       WHERE deployment_namespace = $1 AND logical_operation_id = $2 AND claim_token = $3`,
      [STORE_NAMES.deployment, publication.logicalOperationId, claimToken]
    );
    throw error;
  }
}

export function isTerminalTask(task: PolledTask): boolean {
  return TERMINAL_TASK_STATUSES.has(task.status === 'cancelled' ? 'canceled' : task.status);
}
