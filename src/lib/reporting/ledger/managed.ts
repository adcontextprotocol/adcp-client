import { createHash, randomUUID } from 'node:crypto';

import type {
  ReportingAdjustmentReceipt,
  ReportingDeliveryCapabilities,
  ReportingMaterialization,
  ReportingReceipt,
  ReportingResource,
  ReportingVerification,
  SyncReportingReceiptsResponse,
} from '../../types';
import { ReportingDeliveryCapabilitiesSchema, ReportingMaterializationSchema } from '../../types/schemas.generated';
import { canonicalize } from '../../utils/jcs';
import { getSchemaValidatorByRef } from '../../validation/schema-loader';
import {
  isReportingAdjustmentReceiptEvidence,
  isReportingReceiptEvidence,
  isReportingVerificationEvidence,
} from '../evidence';
import type { AdcpToolMap } from '../../server/create-adcp-server';
import { AdcpError } from '../../server/decisioning/async-outcome';
import { createReportingDeliveryHandler, createReportingStatusHandler } from './handler';
import type { ReportingStatusConsumerScopeOptionsV1 } from './handler';
import type {
  ReportingLedgerAdjustmentV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionV1,
  ReportingLedgerStore,
  ReportingManagedDeliveryBindingV1,
} from './types';

const DEFAULT_LEASE_MILLISECONDS = 65_000;
const DEFAULT_DELIVERY_DEADLINE_MILLISECONDS = 60_000;
const MINIMUM_SETTLEMENT_GRACE_MILLISECONDS = 5_000;
const DEFAULT_RESOURCE_MAX_BYTES = 64 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
/** RC3 `maxItems` on `receipts` and on `adjustment_receipts`, applied separately. */
const MAX_RECEIPTS_PER_ARRAY = 100;
/** RC3 `maxItems` on the response `results` array. */
const MAX_RECEIPT_RESULTS = 100;

export interface ReportingDestinationAuthorizationV1 {
  account_id: string;
  destination_ref: string;
  generation: number;
  authorized_at: string;
  revoked_at?: string;
  cleanup_completed_at?: string;
}

export interface ReportingManagedDeliveryLeaseV1 {
  materialization: ReportingMaterialization;
  binding: ReportingManagedDeliveryBindingV1;
  obligation: ReportingLedgerObligationV1;
  revision: ReportingLedgerRevisionV1;
  owner: string;
  generation: number;
  expires_at: string;
}

export interface ReportingDestinationRevocationLeaseV1 {
  authorization: ReportingDestinationAuthorizationV1;
  owner: string;
  generation: number;
  expires_at: string;
  /**
   * SLA facts as the ledger's own clock sees them.
   *
   * The advertised window is measured from the instant the revocation was
   * committed, so deciding whether a grant is still inside it on the worker's
   * host clock lets skew silently extend or collapse the promise. A store
   * that can compute them reports them here; `overdue` is true at the exact
   * boundary, because the window is elapsed once it has been reached.
   */
  revoked_at?: string;
  overdue?: boolean;
  remaining_milliseconds?: number;
}

export type ReportingReceiptBatchEntryV1 =
  | { kind: 'revision'; receipt: ReportingReceipt }
  | { kind: 'adjustment'; receipt: ReportingAdjustmentReceipt };

export interface ReportingReceiptBatchInputV1 {
  account_id: string;
  consumer_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  entries: ReportingReceiptBatchEntryV1[];
  received_at: string;
}

export interface ReportingManagedDeliveryStore {
  /**
   * Prove that this store shares the supplied Core authority and has its
   * durable schema installed. Throw an actionable configuration error when
   * either condition is false; return true only after an operational probe.
   */
  probe(coreStore: ReportingLedgerStore): Promise<boolean>;
  /** Recovery windows of the Core configurations that have installed managed bindings. */
  listInstalledRecoveryWindowSeconds(): Promise<number[]>;
  /**
   * Records the agent-wide advertised recovery window so the store can hold
   * later binding installs to it.
   *
   * Optional for compatibility. A store without it is validated only against
   * the bindings present at startup, which leaves a binding installed later
   * free to exceed the published bound until the next restart.
   */
  adoptAdvertisedRecoveryWindowSeconds?(seconds: number): Promise<void>;
  /**
   * Durably registers the advertised `status_retention_days`.
   *
   * Every advertised retention promise must be registered before it is
   * published, or a store configured with shorter evidence retention will
   * happily prune inside a horizon this runtime is advertising.
   */
  adoptAdvertisedStatusRetentionDays?(days: number): Promise<void>;
  authorizeDestination(
    input: Omit<ReportingDestinationAuthorizationV1, 'revoked_at' | 'cleanup_completed_at'>
  ): Promise<void>;
  revokeDestination(input: {
    account_id: string;
    destination_ref: string;
    generation: number;
    revoked_at: string;
  }): Promise<boolean>;
  installBinding(binding: ReportingManagedDeliveryBindingV1): Promise<{ inserted: boolean }>;
  planMaterializations(input?: { account_id?: string; limit?: number }): Promise<number>;
  /**
   * Fails materializations that have used every delivery attempt.
   *
   * The claim predicate stops handing them out, so without a sweep they stay
   * `pending` forever — and the planner skips any obligation with a pending
   * row, so the revision is never retried or replanned either.
   */
  failExhaustedMaterializations?(input?: { account_id?: string; limit?: number }): Promise<number>;
  claimMaterialization(input: {
    owner: string;
    now: string;
    lease_milliseconds: number;
    account_id?: string;
  }): Promise<ReportingManagedDeliveryLeaseV1 | null>;
  settleMaterialization(input: {
    lease: ReportingManagedDeliveryLeaseV1;
    now: string;
    /**
     * Retention the store must see satisfied on its own clock.
     *
     * The worker checks it too, but a worker running behind would otherwise
     * accept a resource the database already considers under-retained.
     */
    minimum_resource_retention_days?: number;
    outcome:
      | { status: 'available' | 'delivered'; resource: ReportingResource; verification: ReportingVerification }
      | { status: 'failed'; failure_code: string };
  }): Promise<boolean>;
  claimRevocation(input: {
    owner: string;
    now: string;
    lease_milliseconds: number;
    account_id?: string;
    /** Advertised window, so the store can compute SLA facts on its own clock. */
    authorization_revocation_seconds?: number;
  }): Promise<ReportingDestinationRevocationLeaseV1 | null>;
  completeRevocation(input: { lease: ReportingDestinationRevocationLeaseV1; completed_at: string }): Promise<boolean>;
  /**
   * Releases a cleanup lease after a failed attempt so the grant is
   * immediately reclaimable.
   *
   * Required, not optional: without it a failed attempt keeps its lease as
   * the retry delay, which defers the next attempt and hides an overdue grant
   * behind a lease that has not expired. `claimRevocation` orders by
   * `cleanup_lease_generation`, and a failed attempt has already incremented
   * it, so releasing cannot let one broken grant starve the queue.
   */
  releaseRevocation(input: {
    lease: ReportingDestinationRevocationLeaseV1;
    /** Holds the grant out of selection briefly so a retry is not a tight loop. */
    backoff_milliseconds?: number;
  }): Promise<boolean>;
  getReadableResource(input: {
    account_id: string;
    resource_ref: string;
  }): Promise<{ materialization: ReportingMaterialization; binding: ReportingManagedDeliveryBindingV1 } | null>;
  isAuthorizationCurrent(input: { account_id: string; destination_ref: string; generation: number }): Promise<boolean>;
  syncReceiptBatch(input: ReportingReceiptBatchInputV1): Promise<SyncReportingReceiptsResponse['results']>;
}

