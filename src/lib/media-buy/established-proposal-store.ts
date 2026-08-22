export type EstablishedProposalSourceVersion = '3.0' | '3.1';
export type EstablishedProposalMutationKind = 'accept' | 'refine' | 'decline';
export type EstablishedProposalMutationDisposition = 'accepted' | 'refined' | 'declined' | 'commit-uncertain';

export interface EstablishedProposalScope {
  /** Stable, server-controlled authenticated principal identity. Never a credential. */
  principalScope: string;
  /** Stable digest of the seller identity and endpoint. Never a credential. */
  sellerScope: string;
  sourceAdcpVersion: EstablishedProposalSourceVersion;
}

export interface EstablishedProposalBinding extends EstablishedProposalScope {
  accountScope: string;
  proposalId: string;
}

export type EstablishedProposalTaskScope = EstablishedProposalScope & { accountScope: string };

/** Snapshot version that `reserveMutation` must compare atomically with the reservation. */
export interface EstablishedProposalMutationBinding extends EstablishedProposalBinding {
  snapshotFingerprint: string;
}

/**
 * Serializable, immutable evidence retained from one established seller
 * proposal. This deliberately excludes raw seller responses, credentials,
 * coordinator owners, timers, listeners, and live mutable references.
 */
export interface ProposalSnapshotEntry extends EstablishedProposalBinding {
  proposal: Record<string, unknown>;
  /** SDK-normalized RFC 3339 seller hold expiry, when the proposal supplied one. */
  expiresAt?: string;
  canonicalTermsDigest?: string;
  snapshotFingerprint: string;
  capturedAt: string;
}

export interface EstablishedProposalMutationIntent {
  operation: EstablishedProposalMutationKind;
  requestFingerprint: string;
  operationKey: string;
  /** Duration advertised by the seller. The store computes the deadline with its own clock. */
  retryTtlMs?: number;
  idempotencyKey?: string;
}

export interface EstablishedProposalMutationClaim extends Omit<EstablishedProposalMutationIntent, 'retryTtlMs'> {
  /** Set by the store from its authoritative clock during the first reservation. */
  reservedAt: string;
  /** Fixed by the store during the first reservation from `retryTtlMs`. */
  retryExpiresAt?: string;
  sellerTaskId?: string;
}

export type EstablishedProposalOperation =
  | { state: 'available' }
  | ({ state: 'reserved' | 'retryable'; ambiguity?: 'paused' | 'commit-uncertain' } & EstablishedProposalMutationClaim)
  | ({
      state: 'terminal';
      disposition: EstablishedProposalMutationDisposition;
      /** Hash of the reduced authoritative terminal evidence; never the raw seller response. */
      terminalResultFingerprint?: string;
    } & EstablishedProposalMutationClaim);

export interface EstablishedProposalRecord {
  snapshot: ProposalSnapshotEntry;
  operation: EstablishedProposalOperation;
}

export type EstablishedProposalPutResult =
  | { outcome: 'stored' | 'unchanged'; record: EstablishedProposalRecord }
  | { outcome: 'fenced'; record: EstablishedProposalRecord }
  | { outcome: 'missing' | 'capacity' };

export interface EstablishedProposalReserveRequest {
  bindings: readonly EstablishedProposalMutationBinding[];
  claim: EstablishedProposalMutationIntent;
}

export type EstablishedProposalReserveResult =
  | { outcome: 'reserved'; records: EstablishedProposalRecord[]; retry: boolean }
  | {
      outcome: 'missing' | 'expired' | 'in_flight' | 'ambiguous' | 'terminal' | 'conflict' | 'capacity';
      records: EstablishedProposalRecord[];
    };

export type EstablishedProposalTransitionResult =
  | { outcome: 'updated'; records: EstablishedProposalRecord[] }
  | { outcome: 'missing' | 'conflict' | 'capacity'; records: EstablishedProposalRecord[] };

export interface EstablishedProposalSubmittedOperation {
  request: EstablishedProposalReserveRequest;
  records: EstablishedProposalRecord[];
  sellerTaskId: string;
  /** True when a bounded completion tombstone is servicing an idempotent reconciliation retry. */
  settled?: boolean;
}

/**
 * Production persistence contract for established 3.0/3.1 proposal
 * compatibility state.
 *
 * `reserveMutation` is an atomic compare-and-swap across every supplied
 * binding. Implementations must use their database/server clock in that same
 * transaction. Two workers must never both receive `reserved` for a first
 * attempt, and authoritatively settled terminal records must never become
 * executable again. A terminal `commit-uncertain` record remains fenced, but
 * an exact seller-task reconciliation may complete it or release it after an
 * authoritative terminal error. The
 * mutation fence is proposal-wide within principal, seller, and version
 * scope: alternate `accountScope` representations for the same `proposalId`
 * must conflict once any representation is reserved or terminal.
 *
 * Every input and output must be detached from the backing store. Do not
 * persist raw seller responses, authentication material, presigned URLs, or
 * live coordinator objects. The SDK supplies only its reduced allow-listed
 * proposal snapshot.
 */
