import { createHash, randomUUID } from 'node:crypto';

import type {
  ReportingAdjustmentReceipt,
  ReportingDeliveryCapabilities,
  ReportingMaterialization,
  ReportingReceipt,
  ReportingResource,
  ReportingVerification,
  SyncReportingReceiptsResponse,
} from '@adcp/sdk/types';
import { ReportingDeliveryCapabilitiesSchema, ReportingMaterializationSchema } from '@adcp/sdk/schemas';
import { canonicalize } from '@adcp/sdk';
import {
  isReportingAdjustmentReceiptEvidence,
  isReportingReceiptEvidence,
  isReportingVerificationEvidence,
  createReportingDeliveryHandler,
  createReportingStatusHandler,
  createSyncReportingReceiptsHandler,
  getReportingDeliveryOfferingValidatorV1,
  type ReportingReceiptSyncStoreV1,
  type SyncReportingReceiptsParamsV1,
} from '@adcp/sdk/reporting/ledger';
import { AdcpError } from '@adcp/sdk/server';
import type {
  ReportingStatusConsumerScopeOptionsV1,
  ReportingLedgerAdjustmentV1,
  ReportingLegacyRevisionReaderV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionV1,
  ReportingLedgerStore,
  ReportingManagedDeliveryBindingV1,
} from '@adcp/sdk/reporting/ledger';

const DEFAULT_LEASE_MILLISECONDS = 65_000;
const DEFAULT_DELIVERY_DEADLINE_MILLISECONDS = 60_000;
const MINIMUM_SETTLEMENT_GRACE_MILLISECONDS = 5_000;
const DEFAULT_RESOURCE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Upper bound on an adapter's startup probe, so a hung provider cannot hang startup.
 * A router's per-route probe budget must stay under it, or this deadline fires
 * first and the failing route's id never reaches the startup error.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_ADAPTER_PROBE_DEADLINE_MILLISECONDS_V1 = 30_000;
