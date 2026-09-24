import type {
  GetReportingStatusResponse,
  ReportingAdjustment,
  ReportingAdjustmentReceipt,
  ReportingConsumerStatus,
  ReportingMaterialization,
  ReportingReceipt,
  ReportingRevision,
} from '../../types';
import type { AdcpToolMap, HandlerContext } from '../../server/create-adcp-server';
import type { ErrorRecovery } from '../../types/error-codes';
import type { ReportingScheduleAlignment } from '../../types/core.generated';
import type {
  ReportingSourceExecutorV1,
  ReportingSourceOfferingV1,
  ReportingSourceSliceRequestV1,
  ReportingSourceStagedObjectReaderV1,
  SourceBatchManifestReferenceV1,
} from '../source';

/**
 * Private-by-convention identity used to prove Core and Managed stores share
 * one reporting authority. Store implementations may expose their own stable
 * authority identity through this symbol; it is never serialized.
 */
export const REPORTING_LEDGER_AUTHORITY = Symbol.for('@adcp/sdk/reporting-ledger-authority');

/** Shared identity used by separately constructed Core and opt-in reporting stores. */
export interface ReportingLedgerAuthorityV1 {
  readonly substrate: unknown;
  readonly managedDelivery: boolean;
}

export type ReportingHealthV1 = 'waiting' | 'healthy' | 'delayed' | 'action_required' | 'complete';
export type ReportingFinalityV1 = 'snapshot' | 'official';
export type ReportingObservedFinalityV1 = 'none' | ReportingFinalityV1;

export type ReportingLedgerAccountV1 = Readonly<{ account_id: string }>;

export interface ReportingLedgerCoverageV1 {
  status: 'full' | 'partial' | 'none' | 'unknown';
  evaluatedAt: string;
  mediaBuyIds: string[];
  fullyCoveredMediaBuyIds: string[];
  partiallyCoveredMediaBuyIds: string[];
  unsupportedMediaBuyIds: string[];
  unknownMediaBuyIds: string[];
}

/** Runtime timezone rules frozen into a source-calendar configuration generation. */
export interface ReportingCalendarRulesV1 {
  canonicalTimezone: string;
  tzdbVersion: string;
  icuVersion: string;
  /** First ordinal owned by this generation, resolved under the frozen rules at installation. */
  firstOwnedOrdinal?: number;
  /** Boundary for firstOwnedOrdinal, resolved under the same frozen rules. */
  firstOwnedBoundary?: string;
}

export interface ReportingLedgerConfigurationV1 {
  configurationId: string;
  account: ReportingLedgerAccountV1;
  sourceScope: Record<string, unknown>;
  delivery_config_id: string;
  delivery_config_version: number;
  offeringId: string;
  report_definition_id: string;
  feedPurpose: 'pacing' | 'analytics' | 'billing';
  /**
   * Which party's count of this feed is authoritative. Absence is identical to
   * `'seller'`.
   *
   * `'consumer'` is reserved for the buyer-deposited billing revision task
   * scoped to a later minor. No released version defines that task, so every
   * AdCP 3.2 seller MUST reject the value with `UNSUPPORTED_FEATURE` at
   * `sync_accounts` validation — before the generation becomes ready and
   * before any obligation exists — and MUST NOT silently coerce it to
   * `'seller'`, which would accept a different contract than the one asked
   * for. The field is typed here so a configuration can carry the buyer's
   * request as far as the rejection.
   *
   * See https://github.com/adcontextprotocol/adcp/issues/7440.
   */
  authoritativeParty?: 'seller' | 'consumer';
  requiredFinality: ReportingFinalityV1;
  finalityPolicy?:
    | { policyId: string; basis: 'source_final'; sourceSignal: string }
    | {
        policyId: string;
        basis: 'contractual_cutoff';
        durationAfterPeriodEndMilliseconds: number;
      };
  canonicalization?: {
    id: string;
    uri: string;
    sha256: string;
    primaryKeys: string[];
  };
  requestedMetrics: string[];
  requestedDimensions: string[];
  constituents: ReportingSourceSliceRequestV1['coverage']['constituents'];
  mediaBuyIds: string[];
  sourceTimezone: string;
  /**
   * Host rule-set identity used to resolve calendar boundaries. Calendar
   * generations fail closed on a host with different rules instead of being
   * silently reinterpreted during a rolling runtime/tzdata upgrade.
   */
  calendarRules?: ReportingCalendarRulesV1;
  schedule: {
    anchor: string;
    /** Fixed width for legacy schedules; nominal 86,400,000 for explicit P1D source-calendar days. */
    periodMilliseconds: number;
    deliverySlaMilliseconds: number;
    recoveryWindowMilliseconds: number;
    officialAfterMilliseconds?: number;
    restatementMilliseconds?: number[];
    /**
     * The exact schedule identity the offering advertised, echoed verbatim.
     *
     * `installed_schedule_match` requires period_duration, alignment, and the
     * applicable period_timezone to equal the installed configuration, so these
     * are preserved rather than re-derived: `P1D` must not come back as
     * `PT86400S`, and a `source_timezone` schedule must not be reported as
     * `utc` merely because its boundaries also sit on the UTC origin. Optional
     * so generations installed before this field keep their fingerprint.
     */
    periodDuration?: string;
    alignment?: ReportingScheduleAlignment;
    periodTimezone?: string;
    deliverySlaDuration?: string;
  };
  sourceSettings: ReportingSourceSliceRequestV1['sourceSettings'];
  contract: ReportingSourceSliceRequestV1['contract'];
  installedAt: string;
  supersededAt?: string;
  semanticFingerprint: string;
}