export interface ReportingManagedDeliveryAdapterV1 {
  /** Profiles this installed adapter can actually verify through its consumer/destination path. */
  readonly verificationProfiles: readonly ReportingVerification['verification_profile'][];
  /** Provider revoke installs a generation tombstone that fences late writes. */
  readonly revocationFencesDeliveryGenerations: true;
  deliver(
    input: Readonly<{
      materialization: ReportingMaterialization;
      binding: ReportingManagedDeliveryBindingV1;
      obligation: ReportingLedgerObligationV1;
      revision: ReportingLedgerRevisionV1;
      maxBytes: number;
    }>,
    context: { signal: AbortSignal }
  ): Promise<{ status: 'available' | 'delivered'; resource: ReportingResource; verification: ReportingVerification }>;
  read(
    input: Readonly<{
      materialization: ReportingMaterialization;
      binding: ReportingManagedDeliveryBindingV1;
      resource: ReportingResource;
      maxBytes: number;
    }>,
    context: { signal: AbortSignal }
  ): Promise<Uint8Array>;
  /** Remove seller-controlled provider grants. The durable deny is committed before this call. */
  revoke(
    input: Readonly<{ authorization: ReportingDestinationAuthorizationV1 }>,
    context: { signal: AbortSignal }
  ): Promise<void>;
}

export interface ReportingManagedDeliveryWorkerOptionsV1 {
  signal?: AbortSignal;
  now?: () => Date;
  maxIterations?: number;
  leaseMilliseconds?: number;
  deliveryDeadlineMilliseconds?: number;
  resourceMaxBytes?: number;
  /** Capability minimum enforced in addition to each immutable binding. */
  minimumResourceRetentionDays?: number;
  /**
   * Mirror of the advertised `authorization_revocation_seconds`. Supplying it
   * makes the scheduler honour the promise instead of merely printing it: a
   * cleanup attempt is never given a budget that would run past
   * `revoked_at + authorizationRevocationSeconds`, a failed attempt never holds
   * a retry lease longer than the whole promised window, and a grant that has
   * already outlived the window is counted in `revocationsOverdue` so the
   * breach is observable rather than silent. Omit it only for a worker that is
   * not backing an advertised capability.
   */
  authorizationRevocationSeconds?: number;
  account_id?: string;
}

export interface CreateReportingManagedDeliveryRuntimeOptionsV1<
  TContext extends { account?: unknown } = { account?: unknown },
> {
  coreStore: ReportingLedgerStore;
  store: ReportingManagedDeliveryStore;
  adapter: ReportingManagedDeliveryAdapterV1;
  offerings: ReportingDeliveryCapabilities['offerings'];
  automatedRecoveryWindowSeconds: number;
  statusRetentionDays: number;
  resourceRetentionDays: number;
  authorizationRevocationSeconds: number;
  resolveConsumerId?: (context: TContext) => string | Promise<string>;
  consumerMismatchEscalation?: ReportingStatusConsumerScopeOptionsV1<TContext>['consumerMismatchEscalation'];
}

export interface ReportingManagedDeliveryRuntimeV1<TContext extends { account?: unknown } = { account?: unknown }> {
  reportingDeliveryCapabilities: ReportingDeliveryCapabilities;
  getReportingStatus: ReturnType<typeof createReportingStatusHandler<TContext>>;
  getMediaBuyDelivery: ReturnType<typeof createReportingDeliveryHandler>;
  syncReportingReceipts?: (
    request: AdcpToolMap['sync_reporting_receipts']['params'],
    context: TContext & { account?: unknown }
  ) => Promise<SyncReportingReceiptsResponse>;
  runWorker(options?: ReportingManagedDeliveryWorkerOptionsV1): Promise<{
    planned: number;
    claimed: number;
    delivered: number;
    failed: number;
    revocationsCompleted: number;
    revocationsOverdue: number;
    /** Materializations failed for using every delivery attempt. */
    exhausted: number;
  }>;
  readResource(input: {
    account_id: string;
    resource_ref: string;
    signal?: AbortSignal;
    maxBytes?: number;
    deadlineMilliseconds?: number;
  }): Promise<Uint8Array | null>;
}

/**
 * Wires all operational components before returning any Managed Delivery
 * capability claim. A missing receipt principal resolver limits the runtime to
 * Managed Delivery even if a consumer-receipt offering was supplied.
 */
export async function createReportingManagedDeliveryRuntime<
  TContext extends { account?: unknown } = { account?: unknown },