const ADAPTER_PROBE_DEADLINE_MILLISECONDS = REPORTING_ADAPTER_PROBE_DEADLINE_MILLISECONDS_V1;
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const MAX_NODE_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
/**
 * The delivery pattern a destination authorization generation serves.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export type ReportingDestinationPatternV1 = ReportingManagedDeliveryBindingV1['method'];

/**
 * Delivery patterns, in the order the protocol lists them.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_DESTINATION_PATTERNS_V1: readonly ReportingDestinationPatternV1[] = Object.freeze([
  'file_transfer',
  'dataset_share',
  'warehouse_materialization',
]);

/**
 * Same constraint the protocol puts on `method.transport`.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const REPORTING_DESTINATION_TRANSPORT_PATTERN_V1 = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingDestinationAuthorizationV1 {
  account_id: string;
  destination_ref: string;
  generation: number;
  authorized_at: string;
  /**
   * Delivery pattern this generation serves, recorded when the generation is
   * created. A destination has exactly one pattern, and a change to its
   * delivery contract mints a new `destination_ref` generation, so this never
   * changes for a generation. Absent on generations recorded before it
   * existed (and on ones whose bindings did not agree when backfilled).
   */
  pattern?: ReportingDestinationPatternV1;
  /**
   * Transport (`s3`, `gcs`, ...) that holds this generation's provider grant,
   * recorded and immutable like `pattern`. This is what lets `revoke()` be
   * routed to the transport that holds the grant. Absent for the same legacy
   * reasons as `pattern`.
   */
  transport?: string;
  revoked_at?: string;
  cleanup_completed_at?: string;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingManagedDeliveryLeaseV1 {
  materialization: ReportingMaterialization;
  binding: ReportingManagedDeliveryBindingV1;
  obligation: ReportingLedgerObligationV1;
  revision: ReportingLedgerRevisionV1;
  owner: string;
  generation: number;
  expires_at: string;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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

/**
 * Agent-wide Managed Delivery promises durably shared by every replica.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingManagedDeliveryAdvertisedPoliciesV1 {
  automatedRecoveryWindowSeconds: number;
  statusRetentionDays: number;
  resourceRetentionDays: number;
  authorizationRevocationSeconds: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingManagedDeliveryStore extends ReportingReceiptSyncStoreV1 {
  /**
   * Prove that this store shares the supplied Core authority and has its
   * durable schema installed. Throw an actionable configuration error when
   * either condition is false; return true only after an operational probe.
   */
  probe(coreStore: ReportingLedgerStore): Promise<boolean>;
  /**
   * Direct-store introspection of installed Core recovery windows.
   *
   * This is optional and non-authoritative for capability publication. Runtime
   * factories use `adoptAdvertisedPolicies`, whose store-side transaction must
   * validate binding compatibility while holding the policy fence.
   */
  listInstalledRecoveryWindowSeconds?(): Promise<number[]>;
  /**
   * Records the agent-wide advertised recovery window so the store can hold
   * later binding installs to it.
   *
   * Optional on the structural interface for source compatibility with
   * direct-store integrations. The runtime factory uses the combined atomic
   * hook below; this separate hook remains useful when bindings are installed
   * without a runtime.
   */
  adoptAdvertisedRecoveryWindowSeconds?(seconds: number): Promise<void>;
  /**
   * Durably registers the advertised `status_retention_days`.
   *
   * Direct-store integrations can use this separate hook when no runtime is
   * publishing the full capability policy. The runtime factory uses the
   * combined atomic hook below so a failed startup cannot partially register
   * its promises.
   */
  adoptAdvertisedStatusRetentionDays?(days: number): Promise<void>;
  /**
   * Atomically adopts every policy advertised by a Managed Delivery runtime
   * and returns the strongest values enforced across all replicas.
   *
   * Recovery and authorization-revocation windows are maximum-delay promises,
   * so the adopted value may only decrease. Status and resource retention are
   * minimum-duration promises, so the adopted value may only increase. The
   * operation must serialize with `installBinding`, validate every installed
   * binding against the adopted recovery bound while holding that fence, and
   * leave all four values unchanged if any validation or write fails. The
   * store must enforce the adopted resource and revocation values at its
   * settlement and revocation-claim boundaries.
   *
   * Optional on the base interface so direct-store integrations that use the
   * separate hooks remain source-compatible. Capability publication requires
   * this combined hook because two independent writes cannot prevent a failed
   * startup from leaving only one promise registered.
   */
  adoptAdvertisedPolicies?(
    policy: ReportingManagedDeliveryAdvertisedPoliciesV1
  ): Promise<ReportingManagedDeliveryAdvertisedPoliciesV1>;
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
  /**
   * Installs the check `installBinding` applies to every new binding before it
   * writes anything. A thrown error refuses the install and reaches the caller
   * as-is. Pass `undefined` to remove it.
   *
   * The runtime registers the adapter's `admitBinding` here, so a binding no
   * installed delivery route can serve is refused at install instead of
   * failing at its first delivery. Optional on the structural interface so
   * existing custom stores stay source-compatible; a runtime whose adapter
   * supplies `admitBinding` refuses a store that cannot enforce it.
   */
  setBindingAdmission?(admit: ((binding: ReportingManagedDeliveryBindingV1) => void) | undefined): void;
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
  // `syncReceiptBatch` comes from `ReportingReceiptSyncStoreV1`, the one method the SDK's
  // `sync_reporting_receipts` handler needs.
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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
  /**
   * Optional startup check that the adapter can reach what it delivers to.
   * The runtime calls it once, before it adopts any durable policy, and
   * refuses to start if it rejects. It must not mutate provider state.
   */
  probe?(context: { signal: AbortSignal }): Promise<void>;
  /**
   * Optional install-time admission. Throw to refuse a binding this adapter
   * could not deliver. The runtime wires it into the store's `installBinding`.
   * A single adapter has no reason to define it; the delivery router does.
   */
  admitBinding?(binding: ReportingManagedDeliveryBindingV1): void;
  /**
   * Optional startup admission for an advertised managed offering. Throw if
   * the adapter has no way to serve it. Called once per offering at runtime
   * construction.
   */
  admitOffering?(offering: { method: { pattern: string; transport: string }; reconciliation_mode?: string }): void;
  /**
   * Optional observability hook: the id of the route a binding or an
   * authorization is dispatched to, or `undefined` if none. Only the id may be
   * returned. The worker keys its per-route counts on it, so it must never
   * carry credentials, locations or any other provider detail.
   */
  routeIdFor?(
    target: Readonly<
      { binding: ReportingManagedDeliveryBindingV1 } | { authorization: ReportingDestinationAuthorizationV1 }
    >
  ): string | undefined;
}

