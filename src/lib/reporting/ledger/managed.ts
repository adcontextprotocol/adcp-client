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
  claimMaterialization(input: {
    owner: string;
    now: string;
    lease_milliseconds: number;
    account_id?: string;
  }): Promise<ReportingManagedDeliveryLeaseV1 | null>;
  settleMaterialization(input: {
    lease: ReportingManagedDeliveryLeaseV1;
    now: string;
    outcome:
      | { status: 'available' | 'delivered'; resource: ReportingResource; verification: ReportingVerification }
      | { status: 'failed'; failure_code: string };
  }): Promise<boolean>;
  claimRevocation(input: {
    owner: string;
    now: string;
    lease_milliseconds: number;
    account_id?: string;
  }): Promise<ReportingDestinationRevocationLeaseV1 | null>;
  completeRevocation(input: { lease: ReportingDestinationRevocationLeaseV1; completed_at: string }): Promise<boolean>;
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
  const installedRecoveryWindows = await options.store.listInstalledRecoveryWindowSeconds();
  if (!installedRecoveryWindows.length) {
    throw new Error('Managed Delivery requires an installed binding before capabilities can be advertised');
  }
  if (installedRecoveryWindows.some(value => value !== options.automatedRecoveryWindowSeconds)) {
    throw new Error('automatedRecoveryWindowSeconds must equal every installed managed Core recovery window');
  }
  positiveInteger(options.statusRetentionDays, 'statusRetentionDays');
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
    const entries: ReportingReceiptBatchEntryV1[] = [
      ...(request.receipts ?? []).map(receipt => ({
        kind: 'revision' as const,
        receipt: withoutReceivedAt(receipt) as ReportingReceipt,
      })),
      ...(request.adjustment_receipts ?? []).map(receipt => ({
        kind: 'adjustment' as const,
        receipt: withoutReceivedAt(receipt) as ReportingAdjustmentReceipt,
      })),
    ];
    if (request.account && 'account_id' in request.account && request.account.account_id !== account_id) {
      return receiptBatchFailure(entries, 'PERMISSION_DENIED', 'Reporting receipt account is unavailable');
    }
    if (!entries.length) return { status: 'completed', results: [] };
    if (entries.length > 100) {
      return receiptBatchFailure(entries, 'VALIDATION_ERROR', 'sync_reporting_receipts accepts at most 100 receipts');
    }
    if (!/^[A-Za-z0-9_.:-]{16,255}$/.test(request.idempotency_key)) {
      return receiptBatchFailure(entries, 'VALIDATION_ERROR', 'sync_reporting_receipts idempotency_key is invalid');
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
              entry.receipt.reporting_receipt_id,
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
    results: entries.map(entry => receiptFailure(entry.receipt.reporting_receipt_id, code, message)),
  };
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
  const owner = `managed-reporting-${randomUUID()}`;
  const counts = {
    planned: await store.planMaterializations({ ...(options.account_id ? { account_id: options.account_id } : {}) }),
    claimed: 0,
    delivered: 0,
    failed: 0,
    revocationsCompleted: 0,
  };

  for (let index = 0; index < maxIterations; index += 1) {
    options.signal?.throwIfAborted();
    const revocation = await store.claimRevocation({
      owner,
      now: now().toISOString(),
      lease_milliseconds: leaseMilliseconds,
      ...(options.account_id ? { account_id: options.account_id } : {}),
    });
    if (!revocation) break;
    try {
      await withinDeadline(
        signal => adapter.revoke({ authorization: revocation.authorization }, { signal }),
        deadlineMilliseconds,
        'Reporting revocation deadline elapsed',
        options.signal
      );
      if (await store.completeRevocation({ lease: revocation, completed_at: now().toISOString() })) {
        counts.revocationsCompleted += 1;
      }
    } catch {
      // Retain the lease as a bounded retry delay so one broken provider grant
      // cannot be selected repeatedly and starve the rest of the queue.
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
      if (await store.settleMaterialization({ lease, now: now().toISOString(), outcome })) counts.delivered += 1;
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
    signal => adapter.read({ materialization, binding, resource, maxBytes }, { signal }),
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
  if (
    Date.parse(outcome.resource.expires_at) <
    Date.parse(now) + Math.max(lease.binding.resource_retention_days, minimumResourceRetentionDays) * 86_400_000
  ) {
    throw new Error('Materialization resource expires before the installed retention window');
  }
  if (outcome.verification.canonical_content_digest !== undefined) {
    const expected = lease.revision.wireRevision.canonical_content_digest;
    if (!expected || canonicalJson(outcome.verification.canonical_content_digest) !== canonicalJson(expected)) {
      throw new Error('Canonical materialization evidence does not match the official Core revision');
    }
  }
  if (outcome.resource.immutability === 'native_version' && !outcome.resource.native_version_ref) {
    throw new Error('Native-version materializations require an exact native_version_ref');
  }
  assertCredentialFreeResourceLocation(outcome.resource.location);
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

function withoutReceivedAt<T extends { received_at?: string }>(value: T): T {
  const { received_at: _receivedAt, ...rest } = value;
  return rest as T;
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

function assertCredentialFreeResourceLocation(location: string): void {
  if (/\r|\n|-----BEGIN|\bbearer\s|(?:token|password|secret|signature)=/i.test(location)) {
    throw new Error('Managed reporting resource locations must not contain credentials');
  }
  try {
    const parsed = new URL(location);
    if (parsed.username || parsed.password || parsed.search) {
      throw new Error('Managed reporting resource locations must not contain credentials');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('must not contain credentials')) throw error;
    // Provider-native object/relation identifiers are intentionally not URLs.
  }
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
  const semantic_fingerprint = sha256({ ...input, created_at: undefined });
  return { ...input, created_at, semantic_fingerprint };
}