export interface EstablishedProposalStore {
  /**
   * Store an initial snapshot, or atomically replace the exact available
   * generation named by `expectedSnapshotFingerprint`. Reserved and terminal
   * generations must always win.
   */
  putSnapshot(
    snapshot: ProposalSnapshotEntry,
    expectedSnapshotFingerprint?: string
  ): Promise<EstablishedProposalPutResult>;
  /** Remove only an available snapshot. Reservations and terminal fences win. */
  discardSnapshot(
    binding: EstablishedProposalBinding,
    expectedSnapshotFingerprint: string
  ): Promise<'discarded' | 'missing' | 'fenced'>;
  get(binding: EstablishedProposalBinding): Promise<EstablishedProposalRecord | undefined>;
  find(scope: EstablishedProposalScope, proposalIds: readonly string[]): Promise<EstablishedProposalRecord[]>;
  /** Recover the exact durable operation needed to poll and reconcile after a process restart. */
  findSubmittedTask(
    scope: EstablishedProposalTaskScope,
    sellerTaskId: string
  ): Promise<EstablishedProposalSubmittedOperation | undefined>;
  reserveMutation(request: EstablishedProposalReserveRequest): Promise<EstablishedProposalReserveResult>;
  completeMutation(
    request: EstablishedProposalReserveRequest,
    disposition: 'accepted',
    terminalResultFingerprint: string
  ): Promise<EstablishedProposalTransitionResult>;
  /** Atomically consume source generations and install seller-returned successor generations. */
  completeRefinement(
    request: EstablishedProposalReserveRequest,
    replacements: readonly ProposalSnapshotEntry[],
    retainedBindings?: readonly EstablishedProposalMutationBinding[]
  ): Promise<EstablishedProposalTransitionResult>;
  /** Atomically terminalize successful declines while restoring authoritative unable sources. */
  completeDecline(
    request: EstablishedProposalReserveRequest,
    retainedBindings?: readonly EstablishedProposalMutationBinding[]
  ): Promise<EstablishedProposalTransitionResult>;
  /**
   * Release an exact reserved/retryable claim, or an exact terminal
   * `commit-uncertain` claim after authoritative seller failure evidence.
   */
  releaseMutation(request: EstablishedProposalReserveRequest): Promise<EstablishedProposalTransitionResult>;
  /** Persist one seller task ID and reject scoped reuse by live records or completion tombstones. */
  recordSubmittedTask(
    request: EstablishedProposalReserveRequest,
    sellerTaskId: string
  ): Promise<EstablishedProposalTransitionResult>;
  markAmbiguous(
    request: EstablishedProposalReserveRequest,
    ambiguity: 'paused' | 'commit-uncertain'
  ): Promise<EstablishedProposalTransitionResult>;
}

export interface InMemoryEstablishedProposalStoreOptions {
  maxRecords?: number;
  maxBytes?: number;
  clock?: () => Date;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(binding: EstablishedProposalBinding): string {
  return JSON.stringify([
    binding.principalScope,
    binding.sellerScope,
    binding.sourceAdcpVersion,
    binding.accountScope,
    binding.proposalId,
  ]);
}

function sameScope(record: EstablishedProposalRecord, scope: EstablishedProposalScope): boolean {
  const snapshot = record.snapshot;
  return (
    snapshot.principalScope === scope.principalScope &&
    snapshot.sellerScope === scope.sellerScope &&
    snapshot.sourceAdcpVersion === scope.sourceAdcpVersion
  );
}

function sameClaim(operation: EstablishedProposalOperation, claim: EstablishedProposalMutationIntent): boolean {
  return (
    operation.state !== 'available' &&
    operation.operation === claim.operation &&
    operation.operationKey === claim.operationKey &&
    operation.requestFingerprint === claim.requestFingerprint &&
    operation.idempotencyKey === claim.idempotencyKey
  );
}

function canAuthoritativelySettle(
  operation: EstablishedProposalOperation,
  claim: EstablishedProposalMutationIntent
): boolean {
  return (
    sameClaim(operation, claim) &&
    (operation.state === 'reserved' ||
      operation.state === 'retryable' ||
      (operation.state === 'terminal' && operation.disposition === 'commit-uncertain'))
  );
}

function validFuture(value: string | undefined, now: number): boolean {
  if (value === undefined) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now;
}

/** Process-local reference implementation. Use a durable store in clustered deployments. */
export class InMemoryEstablishedProposalStore implements EstablishedProposalStore {
  private readonly records = new Map<string, EstablishedProposalRecord>();
  private readonly recordBytes = new Map<string, number>();
  private readonly operationIndex = new Map<string, readonly string[]>();
  private readonly proposalMutationIndex = new Map<string, string>();
  private readonly completedRefinements = new Map<
    string,
    {
      requestSignature: string;
      replacementSignature: string;
      request: EstablishedProposalReserveRequest;
      sellerTaskId?: string;
      records: EstablishedProposalRecord[];
    }
  >();
  private completedRefinementBytes = 0;
  private totalBytes = 0;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly clock: () => Date;

  constructor(options: InMemoryEstablishedProposalStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? 256;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.clock = options.clock ?? (() => new Date());
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords <= 0) {
      throw new TypeError('maxRecords must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new TypeError('maxBytes must be a positive safe integer.');
    }
  }

  private sizeOf(record: EstablishedProposalRecord): number {
    return Buffer.byteLength(JSON.stringify(record), 'utf8');
  }

  private proposalFenceKey(binding: EstablishedProposalBinding): string {
    return JSON.stringify([binding.principalScope, binding.sellerScope, binding.sourceAdcpVersion, binding.proposalId]);
  }

  private replace(recordKey: string, record: EstablishedProposalRecord): boolean {
    return this.replaceMany([[recordKey, record]]);
  }

  private replaceMany(entries: ReadonlyArray<readonly [string, EstablishedProposalRecord]>): boolean {
    const priorBytes = entries.reduce((total, [recordKey]) => total + (this.recordBytes.get(recordKey) ?? 0), 0);
    const sized = entries.map(([recordKey, record]) => [recordKey, record, this.sizeOf(record)] as const);
    const nextBytes = sized.reduce((total, [, , bytes]) => total + bytes, 0);
    if (this.totalBytes + this.completedRefinementBytes - priorBytes + nextBytes > this.maxBytes) return false;
    for (const [recordKey, record, bytes] of sized) {
      this.records.set(recordKey, clone(record));
      this.recordBytes.set(recordKey, bytes);
    }
    this.totalBytes = this.totalBytes - priorBytes + nextBytes;
    return true;
  }

  async putSnapshot(
    snapshot: ProposalSnapshotEntry,
    expectedSnapshotFingerprint?: string
  ): Promise<EstablishedProposalPutResult> {
    const recordKey = key(snapshot);
    const existing = this.records.get(recordKey);
    const proposalOperationKey = this.proposalMutationIndex.get(this.proposalFenceKey(snapshot));
    if (proposalOperationKey !== undefined) {
      const fenced = [...this.records.values()].find(
        record =>
          this.proposalFenceKey(record.snapshot) === this.proposalFenceKey(snapshot) &&
          record.operation.state !== 'available'
      );
      if (fenced) return { outcome: 'fenced', record: clone(fenced) };
    }
    if (existing?.operation.state !== undefined && existing.operation.state !== 'available') {
      return { outcome: 'fenced', record: clone(existing) };
    }
    if (existing?.snapshot.snapshotFingerprint === snapshot.snapshotFingerprint) {
      return { outcome: 'unchanged', record: clone(existing) };
    }
    if (!existing && expectedSnapshotFingerprint !== undefined) return { outcome: 'missing' };
    if (
      existing &&
      (expectedSnapshotFingerprint === undefined ||
        existing.snapshot.snapshotFingerprint !== expectedSnapshotFingerprint)
    ) {
      return { outcome: 'fenced', record: clone(existing) };
    }
    if (!existing && this.records.size + this.completedRefinements.size >= this.maxRecords) {
      return { outcome: 'capacity' };
    }
    const record: EstablishedProposalRecord = { snapshot: clone(snapshot), operation: { state: 'available' } };
    if (!this.replace(recordKey, record)) return { outcome: 'capacity' };
    return { outcome: 'stored', record: clone(record) };
  }

  async get(binding: EstablishedProposalBinding): Promise<EstablishedProposalRecord | undefined> {
    const record = this.records.get(key(binding));
    return record ? clone(record) : undefined;
  }

  async discardSnapshot(
    binding: EstablishedProposalBinding,
    expectedSnapshotFingerprint: string
  ): Promise<'discarded' | 'missing' | 'fenced'> {
    const recordKey = key(binding);
    const record = this.records.get(recordKey);
    if (!record) return 'missing';
    if (record.operation.state !== 'available' || record.snapshot.snapshotFingerprint !== expectedSnapshotFingerprint) {
      return 'fenced';
    }
    this.records.delete(recordKey);
    this.totalBytes -= this.recordBytes.get(recordKey) ?? 0;
    this.recordBytes.delete(recordKey);
    return 'discarded';
  }

  async find(scope: EstablishedProposalScope, proposalIds: readonly string[]): Promise<EstablishedProposalRecord[]> {
    const wanted = new Set(proposalIds);
    return [...this.records.values()]
      .filter(record => sameScope(record, scope) && wanted.has(record.snapshot.proposalId))
      .map(clone);
  }