/**
 * Per-route counts keyed by delivery route id. Present on a worker result only
 * when the installed adapter is a router, so a single-adapter runtime's result
 * shape is unchanged. Work that no route could take is counted under
 * `UNROUTED_REPORTING_ROUTE_KEY_V1`, which no route id can equal.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingManagedDeliveryRouteCountsV1 {
  /** Materializations settled as delivered, by the route that delivered them. */
  deliveriesByRoute: Record<string, number>;
  /** Materializations that failed (including an unroutable binding), by route. */
  deliveryFailuresByRoute: Record<string, number>;
  /** Provider revocations completed, by the route that performed them. */
  revocationsByRoute: Record<string, number>;
  /** Revocation attempts that failed and were released for retry, by route. */
  revocationFailuresByRoute: Record<string, number>;
  /** Revocations that had already outlived the advertised window when claimed, by route. */
  overdueByRoute: Record<string, number>;
}

/**
 * Key for work no delivery route could take. Not a valid route id.
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export const UNROUTED_REPORTING_ROUTE_KEY_V1 = '~unrouted';

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingManagedDeliveryWorkerResultV1 extends Partial<ReportingManagedDeliveryRouteCountsV1> {
  planned: number;
  claimed: number;
  delivered: number;
  failed: number;
  revocationsCompleted: number;
  revocationsOverdue: number;
  /** Materializations failed for using every delivery attempt. */
  exhausted: number;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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
  /**
   * Loads verified rows for a claimed revision whose rows live in row storage
   * rather than in the ledger document. `createReportingManagedDeliveryRuntime`
   * supplies one backed by its Core store. PostgreSQL-kind chunks are
   * hydrated by the managed store's claim itself; a direct caller whose rows
   * live in an external binding must supply this, or the adapter receives a
   * revision without rows.
   */
  hydrateRevision?: (
    revision: ReportingManagedDeliveryLeaseV1['revision'],
    account_id: string,
    signal: AbortSignal | undefined
  ) => Promise<ReportingManagedDeliveryLeaseV1['revision']>;
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface CreateReportingManagedDeliveryRuntimeOptionsV1<
  TContext extends { account?: unknown } = { account?: unknown },