>(
  options: CreateReportingManagedDeliveryRuntimeOptionsV1<TContext>
): Promise<ReportingManagedDeliveryRuntimeV1<TContext>> {
  if (!(await options.store.probe(options.coreStore))) {
    throw new Error('Managed reporting store is not operational for the configured Core authority');
  }
  nonnegativeInteger(options.automatedRecoveryWindowSeconds, 'automatedRecoveryWindowSeconds');
  // `automated_recovery_window_seconds` is published once per agent, in one
  // capability document, while Core recovery windows are per configuration.
  // Requiring the advertised value to equal every installed window was
  // therefore unsatisfiable for any agent serving two tenants on different
  // windows — and since a capability document cannot be split per tenant,
  // "run one runtime per cohort" only worked for a seller willing to run one
  // endpoint per cohort. It also refused to start with no binding installed,
  // which a fresh deployment always has, and which is the state a deployment
  // returns to when its last managed tenant offboards.
  //
  // The advertised value is a maximum: "the maximum late interval during which
  // a due obligation may remain delayed while automated recovery continues
  // before action_required". Going action_required sooner than advertised
  // honours it; going later does not. So one agent-wide value is truthful
  // exactly when it is at least every installed window, and the conservative
  // agent-wide policy is to require that bound and nothing more.
  // Hand the store the bound before reading the installed set, so a binding
  // racing this wiring is already held to it rather than slipping in between
  // the check and the first enforced install.
  // Awaited, and before anything is published. These calls can reject — a
  // replica registering a different window over the same database is refused
  // — and firing them without awaiting let a runtime publish a capability
  // document whose promise the registry had already rejected.
  await options.store.adoptAdvertisedRecoveryWindowSeconds?.(options.automatedRecoveryWindowSeconds);
  const installedRecoveryWindows = await options.store.listInstalledRecoveryWindowSeconds();
  const widestInstalledWindow = installedRecoveryWindows.reduce((widest, value) => Math.max(widest, value), 0);
  if (options.automatedRecoveryWindowSeconds < widestInstalledWindow) {
    throw new Error(
      `automatedRecoveryWindowSeconds must be at least the widest installed managed Core recovery window ` +
        `(${widestInstalledWindow}s); advertising ${options.automatedRecoveryWindowSeconds}s would promise a ` +
        `recovery bound this deployment does not keep for every tenant`
    );
  }
  positiveInteger(options.statusRetentionDays, 'statusRetentionDays');
  // Register the retention horizon too. Advertising 90 days while the durable
  // policy stayed null let a store built with 45 days of evidence retention
  // prune inside the horizon this runtime publishes.
  await options.store.adoptAdvertisedStatusRetentionDays?.(options.statusRetentionDays);
  positiveInteger(options.resourceRetentionDays, 'resourceRetentionDays');
  nonnegativeInteger(options.authorizationRevocationSeconds, 'authorizationRevocationSeconds');
  if (
    typeof options.adapter.deliver !== 'function' ||
    typeof options.adapter.read !== 'function' ||
    typeof options.adapter.revoke !== 'function' ||
    options.adapter.revocationFencesDeliveryGenerations !== true
  ) {
    throw new Error(
      'Managed Delivery requires delivery, resource-reader, and provider generation-fencing revocation components'
    );
  }
  assertManagedOfferings(options.offerings);
  if (!options.offerings.length || !options.offerings.some(offering => offering.method !== undefined)) {
    throw new Error('Managed Delivery requires at least one atomic managed offering');
  }
  const reconciledOfferings = options.offerings.filter(offering => offering.reconciliation_mode === 'consumer_receipt');
  if (!options.adapter.verificationProfiles.length) {
    throw new Error('Managed Delivery requires an installed verification profile');
  }
  if (
    reconciledOfferings.length > 0 &&
    (options.resolveConsumerId === undefined || !options.adapter.verificationProfiles.includes('canonical_digest'))
  ) {
    throw new Error(
      'Consumer-receipt offerings require an authenticated receipt handler and canonical-digest verifier'
    );
  }
  const reconciledBilling = reconciledOfferings.length > 0;
  for (const offering of reconciledOfferings) {
    const profile = offering.reporting_profile;
    if (!profile.canonicalization_id || !profile.canonicalization_uri || !profile.canonicalization_sha256) {
      throw new Error('Reconciled Billing offerings require the pinned canonicalization contract');
    }
  }
  const statusOptions = options.resolveConsumerId
    ? {
        resolveConsumerId: options.resolveConsumerId,
        ...(options.consumerMismatchEscalation
          ? { consumerMismatchEscalation: options.consumerMismatchEscalation }
          : {}),
      }
    : undefined;
  const getReportingStatus = createReportingStatusHandler(options.coreStore, statusOptions);
  const getMediaBuyDelivery = createReportingDeliveryHandler(options.coreStore);
  const syncReportingReceipts = reconciledBilling
    ? createSyncReportingReceiptsHandler(options.store, options.resolveConsumerId!)
    : undefined;
  const reportingDeliveryCapabilities: ReportingDeliveryCapabilities = {
    supported: true,
    reliable_reporting_version: '1.0',
    managed_delivery: true,
    ...(reconciledBilling ? { reconciled_billing: true, receipt_task: 'sync_reporting_receipts' as const } : {}),
    configuration_task: 'sync_accounts',
    status_task: 'get_reporting_status',
    revision_content_task: 'get_media_buy_delivery',
    offerings: [...options.offerings] as ReportingDeliveryCapabilities['offerings'],
    automated_recovery_window_seconds: options.automatedRecoveryWindowSeconds,
    status_retention_days: options.statusRetentionDays,
    resource_retention_days: options.resourceRetentionDays,
    authorization_revocation_seconds: options.authorizationRevocationSeconds,
  };
  const parsedCapabilities = ReportingDeliveryCapabilitiesSchema.safeParse(reportingDeliveryCapabilities);
  if (!parsedCapabilities.success) {
    throw new Error(
      `Managed Delivery capability wiring is invalid: ${parsedCapabilities.error.issues[0]?.message ?? 'invalid'}`
    );
  }

  return {
    reportingDeliveryCapabilities,
    getReportingStatus,
    getMediaBuyDelivery,
    ...(syncReportingReceipts ? { syncReportingReceipts } : {}),
    runWorker: workerOptions =>
      runManagedDeliveryWorker(options.store, options.adapter, {
        ...workerOptions,
        minimumResourceRetentionDays: Math.max(
          options.resourceRetentionDays,
          workerOptions?.minimumResourceRetentionDays ?? 0
        ),
        // The capability block is the promise; the worker is what keeps it.
        // A caller may only tighten the advertised window, never widen it.
        authorizationRevocationSeconds: Math.min(
          options.authorizationRevocationSeconds,
          workerOptions?.authorizationRevocationSeconds ?? options.authorizationRevocationSeconds
        ),
      }),
    readResource: input => readManagedReportingResource(options.store, options.adapter, input),
  };
}