export interface ReportingLedgerObligationV1 {
  reporting_obligation_id: string;
  configurationId: string;
  account: ReportingLedgerAccountV1;
  sourceScope: Record<string, unknown>;
  delivery_config_id: string;
  delivery_config_version: number;
  offeringId: string;
  report_definition_id: string;
  feedPurpose: 'pacing' | 'analytics' | 'billing';
  requiredFinality: ReportingFinalityV1;
  finalityPolicy?: ReportingLedgerConfigurationV1['finalityPolicy'];
  canonicalization?: ReportingLedgerConfigurationV1['canonicalization'];
  periodOrdinal: number;
  period: { start: string; end: string; sourceTimezone: string };
  /** Immutable schedule lineage used to reproduce the exact wire period boundaries. */
  schedule: ReportingLedgerConfigurationV1['schedule'];
  scopeResolvedAt: string;
  coverage: ReportingLedgerCoverageV1;
  requestedMetrics: string[];
  requestedDimensions: string[];
  constituents: ReportingSourceSliceRequestV1['coverage']['constituents'];
  mediaBuyIds: string[];
  sourceSettings: ReportingSourceSliceRequestV1['sourceSettings'];
  contract: ReportingSourceSliceRequestV1['contract'];
  expectedAt: string;
  recoveryDeadlineAt: string;
  publicationOffsets: number[];
  nextAttemptAt: string;
  attemptCount: number;
  state: 'pending' | 'terminal';
  semanticFingerprint: string;
  createdAt: string;
}

export interface ReportingRevisionBindingV1 {
  algorithm: 'rfc8785_jcs_v1';
  sha256: string;
  byteCount: number;
  rowCount: number;
}

export interface ReportingLedgerRevisionV1 {
  reporting_revision_id: string;
  reporting_obligation_id: string;
  revisionNumber: number;
  finality: ReportingFinalityV1;
  kind: 'snapshot' | 'official';
  supersedes_reporting_revision_id?: string;
  manifest: SourceBatchManifestReferenceV1;
  sourcePublicationId: string;
  binding: ReportingRevisionBindingV1;
  rows: Record<string, unknown>[];
  observedAt: string;
  dataThrough: string | null;
  sourceReadCutoffAt: string;
  createdAt: string;
  wireRevision: ReportingRevision;
}

export interface ReportingLedgerAdjustmentV1 {
  reporting_adjustment_id: string;
  reporting_obligation_id: string;
  adjusts_reporting_revision_id: string;
  adjustmentNumber: number;
  manifest: SourceBatchManifestReferenceV1;
  sourcePublicationId: string;
  binding: ReportingRevisionBindingV1;
  rows: Record<string, unknown>[];
  observedAt: string;
  dataThrough: string | null;
  sourceReadCutoffAt: string;
  createdAt: string;
  wireAdjustment: ReportingAdjustment;
}

export type ReportingLedgerRevisionSnapshotV1 = Omit<ReportingLedgerRevisionV1, 'rows'>;
export type ReportingLedgerRevisionMetadataV1 = Omit<ReportingLedgerRevisionV1, 'rows'>;
export type ReportingLedgerAdjustmentSnapshotV1 = Omit<ReportingLedgerAdjustmentV1, 'rows'>;

export interface ReportingLedgerConsumerStatusV1 {
  consumerStatusId: string;
  reporting_revision_id: string;
  reporting_obligation_id: string;
  supersedesConsumerStatusId?: string;
  status: Record<string, unknown>;
  createdAt: string;
}

/** Wire fields follow the generated protocol contract, including status-specific reason codes. */
export interface ReportingLedgerConsumerStatementV1 extends Omit<ReportingConsumerStatus, 'recorded_at'> {
  /** Authenticated transport principal; never serialized on the wire. */
  consumerId: string;
  account_id: string;
  recorded_at: string;
}

export type ReportingLedgerConsumerStatusInputV1 = Omit<ReportingLedgerConsumerStatementV1, 'recorded_at'>;

/** Durable diagnostic pointers are bounded independently of caller payload size. */
export const REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES = 1024;
/** Durable replay messages are sanitized and bounded independently of custom stores. */
export const REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES = 1024;
/** A single durable consumer statement may occupy at most 64 KiB. */
export const REPORTING_CONSUMER_STATUS_MAX_BYTES = 64 * 1024;
/** The complete request is bounded before validation or canonical hashing. */
export const REPORTING_CONSUMER_STATUS_BATCH_MAX_BYTES = 8 * 1024 * 1024;
/** Replay metadata is bounded per immutable batch row. */
export const REPORTING_CONSUMER_STATUS_BATCH_RESULT_MAX_BYTES = 64 * 1024;

/** Canonical identity of one consumer-status supersession chain. */
export interface ReportingConsumerStatusChainIdentityV1 {
  delivery_config_id: string;
  delivery_config_version: number;
  report_definition_id: string;
  periodStart: string;
  periodEnd: string;
  sourceTimezone: string;
}

export type ReportingConsumerStatusBatchEntryV1 =
  | {
      status: ReportingLedgerConsumerStatusInputV1;
      validationError?: string;
      validationField?: string;
      validationKeyword?: string;
    }
  | {
      reporting_status_id: string;
      /** True when the handler synthesized the ID because the caller supplied no valid wire ID. */
      syntheticReportingStatusId?: boolean;
      validationError: string;
      validationField?: string;
      validationKeyword?: string;
      chainIdentity?: ReportingConsumerStatusChainIdentityV1;
    };