> {
  coreStore: ReportingLedgerStore;
  /** Exact-revision fallback for revisions the SDK ledger does not hold. */
  legacyRevisionReader?: ReportingLegacyRevisionReaderV1;
  store: ReportingManagedDeliveryStore & Required<Pick<ReportingManagedDeliveryStore, 'adoptAdvertisedPolicies'>>;
  adapter: ReportingManagedDeliveryAdapterV1;
  offerings: ReportingDeliveryCapabilities['offerings'];
  automatedRecoveryWindowSeconds: number;
  statusRetentionDays: number;
  resourceRetentionDays: number;
  authorizationRevocationSeconds: number;
  resolveConsumerId?: (context: TContext) => string | Promise<string>;
  consumerMismatchEscalation?: ReportingStatusConsumerScopeOptionsV1<TContext>['consumerMismatchEscalation'];
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export interface ReportingManagedDeliveryRuntimeV1<TContext extends { account?: unknown } = { account?: unknown }> {
  reportingDeliveryCapabilities: ReportingDeliveryCapabilities;
  getReportingStatus: ReturnType<typeof createReportingStatusHandler<TContext>>;
  getMediaBuyDelivery: ReturnType<typeof createReportingDeliveryHandler>;
  syncReportingReceipts?: (
    request: SyncReportingReceiptsParamsV1,
    context: TContext & { account?: unknown }
  ) => Promise<SyncReportingReceiptsResponse>;
  runWorker(options?: ReportingManagedDeliveryWorkerOptionsV1): Promise<ReportingManagedDeliveryWorkerResultV1>;
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
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
export async function createReportingManagedDeliveryRuntime<
  TContext extends { account?: unknown } = { account?: unknown },
>(
  options: CreateReportingManagedDeliveryRuntimeOptionsV1<TContext>
): Promise<ReportingManagedDeliveryRuntimeV1<TContext>> {
  if (!(await options.store.probe(options.coreStore))) {
    throw new Error('Managed reporting store is not operational for the configured Core authority');
  }
  if (typeof options.store.adoptAdvertisedPolicies !== 'function') {
    throw new Error(
      'Managed Delivery capability publication requires atomic durable adoption of every advertised policy'
    );
  }
  nonnegativeInteger(options.automatedRecoveryWindowSeconds, 'automatedRecoveryWindowSeconds');
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
  // An adapter that dispatches (the router) must have somewhere to send every
  // offering this runtime is about to advertise; a single adapter does not
  // define the hook and keeps its current behaviour.
  if (typeof options.adapter.admitOffering === 'function') {
    for (const offering of options.offerings) {
      const method = offering.method as { pattern: string; transport: string } | undefined;
      if (method === undefined) continue;
      options.adapter.admitOffering({ method, reconciliation_mode: offering.reconciliation_mode });
    }
  }
  if (typeof options.adapter.admitBinding === 'function' && typeof options.store.setBindingAdmission !== 'function') {
    throw new Error(
      'This Managed Delivery adapter admits bindings at install, but the store cannot enforce an install-time admission'
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
  const getMediaBuyDelivery = createReportingDeliveryHandler(
    options.coreStore,
    options.legacyRevisionReader ? { legacyRevisionReader: options.legacyRevisionReader } : {}
  );
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
  // The only I/O before the durable write. A provider that is down must stop
  // startup before this runtime registers promises it cannot keep, and the
  // failure names the route so the operator knows which transport to fix.
  if (typeof options.adapter.probe === 'function') await probeAdapter(options.adapter);
  // Every side-effect-free validation and construction above completes before
  // the durable write. Otherwise a malformed adapter or offering could
  // register policy that no runtime ever published, then reject a corrected
  // restart using different values.
  // The store owns the authoritative binding check under the same fence as
  // `installBinding`; a list-then-adopt check here would be inherently racy.
  // It also returns the strongest promises already adopted by any replica so
  // this worker enforces those values even when it advertises weaker ones.
  const adoptedPolicy = await options.store.adoptAdvertisedPolicies({
    automatedRecoveryWindowSeconds: options.automatedRecoveryWindowSeconds,
    statusRetentionDays: options.statusRetentionDays,
    resourceRetentionDays: options.resourceRetentionDays,
    authorizationRevocationSeconds: options.authorizationRevocationSeconds,
  });
  nonnegativeInteger(adoptedPolicy.automatedRecoveryWindowSeconds, 'adopted automatedRecoveryWindowSeconds');
  positiveInteger(adoptedPolicy.statusRetentionDays, 'adopted statusRetentionDays');
  positiveInteger(adoptedPolicy.resourceRetentionDays, 'adopted resourceRetentionDays');
  nonnegativeInteger(adoptedPolicy.authorizationRevocationSeconds, 'adopted authorizationRevocationSeconds');
  if (
    adoptedPolicy.automatedRecoveryWindowSeconds > options.automatedRecoveryWindowSeconds ||
    adoptedPolicy.statusRetentionDays < options.statusRetentionDays ||
    adoptedPolicy.resourceRetentionDays < options.resourceRetentionDays ||
    adoptedPolicy.authorizationRevocationSeconds > options.authorizationRevocationSeconds
  ) {
    throw new Error('Managed Delivery policy adoption returned values weaker than the capability being published');
  }
  // Last, so a startup that failed above leaves the store's admission alone.
  if (typeof options.adapter.admitBinding === 'function') {
    const adapter = options.adapter;
    options.store.setBindingAdmission?.(binding => adapter.admitBinding!(binding));
  }

  return {
    reportingDeliveryCapabilities,
    getReportingStatus,
    getMediaBuyDelivery,
    ...(syncReportingReceipts ? { syncReportingReceipts } : {}),
    runWorker: workerOptions =>
      runManagedDeliveryWorker(options.store, options.adapter, {
        ...(typeof options.coreStore.getRevision === 'function'
          ? {
              hydrateRevision: async (revision: ReportingLedgerRevisionV1, accountId: string) => {
                const hydrated = await options.coreStore.getRevision(revision.reporting_revision_id, accountId);
                if (!hydrated) throw new Error('Reporting revision is unavailable for delivery');
                return hydrated;
              },
            }
          : {}),
        ...workerOptions,
        minimumResourceRetentionDays: Math.max(
          options.resourceRetentionDays,
          adoptedPolicy.resourceRetentionDays,
          workerOptions?.minimumResourceRetentionDays ?? 0
        ),
        // The capability block is the promise; the worker is what keeps it.
        // A caller may only tighten the advertised window, never widen it.
        authorizationRevocationSeconds: Math.min(
          options.authorizationRevocationSeconds,
          adoptedPolicy.authorizationRevocationSeconds,
          workerOptions?.authorizationRevocationSeconds ?? options.authorizationRevocationSeconds
        ),
      }),
    readResource: input => readManagedReportingResource(options.store, options.adapter, input),
  };
}

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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
  const counts: ReportingManagedDeliveryWorkerResultV1 = {
    exhausted,
    planned: await store.planMaterializations({ ...(options.account_id ? { account_id: options.account_id } : {}) }),
    claimed: 0,
    delivered: 0,
    failed: 0,
    revocationsCompleted: 0,
    revocationsOverdue: 0,
  };
  // Per-route counts exist only for an adapter that can name a route, so every
  // other runtime's result keeps exactly its current shape.
  const routed =
    typeof adapter.routeIdFor === 'function'
      ? {
          deliveriesByRoute: {} as Record<string, number>,
          deliveryFailuresByRoute: {} as Record<string, number>,
          revocationsByRoute: {} as Record<string, number>,
          revocationFailuresByRoute: {} as Record<string, number>,
          overdueByRoute: {} as Record<string, number>,
        }
      : undefined;
  if (routed) Object.assign(counts, routed);
  const countRoute = (
    bucket: keyof ReportingManagedDeliveryRouteCountsV1,
    target: Parameters<NonNullable<ReportingManagedDeliveryAdapterV1['routeIdFor']>>[0]
  ) => {
    if (!routed) return;
    let id: string | undefined;
    try {
      id = adapter.routeIdFor!(target);
    } catch {
      id = undefined;
    }
    const key = typeof id === 'string' && id !== '' ? id : UNROUTED_REPORTING_ROUTE_KEY_V1;
    routed[bucket][key] = (routed[bucket][key] ?? 0) + 1;
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
    if (overdue) {
      counts.revocationsOverdue += 1;
      countRoute('overdueByRoute', { authorization: revocation.authorization });
    }
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
        countRoute('revocationsByRoute', { authorization: revocation.authorization });
      }
    } catch {
      countRoute('revocationFailuresByRoute', { authorization: revocation.authorization });
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
      if (!Array.isArray(lease.revision.rows) && options.hydrateRevision) {
        const hydrated = await options.hydrateRevision(
          lease.revision,
          lease.obligation.account.account_id,
          options.signal
        );
        if (
          hydrated.reporting_revision_id !== lease.revision.reporting_revision_id ||
          hydrated.binding.sha256 !== lease.revision.binding.sha256 ||
          !Array.isArray(hydrated.rows)
        ) {
          throw new Error('Hydrated reporting revision does not match the claimed revision');
        }
        lease.revision = hydrated;
      }

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
      ) {
        counts.delivered += 1;
        countRoute('deliveriesByRoute', { binding: lease.binding });
      } else {
        counts.failed += 1;
        countRoute('deliveryFailuresByRoute', { binding: lease.binding });
      }
    } catch {
      await store.settleMaterialization({
        lease,
        now: now().toISOString(),
        outcome: { status: 'failed', failure_code: 'DELIVERY_FAILED' },
      });
      counts.failed += 1;
      countRoute('deliveryFailuresByRoute', { binding: lease.binding });
    }
  }
  return counts;
}