  async findSubmittedTask(
    scope: EstablishedProposalTaskScope,
    sellerTaskId: string
  ): Promise<EstablishedProposalSubmittedOperation | undefined> {
    const completed = [...this.completedRefinements.values()].find(
      value =>
        value.sellerTaskId === sellerTaskId &&
        value.request.bindings.length > 0 &&
        value.request.bindings.every(binding => binding.accountScope === scope.accountScope) &&
        value.request.bindings.every(
          binding =>
            binding.principalScope === scope.principalScope &&
            binding.sellerScope === scope.sellerScope &&
            binding.sourceAdcpVersion === scope.sourceAdcpVersion
        )
    );
    if (completed) {
      return clone({
        request: completed.request,
        records: completed.records,
        sellerTaskId,
        settled: true,
      });
    }
    const matched = [...this.records.values()].find(
      record =>
        sameScope(record, scope) &&
        record.snapshot.accountScope === scope.accountScope &&
        record.operation.state !== 'available' &&
        record.operation.sellerTaskId === sellerTaskId
    );
    if (!matched || matched.operation.state === 'available') return undefined;
    const bindingKeys = this.operationIndex.get(matched.operation.operationKey);
    if (!bindingKeys) return undefined;
    const records = bindingKeys.flatMap(recordKey => {
      const record = this.records.get(recordKey);
      return record ? [record] : [];
    });
    if (
      records.length !== bindingKeys.length ||
      records.some(record => !sameScope(record, scope) || record.snapshot.accountScope !== scope.accountScope)
    ) {
      return undefined;
    }
    const operation = matched.operation;
    return clone({
      request: {
        bindings: records.map(record => ({
          principalScope: record.snapshot.principalScope,
          sellerScope: record.snapshot.sellerScope,
          sourceAdcpVersion: record.snapshot.sourceAdcpVersion,
          accountScope: record.snapshot.accountScope,
          proposalId: record.snapshot.proposalId,
          snapshotFingerprint: record.snapshot.snapshotFingerprint,
        })),
        claim: {
          operation: operation.operation,
          operationKey: operation.operationKey,
          requestFingerprint: operation.requestFingerprint,
          ...(operation.idempotencyKey && { idempotencyKey: operation.idempotencyKey }),
        },
      },
      records,
      sellerTaskId,
      ...(records.every(
        record => record.operation.state === 'terminal' && record.operation.disposition !== 'commit-uncertain'
      ) && { settled: true }),
    });
  }

  async reserveMutation(request: EstablishedProposalReserveRequest): Promise<EstablishedProposalReserveResult> {
    const bindingKeys = [...new Set(request.bindings.map(key))].sort();
    if (bindingKeys.length === 0) return { outcome: 'missing', records: [] };
    const completed = this.completedRefinements.get(request.claim.operationKey);
    if (
      completed &&
      completed.request.claim.operation === request.claim.operation &&
      completed.request.claim.requestFingerprint === request.claim.requestFingerprint &&
      completed.request.claim.idempotencyKey === request.claim.idempotencyKey
    ) {
      return { outcome: 'conflict', records: completed.records.map(clone) };
    }
    const records = bindingKeys.flatMap(recordKey => {
      const record = this.records.get(recordKey);
      return record ? [record] : [];
    });
    if (records.length !== bindingKeys.length) return { outcome: 'missing', records: records.map(clone) };
    if (
      request.bindings.some(binding => {
        const record = this.records.get(key(binding));
        return record?.snapshot.snapshotFingerprint !== binding.snapshotFingerprint;
      })
    ) {
      return { outcome: 'conflict', records: records.map(clone) };
    }
    const now = this.clock().getTime();
    if (
      request.claim.retryTtlMs !== undefined &&
      (!Number.isSafeInteger(request.claim.retryTtlMs) ||
        request.claim.retryTtlMs <= 0 ||
        now + request.claim.retryTtlMs > 8_640_000_000_000_000)
    ) {
      throw new TypeError('retryTtlMs must be a positive safe integer when provided.');
    }
    const indexed = this.operationIndex.get(request.claim.operationKey);
    if (indexed && JSON.stringify(indexed) !== JSON.stringify(bindingKeys)) {
      return { outcome: 'conflict', records: records.map(clone) };
    }
    if (
      request.bindings.some(binding => {
        const operationKey = this.proposalMutationIndex.get(this.proposalFenceKey(binding));
        return operationKey !== undefined && operationKey !== request.claim.operationKey;
      })
    ) {
      return { outcome: 'conflict', records: records.map(clone) };
    }
    if (records.every(record => record.operation.state === 'available')) {
      const expired = records.some(record => {
        const expiresAt = record.snapshot.expiresAt;
        return expiresAt !== undefined && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now);
      });
      if (expired) return { outcome: 'expired', records: records.map(clone) };
      const claim: EstablishedProposalMutationClaim = {
        operation: request.claim.operation,
        requestFingerprint: request.claim.requestFingerprint,
        operationKey: request.claim.operationKey,
        ...(request.claim.idempotencyKey && { idempotencyKey: request.claim.idempotencyKey }),
        reservedAt: new Date(now).toISOString(),
        ...(request.claim.retryTtlMs !== undefined && {
          retryExpiresAt: new Date(now + request.claim.retryTtlMs).toISOString(),
        }),
      };
      const reserved = records.map(record => ({
        ...record,
        operation: { ...claim, state: 'reserved' as const },
      }));
      const sizes = reserved.map(this.sizeOf.bind(this));
      const priorBytes = bindingKeys.reduce((total, recordKey) => total + (this.recordBytes.get(recordKey) ?? 0), 0);
      const nextBytes = sizes.reduce((total, bytes) => total + bytes, 0);
      if (this.totalBytes + this.completedRefinementBytes - priorBytes + nextBytes > this.maxBytes) {
        return { outcome: 'capacity', records: records.map(clone) };
      }
      if (!this.replaceMany(reserved.map((record, index) => [bindingKeys[index]!, record]))) {
        return { outcome: 'capacity', records: records.map(clone) };
      }
      this.operationIndex.set(request.claim.operationKey, bindingKeys);
      request.bindings.forEach(binding =>
        this.proposalMutationIndex.set(this.proposalFenceKey(binding), request.claim.operationKey)
      );
      return { outcome: 'reserved', records: reserved.map(clone), retry: false };
    }
    if (!records.every(record => sameClaim(record.operation, request.claim))) {
      return {
        outcome: records.some(record => record.operation.state === 'terminal') ? 'terminal' : 'conflict',
        records: records.map(clone),
      };
    }
    if (records.some(record => record.operation.state === 'terminal')) {
      return { outcome: 'terminal', records: records.map(clone) };
    }
    if (records.some(record => record.operation.state === 'reserved')) {
      return { outcome: 'in_flight', records: records.map(clone) };
    }
    if (
      records.some(
        record => record.operation.state === 'available' || !validFuture(record.operation.retryExpiresAt, now)
      )
    ) {
      return { outcome: 'expired', records: records.map(clone) };
    }
    const reserved: EstablishedProposalRecord[] = records.map(record => {
      if (record.operation.state !== 'retryable') {
        throw new Error('Established proposal store reached an invalid retry state.');
      }
      return {
        ...record,
        operation: { ...record.operation, state: 'reserved' as const },
      };
    });
    if (!this.replaceMany(reserved.map((record, index) => [bindingKeys[index]!, record]))) {
      return { outcome: 'capacity', records: records.map(clone) };
    }
    return { outcome: 'reserved', records: reserved.map(clone), retry: true };
  }