export interface ReportingConsumerStatusBatchInputV1 {
  account_id: string;
  consumerId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  /** Ordered entries retain independent failures in the idempotent batch result. */
  entries: ReportingConsumerStatusBatchEntryV1[];
  /** Protocol batch retries return the original result; low-level single puts opt out. */
  replayOriginalResults?: boolean;
}

export type ReportingConsumerStatusReplayInputV1 = Pick<
  ReportingConsumerStatusBatchInputV1,
  'account_id' | 'consumerId' | 'idempotencyKey' | 'requestFingerprint'
>;

export type ReportingConsumerStatusBatchResultV1 =
  | { inserted: boolean; value: ReportingLedgerConsumerStatementV1 }
  | {
      inserted: false;
      reporting_status_id: string;
      errorCode: string;
      recovery?: ErrorRecovery;
      /** Integer wire seconds from 1 through 3600. Invalid values are omitted. */
      retryAfterSeconds?: number;
      safeMessage: string;
      errorField?: string;
      errorKeyword?: string;
    };

/**
 * Seller-maintained lifecycle for one `issueId`.
 *
 * All four values are storable, but only `open` and `acknowledged` are
 * publishable: retiring an issue removes it from the projection instead of
 * emitting it at a terminal state, which is what lets a reader treat a nonempty
 * `issues[]` as degradation. The read handler drops `resolved` and `waived`
 * issues rather than emitting them with the state elided, so marking an issue
 * retired in a custom store does what it looks like it does.
 */
export type ReportingIssueStateV1 = 'open' | 'acknowledged' | 'resolved' | 'waived';

export interface ReportingLedgerIssueV1 {
  issueId: string;
  reporting_obligation_id: string;
  code:
    | 'REPORT_OVERDUE'
    | 'PRODUCTION_FAILED'
    | 'DELIVERY_FAILED'
    | 'ACCESS_REQUIRED'
    | 'CONFIGURATION_REQUIRED'
    | 'REPORTING_COVERAGE_INCOMPLETE'
    | 'RESOURCE_EXPIRED'
    | 'READER_INCOMPATIBLE'
    | 'HISTORY_UNAVAILABLE'
    | 'RECEIPT_REQUIRED'
    | 'RECEIPT_REJECTED'
    | 'ADJUSTMENT_RECEIPT_REQUIRED'
    | 'ADJUSTMENT_RECEIPT_REJECTED'
    | 'CONSUMER_STATUS_MISMATCH';
  severity: 'delayed' | 'action_required';
  responsibleParty: 'seller' | 'buyer' | 'provider';
  recommendedAction:
    | 'wait_for_retry'
    | 'contact_buyer'
    | 'contact_seller'
    | 'contact_provider'
    | 'repair_access'
    | 'update_configuration'
    | 'change_reporting_scope'
    | 'use_supported_reader';
  detail?: Record<string, unknown>;
  /**
   * Consumer statement that caused this issue. Required on the wire for
   * `CONSUMER_STATUS_MISMATCH` — see {@link ReportingLedgerConsumerMismatchIssueV1},
   * which is the variant to construct for that code.
   */
  reporting_status_id?: string;
  /**
   * When the seller first observed this logical condition.
   *
   * Fixed at first emission and carried unchanged across every re-emission of
   * the same `issueId` — including across ledger snapshots and across a
   * severity change from `delayed` to `action_required`. It anchors the
   * escalation clock advertised as `consumer_mismatch_escalation_seconds`, so
   * advancing it on re-emission would let a seller hold an unresolved issue
   * below `action_required` indefinitely. The SDK derives it from immutable
   * ledger facts rather than from the current read time for exactly that
   * reason. Required on the wire for `CONSUMER_STATUS_MISMATCH`.
   */
  openedAt: string;
  /**
   * Optional seller-maintained lifecycle for this `issueId`. Omission means
   * `open`. Only `open` and `acknowledged` issues may appear in `issues[]`:
   * retiring an issue removes it from the projection instead of publishing it
   * at `resolved` or `waived`, so a reader that treats a nonempty `issues[]`
   * as degradation stays correct.
   *
   * For `CONSUMER_STATUS_MISMATCH` retirement is additionally constrained —
   * see `consumer_mismatch_lifecycle` on `core/reporting-status-issue.json`.
   * A seller MUST NOT return a period to `healthy` or `complete` while the
   * consumer statement that caused the mismatch is still that consumer's
   * current unsuperseded leaf. The SDK's derived projection satisfies this by
   * construction because it recomputes the mismatch from the current leaf on
   * every read; a custom store that persists issues must enforce it.
   */
  issueState?: ReportingIssueStateV1;
  /**
   * Optional opaque, non-secret correlation string for the emitting party's
   * own tracker — a ticket key, incident ID, or case number.
   *
   * Inert display text with no protocol meaning. The wire character class
   * excludes whitespace and the solidus so the value cannot express a URL or
   * a sentence; receivers compare, store, and display it and never
   * dereference, resolve, or execute it. A seller MUST NOT reuse one
   * `externalRef` across callers on a caller-scoped issue: a
   * `CONSUMER_STATUS_MISMATCH` is caller-scoped, so a shared ref would leak
   * the blast radius of a seller-side incident between tenants.
   */
  externalRef?: string;
  observedAt: string;
  resolvedAt?: string;
}

/**
 * Non-secret human escalation path for reporting issues the protocol cannot
 * resolve. Display metadata for an operator, not an AdCP endpoint: agents MUST
 * NOT dereference, probe, or send protocol traffic to these values, and they
 * carry no authorization. At least one of `url` / `email` is required.
 */
