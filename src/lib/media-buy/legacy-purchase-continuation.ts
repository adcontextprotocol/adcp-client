import { createHash } from 'node:crypto';

import type { TaskResultCompleted, TaskResultFailure } from '../core/ConversationTypes';
import type { CompatibilityPurchaseCoordinatorInput } from '../types/core.generated';
import type { CreateMediaBuyResponse } from '../types/tools.generated';
import { canonicalize } from '../utils/jcs';

export type LegacyPurchaseSourceVersion = '2.5' | '3.0' | '3.1';
export type LegacyPurchaseLoss =
  | 'feed_version_not_atomic'
  | 'pricing_version_not_atomic'
  | 'mutation_idempotency_not_guaranteed';

export type LegacyPurchaseTerminalResult =
  | TaskResultCompleted<CreateMediaBuyResponse>
  | TaskResultFailure<CreateMediaBuyResponse>;

export interface LegacyPurchasePendingSettlement {
  operationId: string;
  serverTaskId: string;
  taskType: 'create_media_buy';
  /** Sender event identity retained across durable republication. */
  idempotencyKey?: string;
  terminal: LegacyPurchaseTerminalResult;
}

export interface LegacyPurchaseBinding {
  principalScope: string;
  accountScope: string;
  sellerScope: string;
  /** Authenticated seller/account session scope; never a bearer or secret. */
  clientSessionScope: string;
  sourceAdcpVersion: LegacyPurchaseSourceVersion;
  /** A2A conversation identity observed during discovery, when one exists. */
  discoveryContextId?: string;
}

/** Secret-safe durable description of the claimed mutation. */
export interface LegacyPurchaseClaim {
  idempotencyKey: string;
  inputFingerprint: string;
  operationKey: string;
  claimedAt: string;
  replayExpiresAt: string;
  selectedProductIds: string[];
  /** Source-version mutation key (`idempotency_key`, or v2.5 `buyer_ref`). */
  sourceMutationKey?: string;
  /** Seller task handle retained after a submitted response. */
  sellerTaskId?: string;
  /** Buyer callback-route operation id used for restart/replica settlement recovery. */
  callbackOperationId?: string;
  /** Authenticated terminal callback durably queued before seller task binding. */
  pendingSettlement?: LegacyPurchasePendingSettlement;
  /** Compact proof used to make publication acknowledgement exactly idempotent. */
  acknowledgedSettlementFingerprint?: string;
}

export type LegacyPurchaseOperation =
  | { state: 'available' }
  | ({ state: 'claimed' } & LegacyPurchaseClaim)
  | ({ state: 'completed'; result: LegacyPurchaseTerminalResult } & LegacyPurchaseClaim)
  | ({ state: 'ambiguous'; reason: string } & LegacyPurchaseClaim);

/**
 * Durable state behind a projected `legacy_create` continuation. The complete
 * observed response is retained so an implementation can audit that product
 * and pricing data was never substituted between discovery and mutation.
 */
export interface LegacyPurchaseContinuationRecord extends LegacyPurchaseBinding {
  token: string;
  expiresAt: string;
  /** Stable identity for one discovery operation and its exact response. */
  issuanceFingerprint: string;
  discoveryRequestFingerprint: string;
  observedResponse: unknown;
  productIds: string[];
  losses: LegacyPurchaseLoss[];
  operation: LegacyPurchaseOperation;
}

export type LegacyPurchaseCreateResult =
  | { outcome: 'created' | 'existing'; record: LegacyPurchaseContinuationRecord }
  | { outcome: 'capacity' };

export interface LegacyPurchaseClaimRequest {
  claim: LegacyPurchaseClaim;
  expected: LegacyPurchaseBinding;
}

export type LegacyPurchaseClaimResult =
  | { outcome: 'claimed'; record: LegacyPurchaseContinuationRecord }
  | { outcome: 'replay'; record: LegacyPurchaseContinuationRecord; result: LegacyPurchaseTerminalResult }
  | { outcome: 'in_flight' | 'ambiguous' | 'conflict'; record: LegacyPurchaseContinuationRecord }
  | { outcome: 'expired' | 'binding_mismatch'; record: LegacyPurchaseContinuationRecord }
  | { outcome: 'missing' };