  private transition(
    request: EstablishedProposalReserveRequest,
    update: (record: EstablishedProposalRecord) => EstablishedProposalRecord,
    allowedStates: ReadonlySet<EstablishedProposalOperation['state']> = new Set(['reserved', 'retryable'])
  ): EstablishedProposalTransitionResult {
    const bindingKeys = [...new Set(request.bindings.map(key))].sort();
    if (bindingKeys.length === 0) return { outcome: 'missing', records: [] };
    const records = bindingKeys.flatMap(recordKey => {
      const record = this.records.get(recordKey);
      return record ? [record] : [];
    });
    if (records.length !== bindingKeys.length) return { outcome: 'missing', records: records.map(clone) };
    if (!records.every(record => sameClaim(record.operation, request.claim))) {
      return { outcome: 'conflict', records: records.map(clone) };
    }
    if (records.some(record => !allowedStates.has(record.operation.state))) {
      return { outcome: 'conflict', records: records.map(clone) };
    }
    const updated = records.map(update);
    const nextBytes = updated.reduce((total, record) => total + this.sizeOf(record), 0);
    const priorBytes = bindingKeys.reduce((total, recordKey) => total + (this.recordBytes.get(recordKey) ?? 0), 0);
    if (this.totalBytes + this.completedRefinementBytes - priorBytes + nextBytes > this.maxBytes) {
      return { outcome: 'capacity', records: records.map(clone) };
    }
    if (!this.replaceMany(updated.map((record, index) => [bindingKeys[index]!, record]))) {
      return { outcome: 'capacity', records: records.map(clone) };
    }
    return { outcome: 'updated', records: updated.map(clone) };
  }

  async completeMutation(
    request: EstablishedProposalReserveRequest,
    disposition: 'accepted',
    terminalResultFingerprint: string
  ): Promise<EstablishedProposalTransitionResult> {
    const current = request.bindings.flatMap(binding => {
      const record = this.records.get(key(binding));
      return record ? [record] : [];
    });
    if (request.claim.operation !== 'accept' || terminalResultFingerprint.length === 0) {
      return { outcome: 'conflict', records: current.map(clone) };
    }
    if (
      current.length === request.bindings.length &&
      current.every(
        record =>
          record.operation.state === 'terminal' &&
          sameClaim(record.operation, request.claim) &&
          record.operation.disposition === disposition &&
          record.operation.terminalResultFingerprint === terminalResultFingerprint
      )
    ) {
      return { outcome: 'updated', records: current.map(clone) };
    }
    if (
      current.some(
        record => record.operation.state === 'terminal' && !canAuthoritativelySettle(record.operation, request.claim)
      )
    ) {
      return { outcome: 'conflict', records: current.map(clone) };
    }
    return this.transition(
      request,
      record => ({
        ...record,
        operation:
          record.operation.state === 'available'
            ? record.operation
            : { ...record.operation, state: 'terminal', disposition, terminalResultFingerprint },
      }),
      new Set(['reserved', 'retryable', 'terminal'])
    );
  }