/**
 * Runs the adapter's own startup probe. A router rejects with the ids of the
 * routes that failed; they are named here, and only the ids, because the
 * provider's message can carry endpoint or credential detail. The original
 * error stays reachable as `cause` for seller logs.
 */
async function probeAdapter(adapter: ReportingManagedDeliveryAdapterV1): Promise<void> {
  try {
    await withinDeadline(
      signal => Promise.resolve().then(() => adapter.probe!({ signal })),
      ADAPTER_PROBE_DEADLINE_MILLISECONDS,
      'Managed Delivery adapter probe deadline elapsed'
    );
  } catch (cause) {
    const failed = (cause as { failedRouteIds?: unknown } | null)?.failedRouteIds;
    const routes = Array.isArray(failed) ? failed.filter((id): id is string => typeof id === 'string') : [];
    throw new Error(
      routes.length
        ? `Managed Delivery adapter probe failed for route ${routes.map(id => JSON.stringify(id)).join(', ')}`
        : 'Managed Delivery adapter probe failed',
      { cause }
    );
  }
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

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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

/**
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
 */
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
  const validateOffering = getReportingDeliveryOfferingValidatorV1();
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
 *
 * @experimental Reliable Reporting storage surface: breaking changes may ship in minor releases. See https://github.com/adcontextprotocol/adcp-client/blob/main/docs/guides/REPORTING-STABILITY.md
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
  let cancelTimer: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(signal),
      new Promise<never>((_resolve, reject) => {
        cancelTimer = scheduleDeadline(milliseconds, () => {
          const error = new Error(message);
          controller.abort(error);
          reject(error);
        });
      }),
    ]);
  } finally {
    cancelTimer?.();
  }
}