export interface ReportingOperationsContactV1 {
  /**
   * HTTPS page a human uses to open or track a reporting issue. Constrained to
   * the same hardened public-origin shape as the offering document URIs — never
   * an IP literal, userinfo URL, loopback host, AdCP task endpoint, webhook
   * target, or credentialed link — so never-dereference holds by construction.
   */
  url?: string;
  /** Monitored operations mailbox. A role address, not an individual. */
  email?: string;
}

/**
 * Seller commitment that an unattended `CONSUMER_STATUS_MISMATCH` escalates to
 * a human within a bounded window.
 *
 * Advertise both fields or neither: the wire schema conditions
 * `consumer_mismatch_escalation_seconds` on `operations_contact` so the
 * escalation always has a destination. Absence means the seller publishes no
 * escalation commitment; it never means an unbounded one.
 */
export interface ReportingConsumerMismatchEscalationV1 {
  /**
   * Maximum interval after an issue's `openedAt` during which the seller may
   * keep it at a non-escalated `recommendedAction`. At or after that boundary
   * the issue is emitted at severity `action_required` with a `contact_*`
   * action naming the diagnosed responsible party. `wait_for_retry` MUST NOT
   * survive the boundary: an unattended mismatch is an escalation, not a retry.
   */
  escalationSeconds: number;
  operationsContact: ReportingOperationsContactV1;
}

/**
 * `CONSUMER_STATUS_MISMATCH` narrowed to what the wire actually requires.
 *
 * `opened_at` and `reporting_status_id` are both mandatory on this code, so a
 * store that builds the base shape can typecheck its way into a response the
 * SDK's own validator rejects. Construct this variant instead.
 */
export type ReportingLedgerConsumerMismatchIssueV1 = ReportingLedgerIssueV1 & {
  code: 'CONSUMER_STATUS_MISMATCH';
  reporting_status_id: string;
  openedAt: string;
};

export interface ReportingLedgerStatusTransitionV1 {
  transitionId: string;
  reporting_obligation_id: string;
  previousHealth: ReportingHealthV1;
  health: ReportingHealthV1;
  /** Finality visible immediately before this transition. Added in SDK 14. */
  previousFinality?: ReportingObservedFinalityV1;
  /** Finality visible at this transition. Added in SDK 14. */
  finality?: ReportingObservedFinalityV1;
  issueIds: string[];
  occurredAt: string;
  notifiedAt?: string;
}