  async completeRefinement(
    request: EstablishedProposalReserveRequest,
    replacements: readonly ProposalSnapshotEntry[],
    retainedBindings: readonly EstablishedProposalMutationBinding[] = []
  ): Promise<EstablishedProposalTransitionResult> {
    const requestSignature = JSON.stringify(
      request.bindings
        .map(binding => [key(binding), binding.snapshotFingerprint])
        .sort(([left], [right]) => left!.localeCompare(right!))
    );
    const replacementSignature = JSON.stringify({
      replacements: replacements
        .map(replacement => [key(replacement), replacement.snapshotFingerprint])
        .sort(([left], [right]) => left!.localeCompare(right!)),
      retained: retainedBindings
        .map(binding => [key(binding), binding.snapshotFingerprint])
        .sort(([left], [right]) => left!.localeCompare(right!)),
    });
    const completed = this.completedRefinements.get(request.claim.operationKey);
    if (completed) {
      return completed.request.claim.operation === request.claim.operation &&
        completed.request.claim.requestFingerprint === request.claim.requestFingerprint &&
        completed.request.claim.idempotencyKey === request.claim.idempotencyKey &&
        completed.requestSignature === requestSignature &&
        completed.replacementSignature === replacementSignature
        ? { outcome: 'updated', records: completed.records.map(clone) }
        : { outcome: 'conflict', records: completed.records.map(clone) };
    }
    const bindingKeys = [...new Set(request.bindings.map(key))].sort();
    const current = bindingKeys.flatMap(recordKey => {
      const record = this.records.get(recordKey);
      return record ? [record] : [];
    });
    if (current.length !== bindingKeys.length) return { outcome: 'missing', records: current.map(clone) };
    if (
      request.claim.operation !== 'refine' ||
      retainedBindings.some(
        retained =>
          !request.bindings.some(
            binding => key(binding) === key(retained) && binding.snapshotFingerprint === retained.snapshotFingerprint
          )
      ) ||
      !current.every(record => canAuthoritativelySettle(record.operation, request.claim))
    ) {
      return { outcome: 'conflict', records: current.map(clone) };
    }
    const effectiveReplacements = replacements.filter(replacement => {
      const source = request.bindings.find(binding => key(binding) === key(replacement));
      return !source || source.snapshotFingerprint !== replacement.snapshotFingerprint;
    });
    const replacementKeys = new Set<string>();
    for (const replacement of effectiveReplacements) {
      const replacementKey = key(replacement);
      if (replacementKeys.has(replacementKey)) return { outcome: 'conflict', records: current.map(clone) };
      replacementKeys.add(replacementKey);
      const sameRequestScope = request.bindings.some(
        binding =>
          binding.principalScope === replacement.principalScope &&
          binding.sellerScope === replacement.sellerScope &&
          binding.sourceAdcpVersion === replacement.sourceAdcpVersion &&
          binding.accountScope === replacement.accountScope
      );
      const existing = this.records.get(replacementKey);
      const proposalFence = this.proposalFenceKey(replacement);
      const conflictingFence = [...this.records.entries()].some(
        ([recordKey, record]) =>
          this.proposalFenceKey(record.snapshot) === proposalFence &&
          record.operation.state !== 'available' &&
          (!bindingKeys.includes(recordKey) || !sameClaim(record.operation, request.claim))
      );
      const indexedOperation = this.proposalMutationIndex.get(proposalFence);
      if (
        !sameRequestScope ||
        conflictingFence ||
        (indexedOperation !== undefined && indexedOperation !== request.claim.operationKey) ||
        (existing && existing.operation.state !== 'available' && !bindingKeys.includes(replacementKey))
      ) {
        return { outcome: 'conflict', records: current.map(clone) };
      }
    }

    const nextRecords = new Map(this.records);
    const retainedKeys = new Set(retainedBindings.map(key));
    const replacedProposalFences = new Set([
      ...effectiveReplacements.map(replacement => this.proposalFenceKey(replacement)),
      ...retainedBindings.map(binding => this.proposalFenceKey(binding)),
    ]);
    for (const [recordKey, record] of nextRecords) {
      if (
        replacedProposalFences.has(this.proposalFenceKey(record.snapshot)) &&
        record.operation.state === 'available' &&
        !replacementKeys.has(recordKey)
      ) {
        nextRecords.delete(recordKey);
      }
    }
    const updated: EstablishedProposalRecord[] = [];
    for (const record of current) {
      const replacement = effectiveReplacements.find(candidate => key(candidate) === key(record.snapshot));
      const next: EstablishedProposalRecord = retainedKeys.has(key(record.snapshot))
        ? { snapshot: record.snapshot, operation: { state: 'available' } }
        : replacement
          ? { snapshot: clone(replacement), operation: { state: 'available' } }
          : {
              ...record,
              operation: {
                ...(record.operation as EstablishedProposalMutationClaim),
                state: 'terminal',
                disposition: 'refined',
              },
            };
      nextRecords.set(key(record.snapshot), next);
      updated.push(next);
    }
    for (const replacement of effectiveReplacements) {
      const replacementKey = key(replacement);
      if (bindingKeys.includes(replacementKey)) continue;
      const next: EstablishedProposalRecord = { snapshot: clone(replacement), operation: { state: 'available' } };
      nextRecords.set(replacementKey, next);
      updated.push(next);
    }
    const nextBytes = [...nextRecords.values()].reduce((total, record) => total + this.sizeOf(record), 0);
    const sellerTaskId = current.flatMap(record =>
      record.operation.state === 'available' || record.operation.sellerTaskId === undefined
        ? []
        : [record.operation.sellerTaskId]
    )[0];
    const tombstone = {
      requestSignature,
      replacementSignature,
      request: clone(request),
      ...(sellerTaskId && { sellerTaskId }),
      records: updated.map(clone),
    };
    const tombstoneBytes = Buffer.byteLength(JSON.stringify(tombstone), 'utf8');
    if (
      nextRecords.size + this.completedRefinements.size + 1 > this.maxRecords ||
      nextBytes + this.completedRefinementBytes + tombstoneBytes > this.maxBytes
    ) {
      return { outcome: 'capacity', records: current.map(clone) };
    }
    this.records.clear();
    this.recordBytes.clear();
    for (const [recordKey, record] of nextRecords) {
      const bytes = this.sizeOf(record);
      this.records.set(recordKey, clone(record));
      this.recordBytes.set(recordKey, bytes);
    }
    this.totalBytes = nextBytes;
    this.completedRefinements.set(request.claim.operationKey, tombstone);
    this.completedRefinementBytes += tombstoneBytes;
    this.operationIndex.delete(request.claim.operationKey);
    for (const replacement of effectiveReplacements) {
      const fenceKey = this.proposalFenceKey(replacement);
      if (this.proposalMutationIndex.get(fenceKey) === request.claim.operationKey) {
        this.proposalMutationIndex.delete(fenceKey);
      }
    }
    for (const retained of retainedBindings) {
      const fenceKey = this.proposalFenceKey(retained);
      if (this.proposalMutationIndex.get(fenceKey) === request.claim.operationKey) {
        this.proposalMutationIndex.delete(fenceKey);
      }
    }
    return { outcome: 'updated', records: updated.map(clone) };
  }

