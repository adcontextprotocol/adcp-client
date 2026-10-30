import type { GetPrincipalResponse, SyncPrincipalRequest, SyncPrincipalResponse } from '../../types/tools.generated';
import type { MaybePromise } from '../create-adcp-server';
import type { StoredReportingSubscriptionHistory } from './reporting-subscriptions';
import type {
  NotificationRecipientRef,
  NotificationSubscriptionMatch,
  NotificationSubscriptionSet,
  StoredNotificationSubscription,
} from '../notification-subscriptions/types';

export type PrincipalKind = Extract<GetPrincipalResponse['result'], { kind: 'current' }>['principal_kind'];
export type PrincipalConfiguration = Extract<GetPrincipalResponse['result'], { kind: 'current' }>['configuration'];
export type PrincipalConfigurationInput = SyncPrincipalRequest['configuration'];
export type PrincipalAppliedResult = Extract<SyncPrincipalResponse['result'], { kind: 'applied' }>;
export type PrincipalReportingDestination = NonNullable<PrincipalConfiguration['reporting_destinations']>[number];
export type PrincipalReportingDestinationInput = NonNullable<
  PrincipalConfigurationInput['reporting_destinations']
>[number];
export type PrincipalDeclarations = NonNullable<PrincipalConfigurationInput['declarations']>;
export type PrincipalDeclarationsState = NonNullable<PrincipalConfiguration['declarations']>;

/** Trusted result of mapping an authenticated transport identity. */
export interface ResolvedPrincipalScope {
  /** Tenant/deployment namespace used for durable isolation. */
  tenant_id: string;
  /** Stable authorization subject. Never derive this from request content. */
  principal_id: string;
  /** Seller-resolved party kind. */
  principal_kind: PrincipalKind;
  /**
   * Existing seller-issued principal record id. Its presence makes an empty
   * store read `recognized`; absence makes it `unconfigured`.
   */
  principal_record_id?: string;
}

/**
 * The identity of an authenticated principal: who a reporting subscription, an engine record or a
 * principal store row belongs to. The same shape everywhere in the SDK, with no snake-case variant.
 */
export interface PrincipalRef {
  tenantId: string;
  principalId: string;
}

/** @deprecated Use {@link PrincipalRef}, the same shape. Kept as an alias for existing principal-store code. */
export type PrincipalStoreScope = PrincipalRef;

export interface PendingPrincipalNotification {
  notificationId: string;
  emissionId: string;
  changedAt: string;
  firedAt: string;
  reason:
    | 'relationship_changed'
    | 'relationship_expiring'
    | 'destination_state_changed'
    | 'setup_expiring'
    | 'setup_expired'
    | 'proof_invalidated'
    | 'declarations_intersection_changed'
    | 'reporting_subscription_changed'
    | 'other';
  destinationId?: string;
  recipients: NotificationRecipientRef[];
}