export type LegacyPurchaseCompleteResult =
  | { outcome: 'completed'; result: LegacyPurchaseTerminalResult }
  | {
      outcome: 'pending_completed';
      result: LegacyPurchaseTerminalResult;
      /** The earlier queued callback atomically promoted as terminal winner. */
      pendingSettlement: LegacyPurchasePendingSettlement;
    }
  | {
      outcome: 'duplicate';
      result: LegacyPurchaseTerminalResult;
      /** Still-pending durable publication from an earlier callback winner. */
      pendingSettlement?: LegacyPurchasePendingSettlement;
    }
  | { outcome: 'missing' | 'conflict' | 'capacity' };

export type LegacyPurchasePendingSettlementResult =
  | { outcome: 'recorded' | 'duplicate' }
  | { outcome: 'missing' | 'conflict' | 'capacity' };

/**
 * Persistence contract for legacy purchase continuations. `create` is an
 * atomic put-if-absent by issuanceFingerprint. `claim` atomically verifies
 * bindings and expiry, enforces the operation-wide idempotency index, and
 * moves an available token to claimed. Implementations must not return live
 * mutable references. Restart/replica callback recovery is an optional
 * capability, but stores that opt in must implement callback lookup, the
 * pending-settlement inbox, and publication acknowledgement together.
 */
export interface LegacyPurchaseContinuationStore {
  create(record: LegacyPurchaseContinuationRecord): Promise<LegacyPurchaseCreateResult>;
  get(token: string): Promise<LegacyPurchaseContinuationRecord | undefined>;
  /** Resolve a claimed operation for restart/replica callback settlement. */
  getByCallbackOperationId?(operationId: string): Promise<LegacyPurchaseContinuationRecord | undefined>;
  claim(token: string, request: LegacyPurchaseClaimRequest): Promise<LegacyPurchaseClaimResult>;
  /**
   * Atomically install the first terminal winner. Exact retries return that
   * winner; an exact already-installed retry returns `duplicate`, and a
   * different terminal value returns `conflict` without replacing it. If a
   * pending settlement was installed first, implementations MUST atomically
   * validate its callback operation, `create_media_buy` task type, and any
   * already-bound seller task ID before committing. Invalid descriptors
   * return `conflict` without changing state. A valid pending settlement is
   * promoted instead of the caller's candidate and returned as
   * `pending_completed`.
   */
  complete(
    token: string,
    claim: LegacyPurchaseClaim,
    result: LegacyPurchaseTerminalResult
  ): Promise<LegacyPurchaseCompleteResult>;
  /**
   * Atomically retain an authenticated terminal callback that arrived before
   * the seller response bound its task ID. Durable stores should implement
   * this together with `getByCallbackOperationId` and
   * `acknowledgePendingSettlement` for replica-safe callbacks.
   * The write must be atomic with duplicate/conflict comparison and retained
   * through the operation's `replayExpiresAt` fence; writes at or beyond that
   * instant must return conflict. If a seller task is already bound, a
   * different settlement serverTaskId must return conflict.
   */
  recordPendingSettlement?(
    token: string,
    claim: LegacyPurchaseClaim,
    settlement: LegacyPurchasePendingSettlement
  ): Promise<LegacyPurchasePendingSettlementResult>;
  /**
   * Atomically clear a completed callback outbox entry after adopter
   * publication succeeds. Exact already-cleared retries return true; a
   * mismatched claim or settlement returns false.
   */
  acknowledgePendingSettlement?(
    token: string,
    claim: LegacyPurchaseClaim,
    settlement: LegacyPurchasePendingSettlement
  ): Promise<boolean>;
  /**
   * Atomically bind the seller task identity using first-writer-wins semantics.
   * The first bind returns `true`; an exact same-ID retry also returns `true`;
   * a different ID returns `false` and must never replace the stored ID. A
   * different ID already retained by pendingSettlement also returns `false`.
   */
  recordSubmittedTask(token: string, claim: LegacyPurchaseClaim, sellerTaskId: string): Promise<boolean>;
  markAmbiguous(token: string, claim: LegacyPurchaseClaim, reason: string): Promise<boolean>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameClaim(operation: LegacyPurchaseOperation, claim: LegacyPurchaseClaim): boolean {
  return (
    operation.state !== 'available' &&
    operation.idempotencyKey === claim.idempotencyKey &&
    operation.inputFingerprint === claim.inputFingerprint &&
    operation.operationKey === claim.operationKey
  );
}

function comparableTerminalResult(result: LegacyPurchaseTerminalResult): unknown {
  return {
    success: result.success,
    status: result.status,
    data: result.data,
    error: result.error,
    adcpError: result.adcpError,
    correlationId: result.correlationId,
  };
}

function sameTerminalResult(left: LegacyPurchaseTerminalResult, right: LegacyPurchaseTerminalResult): boolean {
  return canonicalize(comparableTerminalResult(left)) === canonicalize(comparableTerminalResult(right));
}

function settlementFingerprint(settlement: LegacyPurchasePendingSettlement): string {
  return createHash('sha256')
    .update(
      canonicalize({
        operationId: settlement.operationId,
        serverTaskId: settlement.serverTaskId,
        taskType: settlement.taskType,
        idempotencyKey: settlement.idempotencyKey ?? null,
        terminal: comparableTerminalResult(settlement.terminal),
      })
    )
    .digest('base64url');
}

function sameBinding(record: LegacyPurchaseContinuationRecord, expected: LegacyPurchaseBinding): boolean {
  return (
    record.principalScope === expected.principalScope &&
    record.accountScope === expected.accountScope &&
    record.sellerScope === expected.sellerScope &&
    record.clientSessionScope === expected.clientSessionScope &&
    record.sourceAdcpVersion === expected.sourceAdcpVersion &&
    record.discoveryContextId === expected.discoveryContextId
  );
}

function sameStableBinding(record: LegacyPurchaseContinuationRecord, expected: LegacyPurchaseBinding): boolean {
  return (
    record.principalScope === expected.principalScope &&
    record.accountScope === expected.accountScope &&
    record.sellerScope === expected.sellerScope &&
    record.clientSessionScope === expected.clientSessionScope &&
    record.sourceAdcpVersion === expected.sourceAdcpVersion
  );
}

function validFuture(timestamp: string, now: number): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed > now;
}