  async completeDecline(
    request: EstablishedProposalReserveRequest,
    retainedBindings: readonly EstablishedProposalMutationBinding[] = []
  ): Promise<EstablishedProposalTransitionResult> {
    const requestSignature = JSON.stringify(
      request.bindings
        .map(binding => [key(binding), binding.snapshotFingerprint])
        .sort(([left], [right]) => left!.localeCompare(right!))
    );
    const replacementSignature = JSON.stringify({
      declined: true,
      retained: retainedBindings
        .map(binding => [key(binding), binding.snapshotFingerprint])
        .sort(([left], [right]) => left!.localeCompare(right!)),
    });
    const completed = this.completedRefinements.get(request.claim.operationKey);
    if (completed) {
      return completed.request.claim.operation === request.claim.operation &&
        completed.request.claim.requestFingerprint === request.claim.requestFingerprint &&
        completed.request.claim.idempotencyKey === request.claim.idempotencyKey &&
        completed.requestSignature === requestSignature &&
        completed.replacementSignature === replacementSignature
        ? { outcome: 'updated', records: completed.records.map(clone) }
        : { outcome: 'conflict', records: completed.records.map(clone) };
    }
    const bindingKeys = [...new Set(request.bindings.map(key))].sort();
    const current = bindingKeys.flatMap(recordKey => {
      const record = this.records.get(recordKey);
      return record ? [record] : [];
    });
    const retainedKeys = new Set(retainedBindings.map(key));
    if (
      request.claim.operation !== 'decline' ||
      current.length !== bindingKeys.length ||
      retainedBindings.some(
        retained =>
          !request.bindings.some(
            binding => key(binding) === key(retained) && binding.snapshotFingerprint === retained.snapshotFingerprint
          )
      ) ||
      !current.every(record => canAuthoritativelySettle(record.operation, request.claim))
    ) {
      return { outcome: current.length === bindingKeys.length ? 'conflict' : 'missing', records: current.map(clone) };
    }
    const updated = current.map<EstablishedProposalRecord>(record =>
      retainedKeys.has(key(record.snapshot))
        ? { snapshot: record.snapshot, operation: { state: 'available' } }
        : {
            ...record,
            operation: {
              ...(record.operation as EstablishedProposalMutationClaim),
              state: 'terminal',
              disposition: 'declined',
            },
          }
    );
    const nextBytes = updated.reduce((total, record) => total + this.sizeOf(record), 0);
    const priorBytes = bindingKeys.reduce((total, recordKey) => total + (this.recordBytes.get(recordKey) ?? 0), 0);
    const sellerTaskId = current.flatMap(record =>
      record.operation.state === 'available' || record.operation.sellerTaskId === undefined
        ? []
        : [record.operation.sellerTaskId]
    )[0];
    const tombstone = {
      requestSignature,
      replacementSignature,
      request: clone(request),
      ...(sellerTaskId && { sellerTaskId }),
      records: updated.map(clone),
    };
    const tombstoneBytes = Buffer.byteLength(JSON.stringify(tombstone), 'utf8');
    if (
      this.records.size + this.completedRefinements.size + 1 > this.maxRecords ||
      this.totalBytes - priorBytes + nextBytes + this.completedRefinementBytes + tombstoneBytes > this.maxBytes
    ) {
      return { outcome: 'capacity', records: current.map(clone) };
    }
    if (!this.replaceMany(updated.map((record, index) => [bindingKeys[index]!, record]))) {
      return { outcome: 'capacity', records: current.map(clone) };
    }
    this.completedRefinements.set(request.claim.operationKey, tombstone);
    this.completedRefinementBytes += tombstoneBytes;
    this.operationIndex.delete(request.claim.operationKey);
    for (const retained of retainedBindings) {
      const fenceKey = this.proposalFenceKey(retained);
      if (this.proposalMutationIndex.get(fenceKey) === request.claim.operationKey) {
        this.proposalMutationIndex.delete(fenceKey);
      }
    }
    return { outcome: 'updated', records: updated.map(clone) };
  }