export function createSyncReportingReceiptsHandler<TContext extends { account?: unknown }>(
  store: ReportingManagedDeliveryStore,
  resolveConsumerId: (context: TContext) => string | Promise<string>,
  now: () => Date = () => new Date()
) {
  return async (
    request: AdcpToolMap['sync_reporting_receipts']['params'],
    context: TContext
  ): Promise<SyncReportingReceiptsResponse> => {
    const account_id = resolvedAccountId(context.account);
    const consumer_id = await resolveConsumerId(context);
    if (!consumer_id || consumer_id.length > 255) {
      throw new TypeError('resolveConsumerId must return a durable authenticated principal of at most 255 characters');
    }
    // These handlers are exported and adopters call them directly, and
    // `requestValidationMode` defaults to 'off' in production, so the framework
    // cannot be assumed to have shape-checked anything. Refuse a malformed
    // request with the repository's typed envelope instead of letting a
    // TypeError escape from `.map` or a destructure.
    if (request.receipts !== undefined && !Array.isArray(request.receipts)) {
      throw new AdcpError('VALIDATION_ERROR', { message: 'sync_reporting_receipts receipts must be an array' });
    }
    if (request.adjustment_receipts !== undefined && !Array.isArray(request.adjustment_receipts)) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts adjustment_receipts must be an array',
      });
    }
    const revisionReceipts = request.receipts ?? [];
    const adjustmentReceipts = request.adjustment_receipts ?? [];
    if (!revisionReceipts.every(isRecord) || !adjustmentReceipts.every(isRecord)) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts entries must be objects',
      });
    }
    // RC3 caps `receipts` and `adjustment_receipts` at 100 each in JSON Schema,
    // so each array is checked against its own cap. An over-cap array cannot be
    // answered per item either, because `results` is itself capped at 100, so
    // it is refused as a request error rather than as a non-conformant body.
    // The separate combined bound is enforced below.
    if (revisionReceipts.length > MAX_RECEIPTS_PER_ARRAY || adjustmentReceipts.length > MAX_RECEIPTS_PER_ARRAY) {
      throw new AdcpError('VALIDATION_ERROR', {
        message:
          `sync_reporting_receipts accepts at most ${MAX_RECEIPTS_PER_ARRAY} receipts and ` +
          `${MAX_RECEIPTS_PER_ARRAY} adjustment receipts per request`,
      });
    }
    // `received_at` is server-authoritative: the request schema does not
    // allow it, and this handler stamps it from the database clock. Stripping
    // a caller-supplied one before validating meant a payload the schema
    // forbids — `received_at: 'invalid'` beside an otherwise valid receipt —
    // was silently repaired and stored. Refuse the request instead; sanitising
    // input the contract rejects hides the caller's bug and makes the two
    // validation paths disagree about what a valid request is.
    if ([...revisionReceipts, ...adjustmentReceipts].some(receipt => 'received_at' in receipt)) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts receipts must not carry received_at; it is assigned by the server',
      });
    }
    const entries: ReportingReceiptBatchEntryV1[] = [
      ...revisionReceipts.map(receipt => ({ kind: 'revision' as const, receipt: receipt as ReportingReceipt })),
      ...adjustmentReceipts.map(receipt => ({
        kind: 'adjustment' as const,
        receipt: receipt as ReportingAdjustmentReceipt,
      })),
    ];
    // RC3 bounds the batch as a whole too, in the request's
    // `x-adcp-validation.batch_identity`: receipt ids "MUST be unique across
    // receipts and adjustment_receipts, whose combined length MUST NOT exceed
    // 100". That bound is normative prose: JSON Schema encodes only the two
    // per-array caps, and `x-adcp-validation` is registered as an AJV keyword
    // for commercial-terms only, not on the reporting validation path. So this
    // check is the only thing enforcing it — do not delete it as redundant
    // with schema validation. A 200-entry request is schema-clean but
    // spec-invalid, and unanswerable regardless, since `results` is capped at
    // 100 while one result per submitted receipt is required.
    if (entries.length > MAX_RECEIPT_RESULTS) {
      throw new AdcpError('VALIDATION_ERROR', {
        message:
          `sync_reporting_receipts can return at most ${MAX_RECEIPT_RESULTS} results, so a request may carry at most ` +
          `${MAX_RECEIPT_RESULTS} receipts and adjustment receipts in total`,
      });
    }
    // RC3 requires `results` minItems 1 and the request anyOf requires a
    // non-empty array, so an empty batch has no legal response body either.
    // This is checked before every per-entry refusal below, because those
    // answer with one result per entry: an empty batch that also named the
    // wrong account returned `results: []`, which is schema-invalid, so the
    // caller got a malformed body instead of a typed error.
    if (!entries.length) {
      throw new AdcpError('VALIDATION_ERROR', {
        message: 'sync_reporting_receipts requires at least one receipt or adjustment receipt',
      });
    }
    if (request.account && 'account_id' in request.account && request.account.account_id !== account_id) {
      return receiptBatchFailure(entries, 'PERMISSION_DENIED', 'Reporting receipt account is unavailable');
    }
    if (!/^[A-Za-z0-9_.:-]{16,255}$/.test(request.idempotency_key)) {
      return receiptBatchFailure(entries, 'VALIDATION_ERROR', 'sync_reporting_receipts idempotency_key is invalid');
    }
    // Duplicate identity is a property of the submitted batch, not of the
    // subset that happens to be well formed. Checking it after filtering let
    // one valid and one malformed entry share a receipt id and still mutate
    // state, which is exactly the collision the rule exists to stop.
    const submittedIds = entries.map(entry =>
      isRecord(entry.receipt) && typeof entry.receipt.reporting_receipt_id === 'string'
        ? entry.receipt.reporting_receipt_id
        : ''
    );
    const duplicateSubmittedIds = new Set(
      submittedIds.filter((value, index) => value !== '' && submittedIds.indexOf(value) !== index)
    );
    if (duplicateSubmittedIds.size) {
      return receiptBatchFailure(
        entries,
        'VALIDATION_ERROR',
        'sync_reporting_receipts receipt IDs must be unique across the batch'
      );
    }
    const valid = entries.map(
      entry =>
        (entry.kind === 'revision'
          ? isReportingReceiptEvidence(entry.receipt)
          : isReportingAdjustmentReceiptEvidence(entry.receipt)) &&
        Buffer.byteLength(JSON.stringify(entry.receipt), 'utf8') <= 64 * 1024
    );
    const validEntries = entries.filter((_, index) => valid[index]);
    const request_fingerprint = sha256({ entries });
    const stored = validEntries.length
      ? await store.syncReceiptBatch({
          account_id,
          consumer_id,
          idempotency_key: request.idempotency_key,
          request_fingerprint,
          entries: validEntries,
          received_at: now().toISOString(),
        })
      : [];
    let storedIndex = 0;
    return {
      status: 'completed',
      results: entries.map((entry, index) =>
        valid[index]
          ? stored[storedIndex++]!
          : receiptFailure(
              reflectableReceiptId(entry.receipt.reporting_receipt_id, index),
              'VALIDATION_ERROR',
              'Reporting receipt evidence is invalid or exceeds 64 KiB'
            )
      ),
    };
  };
}