export interface InMemoryLegacyPurchaseContinuationStoreOptions {
  maxRecords?: number;
  maxBytes?: number;
}

/** Single-process reference implementation. Use a durable store in clustered deployments. */
export class InMemoryLegacyPurchaseContinuationStore implements LegacyPurchaseContinuationStore {
  private readonly records = new Map<string, LegacyPurchaseContinuationRecord>();
  private readonly issuanceIndex = new Map<string, string>();
  private readonly operationIndex = new Map<string, string>();
  private readonly callbackOperationIndex = new Map<string, string>();
  private readonly recordBytes = new Map<string, number>();
  private totalBytes = 0;
  private readonly maxRecords: number;
  private readonly maxBytes: number;

  constructor(options: InMemoryLegacyPurchaseContinuationStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? 256;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords <= 0) {
      throw new TypeError('maxRecords must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive safe integer.');
    }
  }

  private sizeOf(record: LegacyPurchaseContinuationRecord): number {
    return Buffer.byteLength(JSON.stringify(record), 'utf8');
  }

  private remove(token: string): void {
    const record = this.records.get(token);
    if (!record) return;
    this.records.delete(token);
    this.issuanceIndex.delete(record.issuanceFingerprint);
    if (record.operation.state !== 'available') this.operationIndex.delete(record.operation.operationKey);
    if (record.operation.state !== 'available' && record.operation.callbackOperationId) {
      this.callbackOperationIndex.delete(record.operation.callbackOperationId);
    }
    this.totalBytes -= this.recordBytes.get(token) ?? 0;
    this.recordBytes.delete(token);
  }

  private prune(now: number): void {
    for (const [token, record] of this.records) {
      if (record.operation.state === 'available') {
        if (!validFuture(record.expiresAt, now)) this.remove(token);
      } else if (record.operation.state === 'completed' && !validFuture(record.operation.replayExpiresAt, now)) {
        this.remove(token);
      }
      // Never reclaim claimed or ambiguous mutations automatically. The
      // seller may have committed spend even after its advertised replay
      // window closes, so retaining the operation index is the permanent
      // duplicate-dispatch fence. Capacity exhaustion is intentionally
      // fail-closed; production deployments should reconcile uncertainty or
      // supply a durable store sized for their retention policy.
    }
  }

  private replace(record: LegacyPurchaseContinuationRecord): boolean {
    const nextBytes = this.sizeOf(record);
    const priorBytes = this.recordBytes.get(record.token) ?? 0;
    if (this.totalBytes - priorBytes + nextBytes > this.maxBytes) return false;
    this.records.set(record.token, clone(record));
    this.recordBytes.set(record.token, nextBytes);
    this.totalBytes = this.totalBytes - priorBytes + nextBytes;
    return true;
  }

  async create(record: LegacyPurchaseContinuationRecord): Promise<LegacyPurchaseCreateResult> {
    this.prune(Date.now());
    const existingToken = this.issuanceIndex.get(record.issuanceFingerprint);
    const existing = existingToken ? this.records.get(existingToken) : undefined;
    if (existing) return { outcome: 'existing', record: clone(existing) };
    if (this.records.has(record.token) || this.records.size >= this.maxRecords || !this.replace(record)) {
      return { outcome: 'capacity' };
    }
    this.issuanceIndex.set(record.issuanceFingerprint, record.token);
    return { outcome: 'created', record: clone(record) };
  }

  async get(token: string): Promise<LegacyPurchaseContinuationRecord | undefined> {
    const record = this.records.get(token);
    return record ? clone(record) : undefined;
  }

  async getByCallbackOperationId(operationId: string): Promise<LegacyPurchaseContinuationRecord | undefined> {
    const token = this.callbackOperationIndex.get(operationId);
    return token ? this.get(token) : undefined;
  }

  async claim(token: string, request: LegacyPurchaseClaimRequest): Promise<LegacyPurchaseClaimResult> {
    const record = this.records.get(token);
    if (!record) return { outcome: 'missing' };
    if (
      (record.operation.state === 'available' && !sameBinding(record, request.expected)) ||
      (record.operation.state !== 'available' && !sameStableBinding(record, request.expected))
    ) {
      return { outcome: 'binding_mismatch', record: clone(record) };
    }
    // Durable implementations must obtain their database/server clock inside
    // the same transaction as this CAS; never trust a caller-captured time.
    const now = Date.now();

    if (record.operation.state === 'available') {
      if (!validFuture(record.expiresAt, now)) return { outcome: 'expired', record: clone(record) };
      const indexedToken = this.operationIndex.get(request.claim.operationKey);
      if (indexedToken !== undefined && indexedToken !== token) {
        return { outcome: 'conflict', record: clone(record) };
      }
      const callbackToken = request.claim.callbackOperationId
        ? this.callbackOperationIndex.get(request.claim.callbackOperationId)
        : undefined;
      if (callbackToken !== undefined && callbackToken !== token) {
        return { outcome: 'conflict', record: clone(record) };
      }
      const claimed = { ...record, operation: { state: 'claimed' as const, ...request.claim } };
      if (!this.replace(claimed)) return { outcome: 'conflict', record: clone(record) };
      this.operationIndex.set(request.claim.operationKey, token);
      if (request.claim.callbackOperationId) {
        this.callbackOperationIndex.set(request.claim.callbackOperationId, token);
      }
      return { outcome: 'claimed', record: clone(claimed) };
    }

    if (!sameClaim(record.operation, request.claim)) return { outcome: 'conflict', record: clone(record) };
    if (!validFuture(record.operation.replayExpiresAt, now)) {
      return { outcome: 'expired', record: clone(record) };
    }
    if (record.operation.state === 'completed') {
      return { outcome: 'replay', record: clone(record), result: clone(record.operation.result) };
    }
    return { outcome: record.operation.state === 'ambiguous' ? 'ambiguous' : 'in_flight', record: clone(record) };
  }

  async complete(
    token: string,
    claim: LegacyPurchaseClaim,
    result: LegacyPurchaseTerminalResult
  ): Promise<LegacyPurchaseCompleteResult> {
    const record = this.records.get(token);
    if (!record) return { outcome: 'missing' };
    if (!sameClaim(record.operation, claim)) return { outcome: 'conflict' };
    if (record.operation.state === 'available') return { outcome: 'conflict' };
    if (record.operation.state === 'completed') {
      if (!sameTerminalResult(record.operation.result, result)) return { outcome: 'conflict' };
      return {
        outcome: 'duplicate',
        result: clone(record.operation.result),
        ...(record.operation.pendingSettlement !== undefined && {
          pendingSettlement: clone(record.operation.pendingSettlement),
        }),
      };
    }
    const pendingSettlement = record.operation.pendingSettlement;
    if (
      pendingSettlement !== undefined &&
      (pendingSettlement.operationId !== claim.callbackOperationId ||
        pendingSettlement.taskType !== 'create_media_buy' ||
        (record.operation.sellerTaskId !== undefined &&
          pendingSettlement.serverTaskId !== record.operation.sellerTaskId))
    ) {
      return { outcome: 'conflict' };
    }
    const winner = pendingSettlement?.terminal ?? result;
    const completed = {
      ...record,
      operation: {
        ...record.operation,
        state: 'completed' as const,
        result: winner,
      },
    };
    if (!this.replace(completed)) return { outcome: 'capacity' };
    return pendingSettlement === undefined
      ? { outcome: 'completed', result: clone(winner) }
      : {
          outcome: 'pending_completed',
          result: clone(winner),
          pendingSettlement: clone(pendingSettlement),
        };
  }

  async recordPendingSettlement(
    token: string,
    claim: LegacyPurchaseClaim,
    settlement: LegacyPurchasePendingSettlement
  ): Promise<LegacyPurchasePendingSettlementResult> {
    const record = this.records.get(token);
    if (!record) return { outcome: 'missing' };
    if (
      record.operation.state === 'available' ||
      record.operation.state === 'completed' ||
      !sameClaim(record.operation, claim) ||
      !validFuture(record.operation.replayExpiresAt, Date.now()) ||
      settlement.taskType !== 'create_media_buy' ||
      record.operation.callbackOperationId !== settlement.operationId ||
      (record.operation.sellerTaskId !== undefined && record.operation.sellerTaskId !== settlement.serverTaskId)
    ) {
      return { outcome: 'conflict' };
    }
    const existing = record.operation.pendingSettlement;
    if (existing) {
      return existing.operationId === settlement.operationId &&
        existing.serverTaskId === settlement.serverTaskId &&
        existing.taskType === settlement.taskType &&
        existing.idempotencyKey === settlement.idempotencyKey &&
        sameTerminalResult(existing.terminal, settlement.terminal)
        ? { outcome: 'duplicate' }
        : { outcome: 'conflict' };
    }
    return this.replace({
      ...record,
      operation: { ...record.operation, pendingSettlement: clone(settlement) },
    })
      ? { outcome: 'recorded' }
      : { outcome: 'capacity' };
  }

  async recordSubmittedTask(token: string, claim: LegacyPurchaseClaim, sellerTaskId: string): Promise<boolean> {
    const record = this.records.get(token);
    if (!record || record.operation.state === 'available' || !sameClaim(record.operation, claim)) return false;
    if (record.operation.state === 'completed') {
      return record.operation.sellerTaskId === sellerTaskId;
    }
    if (record.operation.sellerTaskId !== undefined && record.operation.sellerTaskId !== sellerTaskId) return false;
    if (
      record.operation.pendingSettlement !== undefined &&
      record.operation.pendingSettlement.serverTaskId !== sellerTaskId
    ) {
      return false;
    }
    return this.replace({ ...record, operation: { ...record.operation, sellerTaskId } });
  }

  async acknowledgePendingSettlement(
    token: string,
    claim: LegacyPurchaseClaim,
    settlement: LegacyPurchasePendingSettlement
  ): Promise<boolean> {
    const record = this.records.get(token);
    if (!record || record.operation.state !== 'completed' || !sameClaim(record.operation, claim)) return false;
    const pending = record.operation.pendingSettlement;
    const fingerprint = settlementFingerprint(settlement);
    if (pending === undefined) return record.operation.acknowledgedSettlementFingerprint === fingerprint;
    if (
      pending.operationId !== settlement.operationId ||
      pending.serverTaskId !== settlement.serverTaskId ||
      pending.taskType !== settlement.taskType ||
      pending.idempotencyKey !== settlement.idempotencyKey ||
      !sameTerminalResult(pending.terminal, settlement.terminal)
    ) {
      return false;
    }
    const { pendingSettlement: _pendingSettlement, ...operation } = record.operation;
    void _pendingSettlement;
    return this.replace({ ...record, operation: { ...operation, acknowledgedSettlementFingerprint: fingerprint } });
  }

  async markAmbiguous(token: string, claim: LegacyPurchaseClaim, reason: string): Promise<boolean> {
    const record = this.records.get(token);
    if (!record || !sameClaim(record.operation, claim) || record.operation.state === 'completed') return false;
    if (record.operation.state === 'available') return false;
    return this.replace({
      ...record,
      operation: {
        ...record.operation,
        state: 'ambiguous',
        reason,
      },
    });
  }
}

export function createInMemoryLegacyPurchaseContinuationStore(
  options: InMemoryLegacyPurchaseContinuationStoreOptions = {}
): LegacyPurchaseContinuationStore {
  return new InMemoryLegacyPurchaseContinuationStore(options);
}

export type LegacyPurchaseReconciliationResult =
  | { outcome: 'completed'; result: LegacyPurchaseTerminalResult }
  | { outcome: 'unresolved'; reason?: string };

export type ReconcileLegacyPurchase = (
  record: LegacyPurchaseContinuationRecord,
  input: CompatibilityPurchaseCoordinatorInput
) => Promise<LegacyPurchaseReconciliationResult>;