/**
 * Schedules the complete safe-integer deadline without passing an overflowing
 * delay to Node, which clamps values above 2^31 - 1 and fires them immediately.
 */
function scheduleDeadline(milliseconds: number, onElapsed: () => void): () => void {
  // PostgreSQL interval arithmetic can return a fractional number of
  // milliseconds. Round up before converting to BigInt so the scheduler both
  // accepts that store-authoritative value and never fires before its stated
  // deadline. Keep the normalized value inside the exact integer range: an
  // imprecise or non-finite delay cannot define a trustworthy deadline.
  const normalizedMilliseconds = Math.ceil(milliseconds);
  if (milliseconds < 0 || !Number.isSafeInteger(normalizedMilliseconds)) {
    throw new RangeError('Reporting deadline must be a finite non-negative safe number of milliseconds');
  }
  const expiresAt = process.hrtime.bigint() + BigInt(normalizedMilliseconds) * NANOSECONDS_PER_MILLISECOND;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleRemaining = () => {
    if (cancelled) return;
    const remainingNanoseconds = expiresAt - process.hrtime.bigint();
    // Equality is elapsed: firing only while positive would defer an exact
    // deadline by another timer turn.
    if (remainingNanoseconds <= 0n) {
      onElapsed();
      return;
    }
    // Round up a partial millisecond so no chunk can fire the deadline early.
    const remainingMilliseconds = Number(
      (remainingNanoseconds + NANOSECONDS_PER_MILLISECOND - 1n) / NANOSECONDS_PER_MILLISECOND
    );
    timer = setTimeout(scheduleRemaining, Math.min(remainingMilliseconds, MAX_NODE_TIMER_DELAY_MILLISECONDS));
  };

  scheduleRemaining();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}