function receiptBatchFailure(
  entries: ReportingReceiptBatchEntryV1[],
  code: 'PERMISSION_DENIED' | 'VALIDATION_ERROR',
  message: string
): SyncReportingReceiptsResponse {
  return {
    status: 'completed',
    results: entries.map((entry, index) =>
      receiptFailure(reflectableReceiptId(entry.receipt.reporting_receipt_id, index), code, message)
    ),
  };
}

const RECEIPT_ID_PATTERN = /^[A-Za-z0-9_.:-]{16,255}$/;

/**
 * `results[].reporting_receipt_id` is pattern- and length-constrained, so a
 * caller-supplied id can only be echoed when it already satisfies the wire
 * contract. Anything else — absent, non-string, 3,000 characters, or carrying
 * characters outside the class — is replaced by a positional placeholder, which
 * keeps a malformed request from steering the shape of our own response.
 */
function reflectableReceiptId(value: unknown, index: number): string {
  return typeof value === 'string' && RECEIPT_ID_PATTERN.test(value)
    ? value
    : `unidentified-reporting-receipt-${String(index).padStart(3, '0')}`;
}

function receiptFailure(
  reporting_receipt_id: string,
  code: 'PERMISSION_DENIED' | 'VALIDATION_ERROR',
  message: string
): SyncReportingReceiptsResponse['results'][number] {
  return {
    result: 'failed',
    reporting_receipt_id,
    errors: [{ code, message, recovery: 'correctable' }],
  };
}