/** Minimum transaction surface used by the bundled PostgreSQL ledger. */
export interface ReportingLedgerTransactionV1 {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * Persists the durable consequence of a reporting lifecycle transition.
 *
 * The ledger store MUST call this port with its active authoritative
 * transaction. Implementations must not perform network I/O from this method.
 */
export interface ReportingLedgerNotificationActivityPortV1<TTransaction = unknown> {
  recordTransition(
    input: {
      transition: Readonly<ReportingLedgerStatusTransitionV1>;
      obligation: Readonly<ReportingLedgerObligationV1>;
    },
    transaction: TTransaction
  ): Promise<void>;
}

export interface ReportingLedgerSubscriberV1 {
  subscriberId: string;
  account_id: string;
  notify(transition: Readonly<ReportingLedgerStatusTransitionV1>): void | Promise<void>;
}

export interface ReportingLedgerSnapshotQueryV1 {
  account_id: string;
  /** Authenticated consumer scope used only for caller-attributed status readback. */
  consumer_id?: string;
  view: 'summary' | 'periods' | 'revision';
  media_buy_ids?: string[];
  delivery_config_ids?: string[];
  feed_purposes?: Array<'pacing' | 'analytics' | 'billing'>;
  health?: ReportingHealthV1[];
  finality?: ReportingFinalityV1[];
  reporting_revision_id?: string;
  reporting_status_id?: string;
  period?: { start?: string; end?: string };
  changes_after?: string;
}

export interface ReportingLedgerSnapshotV1 {
  snapshotId: string;
  ledgerAsOf: string;
  changesCheckpoint: string;
  queryFingerprint: string;
  query: ReportingLedgerSnapshotQueryV1;
  /** Configuration lineage used to prove that every closed-period obligation is present. */
  configurations: ReportingLedgerConfigurationV1[];
  /** Full scoped ordinal set; retained when changes_after returns only changed obligations. */
  coverageOrdinals: Array<{
    configurationId: string;
    periodOrdinal: number;
    period?: { start: string; end: string };
  }>;
  obligations: ReportingLedgerObligationV1[];
  revisions: ReportingLedgerRevisionSnapshotV1[];
  adjustments: ReportingLedgerAdjustmentSnapshotV1[];
  /** Present only when the opt-in Managed Delivery migration is installed. */
  managedBindings?: ReportingManagedDeliveryBindingV1[];
  materializations?: ReportingMaterialization[];
  /** Full immutable history; separate from authorization-aware health projection. */
  materializationHistoryProjection?: ReportingMaterialization[];
  materializationProjection?: ReportingMaterialization[];
  /** Authenticated caller's receipts only; another consumer is never projected. */
  receipts?: ReportingReceipt[];
  receiptProjection?: ReportingReceipt[];
  adjustmentReceipts?: ReportingAdjustmentReceipt[];
  adjustmentReceiptProjection?: ReportingAdjustmentReceipt[];
  /**
   * Subjects whose accepted receipt body has been pruned.
   *
   * Retention removes bodies past the advertised horizon, but an accepted
   * leaf is terminal forever. Without this the projection stops seeing the
   * acceptance and reopens a settled subject.
   */
  tombstonedAcceptedSubjects?: Array<{ kind: 'revision' | 'adjustment'; subjectId: string; consumerId: string }>;
  /** Revisions whose successful materialization row has been pruned. */
  tombstonedDeliveredRevisionIds?: readonly string[];
  consumerStatuses?: ReportingLedgerConsumerStatementV1[];
  /** Full scoped histories retained across changes_after for complete counts and current-leaf projection. */
  consumerStatusProjection?: ReportingLedgerConsumerStatementV1[];
  issues: ReportingLedgerIssueV1[];
}

export interface ReportingLedgerPageV1 {
  snapshot: ReportingLedgerSnapshotV1;
  obligations: ReportingLedgerObligationV1[];
  revisions: ReportingLedgerRevisionSnapshotV1[];
  adjustments: ReportingLedgerAdjustmentSnapshotV1[];
  materializations?: ReportingMaterialization[];
  receipts?: ReportingReceipt[];
  adjustmentReceipts?: ReportingAdjustmentReceipt[];
  consumerStatuses?: ReportingLedgerConsumerStatementV1[];
  totalCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

/**
 * Immutable opt-in binding between one Core configuration generation and one
 * caller-owned destination authorization generation. Core configurations do
 * not carry this shape and remain API-delivered.
 */
export interface ReportingManagedDeliveryBindingV1 {
  configurationId: string;
  account_id: string;
  delivery_config_id: string;
  delivery_config_version: number;
  destination_ref: string;
  authorization_generation: number;
  feed_purpose: 'pacing' | 'analytics' | 'billing';
  method: ReportingMaterialization['method'];
  transport?: string;
  verification_profile: NonNullable<ReportingMaterialization['verification']>['verification_profile'];
  reconciliation_mode: 'delivery_only' | 'consumer_receipt';
  resource_retention_days: number;
  created_at: string;
  semantic_fingerprint: string;
}

/**
 * Managed Delivery inputs the lifecycle reconciler needs to project the same
 * health the read path projects.
 *
 * Reads are scoped to one authenticated consumer; a persisted transition is
 * account-level, so receipts arrive grouped per consumer and the reconciler
 * folds the per-consumer projections with `moreSevereReportingHealthV1`. The
 * seller's obligation is only reconciled once every consumer that owes a
 * receipt has accepted, so the most severe consumer is the truthful one.
 */
export interface ReportingManagedLifecycleProjectionV1 {
  binding: ReportingManagedDeliveryBindingV1;
  /** Authorization-aware view: a revoked destination reads as `failed`. */
  materializations: ReportingMaterialization[];
  /** Full immutable history, independent of current authorization. */
  materializationHistory: ReportingMaterialization[];
  /** One entry per consumer that has submitted receipts; empty when none has. */
  consumers: Array<{
    consumer_id: string;
    receipts: ReportingReceipt[];
    adjustmentReceipts: ReportingAdjustmentReceipt[];
  }>;
  /**
   * Principals that owe a receipt for this obligation, from trusted state.
   *
   * `consumers` alone is not a roster: it is only who has already submitted
   * something. Aggregating it would let an authorized consumer that owes a
   * receipt and has stayed silent vanish the moment another consumer accepts,
   * so the account-level transition could report the obligation reconciled
   * while that consumer's own read still says `action_required`. Entries here
   * that have submitted nothing are projected with empty receipts.
   */
  obligatedConsumerIds?: readonly string[];
  /**
   * Set only when `obligatedConsumerIds` is provably the complete roster.
   *
   * The managed tables key destination authorizations and bindings by
   * `(account_id, destination_ref, generation)` with no consumer dimension, so
   * the SDK's own PostgreSQL store cannot prove completeness and leaves this
   * false. While it is false the reconciler keeps projecting one additional
   * zero-receipt consumer for a `consumer_receipt` binding, so the obligation
   * is never reported reconciled on the strength of the consumers that
   * happened to be observed. A seller whose authorization layer knows the
   * roster should supply it and set this true to get accurate reconciled
   * transitions.
   */
  obligatedConsumerRosterComplete?: boolean;
  /**
   * False when the store could not project every consumer's receipt evidence.
   *
   * A store bounds what it will hold in memory at once. Crossing that bound
   * must not fail the reconcile — nothing about a retry makes a large tenant
   * smaller — so the store truncates at a deterministic consumer boundary and
   * says so here. An incomplete projection can never prove reconciliation, so
   * the fold treats it exactly as it treats an unproven roster.
   */
  receiptEvidenceComplete?: boolean;
  /**
   * Adjustments this obligation had at the projection's cutoff.
   *
   * Adjustment bodies carry a producer-authored `createdAt`, which is a host
   * clock; the cutoff is compared against the store's own ordering column. A
   * store that can tell the two apart reports the cutoff-visible set here, and
   * the reconciler folds only those — otherwise a fast producer clock hid a
   * correction from the lifecycle while the public status still demanded a
   * receipt for it.
   */
  visibleAdjustmentIds?: readonly string[];
  /**
   * Revisions this obligation had at the projection's cutoff.
   *
   * The managed evidence beside a revision is cutoff-bounded, so the revision
   * set has to be too: one committed after the cutoff arrives with no
   * materialization and no receipt in scope and reads as an unmet obligation.
   * The CAS still fences on the full set — that is a concurrency check, not a
   * statement about the moment being described.
   */
  visibleRevisionIds?: readonly string[];
  /**
   * Opaque token over the managed state this projection was computed from.
   *
   * The lifecycle CAS fences Core evidence — revision set, obligation state,
   * attempt count, predecessor health — but managed state is read in a
   * separate transaction, so a revocation, receipt, adjustment or
   * materialization landing between projection and apply would be written over
   * by a health computed before it existed. Pass it back through
   * `applyLifecycleProjection` so a store that supplies one can refuse a stale
   * apply.
   */
  managedStateVersion?: string;
  /**
   * Subjects whose accepted receipt body has been pruned, and revisions whose
   * successful materialization has been pruned.
   *
   * Retention removes bodies; it must not remove conclusions. Without these
   * the lifecycle recomputes an accepted subject as outstanding and a
   * delivered revision as never delivered.
   */
  tombstonedAcceptedSubjects?: Array<{ kind: 'revision' | 'adjustment'; subjectId: string; consumerId: string }>;
  tombstonedDeliveredRevisionIds?: readonly string[];
  /**
   * The cutoff this projection actually used, at full database precision.
   *
   * A host `toISOString()` is millisecond-truncated while the underlying
   * columns are microsecond timestamps, so a caller-taken "now" can sort
   * before a row written in the same millisecond. A store that resolves its
   * own instant reports it here, and the reconciler uses it for everything
   * downstream so the projection, its token and the transition all describe
   * one instant.
   */
  resolvedLedgerAsOf?: string;
  /**
   * Version of the externally supplied obligated-consumer roster.
   *
   * The roster is fetched outside the store's transaction, so it cannot be
   * re-read inside the apply. It is versioned separately and re-checked just
   * before the apply instead, which is what keeps a concurrent roster change
   * from passing the CAS.
   */
  obligatedConsumerRosterVersion?: string;
}

export interface ReportingLedgerLeaseV1 {
  obligation: ReportingLedgerObligationV1;
  owner: string;
  generation: number;
  expiresAt: string;
}

export class ReportingLedgerSnapshotUnavailableError extends Error {
  constructor() {
    super('Reporting ledger snapshot is unavailable');
    this.name = 'ReportingLedgerSnapshotUnavailableError';
  }
}

export class ReportingConsumerStatusConflictError extends Error {
  /**
   * The message is diagnostic-only. The protocol handler always returns a
   * fixed oracle-resistant conflict message to the caller.
   */
  constructor(message = 'Reporting consumer status conflicts with the current immutable chain') {
    super(message);
    this.name = 'ReportingConsumerStatusConflictError';
  }
}

export interface ReportingLedgerStore {
  /** Optional substrate identity for an add-on store that must prove shared authority. */
  readonly [REPORTING_LEDGER_AUTHORITY]?: ReportingLedgerAuthorityV1;
  /**
   * True when durable notification/activity intent is committed with transitions.
   * Such stores must atomically stamp `notifiedAt` as the durable handoff marker.
   */
  readonly transactionalNotificationActivity?: boolean;
  /**
   * Resolves the authoritative observed finality of the obligation's latest
   * transition.
   *
   * Transitions written from SDK 14 onward carry their own `finality`, so the
   * baseline is read straight back off the committed row. Pre-SDK-14 rows carry
   * none, and a store MUST NOT reconstruct one: nothing already stored proves
   * which revisions had committed when such a row was recorded. Payload
   * timestamps rank creation instants rather than commits, and insert wall
   * clocks such as `clock_timestamp()` can repeat within a microsecond and step
   * backward. Either rule can conclude `official`, which makes
   * `previousFinality` equal `finality` and permanently suppresses the real
   * snapshot→official change.
   *
   * Such rows therefore resolve to `'none'`, which the store persists so
   * `applyLifecycleProjection` compares against the same committed value the
   * lifecycle decision used. That records at most one redundant finality-only
   * transition per obligation at upgrade, which stays internal activity because
   * the AdCP status webhook is health-only.
   *
   * Optional for stores compiled against the pre-finality lifecycle port. Such
   * stores must also ignore `expectedPreviousFinality`, and omitting the port
   * is **not** equivalent to returning `'none'`: the lifecycle cannot persist a
   * baseline on their behalf, so it uses the currently observed finality
   * instead, making the comparison a no-op. Finality is simply unobservable
   * there — health transitions still fire, finality-only ones never do, exactly
   * as before finality existed. Returning `'none'` for such a store would
   * instead make every reconciliation tick observe `'none' -> official` and
   * append another finality-only transition, forever.
   *
   * So a store that wants finality-only activity at all must implement this
   * port, and commit what it returns.
   */
  resolveTransitionFinalityBaseline?(reporting_obligation_id: string): Promise<ReportingObservedFinalityV1>;
  putConfiguration(
    configuration: ReportingLedgerConfigurationV1
  ): Promise<{ inserted: boolean; value: ReportingLedgerConfigurationV1 }>;
  listConfigurations(account_id?: string): Promise<ReportingLedgerConfigurationV1[]>;
  putObligation(
    obligation: ReportingLedgerObligationV1
  ): Promise<{ inserted: boolean; value: ReportingLedgerObligationV1 }>;
  getObligation(reporting_obligation_id: string, account_id?: string): Promise<ReportingLedgerObligationV1 | null>;
  listObligations(account_id?: string): Promise<ReportingLedgerObligationV1[]>;
  listLifecycleDueObligations(input: {
    ledgerAsOf: string;
    account_id?: string;
    limit: number;
  }): Promise<ReportingLedgerObligationV1[]>;
  /** Updates a leased obligation and atomically records an optional production issue. */
  updateObligation(
    obligation: ReportingLedgerObligationV1,
    lease: ReportingLedgerLeaseV1,
    issue?: ReportingLedgerIssueV1
  ): Promise<void>;
  claimObligation(input: {
    owner: string;
    now: string;
    leaseMilliseconds: number;
    account_id?: string;
  }): Promise<ReportingLedgerLeaseV1 | null>;
  releaseObligationLease(lease: ReportingLedgerLeaseV1): Promise<void>;
  commitRevision(
    revision: ReportingLedgerRevisionV1,
    lease: ReportingLedgerLeaseV1
  ): Promise<{ inserted: boolean; value: ReportingLedgerRevisionV1 }>;
  /** Returns an exact row-bearing revision only when it belongs to the resolved account. */
  getRevision(reporting_revision_id: string, account_id: string): Promise<ReportingLedgerRevisionV1 | null>;
  listRevisions(reporting_obligation_id: string): Promise<ReportingLedgerRevisionV1[]>;
  commitAdjustment(
    adjustment: ReportingLedgerAdjustmentV1,
    lease: ReportingLedgerLeaseV1
  ): Promise<{ inserted: boolean; value: ReportingLedgerAdjustmentV1 }>;
  listAdjustments(reporting_obligation_id: string): Promise<ReportingLedgerAdjustmentV1[]>;
  putConsumerStatus(
    status: ReportingLedgerConsumerStatusV1
  ): Promise<{ inserted: boolean; value: ReportingLedgerConsumerStatusV1 }>;
  listConsumerStatuses(reporting_revision_id: string): Promise<ReportingLedgerConsumerStatusV1[]>;
  putIssue(issue: ReportingLedgerIssueV1): Promise<void>;
  resolveIssue(issueId: string, resolvedAt: string): Promise<void>;
  listIssues(reporting_obligation_id: string): Promise<ReportingLedgerIssueV1[]>;
  appendTransition(transition: ReportingLedgerStatusTransitionV1): Promise<{ inserted: boolean }>;
  /**
   * Atomically applies a lifecycle projection only while its revision evidence and
   * predecessor health still match. Implementations must serialize this with
   * revision commits for the same account.
   */
  applyLifecycleProjection(input: {
    reporting_obligation_id: string;
    expectedRevisionIds: string[];
    expectedPreviousHealth: ReportingHealthV1;
    /**
     * Baseline observed finality the caller decided against, as returned by
     * `resolveTransitionFinalityBaseline`. Stores must compare it against that
     * same committed baseline and never against a freshly reconstructed one.
     * Optional for callers compiled against the pre-finality lifecycle port.
     */
    expectedPreviousFinality?: ReportingObservedFinalityV1;
    expectedObligationState: ReportingLedgerObligationV1['state'];
    expectedAttemptCount: number;
    projectedIssues: ReportingLedgerIssueV1[];
    ledgerAsOf: string;
    transition?: ReportingLedgerStatusTransitionV1;
    /**
     * Managed-state token from the projection this apply was computed from.
     * A store that produces `managedStateVersion` MUST re-read it inside the
     * apply transaction and return `applied: false` when it has moved, so a
     * concurrent managed write cannot be overwritten by a stale health.
     */
    expectedManagedStateVersion?: string;
    /**
     * Watermark to record for this obligation, even when health did not move.
     *
     * Without it a managed change with no health effect leaves the obligation
     * due forever, and a fair-ordered sweep keeps returning it ahead of work
     * that has waited less.
     */
    processedManagedStateVersion?: string;
    processedObligatedConsumerRosterVersion?: string;
    /**
     * Roster version this reconcile observed, for the same compare-and-set
     * treatment as `expectedManagedStateVersion`.
     *
     * The roster lives outside the store, so the apply cannot re-read it.
     * A store that records what readers observed MUST NOT overwrite a newer
     * observation with this one: the due query compares the observed version
     * with the processed one, so clobbering it drops the re-arm.
     */
    expectedObligatedConsumerRosterVersion?: string;
  }): Promise<{ applied: boolean; transitionInserted: boolean }>;
  markTransitionNotified(transitionId: string, notifiedAt: string): Promise<void>;
  /**
   * Managed Delivery projection inputs for one obligation.
   *
   * Optional on purpose: a Core-only ledger omits it and the lifecycle stays
   * Core-only, exactly as before. A store that has the Managed Delivery
   * migration installed must implement it, otherwise persisted transitions and
   * webhooks would keep reporting Core health while `get_reporting_status`
   * reports the composed managed health — the divergence this exists to close.
   * Return `null` for an obligation whose configuration has no managed binding.
   */
  getManagedLifecycleProjection?(input: {
    reporting_obligation_id: string;
    /** Omit to let the store resolve an authoritative instant at full precision. */
    ledgerAsOf?: string;
  }): Promise<ReportingManagedLifecycleProjectionV1 | null>;
  /**
   * Re-reads the external obligated-consumer roster version immediately
   * before an apply, outside any transaction.
   */
  readObligatedConsumerRosterVersion?(input: { reporting_obligation_id: string }): Promise<string | undefined>;
  /**
   * An authoritative instant from the ledger's own clock, at full precision.
   *
   * Lifecycle cutoffs taken from a caller's `Date` are millisecond-truncated
   * and may lag the database, which silently drops rows written in the same
   * millisecond. Reconciliation prefers this when the caller has not pinned a
   * cutoff, and always takes a fresh one before a retry.
   */
  readLedgerInstant?(): Promise<string>;
  /**
   * Records a failed reconcile so the obligation backs off rather than
   * re-occupying the head of every sweep. It must not advance the
   * reconciliation watermark: the work is still unresolved.
   */
  recordLifecycleFailure?(input: { reporting_obligation_id: string }): Promise<void>;
  /**
   * Refreshes the recorded roster version for obligations that have one.
   *
   * The roster lives outside the database, so nothing here changes when it
   * does. Publishing the version only during a reconcile is circular — a
   * reconcile happens because the obligation is due, and a roster change is
   * what should have made it due. A sweep calls this first so a change made
   * while nothing was scheduled can still schedule something.
   */
  refreshObligatedConsumerRosterVersions?(input: { account_id?: string; limit: number }): Promise<number>;
  listTransitions(reporting_obligation_id: string): Promise<ReportingLedgerStatusTransitionV1[]>;
  listPendingTransitions(input?: { account_id?: string; limit?: number }): Promise<ReportingLedgerStatusTransitionV1[]>;
  createSnapshot(query: ReportingLedgerSnapshotQueryV1): Promise<ReportingLedgerSnapshotV1>;
  /** Throw ReportingLedgerSnapshotUnavailableError for unknown, expired, or mismatched cursors and snapshots. */
  readSnapshotPage(
    snapshotId: string,
    account_id: string,
    cursor: string | undefined,
    limit: number
  ): Promise<ReportingLedgerPageV1>;
}

/**
 * Minimal authoritative-ledger port required by sync_reporting_status.
 *
 * Existing seller ledgers can implement this interface without adopting the
 * SDK producer, worker, lifecycle, lease, issue, or row-storage APIs. Methods
 * carrying account/principal arguments must enforce them; the handler also
 * re-checks account identity on returned configurations, obligations,
 * revisions, and snapshots. syncConsumerStatusBatch must reject every entry
 * in duplicate-ID or duplicate-logical-chain groups, then atomically compare
 * the current leaf, append, and retain the original ordered batch result for
 * idempotent replay.
 */
export interface ReportingConsumerStatusLedgerStore {
  listConfigurations(account_id: string): Promise<ReportingLedgerConfigurationV1[]>;
  getObligation(reporting_obligation_id: string, account_id: string): Promise<ReportingLedgerObligationV1 | null>;
  /** Loads revision identity and binding for ingest validation without materializing rows. */
  getRevisionMetadata(
    reporting_revision_id: string,
    account_id: string
  ): Promise<ReportingLedgerRevisionMetadataV1 | null>;
  /**
   * Every retained revision for one obligation, without materializing rows.
   *
   * Required to accept `content_mismatch`, which per `expected_period` is
   * *"valid only against a revision the seller currently requires for that
   * period"*. Deciding that needs the sibling set: a revision is superseded
   * when another one names it, which cannot be read off the named revision
   * alone. A store that does not implement this rejects `content_mismatch`
   * rather than accepting a statement it cannot validate — the other four
   * statuses are unaffected.
   *
   * `ReportingLedgerStore` implementors already satisfy this through
   * `listRevisions`; the handler uses whichever is present.
   */
  listRevisionMetadata?(
    reporting_obligation_id: string,
    account_id: string
  ): Promise<ReportingLedgerRevisionMetadataV1[]>;
  /** Reads only the caller-bound snapshot needed to validate optional provenance. */
  readSnapshotPage?(
    snapshotId: string,
    account_id: string,
    cursor: string | undefined,
    limit: number
  ): Promise<ReportingLedgerPageV1>;
  getConsumerStatusBatchReplay(
    input: ReportingConsumerStatusReplayInputV1
  ): Promise<ReportingConsumerStatusBatchResultV1[] | null>;
  syncConsumerStatusBatch(input: ReportingConsumerStatusBatchInputV1): Promise<ReportingConsumerStatusBatchResultV1[]>;
}

export interface ReportingProducerContactV1 {
  name: string;
  email?: string;
  url?: string;
}

export interface ReportingProducerV1 {
  installConfiguration(
    input: Omit<
      ReportingLedgerConfigurationV1,
      'configurationId' | 'installedAt' | 'semanticFingerprint' | 'calendarRules'
    >
  ): Promise<ReportingLedgerConfigurationV1>;
  planObligations(
    now?: string,
    options?: { account_id?: string; maxObligations?: number }
  ): Promise<ReportingLedgerObligationV1[]>;
  runWorker(options?: {
    signal?: AbortSignal;
    now?: () => Date;
    maxIterations?: number;
    retryDelayMilliseconds?: number;
    executionDeadlineMilliseconds?: number;
    settlementGraceMilliseconds?: number;
    account_id?: string;
  }): Promise<{
    claimed: number;
    revisionsCommitted: number;
    notReady: number;
    failed: number;
    /**
     * Obligations whose durable work committed but whose projection could not
     * be published on this pass. They stay due for the deadline sweep, which
     * isolates and backs off per obligation; a non-zero count that does not
     * clear is an operational signal, not a lost write.
     */
    reconcilesDeferred: number;
  }>;
}

export type ReportingSourceWithReaderV1 = ReportingSourceExecutorV1 & ReportingSourceStagedObjectReaderV1;
export type ReportingStatusHandlerV1 = (
  request: AdcpToolMap['get_reporting_status']['params'],
  context: HandlerContext<unknown>
) => Promise<GetReportingStatusResponse>;
export type ReportingDeliveryHandlerV1 = (
  request: AdcpToolMap['get_media_buy_delivery']['params'],
  context: HandlerContext<unknown>
) => Promise<AdcpToolMap['get_media_buy_delivery']['result']>;

export interface CreateReportingProducerOptionsV1 {
  store: ReportingLedgerStore;
  source: ReportingSourceWithReaderV1;
  offerings: readonly ReportingSourceOfferingV1[];
  contact: ReportingProducerContactV1;
  subscribers?: readonly ReportingLedgerSubscriberV1[];
}
