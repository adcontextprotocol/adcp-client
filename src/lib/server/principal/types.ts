import type { GetPrincipalResponse, SyncPrincipalRequest, SyncPrincipalResponse } from '../../types/tools.generated';
import type { MaybePromise } from '../create-adcp-server';
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

export interface PrincipalStoreScope {
  tenantId: string;
  principalId: string;
}

export interface PendingPrincipalNotification {
  notificationId: string;
  emissionId: string;
  changedAt: string;
  firedAt: string;
  reason:
    | 'destination_state_changed'
    | 'setup_expiring'
    | 'setup_expired'
    | 'proof_invalidated'
    | 'declarations_intersection_changed'
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
  scopes: PrincipalStoreScope[];
  nextCursor?: string;
}

export type PrincipalStoreReplaceResult =
  | { outcome: 'applied'; value: VersionedPrincipalRecord }
  | { outcome: 'conflict'; currentRevision?: string };

/** Atomic record store. One row contains every caller-owned configuration section. */
export interface PrincipalStateStore {
  readonly durability: 'process-local' | 'durable';
  probe?(): Promise<void>;
  get(scope: Readonly<PrincipalStoreScope>): MaybePromise<VersionedPrincipalRecord | null>;
  replace(args: {
    scope: Readonly<PrincipalStoreScope>;
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
  scope: Readonly<PrincipalStoreScope>;
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