export async function runManagedDeliveryWorker(
  store: ReportingManagedDeliveryStore,
  adapter: ReportingManagedDeliveryAdapterV1,
  options: ReportingManagedDeliveryWorkerOptionsV1 = {}
) {
  const now = options.now ?? (() => new Date());
  const maxIterations = options.maxIterations ?? 25;
  const leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
  const deadlineMilliseconds = options.deliveryDeadlineMilliseconds ?? DEFAULT_DELIVERY_DEADLINE_MILLISECONDS;
  const resourceMaxBytes = options.resourceMaxBytes ?? DEFAULT_RESOURCE_MAX_BYTES;
  const minimumResourceRetentionDays = options.minimumResourceRetentionDays ?? 1;
  positiveInteger(maxIterations, 'maxIterations');
  positiveInteger(leaseMilliseconds, 'leaseMilliseconds');
  positiveInteger(deadlineMilliseconds, 'deliveryDeadlineMilliseconds');
  positiveInteger(resourceMaxBytes, 'resourceMaxBytes');
  positiveInteger(minimumResourceRetentionDays, 'minimumResourceRetentionDays');
  if (leaseMilliseconds < deadlineMilliseconds + MINIMUM_SETTLEMENT_GRACE_MILLISECONDS) {
    throw new RangeError('leaseMilliseconds must include at least 5 seconds of post-delivery settlement grace');
  }
  if (options.authorizationRevocationSeconds !== undefined) {
    nonnegativeInteger(options.authorizationRevocationSeconds, 'authorizationRevocationSeconds');
  }
  const revocationWindow =
    options.authorizationRevocationSeconds === undefined ? undefined : options.authorizationRevocationSeconds * 1_000;
  // A failed cleanup keeps its lease as the retry delay, so the lease is also
  // the retry interval, and a lease as long as the whole advertised window
  // would defer a retry past the promise. Cap it at one attempt's worth
  // instead: the delivery deadline plus the settlement grace is the shortest
  // interval that cannot cut an in-flight attempt short, and it leaves the
  // rest of the window free for further retries.
  //
  // Deliberately NOT scaled by the advertised window. `authorization_
  // revocation_seconds` has a schema minimum of 0, and scaling by it turned a
  // legal zero-second promise into a 1 ms lease — which `completeRevocation`
  // fences with `cleanup_lease_expires_at > clock_timestamp()`, so cleanup
  // could never commit and the grant was stranded forever. The window governs
  // the SLA — when an attempt is clipped and when a grant counts as overdue —
  // and never the length of the lease that fences durable settlement.
  const revocationLeaseMilliseconds =
    revocationWindow === undefined
      ? leaseMilliseconds
      : Math.min(leaseMilliseconds, deadlineMilliseconds + MINIMUM_SETTLEMENT_GRACE_MILLISECONDS);
  const owner = `managed-reporting-${randomUUID()}`;
  // Before planning: a row that used every attempt is still `pending`, and
  // the planner skips an obligation that has one. Without this the revision
  // was stuck — not claimable, not replannable, not visibly failed.
  const exhausted =
    (await store.failExhaustedMaterializations?.({
      ...(options.account_id ? { account_id: options.account_id } : {}),
    })) ?? 0;
  const counts = {
    exhausted,
    planned: await store.planMaterializations({ ...(options.account_id ? { account_id: options.account_id } : {}) }),
    claimed: 0,
    delivered: 0,
    failed: 0,
    revocationsCompleted: 0,
    revocationsOverdue: 0,
  };

  for (let index = 0; index < maxIterations; index += 1) {
    options.signal?.throwIfAborted();
    const revocation = await store.claimRevocation({
      owner,
      now: now().toISOString(),
      lease_milliseconds: revocationLeaseMilliseconds,
      ...(options.account_id ? { account_id: options.account_id } : {}),
      ...(options.authorizationRevocationSeconds !== undefined
        ? {
            authorization_revocation_seconds: options.authorizationRevocationSeconds,
            // A holder is only displaced after it has had a full attempt's
            // worth of time, which recovers a crashed worker without letting
            // live workers steal from each other on an already-late grant.
            steal_after_milliseconds: deadlineMilliseconds + MINIMUM_SETTLEMENT_GRACE_MILLISECONDS,
          }
        : {}),
    });
    if (!revocation) break;
    // `authorization_revocation_seconds` is a maximum delay measured from the
    // instant authorization ended, so the bound belongs to the authorization,
    // not to the worker tick that happens to pick it up.
    // Prefer what the ledger computed on its own clock; fall back to the host
    // only for a store that cannot supply it.
    const remaining =
      revocation.remaining_milliseconds ?? remainingRevocationMilliseconds(revocation, revocationWindow, now());
    const overdue = revocation.overdue ?? (remaining !== undefined && remaining <= 0);
    if (overdue) counts.revocationsOverdue += 1;
    // Never give an attempt a budget that would itself run past the promised
    // instant. Once the window is already spent there is no bound left to
    // honour and withholding cleanup would strand the grant forever, so the
    // attempt gets its normal budget and the breach is counted instead.
    // Clipping bounds the attempt, never the settlement that follows it: the
    // lease above always covers deadline + grace regardless of the window.
    const attemptDeadline =
      remaining !== undefined && remaining > 0 ? Math.min(deadlineMilliseconds, remaining) : deadlineMilliseconds;
    try {
      await withinDeadline(
        signal => adapter.revoke({ authorization: revocation.authorization }, { signal }),
        attemptDeadline,
        'Reporting revocation deadline elapsed',
        options.signal
      );
      if (await store.completeRevocation({ lease: revocation, completed_at: now().toISOString() })) {
        counts.revocationsCompleted += 1;
      }
    } catch {
      // Release immediately rather than holding the lease as a backoff. The
      // lease is not an SLA instrument: holding it deferred the next attempt
      // by up to a full lease and left the grant unreclaimable, so a short
      // advertised window elapsed while the row still looked leased rather
      // than overdue and retry-eligible. Starvation is prevented by ordering
      // instead — `claimRevocation` sorts by `cleanup_lease_generation`, which
      // this failed attempt already incremented, so a repeatedly failing grant
      // is deprioritised behind every healthy one.
      // Backed off, not merely released: clearing the lease outright let the
      // next iteration of this same tick reclaim the same grant, so one
      // broken provider could consume every iteration and nothing else was
      // ever cleaned up.
      await store.releaseRevocation({ lease: revocation });
    }
  }

  for (let index = 0; index < maxIterations; index += 1) {
    options.signal?.throwIfAborted();
    const lease = await store.claimMaterialization({
      owner,
      now: now().toISOString(),
      lease_milliseconds: leaseMilliseconds,
      ...(options.account_id ? { account_id: options.account_id } : {}),
    });
    if (!lease) break;
    counts.claimed += 1;
    try {
      const outcome = await withinDeadline(
        signal =>
          adapter.deliver(
            {
              materialization: lease.materialization,
              binding: lease.binding,
              obligation: lease.obligation,
              revision: lease.revision,
              maxBytes: resourceMaxBytes,
            },
            { signal }
          ),
        deadlineMilliseconds,
        'Reporting delivery deadline elapsed',
        options.signal
      );
      assertMaterializationOutcome(lease, outcome, now().toISOString(), minimumResourceRetentionDays);
      if (
        await store.settleMaterialization({
          lease,
          now: now().toISOString(),
          outcome,
          minimum_resource_retention_days: Math.max(
            lease.binding.resource_retention_days,
            minimumResourceRetentionDays
          ),
        })
      )
        counts.delivered += 1;
      else counts.failed += 1;
    } catch {
      await store.settleMaterialization({
        lease,
        now: now().toISOString(),
        outcome: { status: 'failed', failure_code: 'DELIVERY_FAILED' },
      });
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * Milliseconds left in the advertised revocation window for one claimed grant,
 * or `undefined` when no window is being enforced or `revoked_at` is unusable.
 * Negative means the promise has already been broken.
 */
function remainingRevocationMilliseconds(
  revocation: ReportingDestinationRevocationLeaseV1,
  revocationWindow: number | undefined,
  now: Date
): number | undefined {
  if (revocationWindow === undefined) return undefined;
  const revokedAt = revocation.authorization.revoked_at;
  if (!revokedAt) return undefined;
  const revoked = Date.parse(revokedAt);
  if (!Number.isFinite(revoked)) return undefined;
  return revoked + revocationWindow - now.getTime();
}

export async function readManagedReportingResource(
  store: ReportingManagedDeliveryStore,
  adapter: ReportingManagedDeliveryAdapterV1,
  input: {
    account_id: string;
    resource_ref: string;
    signal?: AbortSignal;
    maxBytes?: number;
    deadlineMilliseconds?: number;
  }
): Promise<Uint8Array | null> {
  const maxBytes = input.maxBytes ?? DEFAULT_RESOURCE_MAX_BYTES;
  const deadlineMilliseconds = input.deadlineMilliseconds ?? DEFAULT_DELIVERY_DEADLINE_MILLISECONDS;
  positiveInteger(maxBytes, 'maxBytes');
  positiveInteger(deadlineMilliseconds, 'deadlineMilliseconds');
  const selected = await store.getReadableResource(input);
  const resource = selected?.materialization.resource;
  if (!selected || !resource) return null;
  const { binding, materialization } = selected;
  const bytes = await withinDeadline(
    // Adapter failure messages are provider strings: they vary by SDK version
    // and can carry endpoint or credential detail. Callers get one stable
    // sentence; the provider error stays reachable as `cause` for seller logs.
    // `Promise.resolve().then` rather than calling and chaining `.catch`: an
    // adapter that throws synchronously — a bad credential resolved eagerly,
    // a client constructed inside `read` — never produced a promise to attach
    // the handler to, so its raw provider message escaped this boundary.
    signal =>
      Promise.resolve()
        .then(() => adapter.read({ materialization, binding, resource, maxBytes }, { signal }))
        .catch((cause: unknown) => {
          throw new Error('Managed reporting resource read failed', { cause });
        }),
    deadlineMilliseconds,
    'Reporting resource read deadline elapsed',
    input.signal
  );
  if (bytes.byteLength > maxBytes) throw new RangeError('Managed reporting resource exceeds maxBytes');
  // Buffer before returning, then re-check durable authorization. A revoke
  // racing the provider read therefore discloses no bytes through this API.
  if (
    !(await store.isAuthorizationCurrent({
      account_id: input.account_id,
      destination_ref: binding.destination_ref,
      generation: binding.authorization_generation,
    }))
  ) {
    return null;
  }
  return bytes;
}

export function assertMaterializationOutcome(
  lease: ReportingManagedDeliveryLeaseV1,
  outcome: { status: 'available' | 'delivered'; resource: ReportingResource; verification: ReportingVerification },
  now: string,
  minimumResourceRetentionDays = lease.binding.resource_retention_days
): void {
  const parsed = ReportingMaterializationSchema.safeParse({
    ...lease.materialization,
    status: outcome.status,
    ready_at: now,
    resource: outcome.resource,
    verification: outcome.verification,
  });
  if (!parsed.success) {
    throw new Error(`Managed materialization evidence is invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  if (Buffer.byteLength(JSON.stringify(outcome), 'utf8') > MAX_DESCRIPTOR_BYTES) {
    throw new RangeError('Managed materialization descriptor exceeds 1 MiB');
  }
  if (outcome.verification.verification_profile !== lease.binding.verification_profile) {
    throw new Error('Materialization verification profile differs from the installed binding');
  }
  if (outcome.verification.row_count !== lease.revision.binding.rowCount) {
    throw new Error('Materialization verification row count differs from the Core revision');
  }
  if (!isReportingVerificationEvidence(outcome.verification)) {
    throw new Error('Materialization is missing evidence required by its verification profile');
  }
  if (
    canonicalJson(outcome.verification.control_totals) !== canonicalJson(lease.revision.wireRevision.control_totals)
  ) {
    throw new Error('Materialization verification control totals differ from the Core revision');
  }
  if (lease.binding.feed_purpose === 'billing' && lease.binding.verification_profile !== 'canonical_digest') {
    throw new Error('Billing materializations require canonical-digest verification');
  }
  if (
    (lease.binding.method === 'file_transfer' && outcome.resource.kind !== 'manifest') ||
    (lease.binding.method === 'dataset_share' &&
      (outcome.resource.kind !== 'dataset' || outcome.verification.verification_path !== 'representative_consumer')) ||
    (lease.binding.method === 'warehouse_materialization' &&
      (outcome.resource.kind !== 'warehouse_relation' || outcome.verification.verification_path !== 'destination'))
  ) {
    throw new Error('Materialization resource or verification path differs from its delivery method');
  }
  if (lease.binding.method === 'file_transfer' && !outcome.verification.physical_checksums?.length) {
    throw new Error('File-transfer materializations require physical checksums');
  }
  if (
    outcome.resource.kind === 'manifest' &&
    (outcome.resource.manifest_version !== '1.0' || !outcome.resource.manifest_sha256)
  ) {
    throw new Error('Manifest resources require immutable version and digest metadata');
  }
  const native = outcome.verification.native_commit_evidence;
  if (native !== undefined) {
    if (
      native.native_version_ref !== outcome.resource.native_version_ref ||
      native.observed_through !== outcome.verification.verification_path
    ) {
      throw new Error('Native commit evidence does not match the retained resource and verification path');
    }
  }
  // Retention is deliberately NOT judged here. `now` is the worker's clock,
  // and `settleMaterialization` already enforces the window in SQL against
  // the clock that stores the row — terminalizing the attempt when it fails.
  // Checking it twice against two clocks meant a worker running ahead of the
  // database refused an outcome the database would have accepted, turning a
  // good delivery into DELIVERY_FAILED for no reason but skew. The parameter
  // is kept so the exported signature is stable for adopters.
  void minimumResourceRetentionDays;
  if (outcome.verification.canonical_content_digest !== undefined) {
    const expected = lease.revision.wireRevision.canonical_content_digest;
    if (!expected || canonicalJson(outcome.verification.canonical_content_digest) !== canonicalJson(expected)) {
      throw new Error('Canonical materialization evidence does not match the official Core revision');
    }
  }
  if (outcome.resource.immutability === 'native_version' && !outcome.resource.native_version_ref) {
    throw new Error('Native-version materializations require an exact native_version_ref');
  }
  assertCredentialFreeReportingResourceLocationV1(outcome.resource.location);
}

export function receiptEvidenceMatches(receipt: ReportingReceipt, materialization: ReportingMaterialization): boolean {
  const verification = materialization.verification;
  const resource = materialization.resource;
  if (!verification || !resource || !isReportingReceiptEvidence(receipt)) return false;
  return (
    receipt.verification_profile === verification.verification_profile &&
    receipt.observed_row_count === verification.row_count &&
    canonicalJson(receipt.observed_control_totals) === canonicalJson(verification.control_totals) &&
    canonicalJson(receipt.observed_canonical_content_digest) === canonicalJson(verification.canonical_content_digest) &&
    (verification.verification_profile !== 'manifest_checksums' ||
      receipt.observed_manifest_sha256 === resource.manifest_sha256) &&
    (verification.verification_profile !== 'native_commit' ||
      receipt.observed_native_version_ref === resource.native_version_ref)
  );
}

export function adjustmentReceiptEvidenceMatches(
  receipt: ReportingAdjustmentReceipt,
  adjustment: ReportingLedgerAdjustmentV1
): boolean {
  return (
    isReportingAdjustmentReceiptEvidence(receipt) &&
    receipt.adjusts_reporting_revision_id === adjustment.adjusts_reporting_revision_id &&
    receipt.observed_adjustment_sha256 === adjustment.wireAdjustment.canonical_adjustment_sha256
  );
}

function resolvedAccountId(account: unknown): string {
  if (!account || typeof account !== 'object') throw new Error('Reporting receipts require a resolved account');
  const value = account as { id?: unknown; account_id?: unknown };
  const id = typeof value.id === 'string' ? value.id : typeof value.account_id === 'string' ? value.account_id : '';
  if (!id) throw new Error('Reporting receipts require a resolved account');
  return id;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return canonicalize(value === undefined ? null : value);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function nonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function assertManagedOfferings(offerings: ReportingDeliveryCapabilities['offerings']): void {
  const validateOffering = getSchemaValidatorByRef('core/reporting-delivery-offering.json');
  if (!validateOffering) throw new Error('The installed AdCP bundle cannot validate reporting delivery offerings');
  const ids = new Set<string>();
  for (const offering of offerings) {
    if (!validateOffering(offering)) {
      throw new Error('Managed Delivery offering does not satisfy the complete installed RC3 schema');
    }
    if (ids.has(offering.offering_id)) throw new Error('Managed Delivery offering_id values must be unique');
    ids.add(offering.offering_id);
    const method = offering.method as unknown;
    if (method !== undefined) {
      if (!isRecord(method)) throw new Error('Managed Delivery offering method is invalid');
      const pattern = method.pattern;
      if (
        !['file_transfer', 'dataset_share', 'warehouse_materialization'].includes(String(pattern)) ||
        typeof method.transport !== 'string' ||
        !['producer_managed', 'consumer_managed'].includes(String(method.orchestration)) ||
        !Array.isArray(method.destination_modes) ||
        method.destination_modes.length === 0 ||
        !isRecord(method.provider) ||
        typeof method.provider.domain !== 'string' ||
        (pattern === 'file_transfer' && typeof method.format !== 'string') ||
        (pattern === 'dataset_share' && typeof method.access_mode !== 'string')
      ) {
        throw new Error('Managed Delivery offering method omits RC3-required delivery fields');
      }
    }
    if (offering.feed_purpose === 'billing' && offering.reconciliation_mode !== 'consumer_receipt') {
      throw new Error('Billing offerings require consumer-receipt reconciliation');
    }
    const profile = offering.reporting_profile;
    if (offering.reconciliation_mode === 'consumer_receipt') {
      if (
        method === undefined ||
        profile.canonicalization_contract_version !== '1.0' ||
        profile.canonicalization_media_type !== 'application/vnd.adcp.reporting-canonicalization+json' ||
        !profile.canonicalization_id ||
        !profile.canonicalization_uri ||
        !profile.canonicalization_sha256
      ) {
        throw new Error('Reconciled Billing offerings require the complete pinned RC3 canonicalization contract');
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Refuses a retained resource location that carries credential syntax.
 *
 * Exported because the worker is not the only way a resource reaches
 * storage: a caller driving `settleMaterialization` directly must be held to
 * the same rule, or a presigned location is persisted and then published in
 * `get_reporting_status`.
 */
export function assertCredentialFreeReportingResourceLocationV1(location: string): void {
  const refuse = () => {
    throw new Error('Managed reporting resource locations must not contain credentials');
  };
  if (/\r|\n|-----BEGIN|\bbearer\s|(?:token|password|secret|signature)=/i.test(location)) refuse();
  // Query and fragment, refused on the raw string rather than on a parse: a
  // relative path carrying a presigning query — `report.csv?sig=...`, which
  // the keyword test above does not match — never parsed as a URL at all and
  // so was waved through. A retained location is an immutable object
  // reference; neither delimiter has a legitimate place in one.
  if (/[?#]/.test(location)) refuse();
  // `user:password@host` userinfo, which is the actual credential shape. A
  // blanket `@` rule is wrong: `abfss://container@account.dfs.core.windows.net/...`
  // puts a container name there, and a Snowflake stage reference begins with
  // one, so refusing every `@` rejected credential-free identifiers and
  // exhausted their delivery attempts. A colon-separated pair before the `@`
  // is what distinguishes a secret from a namespace.
  if (hasColonSeparatedUserinfo(location)) refuse();
  try {
    const parsed = new URL(location);
    // `http(s)` userinfo is basic-auth credentials by definition, whatever it
    // contains. Other schemes use that position for an account or container
    // namespace, and the pair test above already caught a secret in it.
    if (parsed.password || parsed.search || parsed.hash) refuse();
    if (parsed.username && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) refuse();
  } catch (error) {
    if (error instanceof Error && error.message.includes('must not contain credentials')) throw error;
    // Provider-native object/relation identifiers are intentionally not URLs.
  }
}

/**
 * Finds `name:secret@` at the start of a location or after an authority `//`.
 *
 * This is deliberately a single pass. The equivalent regular expression had
 * overlapping repetitions on either side of `:` and took polynomial time on
 * a `//` followed by many colons when no `@` completed the match.
 */
function hasColonSeparatedUserinfo(location: string): boolean {
  let scanningCandidate = true;
  let sawColon = false;
  let previousWasSlash = false;

  for (let index = 0; index < location.length; index += 1) {
    const code = location.charCodeAt(index);

    if (scanningCandidate) {
      if (code === 0x40) {
        if (sawColon) return true;
        scanningCandidate = false;
      } else if (code === 0x3a) {
        sawColon = true;
      } else if (code === 0x2f || code === 0x3f || code === 0x23 || isLocationWhitespace(code)) {
        scanningCandidate = false;
      }
    }

    const startsAuthorityCandidate = code === 0x2f && previousWasSlash;
    previousWasSlash = code === 0x2f;
    if (startsAuthorityCandidate) {
      scanningCandidate = true;
      sawColon = false;
    }
  }

  return false;
}

/** ECMAScript `\s`, expressed without a regular expression for the scanner. */
function isLocationWhitespace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  message: string,
  outerSignal?: AbortSignal
): Promise<T> {
  outerSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = outerSignal ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          controller.abort(error);
          reject(error);
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Stable helper for immutable binding creation. */
export function reportingManagedDeliveryBindingV1(
  input: Omit<ReportingManagedDeliveryBindingV1, 'created_at' | 'semantic_fingerprint'> & { created_at?: string }
): ReportingManagedDeliveryBindingV1 {
  const created_at = input.created_at ?? new Date().toISOString();
  // Derive from semantic content only. Deriving a new binding by spreading an
  // existing one is the documented pattern, and that carries the predecessor's
  // `semantic_fingerprint` in as an ordinary field — which used to be folded
  // into the digest, so the helper produced a value the store's own
  // `managedBindingFingerprint` could never reproduce. The store now recomputes
  // before it compares anything, so the two must agree exactly.
  const { semantic_fingerprint: _predecessor, ...semantic } = input as typeof input & {
    semantic_fingerprint?: string;
  };
  const semantic_fingerprint = sha256({ ...semantic, created_at: undefined });
  return { ...semantic, created_at, semantic_fingerprint };
}