export interface StoredReportingDestinationGeneration {
  destinationId: string;
  destinationRef: string;
  configuration: PrincipalReportingDestinationInput;
  state: PrincipalReportingDestination['state'];
  lifecycle: 'current' | 'superseded' | 'retired';
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredPrincipalRecord extends Record<string, unknown> {
  schemaVersion: 1;
  tenantId: string;
  scopePrincipalId: string;
  principalId: string;
  principalKind: PrincipalKind;
  configurationVersion?: string;
  configuration?: PrincipalConfiguration;
  notificationGeneration?: string;
  notificationSubscriptions: StoredNotificationSubscription[];
  reportingGenerations: StoredReportingDestinationGeneration[];
  pendingNotifications: PendingPrincipalNotification[];
  /**
   * Reporting subscription history the readback omits (experimental, AdCP 3.3). Absent on
   * rows written without subscription support.
   */
  reportingSubscriptionHistory?: StoredReportingSubscriptionHistory[];
}

export interface VersionedPrincipalRecord {
  record: StoredPrincipalRecord;
  revision: string;
}

export interface PrincipalNotificationRecoveryResult {
  processedScopes: number;
  failedScopes: number;
  hasMore: boolean;
  nextCursor?: string;
}

export interface PrincipalPendingNotificationPage {
  scopes: PrincipalRef[];
  nextCursor?: string;
}

export type PrincipalStoreReplaceResult =
  | { outcome: 'applied'; value: VersionedPrincipalRecord }
  | { outcome: 'conflict'; currentRevision?: string };

/** Atomic record store. One row contains every caller-owned configuration section. */
export interface PrincipalStateStore {
  readonly durability: 'process-local' | 'durable';
  probe?(): Promise<void>;
  get(scope: Readonly<PrincipalRef>): MaybePromise<VersionedPrincipalRecord | null>;
  replace(args: {
    scope: Readonly<PrincipalRef>;
    expectedRevision: string | null;
    record: Readonly<StoredPrincipalRecord>;
  }): MaybePromise<PrincipalStoreReplaceResult>;
  /** Returns at most `limit + 1` records so fanout can fail closed on truncation. */
  findNotificationCandidates(
    match: Readonly<NotificationSubscriptionMatch>,
    limit: number
  ): MaybePromise<NotificationSubscriptionSet[]>;
  /** Scans a bounded page of records for pending principal notifications. */
  findPendingNotificationScopes(options: {
    limit: number;
    cursor?: string;
  }): MaybePromise<PrincipalPendingNotificationPage>;
}

export interface PrincipalDeclarationSupport {
  asyncAdcpVersions?: readonly string[];
  webhookSigningAlgorithms?: readonly ('ed25519' | 'ecdsa-p256-sha256')[];
  experimentalFeatures?: readonly string[];
  exclusionReason?: (axis: string, value: string) => string;
  selectAsyncAdcpVersion?: (accepted: readonly string[]) => string | undefined;
}

export interface ReportingDestinationPreparation {
  state: 'validating' | 'action_required' | 'rejected';
  configuration: PrincipalReportingDestinationInput;
  setup?: PrincipalReportingDestination['setup'];
  issues?: PrincipalReportingDestination['issues'];
}

/** Pure validation/canonicalization hook. It must not create provider grants. */
export type PrepareReportingDestination = (input: {
  scope: Readonly<PrincipalRef>;
  destination: Readonly<PrincipalReportingDestinationInput>;
  previous?: Readonly<PrincipalReportingDestination>;
  dryRun: boolean;
}) => MaybePromise<ReportingDestinationPreparation>;

export interface PrincipalDestinationTransition {
  destinationId: string;
  destinationRef: string;
  state: 'validating' | 'ready' | 'action_required' | 'rejected';
  setup?: PrincipalReportingDestination['setup'];
  issues?: PrincipalReportingDestination['issues'];
  reason?: PendingPrincipalNotification['reason'];
}

export interface ResolvedReportingDestination {
  destinationId: string;
  destinationRef: string;
  configuration: PrincipalReportingDestinationInput;
  state: PrincipalReportingDestination['state'];
  lifecycle: StoredReportingDestinationGeneration['lifecycle'];
  deliveryEligible: boolean;
}

export type PrincipalReportingSubscriptionState = NonNullable<
  PrincipalConfiguration['reporting_subscriptions']
>[number];

/**
 * Opt-in support for the `sync_principal` `reporting_subscriptions` section
 * (experimental `media_buy.reporting_subscriptions`). Without it the section is refused
 * with `UNSUPPORTED_FEATURE`, as before.
 */
export interface PrincipalReportingSubscriptionSupport {
  /**
   * The caller's `sync_accounts` `delivery_config_id` values on any account. A
   * `subscription_id` equal to one is rejected; the host's `sync_accounts` must reject the
   * reverse clash using {@link PrincipalLifecycleRuntimeSubscriptions.reportingSubscriptionIds}.
   */
  listDeliveryConfigIds?(scope: Readonly<PrincipalRef>): MaybePromise<readonly string[]>;
  /**
   * Apply `replace_account_configs`: deactivate the caller's own active
   * `reporting_delivery_configs` with this `feed_purpose`, by cutover at `at`, on in-scope
   * accounts where the subscription resolves an offering, without advancing any account's
   * revision. Called after the principal row commits, never on `dry_run`. Without it a
   * subscription with `replace_account_configs: true` is refused with `UNSUPPORTED_FEATURE`.
   */
  replaceAccountConfigs?(input: {
    scope: Readonly<PrincipalRef>;
    subscriptionId: string;
    subscriptionVersion: number;
    feedPurpose: string;
    at: string;
  }): MaybePromise<void>;
  /** Most subscriptions per principal. Defaults to 64. */
  maxSubscriptions?: number;
  /**
   * Whether the seller also serves account-level `sync_accounts` configurations (the
   * default). When true, `listDeliveryConfigIds` is required so a `subscription_id` that
   * equals one of the caller's `delivery_config_id` values is always rejected.
   */
  accountConfigurations?: boolean;
  /**
   * Called after a write that submitted `reporting_subscriptions` commits. The managed
   * subscriptions block reconciles the principal here. A rejection never fails the write.
   */
  onApplied?(scope: Readonly<PrincipalRef>): void | Promise<void>;
}

/** Runtime surface the reporting subscription engine and hosts use. */
export interface PrincipalLifecycleRuntimeSubscriptions {
  /** Current readback plus the retained version history, for coverage computation. */
  listReportingSubscriptions(scope: Readonly<PrincipalRef>): Promise<{
    states: PrincipalReportingSubscriptionState[];
    history: StoredReportingSubscriptionHistory[];
  }>;
  /** Subscription IDs of this principal, active or retained, for the reverse namespace check. */
  reportingSubscriptionIds(scope: Readonly<PrincipalRef>): Promise<string[]>;
  /**
   * Record engine-maintained readback (`accounts_with_exceptions`, `accounts_unauthorized`).
   * Any change enqueues `principal.changed` with reason `reporting_subscription_changed`.
   * Returns whether anything changed. It writes the readback lists, not `subscription_coverage`.
   */
  recordSubscriptionReadback(
    scope: Readonly<PrincipalRef>,
    updates: ReadonlyArray<{
      subscriptionId: string;
      accountsWithExceptions: NonNullable<PrincipalReportingSubscriptionState['accounts_with_exceptions']>;
      accountsUnauthorized: NonNullable<PrincipalReportingSubscriptionState['accounts_unauthorized']>;
    }>,
    /** `forceNotification` fires even when the readback is unchanged, for example when an exception opened and another closed. */
    options?: { deferNotification?: boolean; forceNotification?: boolean }
  ): Promise<boolean>;
  /**
   * @deprecated Renamed {@link PrincipalLifecycleRuntimeSubscriptions.recordSubscriptionReadback}: it
   * writes readback lists, not `subscription_coverage`. This alias is removed in a later beta.
   */
  recordReportingSubscriptionCoverage?(
    ...args: Parameters<PrincipalLifecycleRuntimeSubscriptions['recordSubscriptionReadback']>
  ): Promise<boolean>;
}