  async releaseMutation(request: EstablishedProposalReserveRequest): Promise<EstablishedProposalTransitionResult> {
    const current = request.bindings.flatMap(binding => {
      const record = this.records.get(key(binding));
      return record ? [record] : [];
    });
    if (
      current.some(
        record => record.operation.state === 'terminal' && !canAuthoritativelySettle(record.operation, request.claim)
      )
    ) {
      return { outcome: 'conflict', records: current.map(clone) };
    }
    const result = this.transition(
      request,
      record => ({ ...record, operation: { state: 'available' } }),
      new Set(['reserved', 'retryable', 'terminal'])
    );
    if (result.outcome === 'updated') {
      this.operationIndex.delete(request.claim.operationKey);
      request.bindings.forEach(binding => {
        const fenceKey = this.proposalFenceKey(binding);
        if (this.proposalMutationIndex.get(fenceKey) === request.claim.operationKey) {
          this.proposalMutationIndex.delete(fenceKey);
        }
      });
    }
    return result;
  }

  async recordSubmittedTask(
    request: EstablishedProposalReserveRequest,
    sellerTaskId: string
  ): Promise<EstablishedProposalTransitionResult> {
    const conflict = request.bindings.some(binding => {
      const operation = this.records.get(key(binding))?.operation;
      const duplicateCompletedTask = [...this.completedRefinements.values()].some(
        completed =>
          completed.sellerTaskId === sellerTaskId &&
          completed.request.claim.operationKey !== request.claim.operationKey &&
          completed.request.bindings.some(
            completedBinding =>
              completedBinding.principalScope === binding.principalScope &&
              completedBinding.sellerScope === binding.sellerScope &&
              completedBinding.sourceAdcpVersion === binding.sourceAdcpVersion &&
              completedBinding.accountScope === binding.accountScope
          )
      );
      const duplicateTask = [...this.records.values()].some(
        record =>
          sameScope(record, binding) &&
          record.snapshot.accountScope === binding.accountScope &&
          record.operation.state !== 'available' &&
          record.operation.sellerTaskId === sellerTaskId &&
          record.operation.operationKey !== request.claim.operationKey
      );
      return (
        duplicateCompletedTask ||
        duplicateTask ||
        (operation &&
          operation.state !== 'available' &&
          operation.sellerTaskId &&
          operation.sellerTaskId !== sellerTaskId)
      );
    });
    if (conflict) {
      return {
        outcome: 'conflict',
        records: request.bindings.flatMap(binding => {
          const record = this.records.get(key(binding));
          return record ? [clone(record)] : [];
        }),
      };
    }
    return this.transition(request, record => ({
      ...record,
      operation: record.operation.state === 'available' ? record.operation : { ...record.operation, sellerTaskId },
    }));
  }

  async markAmbiguous(
    request: EstablishedProposalReserveRequest,
    ambiguity: 'paused' | 'commit-uncertain'
  ): Promise<EstablishedProposalTransitionResult> {
    const now = this.clock().getTime();
    return this.transition(request, record => ({
      ...record,
      operation:
        record.operation.state === 'available'
          ? record.operation
          : record.operation.idempotencyKey && validFuture(record.operation.retryExpiresAt, now)
            ? { ...record.operation, state: 'retryable', ambiguity }
            : { ...record.operation, state: 'terminal', disposition: 'commit-uncertain' },
    }));
  }
}

export function createInMemoryEstablishedProposalStore(
  options: InMemoryEstablishedProposalStoreOptions = {}
): EstablishedProposalStore {
  return new InMemoryEstablishedProposalStore(options);
}
