import { createHash } from 'crypto';
import type {
  GetReportingStatusRequest,
  GetReportingStatusResponse,
  ReportingCanonicalContentDigest,
  ReportingControlTotal,
  ReportingMaterialization,
  ReportingObligation,
  ReportingReceipt,
  ReportingConsumerStatus,
  ReportingRevision,
  SyncReportingReceiptsRequest,
  SyncReportingReceiptsResponse,
} from '../types/tools.generated';
import { generateIdempotencyKey } from '../utils/idempotency';
import { canonicalize } from '../utils/jcs';
import {
  detectReportingContentMismatch,
  type ReportingContractFactsV1,
  type ReportingMismatchCodeV1,
  type ReportingRowEvidenceV1,
} from './content-mismatch';
import { isReportingControlTotals, isReportingReceiptEvidence, isReportingVerificationEvidence } from './evidence';
import {
  createReportingManifestInspector,
  ReportingInspectionError,
  type ReportingCredentialProvider,
  type ReportingManifestInspectorOptions,
  type ReportingResourceReader,
} from './inspection';

/** `sync-reporting-status-request.json` caps `statuses` at 100 per batch. */
const CONSUMER_STATUS_BATCH_MAX = 100;

/**
 * Ceiling on the accumulated rows of one revision read, in approximate bytes.
 *
 * `maxRecords` bounds the row *count*; this bounds their size, which is the
 * dimension a seller actually controls. Exceeding it is a buyer-side budget,
 * so it suppresses rather than accusing.
 */
const MAX_CONSUMED_REVISION_BYTES = 256 * 1024 * 1024;

/**
 * Containers the estimator will walk into for one row.
 *
 * Only containers count. An ordinary wide row — an array of a hundred thousand
 * numbers — is one container, so it is sized exactly; a structure that needs
 * more than this to describe is one the estimator declines to size.
 */
const MAX_ROW_ESTIMATE_CONTAINERS = 262_144;

/**
 * A deadline that resolved, one that resolved outside the representable range,
 * or `undefined` for "nothing derived at all".
 *
 * The overflow arm carries the *field that overflowed*, because the whole
 * reason it is not folded into `undefined` is diagnostic: `undefined` is
 * reported as a missing pin, and telling an adopter to record a value they did
 * record — or to lower a window that was innocent — sends them to fix the
 * wrong field.
 */
type DerivedDeadline = { instant: string } | { overflowedField: string } | undefined;

/**
 * How deep the walk goes before declining.
 *
 * A row nested past this is the seller's shape, not the buyer's budget, so it
 * is reported rather than suppressed. The bound also keeps the walk off the
 * call stack: without one, a deep enough row overflows it, and the resulting
 * `RangeError` would be classified by the canonicalization guard as the buyer's
 * own ceiling — silence bought with an alibi.
 */
const MAX_ROW_ESTIMATE_DEPTH = 64;

// Runtime guards keep these evidence-bearing fields optional at the boundary so
// malformed or older seller payloads fail with reconciliation diagnostics rather
// than an unchecked property access.
type ManagedReportingObligation = ReportingObligation & {
  scope_resolved_at?: string;
  coverage?: ReportingCoverageEvidence;
};

export interface ReportingCoverageLimitation {
  reason:
    | 'offering_unsupported'
    | 'account_entitlement_unavailable'
    | 'credential_scope_insufficient'
    | 'provider_limitation'
    | 'capability_unknown';
  media_buy_id: string;
  package_ids?: string[];
}

export interface ReportingCoverageEvidence {
  status: 'full' | 'partial' | 'none' | 'unknown';
  evaluated_at: string;
  media_buy_ids: string[];
  fully_covered_media_buy_ids: string[];
  partially_covered_media_buy_ids: string[];
  unsupported_media_buy_ids: string[];
  unknown_media_buy_ids: string[];
  package_ids: string[];
  covered_package_ids: string[];
  unsupported_package_ids: string[];
  unknown_package_ids: string[];
  limitations: ReportingCoverageLimitation[];
}

export type ExpectedReportingCoverage = Omit<ReportingCoverageEvidence, 'evaluated_at' | 'limitations'>;

export type ReportingCanonicalDigestEvidence = ReportingCanonicalContentDigest & {
  canonicalization_uri: string;
};

type ManagedReportingRevision = Omit<ReportingRevision, 'canonical_content_digest'> & {
  report_definition_uri?: string;
  report_definition_sha256?: string;
  finality_basis?: 'source_final' | 'contractual_cutoff' | 'stabilized';
  finality_policy_id?: string;
  finalized_at?: string;
  coverage?: ReportingCoverageEvidence;
  canonical_content_digest?: ReportingCanonicalDigestEvidence;
};

export interface ReportingReconciliationClient {
  getReportingStatus(
    params: GetReportingStatusRequest,
    options?: { signal?: AbortSignal }
  ): Promise<GetReportingStatusResponse>;
  syncReportingReceipts(
    params: SyncReportingReceiptsRequest,
    options?: { signal?: AbortSignal }
  ): Promise<SyncReportingReceiptsResponse>;
  /**
   * rc.3 consumer-status loop. Optional so existing adopters keep working:
   * when it is absent the reconciler still *plans* every status and reports it
   * on the result, it just cannot post. Supply it only against a seller that
   * advertises `consumer_status_task`.
   */
  syncReportingStatus?(
    params: {
      account?: GetReportingStatusRequest['account'];
      idempotency_key: string;
      statuses: Array<Record<string, unknown>>;
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ status?: string; results?: unknown[] }>;
  /**
   * Exact-revision read, the only way a buyer can *earn* a `received`
   * statement.
   *
   * `observed_revision_content_sha256` is defined as the binding digest
   * "independently recomputed from the exact consumed Core revision binding".
   * Copying the seller's own `revision_content_sha256` out of the ledger would
   * hand that digest back unverified and turn buyer-attributed arrival evidence
   * into an echo. So the reconciler pages `reporting_rows` for the exact
   * revision, concatenates them in cursor order, and recomputes
   * SHA-256(JCS({reporting_revision_id,row_count,control_totals,reporting_rows}))
   * itself.
   *
   * Optional: without it the reconciler still plans `received` and
   * `content_mismatch`, but marks them `suppressed: 'consumption_unavailable'`
   * and posts neither. Attesting consumption we did not perform is the one
   * outcome worse than staying silent.
   */
  getMediaBuyDelivery?(
    params: {
      account?: GetReportingStatusRequest['account'];
      reporting_revision_id: string;
      pagination?: { cursor?: string };
    },
    options?: { signal?: AbortSignal }
  ): Promise<{
    status?: string;
    reporting_revision_binding?: {
      reporting_revision_id?: string;
      row_count?: number;
      control_totals?: ReportingControlTotal[];
      content_sha256?: string;
    };
    reporting_rows?: unknown[];
    pagination?: { has_more?: boolean; cursor?: string; total_count?: number };
  }>;
}

export interface ReportingLedger {
  ledgerSnapshotId: string;
  ledgerAsOf: string;
  accountId: string;
  scope: NonNullable<GetReportingStatusResponse['scope']>;
  obligations: ManagedReportingObligation[];
  revisions: ManagedReportingRevision[];
  materializations: ReportingMaterialization[];
  receipts: ReportingReceipt[];
  /**
   * The authenticated caller's own append-only status history for this scope.
   * Sellers disclose no other consumer's statements, so this is the only way to
   * see the current leaf's *content* — which is what tells the buyer whether it
   * has anything new to say.
   */
  consumerStatuses?: ReportingConsumerStatus[];
}

export interface ReportingLedgerLimits {
  /** Cursor pages per read. Bounds the ledger walk and each revision row read. */
  maxPages?: number;
  /** Ledger records (obligations + revisions + adjustments) in one snapshot. */
  maxRecords?: number;
  /**
   * Wall-clock budget, applied per read: the ledger walk, each receipt write,
   * each posting batch, the summary read — and, shared across all of them, the
   * consumer-status consumption pass.
   */
  maxLoadMs?: number;
  /**
   * Rows accumulated from one exact-revision read. Separate from `maxRecords`,
   * which bounds *ledger* records: a caller who capped a small ledger at a few
   * hundred records should not thereby cap every revision read at the same
   * number. Defaults to 100,000, and exceeding it suppresses the statement
   * rather than accusing the seller.
   */
  maxRevisionRows?: number;
  /**
   * Approximate accumulated bytes from one exact-revision read. May only
   * tighten the SDK's own 256 MiB ceiling: a larger value is **refused** with
   * `INVALID_LEDGER_LIMITS`, because that ceiling bounds this process's memory,
   * which is not the caller's to spend. Mainly here so the ceiling is reachable
   * in a test; exceeding it suppresses the statement rather than accusing the
   * seller.
   */
  maxRevisionBytes?: number;
}

interface ExpectedReportingPeriodBase {
  deliveryConfigId: string;
  deliveryConfigVersion: number;
  reportDefinitionId: string;
  feedPurpose: ReportingObligation['feed_purpose'];
  reportingProfile: string;
  mediaBuyIds: string[];
  destinationRef: string;
  deliveryMethod: ReportingMaterialization['method'];
  requiredFinality: ReportingObligation['required_finality'];
  reconciliationMode: ReportingObligation['reconciliation_mode'];
  coverageRequirement: 'full' | 'allow_partial';
  coverage: ExpectedReportingCoverage;
  reportDefinitionUri: string;
  reportDefinitionSha256: string;
  schemaVersion: string;
  schemaUri: string;
  schemaSha256: string;
  schemaDialect: 'https://json-schema.org/draft/2020-12/schema';
  schemaRefPolicy: 'local_fragment_only';
  /**
   * `metrics[].name` from the pinned report definition. Supplying it enables
   * the `metric_missing` arm of `content_mismatch`; omitting it means the buyer
   * never claims a promised metric is absent, which is the safe default.
   */
  committedMetrics?: readonly string[];
  /**
   * Units the pinned report definition fixed, keyed by metric/control-total
   * name. Enables the `currency_mismatch` arm. Omit to skip that check.
   */
  metricUnits?: Readonly<Record<string, string>>;
  /**
   * The seller's advertised `automated_recovery_window_seconds`, as the buyer
   * recorded it when accepting the configuration generation.
   *
   * It lives on `reporting-delivery-capabilities.json`, **not** on the
   * obligation, so the ledger cannot supply it — the buyer has to carry its own
   * copy. Without it the SDK cannot compute the rc.3 posting deadline, so it
   * marks nothing overdue and posts nothing automatically: silence is a counted
   * unknown, whereas posting on a guessed clock would churn the status chain.
   */
  automatedRecoveryWindowSeconds?: number;
  /**
   * The accepted configuration generation's `schedule.delivery_sla`, in
   * seconds, as the buyer recorded it.
   *
   * `expected_at` is "the resolved period end plus this duration". The seller
   * publishes `expected_at` on an obligation — but `obligation_missing` exists
   * precisely because there is no obligation, so for that statement the buyer
   * must derive it. Without this pin the SDK cannot prove a missing period is
   * yet owed, so it marks nothing overdue and posts nothing: `expected_period`
   * makes `obligation_missing` valid only at or after `expected_at`, and a
   * statement dated from the period end is rejected outright by a conformant
   * seller.
   */
  deliverySlaSeconds?: number;
  /**
   * Offset used instead of `deliverySlaSeconds` when `requiredFinality` is
   * `official`, if the seller advertises one.
   *
   * `reporting-schedule.json` defines only `delivery_sla`, but this repo's own
   * seller ingest anchors `expected_at` for official-finality generations on a
   * separate `officialAfterMilliseconds` and rejects a missing-status statement
   * dated before it. Without a matching pin a buyer on an official generation
   * posts at `period.end + delivery_sla`, is refused, and — because that
   * statement takes no clock input — rebuilds the identical body and is refused
   * again on every run. Leave it unset when the seller does not advertise one.
   */
  officialAfterSeconds?: number;
  /**
   * `period.source_timezone` for the accepted generation.
   *
   * A *check*, not the value that is wired. The seller's echoed
   * `period.source_timezone` goes on the statement whenever it has one, because
   * its ingest compares that field byte-for-byte and would refuse the buyer's
   * own spelling of the same zone. This pin is used for the wire value only
   * when the seller declared nothing.
   *
   * What it buys is detection: a pin naming a genuinely different zone from the
   * seller's echo sets `ReportingConsumerStatusPlanV1.periodZoneBeyondPin`, and
   * a link and its canonical name (`Japan` / `Asia/Tokyo`) are treated as one
   * zone. An unreadable pin suppresses as `period_identity_unknown` rather than
   * being silently ignored.
   */
  periodSourceTimezone?: string;
  /** Consumer-pinned finality rule, required whenever an official revision is accepted. */
  officialFinality?: {
    policyId: string;
    basis: 'source_final' | 'contractual_cutoff' | 'stabilized';
  };
  periodStart: string;
  periodEnd: string;
}

interface ExpectedCanonicalization {
  id: string;
  uri: string;
  sha256: string;
  primaryKeys: string[];
}

export type ExpectedReportingPeriod = ExpectedReportingPeriodBase &
  (
    | { verificationProfile: 'canonical_digest'; canonicalization: ExpectedCanonicalization }
    | { verificationProfile: 'manifest_checksums' | 'native_commit'; canonicalization?: never }
  );

export interface ReportingObservation {
  rowCount: number;
  controlTotals: ReportingControlTotal[];
  canonicalContentDigest?: ReportingCanonicalDigestEvidence;
  manifestSha256?: string;
  nativeVersionRef?: string;
  consumerCommitRef?: string;
}

export interface ReportingCheckpointKey {
  /** Caller-defined stable seller + authenticated-principal scope. */
  consumerScope: string;
  accountId: string;
  reportingObligationId: string;
  reportingRevisionId: string;
  reportingMaterializationId: string;
  destinationRef: string;
}

export interface ReportingCheckpoint {
  receipt: ReportingReceipt;
  receiptSyncIdempotencyKey: string;
  /** SHA-256 of the exact obligation, revision, materialization, and consumer expectation inspected. */
  contextFingerprint: string;
}

export interface ReportingCheckpointStore {
  get(key: ReportingCheckpointKey): Promise<ReportingCheckpoint | undefined>;
  put(key: ReportingCheckpointKey, checkpoint: ReportingCheckpoint): Promise<void>;
}

/** One consumer-status supersession chain: the logical key the spec defines. */
export interface ReportingPendingConsumerStatusKey {
  accountId: string;
  deliveryConfigId: string;
  deliveryConfigVersion: number;
  reportDefinitionId: string;
  periodStart: string;
  periodEnd: string;
}

export interface ReportingPendingConsumerStatus {
  /** The exact wire statement, replayed verbatim until the seller confirms it. */
  statement: Record<string, unknown>;
  /** Fingerprint of the claim it makes; a changed claim discards it. */
  claimFingerprint: string;
}

/**
 * Durable memory of a statement that has been built but not yet confirmed.
 *
 * `status_as_of` for `received` and `unreadable` is *when this consumer
 * consumed the revision* — buyer-attributed arrival evidence that the spec
 * explicitly refuses to let a seller substitute publication time for. That
 * makes it irreducibly stateful: a stateless reconciler cannot reproduce it,
 * so after a lost response it would build a different statement for the same
 * claim.
 *
 * Wire this store and the reconciler replays the original statement
 * byte-for-byte until the seller confirms it, which is the "exact retry" the
 * spec's `immutability` and `idempotency_key` rules are written around. Leave
 * it out and a re-plan is a new, valid statement instead: the chain still ends
 * with exactly one, it just is not literally the same one.
 */
export interface ReportingPendingConsumerStatusStore {
  get(key: ReportingPendingConsumerStatusKey): Promise<ReportingPendingConsumerStatus | undefined>;
  put(key: ReportingPendingConsumerStatusKey, pending: ReportingPendingConsumerStatus): Promise<void>;
  clear(key: ReportingPendingConsumerStatusKey): Promise<void>;
}

export interface ReportingInspectionContext {
  obligation: ManagedReportingObligation;
  revision: ManagedReportingRevision;
  materialization: ReportingMaterialization;
  /** Independently selected consumer contract and coverage expectations. */
  expected: ExpectedReportingPeriod;
}

export interface ObligationReconciliation {
  reportingObligationId: string;
  definitive: boolean;
  reportingRevisionId?: string;
  reportingMaterializationId?: string;
  reasons: string[];
}

/**
 * One consumer status the buyer owes for an expected period, with the deadline
 * that makes it owed.
 *
 * rc.3 moves the buyer's duty off "before you close the scope" and onto a
 * clock: a current status is owed by `expected_at` plus the seller's advertised
 * `automated_recovery_window_seconds`. A buyer still retrying at that point
 * posts `revision_missing` or `unreadable` and supersedes it later rather than
 * staying silent, because silence is what the seller counts in
 * `obligation_counts.consumer_status_pending`.
 */
export interface ReportingConsumerStatusPlanV1 {
  deliveryConfigId: string;
  deliveryConfigVersion: number;
  reportDefinitionId: string;
  period: { start: string; end: string; source_timezone: string };
  reportingObligationId?: string;
  reportingRevisionId?: string;
  observedRevisionContentSha256?: string;
  /**
   * The caller's current unsuperseded leaf, when the seller published one. A
   * new statement must name it; omitting it on a chain that already has a leaf
   * fails atomically rather than forking.
   */
  supersedesReportingStatusId?: string;
  consumerStatus: 'received' | 'obligation_missing' | 'revision_missing' | 'unreadable' | 'content_mismatch';
  mismatchCode?: ReportingMismatchCodeV1;
  failureCode?:
    | 'access_denied'
    | 'resource_not_found'
    | 'integrity_mismatch'
    | 'reader_incompatible'
    | 'transport_failed';
  /** `expected_at` + `automated_recovery_window_seconds`, when both are known. */
  deadline?: string;
  /** True once the deadline has passed — the status is owed now, not at scope close. */
  overdue: boolean;
  /**
   * When the consumer established this status.
   *
   * `undefined` while `requiresConsumption` is still true: a `received`
   * statement is dated from when the revision became consumable *to this
   * consumer*, which is not knowable until the buyer has actually read it.
   */
  statusAsOf?: string;
  /**
   * Earliest instant this statement may legally carry: the later of the
   * instant it became true and the superseded leaf's own `status_as_of`, since
   * `time` forbids a chain from moving backwards.
   */
  statusAsOfFloor: string;
  /**
   * True until the buyer has consumed the named revision and recomputed its
   * binding digest. `received` and `content_mismatch` both require that
   * recomputation, so neither may be posted while this is set.
   */
  requiresConsumption?: boolean;
  /**
   * Why this status was planned but not posted.
   *
   * - `unchanged` — the caller's current leaf already says exactly this. Posting
   *   it again would supersede a statement with its own duplicate, forever;
   *   `retention_and_limits` calls that pathological churn.
   * - `leaf_undisclosed` — the seller named a current leaf it did not return, so
   *   the buyer cannot tell whether it has anything new to say and declines to
   *   guess.
   * - `consumption_unavailable` — no exact-revision reader is wired, so the
   *   buyer cannot honestly attest consumption.
   * - `posting_unavailable` — no `syncReportingStatus` is wired, so there is
   *   nothing to append to. Without this the plan reads as live, due and
   *   unsuppressed while silently going nowhere.
   * - `period_identity_unknown` — `period.source_timezone` is part of the
   *   chain's logical key and its identity could not be established. Three
   *   causes, each named in `reason`: the seller's value is not a recognized
   *   IANA zone; the buyer's own `periodSourceTimezone` pin is not; or neither
   *   is. Substituting a value produces a statement the seller refuses on every
   *   run, and `iana_timezone` forbids the substitution by name. A pin naming a
   *   *different but valid* zone does **not** suppress — it posts under the
   *   seller's value and sets `periodZoneBeyondPin`.
   * - `local_budget_exhausted` — a read ceiling was reached before the revision
   *   could be consumed. `reason` names which; not all of them are tunable, so
   *   do not assume raising a `ledgerLimits` knob will clear it. Never an
   *   `unreadable` claim against a seller that did nothing wrong.
   * - `deadline_unknown` — no posting deadline could be derived, so this period
   *   will never post. Three causes, each named in `reason`: a pin the buyer has
   *   to supply is missing; the seller's own `obligation.expected_at` is
   *   unreadable and its `schedule.delivery_sla` did not resolve one either; or
   *   the deadline overflowed the representable range, in which case `reason`
   *   names the field that overflowed.
   *   Without this value a permanent misconfiguration renders exactly like a
   *   period that is simply not due yet.
   * - `chain_indeterminate` — the seller's revision chain forked, or the buyer
   *   could not walk it. That is the buyer failing to read, not the seller
   *   failing to publish, and `revision_missing` would blame the wrong party.
   */
  suppressed?:
    | 'unchanged'
    | 'leaf_undisclosed'
    | 'consumption_unavailable'
    | 'local_budget_exhausted'
    | 'deadline_unknown'
    | 'chain_indeterminate'
    | 'posting_unavailable'
    | 'period_identity_unknown';
  /**
   * Set when a seller-derived deadline cannot be vouched for locally: either
   * it is later than the buyer's pinned expectation by more than the recovery
   * window (`pinned` carries what the buyer expected), or the buyer recorded no
   * pin at all and so has nothing to check it against (`pinned` is absent).
   *
   * The deadline is still honoured — `expected_period` makes the seller's
   * instant authoritative, and a locally derived one would be refused. But
   * without this the period sits at `overdue: false` with `suppressed` unset,
   * indistinguishable from one that is simply not due yet, which is a silent
   * kill switch for the whole loop. **Alert on it.**
   */
  deadlineBeyondPin?: { declared: string; pinned?: string };
  /**
   * Which input the deadline came from.
   *
   * `buyer_pin` is the only one the buyer can vouch for by itself, and it never
   * sets `deadlineBeyondPin`. `seller_schedule` always sets it — there is no
   * pin to check against. `seller_expected_at` sets it *only* when the seller's
   * instant is beyond the pin plus the recovery window, or when no pin was
   * recorded; a seller that agrees with the pin is the healthy case and sets
   * nothing.
   *
   * **Alert on `deadlineBeyondPin`, not on this field.** This one reads
   * `seller_expected_at` on every conformant period, because a conformant
   * seller publishes `expected_at`.
   */
  deadlineSource?: 'buyer_pin' | 'seller_expected_at' | 'seller_schedule';
  /**
   * Set when the buyer's `periodSourceTimezone` pin and the seller's echoed
   * `period.source_timezone` are both recognized IANA zones naming *different*
   * zones.
   *
   * The statement is still posted, under the seller's value — that is the only
   * spelling its ingest accepts, and staying silent would leave the period
   * unrecorded for exactly the adopters careful enough to have pinned one.
   * But the buyer's independent expectation of the period's identity did not
   * hold, so the period's boundaries may have been generated from a different
   * calendar than the seller used. **Alert on it**, and reconcile the two
   * values with the seller.
   *
   * A link and its canonical name — `Japan` and `Asia/Tokyo` — are the same
   * zone and never set this.
   */
  periodZoneBeyondPin?: { declared: string; pinned: string };
  /** Why this status, in adopter-readable terms. Never a measurement claim. */
  reason: string;
}

/**
 * A seller-reported issue the buyer may need to put in front of a human,
 * carried with the escalation destination so an SDK user can page someone
 * without re-reading the capability document.
 */
export interface ReportingEscalationV1 {
  reportingObligationId: string;
  issueId: string;
  code: string;
  severity: string;
  responsibleParty: string;
  recommendedAction: string;
  /** Fixed at first emission; age the issue from this, not from the read. */
  openedAt?: string;
  issueState?: string;
  /** Inert correlation text. Never dereference or resolve it. */
  externalRef?: string;
  reportingStatusId?: string;
  /**
   * Seller's advertised human escalation path. Display metadata only: agents
   * MUST NOT fetch the URL, send protocol traffic to it, or treat either value
   * as a credential.
   */
  operationsContact?: { url?: string; email?: string };
  /** True when `recommended_action` is in the `contact_*` family. */
  requiresHumanContact: boolean;
}

export interface ReportingReconciliationResult {
  definitive: boolean;
  ledger: ReportingLedger;
  obligations: ObligationReconciliation[];
  missingExpectedPeriods: ExpectedReportingPeriod[];
  submittedReceipts: ReportingReceipt[];
  /** Every status the buyer owes for the reconciled scope, overdue flagged. */
  consumerStatuses: ReportingConsumerStatusPlanV1[];
  /** The subset actually posted through `syncReportingStatus` this run. */
  postedConsumerStatuses: ReportingConsumerStatusPlanV1[];
  /**
   * Statuses the seller rejected item-locally, carrying the errors it returned.
   * `sync_reporting_status` is a partial-success batch, so a rejection is data
   * the caller has to see — swallowing it leaves a buyer believing it has
   * discharged a duty it has not.
   */
  failedConsumerStatuses: Array<{
    plan: ReportingConsumerStatusPlanV1;
    reportingStatusId?: string;
    errors: unknown[];
  }>;
  /**
   * The seller's own count of obligations past the buyer's posting deadline
   * with no current status from this caller. Surfaced verbatim; it is a
   * visibility count over the buyer's silence and never a health input.
   * `undefined` when the read could not establish it: the client carries no
   * `syncReportingStatus` (so this seller is not running the loop), the seller
   * omitted the field, or the summary read failed.
   */
  consumerStatusPending?: number;
  /** Seller-reported issues, with escalation destination attached. */
  escalations: ReportingEscalationV1[];
  totalsByRevision: Array<{
    reportingRevisionId: string;
    rowCount: number;
    controlTotals: ReportingControlTotal[];
    coverageStatus: ReportingCoverageEvidence['status'];
    coveredPackageIds: string[];
    packageIds: string[];
  }>;
}

interface ReconcileReportingBaseOptions {
  client: ReportingReconciliationClient;
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination'>;
  expectedPeriods: ExpectedReportingPeriod[];
  maxSnapshotRestarts?: number;
  maxInspectionAttempts?: number;
  inspectionRetryBaseDelayMs?: number;
  ledgerLimits?: ReportingLedgerLimits;
  now?: Date;
  /**
   * The seller's advertised `operations_contact`, recorded by the buyer from
   * the capability document. Surfaced on every escalation so an SDK user can
   * page a human. Inert display metadata — never dereference it.
   */
  operationsContact?: { url?: string; email?: string };
  /**
   * Durable memory for statements built but not yet confirmed, so a retry
   * after a lost response is the same statement rather than a new one. Optional;
   * see `ReportingPendingConsumerStatusStore` for what changes without it.
   */
  pendingConsumerStatusStore?: ReportingPendingConsumerStatusStore;
}

type ReportingCheckpointOptions =
  | { checkpointStore?: never; checkpointScope?: never }
  | {
      checkpointStore: ReportingCheckpointStore;
      /** Stable non-secret seller + authenticated-principal scope. */
      checkpointScope: string;
    };

export type ReconcileReportingOptions<TCredential = unknown> = ReconcileReportingBaseOptions &
  ReportingCheckpointOptions &
  (
    | {
        /** Advanced inspection override. */
        inspect: (context: ReportingInspectionContext) => Promise<ReportingObservation>;
        resourceReader?: never;
        credentialProvider?: never;
        manifestInspectorOptions?: never;
      }
    | {
        inspect?: never;
        /** Pluggable destination reader used by the SDK-managed manifest inspector. */
        resourceReader: ReportingResourceReader<TCredential>;
        credentialProvider?: ReportingCredentialProvider<TCredential>;
        manifestInspectorOptions: Omit<ReportingManifestInspectorOptions<TCredential>, 'reader' | 'credentialProvider'>;
      }
  );

export class ReportingReconciliationError extends Error {
  /**
   * Receipts this run durably synced to the seller before the failure.
   *
   * Set only when the failure happened *after* `sync_reporting_receipts`
   * accepted them — the ledger is re-read afterwards, and a malformed record in
   * that second read used to leave the caller unable to tell whether the write
   * had happened. The caller needs to know it is retrying rather than starting,
   * and these are the receipts a successful run would have returned on
   * `submittedReceipts`.
   *
   * Retrying is idempotent only with a `checkpointStore` wired: receipt ids are
   * generated per attempt, and `reporting-receipt.json`'s `immutability` makes
   * an *accepted* current leaf terminal, so a fresh id against one is a
   * conflict rather than `unchanged`. With a checkpoint the same id and
   * idempotency key are replayed and the seller answers `unchanged`.
   *
   * Absent means no write was *confirmed*, which is not quite the same as
   * nothing having happened: a `sync_reporting_receipts` call whose response is
   * lost or malformed may well have landed at the seller, and the receipt is
   * only recorded here once the acknowledgement verifies. Treat absence as "no
   * confirmed durable write" and let the checkpointed idempotency key make the
   * retry safe.
   */
  readonly submittedReceipts?: readonly ReportingReceipt[];

  constructor(
    readonly code: string,
    message: string,
    options?: { submittedReceipts?: readonly ReportingReceipt[]; cause?: unknown }
  ) {
    super(message);
    this.name = 'ReportingReconciliationError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    if (options?.submittedReceipts?.length) this.submittedReceipts = options.submittedReceipts;
  }
}

/**
 * Re-throw carrying the durable receipt writes this run had already made.
 *
 * Without this the caller of a failed reconcile cannot distinguish "nothing was
 * written" from "receipts are at the seller and the ledger re-read failed",
 * which is the difference between starting over and retrying.
 */
function withSubmittedReceipts(error: unknown, submittedReceipts: readonly ReportingReceipt[]): unknown {
  if (submittedReceipts.length === 0) return error;
  if (error instanceof ReportingReconciliationError) {
    // The early return is unreachable today — only the single top-level catch
    // sets the field, so an inner error cannot already carry it — and is kept
    // so nesting this wrapper stays idempotent. The code is what agents
    // dispatch on, so it is preserved either way.
    if (error.submittedReceipts) return error;
    return new ReportingReconciliationError(error.code, error.message, { submittedReceipts, cause: error });
  }
  return new ReportingReconciliationError(
    'RECONCILE_FAILED_AFTER_RECEIPTS',
    `the reconcile failed after ${submittedReceipts.length} receipt(s) were durably synced${
      error instanceof Error ? `: ${boundedDiagnostic(error.message)}` : ''
    }`,
    { submittedReceipts, cause: error }
  );
}

async function callBeforeDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  code: string,
  message: string
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new ReportingReconciliationError(code, message);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ReportingReconciliationError(code, message));
    }, remainingMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function sameSha256(left: string | undefined, right: string | undefined): boolean {
  return Boolean(
    left &&
    right &&
    /^[a-fA-F0-9]{64}$/.test(left) &&
    /^[a-fA-F0-9]{64}$/.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function sameCanonicalDigest(
  left: ReportingCanonicalContentDigest | undefined,
  right: ReportingCanonicalContentDigest | undefined
): boolean {
  if (!left || !right) return false;
  const leftWithUri = left as ReportingCanonicalContentDigest & { canonicalization_uri?: string };
  const rightWithUri = right as ReportingCanonicalContentDigest & { canonicalization_uri?: string };
  return (
    left.algorithm === right.algorithm &&
    sameSha256(left.value, right.value) &&
    left.canonicalization_id === right.canonicalization_id &&
    sameSha256(left.canonicalization_sha256, right.canonicalization_sha256) &&
    leftWithUri.canonicalization_uri === rightWithUri.canonicalization_uri
  );
}

function uniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return same([...left].sort(), [...right].sort());
}

export function isReportingCoverageEvidence(value: unknown): value is ReportingCoverageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const coverage = value as ReportingCoverageEvidence;
  const allowedKeys = new Set([
    'status',
    'evaluated_at',
    'media_buy_ids',
    'fully_covered_media_buy_ids',
    'partially_covered_media_buy_ids',
    'unsupported_media_buy_ids',
    'unknown_media_buy_ids',
    'package_ids',
    'covered_package_ids',
    'unsupported_package_ids',
    'unknown_package_ids',
    'limitations',
  ]);
  if (
    Object.keys(coverage).some(key => !allowedKeys.has(key)) ||
    !['full', 'partial', 'none', 'unknown'].includes(coverage.status) ||
    typeof coverage.evaluated_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(coverage.evaluated_at) ||
    !Number.isFinite(Date.parse(coverage.evaluated_at))
  ) {
    return false;
  }
  const arrays = [
    coverage.media_buy_ids,
    coverage.fully_covered_media_buy_ids,
    coverage.partially_covered_media_buy_ids,
    coverage.unsupported_media_buy_ids,
    coverage.unknown_media_buy_ids,
    coverage.package_ids,
    coverage.covered_package_ids,
    coverage.unsupported_package_ids,
    coverage.unknown_package_ids,
  ];
  if (!arrays.every(uniqueStrings) || !Array.isArray(coverage.limitations)) return false;
  const buyParts = [
    ...coverage.fully_covered_media_buy_ids,
    ...coverage.partially_covered_media_buy_ids,
    ...coverage.unsupported_media_buy_ids,
    ...coverage.unknown_media_buy_ids,
  ];
  const packageParts = [
    ...coverage.covered_package_ids,
    ...coverage.unsupported_package_ids,
    ...coverage.unknown_package_ids,
  ];
  if (
    new Set(buyParts).size !== buyParts.length ||
    new Set(packageParts).size !== packageParts.length ||
    !sameStringSet(buyParts, coverage.media_buy_ids) ||
    !sameStringSet(packageParts, coverage.package_ids)
  ) {
    return false;
  }
  const limitationReasons = new Set([
    'offering_unsupported',
    'account_entitlement_unavailable',
    'credential_scope_insufficient',
    'provider_limitation',
    'capability_unknown',
  ]);
  for (const limitation of coverage.limitations) {
    if (
      !limitation ||
      typeof limitation !== 'object' ||
      Array.isArray(limitation) ||
      !Object.keys(limitation).every(key => ['reason', 'media_buy_id', 'package_ids'].includes(key)) ||
      !limitationReasons.has(limitation.reason) ||
      typeof limitation.media_buy_id !== 'string' ||
      !coverage.media_buy_ids.includes(limitation.media_buy_id) ||
      (limitation.package_ids !== undefined &&
        (!uniqueStrings(limitation.package_ids) ||
          limitation.package_ids.length === 0 ||
          !limitation.package_ids.every(id => coverage.package_ids.includes(id))))
    ) {
      return false;
    }
  }
  const full =
    coverage.partially_covered_media_buy_ids.length === 0 &&
    coverage.unsupported_media_buy_ids.length === 0 &&
    coverage.unknown_media_buy_ids.length === 0 &&
    coverage.unsupported_package_ids.length === 0 &&
    coverage.unknown_package_ids.length === 0 &&
    sameStringSet(coverage.fully_covered_media_buy_ids, coverage.media_buy_ids) &&
    sameStringSet(coverage.covered_package_ids, coverage.package_ids);
  if (coverage.status === 'full') return full;
  const nonempty = coverage.media_buy_ids.length > 0 || coverage.package_ids.length > 0;
  const hasCovered = coverage.fully_covered_media_buy_ids.length > 0 || coverage.covered_package_ids.length > 0;
  const hasUncovered =
    coverage.partially_covered_media_buy_ids.length > 0 ||
    coverage.unsupported_media_buy_ids.length > 0 ||
    coverage.unknown_media_buy_ids.length > 0 ||
    coverage.unsupported_package_ids.length > 0 ||
    coverage.unknown_package_ids.length > 0;
  if (coverage.status === 'partial') return hasCovered && hasUncovered;
  if (coverage.status === 'none')
    return (
      nonempty &&
      coverage.fully_covered_media_buy_ids.length === 0 &&
      coverage.partially_covered_media_buy_ids.length === 0 &&
      coverage.covered_package_ids.length === 0 &&
      coverage.unknown_media_buy_ids.length === 0 &&
      coverage.unknown_package_ids.length === 0 &&
      (coverage.unsupported_media_buy_ids.length > 0 || coverage.unsupported_package_ids.length > 0)
    );
  return (
    coverage.status === 'unknown' &&
    nonempty &&
    !hasCovered &&
    coverage.partially_covered_media_buy_ids.length === 0 &&
    (coverage.unknown_media_buy_ids.length > 0 || coverage.unknown_package_ids.length > 0)
  );
}

function coverageMatchesExpected(
  coverage: ReportingCoverageEvidence,
  expected: ExpectedReportingPeriod['coverage']
): boolean {
  const comparable = {
    status: coverage.status,
    media_buy_ids: coverage.media_buy_ids,
    fully_covered_media_buy_ids: coverage.fully_covered_media_buy_ids,
    partially_covered_media_buy_ids: coverage.partially_covered_media_buy_ids,
    unsupported_media_buy_ids: coverage.unsupported_media_buy_ids,
    unknown_media_buy_ids: coverage.unknown_media_buy_ids,
    package_ids: coverage.package_ids,
    covered_package_ids: coverage.covered_package_ids,
    unsupported_package_ids: coverage.unsupported_package_ids,
    unknown_package_ids: coverage.unknown_package_ids,
  };
  return same(comparable, expected);
}

function scopeMatchesRequest(
  scope: ReportingLedger['scope'],
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination'>
): boolean {
  if (request.period && (scope.period_start !== request.period.start || scope.period_end !== request.period.end)) {
    return false;
  }
  if (request.media_buy_ids) {
    if (scope.all_accessible_media_buys || !sameStringSet(scope.media_buy_ids ?? [], request.media_buy_ids))
      return false;
  } else if (!scope.all_accessible_media_buys) {
    return false;
  }
  // Array-ness checked, not assumed. `scope` is whatever the seller returned and
  // only its presence is verified upstream, so an omitted array here threw a raw
  // `TypeError` out of `reconcileReporting` — including from the reload that
  // follows a durable receipt write. A mismatch is the same answer either way.
  if (request.delivery_config_ids) {
    if (!Array.isArray(scope.delivery_config_generations)) return false;
    const resolved = [...new Set(scope.delivery_config_generations.map(item => item?.delivery_config_id))];
    if (!sameStringSet(resolved, request.delivery_config_ids)) return false;
  }
  if (request.feed_purposes) {
    if (!Array.isArray(scope.feed_purposes) || !sameStringSet(scope.feed_purposes, request.feed_purposes)) return false;
  }
  if (request.finality) {
    if (!Array.isArray(scope.finality) || !sameStringSet(scope.finality, request.finality)) return false;
  }
  return true;
}

function normalizedTotals(totals: ReportingControlTotal[]): ReportingControlTotal[] {
  return [...totals].sort((left, right) => left.name.localeCompare(right.name));
}

function receiptMatches(
  receipt: ReportingReceipt,
  revision: ManagedReportingRevision,
  materialization: ReportingMaterialization
): boolean {
  if (
    !isReportingReceiptEvidence(receipt) ||
    receipt.status !== 'accepted' ||
    !materialization.verification ||
    !isReportingVerificationEvidence(materialization.verification) ||
    !isReportingControlTotals(revision.control_totals)
  ) {
    return false;
  }
  if (receipt.reporting_obligation_id !== materialization.reporting_obligation_id) return false;
  if (receipt.reporting_revision_id !== revision.reporting_revision_id) return false;
  if (receipt.reporting_materialization_id !== materialization.reporting_materialization_id) return false;
  if (receipt.verification_profile !== materialization.verification.verification_profile) return false;
  if (receipt.observed_row_count !== revision.row_count) return false;
  if (!same(normalizedTotals(receipt.observed_control_totals), normalizedTotals(revision.control_totals))) return false;

  if (receipt.verification_profile === 'canonical_digest') {
    return Boolean(
      revision.canonical_content_digest &&
      receipt.observed_canonical_content_digest &&
      sameCanonicalDigest(receipt.observed_canonical_content_digest, revision.canonical_content_digest)
    );
  }
  if (receipt.verification_profile === 'manifest_checksums') {
    return Boolean(
      materialization.resource?.manifest_sha256 &&
      sameSha256(receipt.observed_manifest_sha256, materialization.resource.manifest_sha256)
    );
  }
  return Boolean(
    materialization.resource?.native_version_ref &&
    receipt.observed_native_version_ref === materialization.resource.native_version_ref
  );
}

/**
 * One ledger record, keyed by the id it carries, or a typed failure.
 *
 * `null` inside any of the five collections used to dereference straight to
 * `TypeError` — and because the ledger is re-read *after* receipts are synced,
 * that escaped `reconcileReporting` and destroyed the caller's record of
 * durable work. The payload is malformed, so this fails closed; it is
 * deliberately a local error rather than a durable `unreadable` statement,
 * which would put an accusation against the seller on the buyer's permanent
 * record for what is a transport-shaped defect.
 */
/**
 * One ledger collection, or a typed failure.
 *
 * `?? []` guarded the collection against `null` and `undefined` and nothing
 * else, so a seller sending `periods: 0` — or `true`, or an object — reached
 * `for…of` on a non-iterable and threw a raw `TypeError` out of
 * `reconcileReporting`. That is the same `?? []` defect this file fixes for
 * `media_buy_ids`, and it survived at the five lines that were rewritten to add
 * the per-record guard below.
 */
function collectRecords<T>(map: Map<string, T>, collection: unknown, idKey: string, kind: string): void {
  if (collection === undefined || collection === null) return;
  if (!Array.isArray(collection)) {
    throw new ReportingReconciliationError(
      'LEDGER_RECORD_MALFORMED',
      `reporting ledger returned ${kind} records that are not an array (${boundedDiagnostic(collection)})`
    );
  }
  for (const item of collection) collectRecord<T>(map, item, idKey, kind);
}

function collectRecord<T>(map: Map<string, T>, item: unknown, idKey: string, kind: string): void {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new ReportingReconciliationError(
      'LEDGER_RECORD_MALFORMED',
      `reporting ledger returned a ${kind} record that is not an object (${boundedDiagnostic(item)})`
    );
  }
  const id = (item as Record<string, unknown>)[idKey];
  if (typeof id !== 'string' || id.length === 0) {
    throw new ReportingReconciliationError(
      'LEDGER_RECORD_MALFORMED',
      `reporting ledger returned a ${kind} record with no ${idKey} (${boundedDiagnostic(id)})`
    );
  }
  // Unchecked beyond object-ness and a usable id: the field-level shapes are
  // enforced downstream, by `assertReportingLedgerGraph` and by the per-field
  // guards in `selectCurrent` and `expectedPeriodMatches`. Nothing here should
  // be read as a guarantee that `T`'s other fields are present or well-typed.
  addImmutable(map, id, item as T, kind);
}

function addImmutable<T>(map: Map<string, T>, id: string, value: T, kind: string): void {
  const previous = map.get(id);
  if (previous && !same(previous, value)) {
    throw new ReportingReconciliationError(
      'IMMUTABLE_RECORD_CHANGED',
      `${kind} ${id} changed within one ledger snapshot`
    );
  }
  map.set(id, value);
}

export async function loadReportingLedger(
  client: ReportingReconciliationClient,
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination'>,
  maxSnapshotRestarts = 2,
  limits: ReportingLedgerLimits = {}
): Promise<ReportingLedger> {
  if (!Number.isSafeInteger(maxSnapshotRestarts) || maxSnapshotRestarts < 0 || maxSnapshotRestarts > 10) {
    throw new ReportingReconciliationError(
      'INVALID_LEDGER_LIMITS',
      'maxSnapshotRestarts must be an integer from 0 through 10'
    );
  }
  const requestedAccountId = (request.account as { account_id?: unknown }).account_id;
  const maxPages = limits.maxPages ?? 1_000;
  const maxRecords = limits.maxRecords ?? 100_000;
  const maxLoadMs = limits.maxLoadMs ?? 60_000;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new ReportingReconciliationError('INVALID_LEDGER_LIMITS', 'maxPages must be an integer from 1 through 10000');
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) {
    throw new ReportingReconciliationError(
      'INVALID_LEDGER_LIMITS',
      'maxRecords must be an integer from 1 through 1000000'
    );
  }
  if (!Number.isSafeInteger(maxLoadMs) || maxLoadMs < 1 || maxLoadMs > 3_600_000) {
    throw new ReportingReconciliationError(
      'INVALID_LEDGER_LIMITS',
      'maxLoadMs must be an integer from 1 through 3600000'
    );
  }
  // Symmetry with the three above. `maxRevisionRows: -5` silently muted every
  // period in scope and `NaN` silently disabled the row bound, where a bad
  // `maxPages` throws.
  const maxRevisionRows = limits.maxRevisionRows;
  if (
    maxRevisionRows !== undefined &&
    (!Number.isSafeInteger(maxRevisionRows) || maxRevisionRows < 1 || maxRevisionRows > 10_000_000)
  ) {
    throw new ReportingReconciliationError(
      'INVALID_LEDGER_LIMITS',
      `maxRevisionRows must be an integer from 1 through ${MAX_CONSUMED_REVISION_ROWS}`
    );
  }
  const maxRevisionBytes = limits.maxRevisionBytes;
  if (
    maxRevisionBytes !== undefined &&
    (!Number.isSafeInteger(maxRevisionBytes) || maxRevisionBytes < 1 || maxRevisionBytes > MAX_CONSUMED_REVISION_BYTES)
  ) {
    throw new ReportingReconciliationError(
      'INVALID_LEDGER_LIMITS',
      typeof maxRevisionBytes === 'number' && Number.isSafeInteger(maxRevisionBytes) && maxRevisionBytes > 0
        ? `maxRevisionBytes may only tighten this SDK's ${MAX_CONSUMED_REVISION_BYTES}-byte per-revision ceiling, which bounds the SDK process's memory and cannot be raised`
        : `maxRevisionBytes must be an integer from 1 through ${MAX_CONSUMED_REVISION_BYTES}`
    );
  }
  const deadline = Date.now() + maxLoadMs;
  for (let restart = 0; restart <= maxSnapshotRestarts; restart += 1) {
    try {
      const obligations = new Map<string, ManagedReportingObligation>();
      const revisions = new Map<string, ManagedReportingRevision>();
      const materializations = new Map<string, ReportingMaterialization>();
      const receipts = new Map<string, ReportingReceipt>();
      const consumerStatuses = new Map<string, ReportingConsumerStatus>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let snapshotId: string | undefined;
      let ledgerAsOf: string | undefined;
      let accountId: string | undefined;
      let scope: NonNullable<GetReportingStatusResponse['scope']> | undefined;
      let totalCount: number | undefined;
      let pageCount = 0;

      do {
        pageCount += 1;
        if (pageCount > maxPages || Date.now() > deadline) {
          throw new ReportingReconciliationError('LEDGER_LIMIT_EXCEEDED', 'reporting ledger exceeded load limits');
        }
        const response = await callBeforeDeadline(
          signal =>
            client.getReportingStatus(
              {
                ...request,
                view: 'periods',
                ...(cursor ? { pagination: { cursor } } : {}),
              },
              { signal }
            ),
          deadline,
          'LEDGER_LIMIT_EXCEEDED',
          'get_reporting_status exceeded the reporting ledger load deadline'
        );
        if (response.status !== 'completed' || response.view !== 'periods') {
          throw new ReportingReconciliationError(
            'STATUS_READ_FAILED',
            'get_reporting_status did not return a completed periods view'
          );
        }
        if (
          !response.ledger_snapshot_id ||
          !response.ledger_as_of ||
          !response.account_id ||
          !response.scope ||
          !response.pagination
        ) {
          throw new ReportingReconciliationError(
            'INCOMPLETE_LEDGER_PAGE',
            'get_reporting_status omitted required ledger metadata'
          );
        }
        if (typeof requestedAccountId === 'string' && response.account_id !== requestedAccountId) {
          throw new ReportingReconciliationError(
            'ACCOUNT_SCOPE_MISMATCH',
            'get_reporting_status returned a ledger for a different requested account'
          );
        }
        if (!scopeMatchesRequest(response.scope, request)) {
          throw new ReportingReconciliationError(
            'REQUEST_SCOPE_MISMATCH',
            'get_reporting_status returned a denominator that does not match the requested scope'
          );
        }
        if (
          typeof response.pagination.total_count !== 'number' ||
          !Number.isSafeInteger(response.pagination.total_count) ||
          response.pagination.total_count < 0
        ) {
          throw new ReportingReconciliationError(
            'INCOMPLETE_LEDGER_PAGE',
            'get_reporting_status returned an invalid total_count'
          );
        }
        if (snapshotId && snapshotId !== response.ledger_snapshot_id) {
          throw new ReportingReconciliationError('SNAPSHOT_CHANGED', 'ledger snapshot changed during pagination');
        }
        if (ledgerAsOf && ledgerAsOf !== response.ledger_as_of) {
          throw new ReportingReconciliationError(
            'SNAPSHOT_CHANGED',
            'ledger observation boundary changed during pagination'
          );
        }
        if (accountId && accountId !== response.account_id) {
          throw new ReportingReconciliationError('SNAPSHOT_CHANGED', 'account changed during pagination');
        }
        if (scope && !same(scope, response.scope)) {
          throw new ReportingReconciliationError('SNAPSHOT_CHANGED', 'reporting denominator changed during pagination');
        }
        if (totalCount !== undefined && response.pagination.total_count !== totalCount) {
          throw new ReportingReconciliationError('SNAPSHOT_CHANGED', 'ledger total changed during pagination');
        }

        snapshotId = response.ledger_snapshot_id;
        ledgerAsOf = response.ledger_as_of;
        accountId = response.account_id;
        scope = response.scope;
        totalCount = response.pagination.total_count;
        if (totalCount > maxRecords) {
          throw new ReportingReconciliationError('LEDGER_LIMIT_EXCEEDED', 'reporting ledger exceeds record limit');
        }
        collectRecords(obligations, response.periods, 'reporting_obligation_id', 'obligation');
        collectRecords<ManagedReportingRevision>(revisions, response.revisions, 'reporting_revision_id', 'revision');
        collectRecords(materializations, response.materializations, 'reporting_materialization_id', 'materialization');
        collectRecords(receipts, response.receipts, 'reporting_receipt_id', 'receipt');
        // Counted separately: `total_count` is the obligation/revision/adjustment
        // denominator, and consumer statements are the caller's own append-only
        // history rather than ledger records, so folding them into the record
        // reconciliation below would make every page appear to overrun.
        collectRecords(consumerStatuses, response.consumer_statuses, 'reporting_status_id', 'consumer status');
        if (consumerStatuses.size > maxRecords) {
          throw new ReportingReconciliationError(
            'LEDGER_LIMIT_EXCEEDED',
            'reporting consumer status history exceeds record limit'
          );
        }
        if (obligations.size + revisions.size + materializations.size + receipts.size > maxRecords) {
          throw new ReportingReconciliationError('LEDGER_LIMIT_EXCEEDED', 'reporting ledger exceeds record limit');
        }

        if (response.pagination.has_more) {
          if (!response.pagination.cursor || seenCursors.has(response.pagination.cursor)) {
            throw new ReportingReconciliationError('CURSOR_LOOP', 'ledger pagination did not advance');
          }
          seenCursors.add(response.pagination.cursor);
          cursor = response.pagination.cursor;
        } else {
          cursor = undefined;
        }
      } while (cursor);

      const observedCount = obligations.size + revisions.size + materializations.size + receipts.size;
      if (totalCount !== undefined && totalCount !== observedCount) {
        throw new ReportingReconciliationError(
          'LEDGER_COUNT_MISMATCH',
          `ledger declared ${totalCount} records but returned ${observedCount}`
        );
      }
      if (!snapshotId || !ledgerAsOf || !accountId || !scope) {
        throw new ReportingReconciliationError('EMPTY_LEDGER_RESPONSE', 'get_reporting_status returned no ledger page');
      }
      assertReportingLedgerGraph(accountId, obligations, revisions, materializations, receipts);
      return {
        ledgerSnapshotId: snapshotId,
        ledgerAsOf,
        accountId,
        scope,
        consumerStatuses: [...consumerStatuses.values()],
        obligations: [...obligations.values()],
        revisions: [...revisions.values()],
        materializations: [...materializations.values()],
        receipts: [...receipts.values()],
      };
    } catch (error) {
      if (
        !(error instanceof ReportingReconciliationError) ||
        error.code !== 'SNAPSHOT_CHANGED' ||
        restart === maxSnapshotRestarts
      ) {
        throw error;
      }
    }
  }
  throw new ReportingReconciliationError('SNAPSHOT_CHANGED', 'ledger never stabilized');
}

function assertReportingLedgerGraph(
  accountId: string,
  obligations: Map<string, ManagedReportingObligation>,
  revisions: Map<string, ManagedReportingRevision>,
  materializations: Map<string, ReportingMaterialization>,
  receipts: Map<string, ReportingReceipt>
): void {
  const fail = (): never => {
    throw new ReportingReconciliationError(
      'LEDGER_GRAPH_INTEGRITY_FAILED',
      'reporting ledger contains an out-of-scope or unjoined record'
    );
  };
  for (const obligation of obligations.values()) {
    if (obligation.account_id !== accountId) fail();
    // Checked here, upstream of the receipt loop, so a malformed payload fails
    // before anything durable is written rather than throwing during the
    // consumer-status pass that runs after receipts have gone to the seller.
    if (!Array.isArray(obligation.media_buy_ids)) fail();
  }
  for (const revision of revisions.values()) {
    // Also array-checked, so `reportingRevisionScopeKey` can spread it while
    // building the direct-Core index without a per-revision guard.
    if (!Array.isArray(revision.media_buy_ids)) fail();
    // Same reason: `selectCurrent` reads `revision.period.end`, and it is
    // reached for every obligation after receipts are synced.
    //
    // This one does fail the load rather than disqualifying the single
    // revision, because a revision with no readable period cannot be matched to
    // *any* obligation, so there is no period whose diagnostic could carry it.
    // The scope-key comparison, by contrast, now resolves zone aliases rather
    // than failing — see `sameReportingPeriod`.
    if (!isReportingPeriodShape(revision.period)) fail();
  }
  const referencedRevisions = new Set<string>();
  for (const materialization of materializations.values()) {
    const obligation = obligations.get(materialization.reporting_obligation_id);
    const revision = revisions.get(materialization.reporting_revision_id);
    if (
      !obligation ||
      !revision ||
      revision.account_id !== accountId ||
      materialization.delivery_config_id !== obligation.delivery_config_id ||
      materialization.delivery_config_version !== obligation.delivery_config_version ||
      materialization.destination_ref !== obligation.destination_ref ||
      materialization.feed_purpose !== obligation.feed_purpose ||
      ((materialization.status === 'available' || materialization.status === 'delivered') &&
        !isReportingVerificationEvidence(materialization.verification))
    ) {
      fail();
    }
    referencedRevisions.add(materialization.reporting_revision_id);
  }
  const materializedObligations = new Set(
    [...materializations.values()].map(materialization => materialization.reporting_obligation_id)
  );
  const directCoreScopeCounts = new Map<string, number>();
  for (const obligation of obligations.values()) {
    if (
      !isDirectCoreObligation(obligation) ||
      !Array.isArray(obligation.media_buy_ids) ||
      materializedObligations.has(obligation.reporting_obligation_id)
    ) {
      continue;
    }
    const scopeKey = reportingRevisionScopeKey(obligation);
    directCoreScopeCounts.set(scopeKey, (directCoreScopeCounts.get(scopeKey) ?? 0) + 1);
  }
  for (const revision of revisions.values()) {
    const referenced = referencedRevisions.has(revision.reporting_revision_id);
    const directCoreScopeCount = Array.isArray(revision.media_buy_ids)
      ? (directCoreScopeCounts.get(reportingRevisionScopeKey(revision)) ?? 0)
      : 0;
    // A Core revision intentionally excludes feed purpose, destination, and
    // obligation identity. Obligations that share one logical reporting slice
    // therefore share the same canonical revision, including mixed direct-Core
    // and managed-materialization consumers.
    const directlyScopedCoreRevision = directCoreScopeCount > 0;
    if (
      revision.account_id !== accountId ||
      (!referenced && !directlyScopedCoreRevision) ||
      !isReportingControlTotals(revision.control_totals)
    ) {
      fail();
    }
  }
  for (const receipt of receipts.values()) {
    const obligation = obligations.get(receipt.reporting_obligation_id);
    const revision = revisions.get(receipt.reporting_revision_id);
    const materialization = materializations.get(receipt.reporting_materialization_id);
    if (
      !isReportingReceiptEvidence(receipt) ||
      !obligation ||
      !revision ||
      !materialization ||
      materialization.reporting_obligation_id !== obligation.reporting_obligation_id ||
      materialization.reporting_revision_id !== revision.reporting_revision_id
    ) {
      fail();
    }
  }
}

function isDirectCoreObligation(obligation: ManagedReportingObligation): boolean {
  return obligation.reconciliation_mode === 'delivery_only' && obligation.destination_ref === undefined;
}

function revisionMatchesObligationScope(
  revision: ManagedReportingRevision,
  obligation: ManagedReportingObligation
): boolean {
  return (
    revision.account_id === obligation.account_id &&
    revision.report_definition_id === obligation.report_definition_id &&
    revision.reporting_profile === obligation.reporting_profile &&
    Array.isArray(revision.media_buy_ids) &&
    Array.isArray(obligation.media_buy_ids) &&
    sameStringSet(revision.media_buy_ids, obligation.media_buy_ids) &&
    sameReportingPeriod(revision.period, obligation.period)
  );
}

/**
 * Two period descriptors naming the same period.
 *
 * The zone is compared by zone identity rather than spelling, for the same
 * reason `sameZone` exists one layer up: `iana_timezone` blesses a name *or a
 * link*, so an obligation saying `UTC` and a revision saying `Zulu` describe
 * one period. Byte-comparing them made one seller-controlled string abort the
 * entire reconcile — every period in scope, not just the affected one — which
 * is a cheaper and more complete silence primitive than the suppression this
 * SDK works hard to avoid.
 */
function sameReportingPeriod(left: unknown, right: unknown): boolean {
  // The non-shape fallback and the non-string zone compare below are both
  // pre-empted by the graph assertion, which refuses a malformed period on load
  // — neither is claimed as tested.
  if (!isReportingPeriodShape(left) || !isReportingPeriodShape(right)) return same(left, right);
  const leftZone = (left as { source_timezone?: unknown }).source_timezone;
  const rightZone = (right as { source_timezone?: unknown }).source_timezone;
  if (left.start !== right.start || left.end !== right.end) return false;
  if (typeof leftZone !== 'string' || typeof rightZone !== 'string') return leftZone === rightZone;
  return sameZone(leftZone, rightZone);
}

function reportingRevisionScopeKey(value: ManagedReportingRevision | ManagedReportingObligation): string {
  const period = value.period as { start?: unknown; end?: unknown; source_timezone?: unknown } | undefined;
  const zone = period?.source_timezone;
  return canonical({
    account_id: value.account_id,
    report_definition_id: value.report_definition_id,
    reporting_profile: value.reporting_profile,
    media_buy_ids: [...value.media_buy_ids].sort(),
    // Exactly the three fields the schema defines, and zone *identity* rather
    // than spelling. Hashing the raw period object put an obligation saying
    // `UTC` and a revision saying `Zulu` in different scopes — and one extra
    // key from a client that does not schema-validate did the same — with the
    // mismatch aborting the whole ledger rather than the one record.
    //
    // `?? zone` so an unrecognized zone keeps its own identity: bare
    // `canonicalZone` yields `undefined` for anything `Intl` refuses, and
    // `canonical` drops `undefined`, which collapsed every unreadable zone and
    // every absent one into a single key.
    period:
      period === undefined
        ? period
        : { start: period.start, end: period.end, source_timezone: canonicalZone(zone) ?? zone },
  });
}

function assertDirectReportingLedgerGraph(ledger: ReportingLedger): void {
  const obligations = new Map(ledger.obligations.map(item => [item.reporting_obligation_id, item]));
  const revisions = new Map(ledger.revisions.map(item => [item.reporting_revision_id, item]));
  const materializations = new Map(ledger.materializations.map(item => [item.reporting_materialization_id, item]));
  const receipts = new Map(ledger.receipts.map(item => [item.reporting_receipt_id, item]));
  if (
    obligations.size !== ledger.obligations.length ||
    revisions.size !== ledger.revisions.length ||
    materializations.size !== ledger.materializations.length ||
    receipts.size !== ledger.receipts.length
  ) {
    throw new ReportingReconciliationError(
      'LEDGER_GRAPH_INTEGRITY_FAILED',
      'reporting ledger contains duplicate record identifiers'
    );
  }
  assertReportingLedgerGraph(ledger.accountId, obligations, revisions, materializations, receipts);
}

/**
 * Revisions joinable to a direct-Core obligation, by scope key.
 *
 * The linear alternative was O(obligations x revisions) — `maxRecords` bounds
 * only the sum, so a 50k/50k ledger is 2.5e9 comparisons, synchronous, with no
 * budget over it. `reportingRevisionScopeKey` hashes exactly the fields
 * `revisionMatchesObligationScope` compares, including zone *identity*, so the
 * index is an equivalent test rather than an approximation of one.
 *
 * Keyed on the ledger object, which is replaced wholesale by the post-receipt
 * reload, so the index cannot outlive the snapshot it describes.
 *
 * Verified equivalent by running the suite against both implementations, which
 * is the only claim made for it: the benefit is asymptotic, so no test pins it.
 */
const DIRECT_CORE_REVISION_INDEX = new WeakMap<ReportingLedger, Map<string, ManagedReportingRevision[]>>();

function directCoreRevisionsFor(
  ledger: ReportingLedger,
  obligation: ManagedReportingObligation
): ManagedReportingRevision[] {
  let index = DIRECT_CORE_REVISION_INDEX.get(ledger);
  if (!index) {
    index = new Map<string, ManagedReportingRevision[]>();
    for (const revision of ledger.revisions) {
      const key = reportingRevisionScopeKey(revision);
      const bucket = index.get(key);
      if (bucket) bucket.push(revision);
      else index.set(key, [revision]);
    }
    DIRECT_CORE_REVISION_INDEX.set(ledger, index);
  }
  return index.get(reportingRevisionScopeKey(obligation)) ?? [];
}

function selectCurrent(
  obligation: ManagedReportingObligation,
  ledger: ReportingLedger,
  expected?: ExpectedReportingPeriod
): { revision?: ManagedReportingRevision; materialization?: ReportingMaterialization; reasons: string[] } {
  const reasons: string[] = [];
  const attempts = ledger.materializations.filter(
    item => item.reporting_obligation_id === obligation.reporting_obligation_id
  );
  const revisionIds = new Set(attempts.map(item => item.reporting_revision_id));
  // Core sellers can expose immutable revision rows directly through
  // get_media_buy_delivery without creating a managed destination
  // materialization. In that case the protocol-authored revision scope is the
  // join key. Once materializations exist, keep using their explicit IDs.
  const candidates =
    attempts.length > 0
      ? ledger.revisions.filter(item => revisionIds.has(item.reporting_revision_id))
      : isDirectCoreObligation(obligation)
        ? directCoreRevisionsFor(ledger, obligation)
        : [];
  const receipts = ledger.receipts.filter(item => item.reporting_obligation_id === obligation.reporting_obligation_id);
  const successfulAttempts = attempts.filter(item => item.status === 'available' || item.status === 'delivered');
  const acceptedReceipts = receipts.filter(item => item.status === 'accepted');
  const closedHealthy = obligation.health === 'healthy' || obligation.health === 'complete';
  const materializationCountsRequired = closedHealthy && obligation.destination_ref !== undefined;
  const receiptCountsRequired = closedHealthy && obligation.reconciliation_mode === 'consumer_receipt';
  if (obligation.account_id !== ledger.accountId) reasons.push('OBLIGATION_ACCOUNT_MISMATCH');
  if (
    candidates.length !== obligation.revision_count ||
    countMismatch(obligation.materialization_count, attempts.length, materializationCountsRequired) ||
    countMismatch(
      obligation.successful_materialization_count,
      successfulAttempts.length,
      materializationCountsRequired
    ) ||
    countMismatch(obligation.receipt_count, receipts.length, receiptCountsRequired) ||
    countMismatch(obligation.accepted_receipt_count, acceptedReceipts.length, receiptCountsRequired)
  ) {
    reasons.push('ASSOCIATED_HISTORY_INCOMPLETE');
  }
  const superseded = new Set(
    candidates.map(item => item.supersedes_reporting_revision_id).filter((id): id is string => Boolean(id))
  );
  const candidateIds = new Set(candidates.map(item => item.reporting_revision_id));
  if (
    candidates.some(
      item => item.supersedes_reporting_revision_id && !candidateIds.has(item.supersedes_reporting_revision_id)
    )
  ) {
    reasons.push('REVISION_PREDECESSOR_MISSING');
  }
  if (
    candidates.some(
      item =>
        item.account_id !== obligation.account_id ||
        item.report_definition_id !== obligation.report_definition_id ||
        item.reporting_profile !== obligation.reporting_profile ||
        !Array.isArray(item.media_buy_ids) ||
        !Array.isArray(obligation.media_buy_ids) ||
        !same([...item.media_buy_ids].sort(), [...obligation.media_buy_ids].sort()) ||
        !sameReportingPeriod(item.period, obligation.period)
    )
  ) {
    reasons.push('REVISION_CHAIN_SCOPE_MISMATCH');
  }
  const current = candidates.filter(item => !superseded.has(item.reporting_revision_id));
  if (current.length !== 1) {
    reasons.push(current.length === 0 ? 'MISSING_CURRENT_REVISION' : 'AMBIGUOUS_REVISION_CHAIN');
    return { reasons };
  }
  const revision = current[0]!;
  const revisionControlTotalsValid = isReportingControlTotals(revision.control_totals);
  if (!revisionControlTotalsValid) reasons.push('REVISION_CONTROL_TOTALS_INVALID');
  if (!revision.report_definition_uri || !revision.report_definition_sha256) {
    reasons.push('REPORT_DEFINITION_NOT_PINNED');
  }
  if (
    revision.account_id !== obligation.account_id ||
    revision.report_definition_id !== obligation.report_definition_id ||
    revision.reporting_profile !== obligation.reporting_profile ||
    !Array.isArray(revision.media_buy_ids) ||
    !Array.isArray(obligation.media_buy_ids) ||
    !same([...revision.media_buy_ids].sort(), [...obligation.media_buy_ids].sort()) ||
    // Zone identity, not spelling — an obligation saying `UTC` and a revision
    // saying `Zulu` describe one period, and calling that a scope mismatch
    // turned a conformant seller's revision into `revision_missing`.
    !sameReportingPeriod(revision.period, obligation.period)
  ) {
    reasons.push('REVISION_SCOPE_MISMATCH');
  }
  if (obligation.scope_resolved_at !== obligation.period?.end) reasons.push('SCOPE_CUTOFF_MISMATCH');
  if (
    !isReportingCoverageEvidence(obligation.coverage) ||
    obligation.coverage.evaluated_at !== obligation.scope_resolved_at ||
    // Pre-empted today by the graph assertion, which refuses a non-array
    // `media_buy_ids` before any durable write, so this arm is not
    // independently reachable and is not claimed as tested. Kept because it is
    // the line that dereferenced: `?? []` caught absent and null and nothing
    // else, so a scalar reached `[...0]` and threw from a call site that runs
    // after receipts sync.
    !sameStringSet(
      obligation.coverage.media_buy_ids,
      Array.isArray(obligation.media_buy_ids) ? obligation.media_buy_ids : []
    ) ||
    !isReportingCoverageEvidence(revision.coverage) ||
    !same(revision.coverage, obligation.coverage)
  ) {
    reasons.push('COVERAGE_SCOPE_MISMATCH');
  }
  if (!expected) {
    reasons.push('EXPECTED_CONTRACT_MISSING');
  } else {
    const revisionDigest = revision.canonical_content_digest;
    if (
      revision.report_definition_uri !== expected.reportDefinitionUri ||
      !sameSha256(revision.report_definition_sha256, expected.reportDefinitionSha256) ||
      revision.schema_version !== expected.schemaVersion ||
      revision.schema_uri !== expected.schemaUri ||
      !sameSha256(revision.schema_sha256, expected.schemaSha256) ||
      revision.schema_dialect !== expected.schemaDialect ||
      revision.schema_ref_policy !== expected.schemaRefPolicy
    ) {
      reasons.push('EXPECTED_CONTRACT_MISMATCH');
    }
    if (
      !isReportingCoverageEvidence(obligation.coverage) ||
      !coverageMatchesExpected(obligation.coverage, expected.coverage)
    ) {
      reasons.push('EXPECTED_COVERAGE_MISMATCH');
    }
    if (expected.coverageRequirement === 'full' && obligation.coverage?.status !== 'full') {
      reasons.push('COVERAGE_REQUIREMENT_NOT_MET');
    }
    if (
      expected.verificationProfile === 'canonical_digest' &&
      (!revisionDigest ||
        revisionDigest.canonicalization_id !== expected.canonicalization.id ||
        revisionDigest.canonicalization_uri !== expected.canonicalization.uri ||
        !sameSha256(revisionDigest.canonicalization_sha256, expected.canonicalization.sha256))
    ) {
      reasons.push('EXPECTED_CANONICALIZATION_MISMATCH');
    }
  }
  const finalizedAt = revision.finalized_at ? Date.parse(revision.finalized_at) : Number.NaN;
  // Defence in depth behind `assertReportingLedgerGraph`, which now refuses a
  // malformed `revision.period` before any durable write, so this arm is not
  // independently reachable today and is deliberately not claimed as tested.
  // Kept because this line is what actually dereferenced: a missing or
  // non-object `period` threw `TypeError` out of `reconcileReporting` after
  // receipts had gone to the seller, destroying the caller's record of durable
  // work. A revision whose own period the buyer cannot read cannot be shown to
  // cover the expected one, so it is disqualified rather than dereferenced.
  if (!isReportingPeriodShape(revision.period)) reasons.push('MALFORMED_REVISION_PERIOD');
  const periodEnd = isReportingPeriodShape(revision.period) ? Date.parse(revision.period.end) : Number.NaN;
  const createdAt = Date.parse(revision.created_at);
  if (
    (obligation.required_finality === 'official' && revision.finality !== 'official') ||
    (revision.finality === 'official' &&
      (!revision.finality_basis ||
        !revision.finality_policy_id ||
        !revision.finalized_at ||
        !Number.isFinite(finalizedAt) ||
        finalizedAt < periodEnd ||
        finalizedAt > createdAt))
  ) {
    reasons.push('FINALITY_NOT_MET');
  }
  if (
    revision.finality === 'official' &&
    (!expected?.officialFinality ||
      revision.finality_policy_id !== expected.officialFinality.policyId ||
      revision.finality_basis !== expected.officialFinality.basis)
  ) {
    reasons.push('EXPECTED_FINALITY_POLICY_MISMATCH');
  }

  const successful = successfulAttempts
    .filter(
      item =>
        item.reporting_revision_id === revision.reporting_revision_id &&
        (item.status === 'available' || item.status === 'delivered')
    )
    .sort((left, right) => right.attempt - left.attempt);
  const materialization = successful[0];
  if (!materialization?.verification || !materialization.resource) {
    reasons.push('MISSING_VERIFIED_MATERIALIZATION');
    return { revision, reasons };
  }
  const verificationEvidenceValid = isReportingVerificationEvidence(materialization.verification);
  if (!verificationEvidenceValid) {
    reasons.push('PRODUCER_VERIFICATION_EVIDENCE_INVALID');
  }
  const methodEvidenceValid =
    Boolean(materialization.ready_at) &&
    ((materialization.method === 'file_transfer' &&
      materialization.resource.kind === 'manifest' &&
      materialization.resource.manifest_version === '1.0' &&
      Boolean(materialization.resource.manifest_sha256) &&
      Boolean(materialization.verification.physical_checksums?.length)) ||
      (materialization.method === 'dataset_share' &&
        materialization.resource.kind === 'dataset' &&
        materialization.verification.verification_path === 'representative_consumer') ||
      (materialization.method === 'warehouse_materialization' &&
        materialization.resource.kind === 'warehouse_relation' &&
        materialization.verification.verification_path === 'destination'));
  if (!methodEvidenceValid) reasons.push('MATERIALIZATION_METHOD_EVIDENCE_MISMATCH');
  if (materialization.resource.immutability === 'native_version' && !materialization.resource.native_version_ref) {
    reasons.push('MATERIALIZATION_RESOURCE_EVIDENCE_MISMATCH');
  }
  if (expected && materialization.verification.verification_profile !== expected.verificationProfile) {
    reasons.push('EXPECTED_VERIFICATION_PROFILE_MISMATCH');
  }
  if (expected && materialization.method !== expected.deliveryMethod) {
    reasons.push('EXPECTED_DELIVERY_METHOD_MISMATCH');
  }
  if (materialization.method === 'file_transfer' && !materialization.verification.physical_checksums?.length) {
    reasons.push('PRODUCER_PHYSICAL_CHECKSUMS_MISSING');
  }
  if (
    materialization.delivery_config_id !== obligation.delivery_config_id ||
    materialization.delivery_config_version !== obligation.delivery_config_version ||
    materialization.destination_ref !== obligation.destination_ref ||
    materialization.feed_purpose !== obligation.feed_purpose
  ) {
    reasons.push('MATERIALIZATION_SCOPE_MISMATCH');
  }
  if (
    (verificationEvidenceValid &&
      revisionControlTotalsValid &&
      materialization.verification.row_count !== revision.row_count) ||
    (verificationEvidenceValid &&
      revisionControlTotalsValid &&
      !same(normalizedTotals(materialization.verification.control_totals), normalizedTotals(revision.control_totals)))
  ) {
    reasons.push('PRODUCER_CONTROL_TOTAL_MISMATCH');
  }
  if (
    materialization.verification.verification_profile === 'canonical_digest' &&
    (!revision.canonical_content_digest ||
      !sameCanonicalDigest(materialization.verification.canonical_content_digest, revision.canonical_content_digest))
  ) {
    reasons.push('PRODUCER_DIGEST_MISMATCH');
  }
  if (
    obligation.feed_purpose === 'billing' &&
    materialization.verification.verification_profile !== 'canonical_digest'
  ) {
    reasons.push('BILLING_VERIFICATION_PROFILE_MISMATCH');
  }
  if (materialization.verification.verification_profile === 'native_commit') {
    const evidence = materialization.verification.native_commit_evidence;
    if (
      !evidence ||
      !materialization.resource.native_version_ref ||
      evidence.native_version_ref !== materialization.resource.native_version_ref ||
      evidence.observed_through !== materialization.verification.verification_path
    ) {
      reasons.push('PRODUCER_NATIVE_EVIDENCE_MISMATCH');
    }
  }
  if (materialization.verification.verification_profile === 'manifest_checksums') {
    if (
      materialization.resource.kind !== 'manifest' ||
      materialization.resource.manifest_version !== '1.0' ||
      !materialization.resource.manifest_sha256 ||
      !materialization.verification.physical_checksums?.length
    ) {
      reasons.push('PRODUCER_MANIFEST_EVIDENCE_MISSING');
    }
  }
  return { revision, materialization, reasons };
}

function countMismatch(declared: number | undefined, observed: number, required: boolean): boolean {
  return declared === undefined ? required : declared !== observed;
}

/**
 * Decide the status the buyer owes for every expected period, whether the
 * posting deadline has passed, and whether the buyer has anything new to say.
 *
 * Ordering mirrors how much the buyer actually knows: an absent obligation is
 * `obligation_missing` (valid without any seller-issued id), an obligation with
 * no qualifying revision is `revision_missing`, and a revision is `received`
 * unless it contradicts a frozen contract fact, in which case it is
 * `content_mismatch` with the code naming that fact.
 *
 * Two arms are planned but deliberately **unfinished** here. `received` and
 * `content_mismatch` both require a digest the buyer recomputed from bytes it
 * read, and reading bytes is asynchronous, so they come back with
 * `requiresConsumption` set, no digest, and no `status_as_of`. Only
 * `attestConsumerStatusPlan` can complete them.
 *
 * `unreadable` is likewise absent: it is the outcome of a failed read, which
 * this function has not attempted.
 */
function planReportingConsumerStatuses(
  ledger: ReportingLedger,
  expectedPeriods: readonly ExpectedReportingPeriod[],
  missingExpectedPeriods: readonly ExpectedReportingPeriod[],
  now: Date
): ReportingConsumerStatusPlanV1[] {
  const missing = new Set(missingExpectedPeriods);
  return expectedPeriods.map(expected => {
    const obligationForPeriod = ledger.obligations.find(candidate =>
      expectedPeriodMatches(expected, candidate, ledger)
    );
    // `source_timezone` is part of the period's declared identity. Identity is
    // checked, not length — `iana_timezone` is a MUST and a numeric offset is
    // exactly what it forbids substituting.
    const declaredSourceTimezone = (obligationForPeriod as { period?: { source_timezone?: unknown } } | undefined)
      ?.period?.source_timezone;
    const pinnedSourceTimezone = ianaTimeZone(expected.periodSourceTimezone);
    const echoedSourceTimezone = ianaTimeZone(declaredSourceTimezone);
    // The seller's spelling goes on the wire whenever it has one, because
    // `status-ingest.ts` compares this field to the obligation's by string
    // identity — the buyer's own spelling of the same zone is refused. The pin
    // is used only when the seller declared nothing, and the *canonical* name
    // is never wired: `Intl` canonicalization is ICU-version-dependent and on
    // some runtimes moves away from the tzdb canonical name (`Asia/Kolkata` →
    // `Asia/Calcutta`), so emitting it would be its own source of churn.
    const resolvedSourceTimezone = echoedSourceTimezone ?? pinnedSourceTimezone;
    // Three distinct ways the period's identity is not established, all of
    // which have to suppress rather than post:
    //
    // 1. The seller declared a zone this buyer cannot read. Substituting
    //    `'UTC'` for it is what `iana_timezone` forbids by name, and because
    //    the value is in the chain's logical key the substituted statement is
    //    refused on every run, forever.
    // 2. The *buyer's own* pin is unreadable. Falling through to the seller's
    //    echo would silently post under a chain key the adopter did not choose
    //    — the pin exists so the adopter decides the key, and a typo in it is
    //    something to report, not something to route around.
    // 3. Both are readable and they disagree. `status-ingest.ts` compares
    //    `period.source_timezone` to the obligation's by string identity, so
    //    the buyer's pin cannot be posted against a seller echoing anything
    //    else — measured as a permanent item-local rejection. Nor can the echo
    //    simply be adopted: it is in the chain key, so a seller rotating its
    //    spelling would fork the buyer's own history. Neither value is usable,
    //    which is exactly what `period_identity_unknown` says.
    //
    // With nothing declared and nothing pinned, `'UTC'` is the buyer's own
    // documented default rather than a substitution of someone else's value.
    // Which of the three, not merely whether. One shared sentence for all of
    // them asserted the seller's zone was unrecognised even when the seller was
    // blameless, and sent the adopter to record a pin that was either already
    // recorded or was itself the defect — the exact failure `deadlineGapReason`
    // exists to avoid.
    const pinUnreadable = expected.periodSourceTimezone !== undefined && pinnedSourceTimezone === undefined;
    const echoUnreadable = declaredSourceTimezone !== undefined && echoedSourceTimezone === undefined;
    const periodIdentityGap: PeriodIdentityGap | undefined =
      pinUnreadable && echoUnreadable
        ? // Reporting only one of them would have the adopter fix it, re-run,
          // and meet the other — so both are named at once.
          { cause: 'both_unreadable', pin: expected.periodSourceTimezone, declared: declaredSourceTimezone }
        : echoUnreadable
          ? { cause: 'unreadable_seller_zone', value: declaredSourceTimezone }
          : pinUnreadable
            ? { cause: 'unreadable_pin', value: expected.periodSourceTimezone }
            : undefined;
    // A pin that names a *different but valid* zone from the seller's echo is
    // reported, not suppressed.
    //
    // Suppressing it was a net loss. Measured: the buyer that recorded a pin
    // went permanently silent while the buyer that recorded none posted the
    // `content_mismatch`, so one seller config change silenced exactly the
    // careful adopters — a cheap, permanent, seller-triggerable hole in the
    // accountability record, and `buyer_duty` requires a statement either way.
    //
    // The justification for suppressing was also false: it claimed adopting the
    // echo would fork the buyer's own chain. It cannot. `period.source_timezone`
    // is in neither `currentConsumerLeaf`'s key nor `sameConsumerStatement`'s
    // comparison, so a seller rotating its spelling leaves one statement and
    // reports `unchanged` — measured over seven spellings.
    const periodZoneBeyondPin =
      pinnedSourceTimezone !== undefined &&
      echoedSourceTimezone !== undefined &&
      !sameZone(pinnedSourceTimezone, echoedSourceTimezone)
        ? { declared: echoedSourceTimezone, pinned: pinnedSourceTimezone }
        : undefined;
    const period = {
      start: expected.periodStart,
      end: expected.periodEnd,
      source_timezone: resolvedSourceTimezone ?? 'UTC',
    };
    const base = {
      deliveryConfigId: expected.deliveryConfigId,
      deliveryConfigVersion: expected.deliveryConfigVersion,
      reportDefinitionId: expected.reportDefinitionId,
      period,
    };
    // Clamped once, here, so the deadline and the statement's own instant come
    // from the same value: `expected_at` is "the resolved period end plus this
    // duration" and cannot precede the period end, and feeding the raw value to
    // `overdue` made a past-dated one force a statement the seller refuses on
    // every run.
    const derived = reportingExpectedAt(obligationForPeriod, expected);
    // The field that overflowed, carried all the way to the diagnostic. It used
    // to stop here, so every overflow — a buyer pin's, a seller duration's —
    // was reported against a generic "the derived expected_at".
    const overflowedField = derived !== undefined && 'overflowedField' in derived ? derived.overflowedField : undefined;
    // Clamp only a value that was actually derived: turning "nothing derived"
    // into the period end would manufacture a deadline out of the absence of
    // one, and every present-but-unreadable diagnostic depends on that
    // distinction surviving.
    const expectedAt =
      derived === undefined || !('instant' in derived)
        ? undefined
        : latestInstant([derived.instant, expected.periodEnd]);
    // The seller sent something we could not read *and* could not recompute
    // from its own schedule — carried so the diagnostic can name the value.
    // Present in any form the buyer could not read — including a non-string —
    // is the seller's defect, not a pin the adopter forgot to record.
    const declaredExpectedAt = obligationForPeriod?.expected_at;
    const malformedExpectedAt =
      expectedAt === undefined && overflowedField === undefined && declaredExpectedAt !== undefined
        ? typeof declaredExpectedAt === 'string'
          ? declaredExpectedAt
          : `<${typeof declaredExpectedAt}>`
        : undefined;
    const schedule = consumerStatusSchedule(expectedAt, expected, now, malformedExpectedAt, overflowedField);
    // A seller deadline far past the buyer's own pinned expectation is honoured
    // — the spec makes it authoritative — but recorded, because otherwise it is
    // a silent, permanent opt-out of the entire accountability loop.
    const pinnedExpectation = pinnedExpectedAt(expected);
    // Where the deadline came from, always. The alarm below can only compare
    // against a pin the buyer recorded, so a buyer with *no* pin got a
    // seller-chosen deadline with `suppressed` unset and no marker — a silent,
    // permanent opt-out, and a regression against the behaviour before the
    // schedule fallback existed, which was a loud `deadline_unknown`.
    const deadlineSource: 'buyer_pin' | 'seller_expected_at' | 'seller_schedule' | undefined =
      expectedAt === undefined
        ? undefined
        : normalizedInstant(obligationForPeriod?.expected_at) !== undefined
          ? 'seller_expected_at'
          : pinnedExpectation !== undefined
            ? 'buyer_pin'
            : 'seller_schedule';
    const deadlineBeyondPin =
      expectedAt === undefined || deadlineSource === 'buyer_pin'
        ? undefined
        : pinnedExpectation === undefined
          ? // Nothing of the buyer's own to check it against, so the seller set
            // the buyer's clock unverifiably. Recorded without a `pinned`
            // value rather than left silent.
            { declared: expectedAt }
          : Date.parse(expectedAt) >
              Date.parse(pinnedExpectation) + (expected.automatedRecoveryWindowSeconds ?? 0) * 1_000
            ? { declared: expectedAt, pinned: pinnedExpectation }
            : undefined;
    const leaf = currentConsumerLeaf(
      ledger,
      base,
      (obligationForPeriod as { current_consumer_status_id?: unknown } | undefined)?.current_consumer_status_id
    );
    // `expected_period`: obligation_missing and revision_missing are valid only
    // at or after expected_at. Dating them from the period end instead makes a
    // conformant seller reject every one of them.
    // `expected_at` is "the resolved period end plus this duration", so it can
    // never precede the period end. Clamping up is deterministic and stops a
    // seller dating the buyer's own durable statement in, say, year 1; a
    // far-*future* `expected_at` is deliberately left alone, because that is
    // the seller declaring a long SLA, which the spec makes its prerogative.
    // `expectedAt` is already clamped to at or after the period end above, so
    // there is nothing left to compare — only the absent case to fall back for.
    // The `normalizedInstant` is belt-and-braces: `latestInstant` normalizes
    // every value it takes, so removing it is unobservable.
    const establishedAt = expectedAt ?? normalizedInstant(expected.periodEnd) ?? expected.periodEnd;

    if (missing.has(expected) || !obligationForPeriod) {
      return finalizeConsumerStatusPlan(
        {
          ...base,
          ...schedule,
          ...(periodIdentityGap ? { periodIdentityGap } : {}),
          ...(deadlineBeyondPin ? { deadlineBeyondPin } : {}),
          ...(deadlineSource ? { deadlineSource } : {}),
          ...(periodZoneBeyondPin ? { periodZoneBeyondPin } : {}),
          consumerStatus: 'obligation_missing',
          establishedAt,
          reason: missing.has(expected)
            ? 'the independently expected period is absent from the seller ledger'
            : 'no obligation in the ledger matches this expected period',
        },
        leaf,
        now
      );
    }

    const obligation = obligationForPeriod;
    const selected = selectCurrent(obligation, ledger, expected);
    const revision = selected.revision;
    // A chain the buyer could not resolve is not the same claim as a period the
    // seller never published for, and it is not a claim about the head either:
    // if a revision names a predecessor the buyer never materialised, the buyer
    // has not established that the head it picked is the current one. Both
    // signals therefore suppress whether or not a head resolved.
    // `MISSING_CURRENT_REVISION` alone is the ordinary case — the seller
    // published nothing for this period — and is a true `revision_missing`.
    const forked = selected.reasons.includes('AMBIGUOUS_REVISION_CHAIN');
    const predecessorMissing = selected.reasons.includes('REVISION_PREDECESSOR_MISSING');
    const indeterminate = forked || predecessorMissing;

    if (!revision || indeterminate) {
      return finalizeConsumerStatusPlan(
        {
          ...base,
          ...schedule,
          ...(periodIdentityGap ? { periodIdentityGap } : {}),
          ...(deadlineBeyondPin ? { deadlineBeyondPin } : {}),
          ...(deadlineSource ? { deadlineSource } : {}),
          ...(periodZoneBeyondPin ? { periodZoneBeyondPin } : {}),
          reportingObligationId: obligation.reporting_obligation_id,
          consumerStatus: 'revision_missing',
          ...(indeterminate ? { indeterminate: true } : {}),
          establishedAt,
          reason: forked
            ? 'the revision chain forks, so no single current revision could be resolved'
            : predecessorMissing
              ? `a revision names a predecessor the buyer never saw, so ${revision ? `the head ${boundedDiagnostic(revision.reporting_revision_id)}` : 'no head'} could not be proven current`
              : 'the obligation exists but no required revision was available',
        },
        leaf,
        now
      );
    }

    // `consumer_status`: revision_missing means no **required** revision was
    // available. A revision the frozen generation disqualifies — wrong
    // finality, a contract or coverage the obligation did not accept — is
    // exactly that, and posting `received` for it would affirmatively clear
    // the condition this loop exists to surface.
    const disqualifying = selected.reasons.filter(reason => REVISION_DISQUALIFYING_REASONS.has(reason));
    if (disqualifying.length > 0) {
      return finalizeConsumerStatusPlan(
        {
          ...base,
          ...schedule,
          ...(periodIdentityGap ? { periodIdentityGap } : {}),
          ...(deadlineBeyondPin ? { deadlineBeyondPin } : {}),
          ...(deadlineSource ? { deadlineSource } : {}),
          ...(periodZoneBeyondPin ? { periodZoneBeyondPin } : {}),
          reportingObligationId: obligation.reporting_obligation_id,
          consumerStatus: 'revision_missing',
          establishedAt,
          reason: `the published revision does not satisfy the accepted generation (${disqualifying.join(', ')})`,
        },
        leaf,
        now
      );
    }

    const mismatch = detectReportingContentMismatch(contractFactsFor(obligation, expected), revision);
    return finalizeConsumerStatusPlan(
      {
        ...base,
        ...schedule,
        ...(periodIdentityGap ? { periodIdentityGap } : {}),
        ...(deadlineBeyondPin ? { deadlineBeyondPin } : {}),
        ...(deadlineSource ? { deadlineSource } : {}),
        ...(periodZoneBeyondPin ? { periodZoneBeyondPin } : {}),
        reportingObligationId: obligation.reporting_obligation_id,
        reportingRevisionId: revision.reporting_revision_id,
        consumerStatus: mismatch ? ('content_mismatch' as const) : ('received' as const),
        ...(mismatch ? { mismatchCode: mismatch.mismatchCode } : {}),
        // Not the revision's own `observed_at`: `status_as_of` is when the
        // revision became consumable *to this consumer*, and the spec is
        // explicit that sellers must not silently substitute publication time.
        // The floor stands in until the buyer has actually read it.
        establishedAt,
        requiresConsumption: true,
        reason: mismatch?.detail ?? 'the named revision is ready to consume and honors every frozen contract fact',
      },
      leaf,
      now
    );
  });
}

/**
 * `selectCurrent` reasons that disqualify a published revision from being the
 * one the accepted generation requires.
 *
 * Deliberately narrow. Coverage shortfalls, missing metrics, unit
 * disagreements and period violations all have their own `mismatch_code` under
 * `content_mismatch`, and routing them here would replace a specific
 * contradiction the seller can act on with a flat "no revision". What is left
 * is the set `content_mismatch` has no vocabulary for: wrong finality, a
 * different pinned definition or schema, or a revision that belongs to another
 * slice entirely. The buyer's own inability to read the chain is separate
 * again — that is `chain_indeterminate`.
 */
const REVISION_DISQUALIFYING_REASONS = new Set([
  'FINALITY_NOT_MET',
  'EXPECTED_FINALITY_POLICY_MISMATCH',
  'EXPECTED_CONTRACT_MISMATCH',
  'EXPECTED_CONTRACT_MISSING',
  'REVISION_SCOPE_MISMATCH',
  // Deliberately *not* REVISION_CHAIN_SCOPE_MISMATCH: it fires when any
  // candidate in the chain is off-scope, including a long-superseded one, so a
  // perfectly valid current revision would be reported as missing. Nothing is
  // lost by dropping it — the head-only predicate REVISION_SCOPE_MISMATCH
  // tests the same fields against the revision actually being named.
  //
  // It is a live path, not defence in depth: for a direct-Core obligation the
  // graph assertion does refuse an off-scope revision, but a revision joined
  // through a materialization is checked only for `account_id`, so under
  // managed delivery an off-scope predecessor survives the load and becomes a
  // candidate. The test builds exactly that fixture.
]);

interface ConsumerStatusDraft {
  deliveryConfigId: string;
  deliveryConfigVersion: number;
  reportDefinitionId: string;
  period: { start: string; end: string; source_timezone: string };
  reportingObligationId?: string;
  reportingRevisionId?: string;
  consumerStatus: ReportingConsumerStatusPlanV1['consumerStatus'];
  mismatchCode?: ReportingMismatchCodeV1;
  deadline?: string;
  overdue: boolean;
  requiresConsumption?: boolean;
  /**
   * Why this period has no computable deadline. Either a pin the buyer never
   * recorded, or the seller's own `expected_at` being unreadable — different
   * parties, so they are told apart rather than sharing one sentence.
   */
  deadlineGap?:
    | { cause: 'missing_pin'; pin: string }
    | { cause: 'unreadable_expected_at'; value: string }
    | { cause: 'deadline_overflow'; field: string };
  /** The buyer could not resolve the chain, so it must not assert anything. */
  indeterminate?: boolean;
  /** The seller's `period.source_timezone` is not a zone the buyer can adopt. */
  periodIdentityGap?: PeriodIdentityGap;
  /** The seller's deadline is far past the buyer's own pinned expectation. */
  deadlineBeyondPin?: { declared: string; pinned?: string };
  deadlineSource?: 'buyer_pin' | 'seller_expected_at' | 'seller_schedule';
  periodZoneBeyondPin?: { declared: string; pinned: string };
  /** The instant this statement became true, before the monotonicity floor. */
  establishedAt: string;
  reason: string;
}

interface ConsumerStatusLeaf {
  statusId?: string;
  statement?: ReportingConsumerStatus;
  /** The seller named a current leaf it did not disclose on any page. */
  undisclosed: boolean;
}

/**
 * Attach the chain discipline every statement needs: name the exact current
 * leaf, never date a statement before the one it supersedes, and say nothing
 * when the leaf already says it.
 */
function finalizeConsumerStatusPlan(
  draft: ConsumerStatusDraft,
  leaf: ConsumerStatusLeaf,
  now: Date
): ReportingConsumerStatusPlanV1 {
  const statusAsOfFloor =
    latestInstant([draft.establishedAt, usableLeafInstant(leaf.statement, now)]) ?? draft.establishedAt;
  const { establishedAt: _establishedAt, deadlineGap, indeterminate, periodIdentityGap, ...carried } = draft;
  const plan: ReportingConsumerStatusPlanV1 = {
    ...carried,
    ...(leaf.statusId ? { supersedesReportingStatusId: leaf.statusId } : {}),
    statusAsOfFloor,
    // A statement the buyer can already date is dated now; one that still owes
    // a read is left open for `attestConsumerStatusPlan`.
    ...(draft.requiresConsumption ? {} : { statusAsOf: statusAsOfFloor }),
  };
  if (periodIdentityGap) {
    return {
      ...plan,
      suppressed: 'period_identity_unknown',
      reason: periodIdentityReason(periodIdentityGap),
    };
  }
  if (indeterminate) {
    return {
      ...plan,
      suppressed: 'chain_indeterminate',
      reason: suppressionReason('chain_indeterminate', plan.reason),
    };
  }
  // Applied to every status. `expected_period` puts the *validity* precondition
  // on obligation_missing and revision_missing alone, but this label is not a
  // validity claim — it is the only signal an adopter gets that a period will
  // never post. Narrowing it made the commonest misconfiguration (an
  // unrecorded `automatedRecoveryWindowSeconds`) render exactly like a period
  // that is simply not due yet, which is what this value exists to prevent.
  if (deadlineGap) {
    return {
      ...plan,
      suppressed: 'deadline_unknown',
      reason: deadlineGapReason(deadlineGap),
    };
  }
  const suppressed = consumerStatusSuppression(plan, leaf);
  // `reason` explains the status; once a plan is suppressed it also has to
  // explain the silence, or a log line built from it reads as a success.
  return suppressed ? { ...plan, suppressed, reason: suppressionReason(suppressed, plan.reason) } : plan;
}

/**
 * Say why no deadline could be derived, truthfully.
 *
 * Each cause has a different remedy and a different owner, and naming the wrong
 * one is worse than naming none: an adopter told to record a pin that cannot
 * help does it, re-runs, and gets the identical sentence forever.
 */
/**
 * Why `period.source_timezone` could not be established.
 *
 * Carried rather than collapsed to a boolean, because the remedy differs: one
 * is the seller's to fix, one is the adopter's, and one is a disagreement
 * neither side can resolve unilaterally.
 */
type PeriodIdentityGap =
  | { cause: 'unreadable_seller_zone'; value: unknown }
  | { cause: 'unreadable_pin'; value: unknown }
  | { cause: 'both_unreadable'; pin: unknown; declared: unknown };

function periodIdentityReason(gap: PeriodIdentityGap): string {
  // `period.source_timezone` is in the chain's logical key, so none of these
  // can be resolved by substituting a value — `iana_timezone` forbids it and
  // `status-ingest.ts` compares the field by string identity.
  switch (gap.cause) {
    case 'unreadable_seller_zone':
      // Deliberately offers no local remedy. This gap is decided without
      // consulting the pin, so "record periodSourceTimezone" is an instruction
      // the adopter can follow, re-run, and see fail identically forever.
      return `not posted: the seller's period.source_timezone (${boundedDiagnostic(gap.value)}) is not a recognized IANA zone, and that value is part of the chain's logical key. The buyer cannot substitute for it — iana_timezone forbids that, and the seller compares the field by string identity — so only the seller can correct the value`;
    case 'unreadable_pin':
      return `not posted: ExpectedReportingPeriod.periodSourceTimezone (${boundedDiagnostic(gap.value)}) is not a recognized IANA zone. The seller's echo is not substituted for a pin the adopter chose, because that would post under a chain key they did not pick — correct the pin`;
    default:
      return `not posted: neither ExpectedReportingPeriod.periodSourceTimezone (${boundedDiagnostic(gap.pin)}) nor the seller's period.source_timezone (${boundedDiagnostic(gap.declared)}) is a recognized IANA zone. Correct the pin *and* have the seller correct its value — fixing either one alone leaves the period's identity unestablished`;
  }
}

function deadlineGapReason(gap: NonNullable<ConsumerStatusDraft['deadlineGap']>): string {
  switch (gap.cause) {
    case 'missing_pin':
      return `no posting deadline: record ExpectedReportingPeriod.${gap.pin} to derive one`;
    case 'deadline_overflow':
      return `no posting deadline: ${gap.field} puts it outside the representable range`;
    default:
      // Deliberately offers no local remedy. A present `expected_at` is the
      // seller's real deadline, and a locally derived one would disagree with
      // it — the statement would be refused on every run. Only the seller can
      // fix the value, so saying "record a pin" would send the adopter down a
      // road that cannot work.
      return `no posting deadline: the seller's obligation.expected_at (${boundedDiagnostic(gap.value)}) is not a readable instant, and a present expected_at is never overridden locally — the seller has to correct it`;
  }
}

/** Say why nothing was posted, without losing why the status was planned. */
function suppressionReason(
  suppressed: NonNullable<ReportingConsumerStatusPlanV1['suppressed']>,
  reason: string
): string {
  switch (suppressed) {
    case 'unchanged':
      return `not posted: the current leaf already says this (${reason})`;
    case 'leaf_undisclosed':
      return "not posted: the buyer's status chain has more than one unsuperseded leaf, or the seller named a current leaf it did not disclose — either way the buyer cannot tell whether it has anything new to say";
    case 'consumption_unavailable':
      return 'not posted: no client.getMediaBuyDelivery is wired, so consumption cannot be attested';
    case 'posting_unavailable':
      return 'not posted: no client.syncReportingStatus is wired, so the buyer cannot append to the status chain';
    case 'local_budget_exhausted':
      // `reason` carries the draft's own sentence, which names the ceiling that
      // tripped. Not every ceiling is the caller's to raise, so a single
      // "your ledgerLimits ran out" sentence sent adopters to a knob that does
      // not exist for two of the five producers.
      return `not posted: ${reason}`;
    case 'chain_indeterminate':
      // The draft already says which defect it was, and the two differ: a fork
      // leaves no head at all, a missing predecessor leaves one the buyer
      // cannot prove is current.
      return `not posted: ${reason}`;
    default:
      return reason;
  }
}

/** Why this statement must not be posted, or `undefined` when it may be. */
function consumerStatusSuppression(
  plan: ReportingConsumerStatusPlanV1,
  leaf: ConsumerStatusLeaf
): ReportingConsumerStatusPlanV1['suppressed'] {
  if (leaf.undisclosed) return 'leaf_undisclosed';
  // Before attestation a consumption plan has no digest yet, so the comparison
  // would test `undefined` against the leaf's recorded one and suppress a
  // statement whose content has not been established. `withSuppression` runs
  // the same test again once the digest exists.
  if (plan.requiresConsumption) return undefined;
  if (leaf.statement && sameConsumerStatement(plan, leaf.statement)) return 'unchanged';
  return undefined;
}

/**
 * Whether a planned statement says the same thing the current leaf already
 * says.
 *
 * `immutability` allows a new ID only for *changed* status, so the comparison
 * is over meaning, not over the whole record: the chain pointer, the timestamps
 * and the seller's obligation id all move without the buyer's claim changing.
 * `reporting_obligation_id` is excluded on purpose — the spec has the seller
 * attach an `obligation_missing` chain to a later repaired obligation without
 * resetting it, and a repair that actually changes the buyer's claim already
 * shows up as a different `consumer_status`.
 */
function sameConsumerStatement(plan: ReportingConsumerStatusPlanV1, statement: ReportingConsumerStatus): boolean {
  // The digest is in the comparison because it is the one fact in this whole
  // loop the buyer established itself. A seller that rewrites a revision's
  // bytes under a stable `reporting_revision_id` is committing the
  // immutability violation `observed_revision_content_sha256` exists to catch,
  // and leaving the digest out of the churn guard would suppress the very
  // supersession that reports it.
  return (
    statement.consumer_status === plan.consumerStatus &&
    (statement.reporting_revision_id ?? undefined) === plan.reportingRevisionId &&
    (statement.mismatch_code ?? undefined) === plan.mismatchCode &&
    (statement.failure_code ?? undefined) === plan.failureCode &&
    sameOptionalSha256(statement.observed_revision_content_sha256, plan.observedRevisionContentSha256)
  );
}

function sameOptionalSha256(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameSha256(left, right);
}

/**
 * The caller's one unsuperseded statement for this logical key.
 *
 * Keyed on the configuration generation, report definition and period rather
 * than on the obligation, because `obligation_missing` chains start before any
 * obligation exists and the seller attaches them afterwards.
 */
function currentConsumerLeaf(
  ledger: ReportingLedger,
  key: {
    deliveryConfigId: string;
    deliveryConfigVersion: number;
    reportDefinitionId: string;
    period: { start: string; end: string };
  },
  declaredLeafId?: unknown
): ConsumerStatusLeaf {
  const declared = typeof declaredLeafId === 'string' ? declaredLeafId : undefined;
  const chain = (ledger.consumerStatuses ?? []).filter(
    statement =>
      statement.delivery_config_id === key.deliveryConfigId &&
      statement.delivery_config_version === key.deliveryConfigVersion &&
      statement.report_definition_id === key.reportDefinitionId &&
      statement.period?.start === key.period.start &&
      statement.period?.end === key.period.end
  );
  if (declared) {
    const statement = chain.find(candidate => candidate.reporting_status_id === declared);
    return statement
      ? { statusId: declared, statement, undisclosed: false }
      : { statusId: declared, undisclosed: true };
  }
  const superseded = new Set(
    chain
      .map(statement => statement.supersedes_reporting_status_id)
      .filter((value): value is string => typeof value === 'string')
  );
  const leaves = chain.filter(statement => !superseded.has(statement.reporting_status_id));
  // More than one unsuperseded statement means the chain already forked, which
  // only the seller can resolve. Appending to either branch would deepen it.
  if (leaves.length !== 1) return { undisclosed: leaves.length > 1 };
  const statement = leaves[0]!;
  return { statusId: statement.reporting_status_id, statement, undisclosed: false };
}

/**
 * `expected_at` for this period: the seller's own value when an obligation
 * exists, and otherwise `period.end + delivery_sla` derived from the accepted
 * generation — the definition `reporting-schedule.json` gives it.
 *
 * `undefined` when neither is available. The caller then treats nothing as
 * owed, because a statement dated before `expected_at` is invalid and a
 * statement dated from a guess is worse than silence.
 */
function reportingExpectedAt(
  obligation: ManagedReportingObligation | undefined,
  expected: ExpectedReportingPeriod
): DerivedDeadline {
  // Normalised, never echoed: whatever comes back here is re-emitted as the
  // buyer's own `status_as_of`.
  const declared = normalizedInstant(obligation?.expected_at);
  if (declared !== undefined) return { instant: declared };
  // Present but unreadable is *not* the same as absent. The seller has a real
  // deadline the buyer cannot read, so any derived one disagrees with it and
  // the statement is refused — on every run, forever, because the body takes
  // no clock input. Silence (`deadline_unknown`, naming the seller's field) is
  // the honest outcome; a fallback here would only churn.
  if (obligation?.expected_at !== undefined) return undefined;
  // The buyer's own pin comes next, ahead of the seller's `schedule`.
  //
  // This order is a security property, not a preference. `schedule` is as
  // seller-controlled as `expected_at`, so consulting it first let a seller
  // that had published nothing omit `expected_at`, advertise
  // `delivery_sla: "P10Y"`, and push its own deadline a decade out — the
  // period never goes overdue, the `revision_missing` that would have recorded
  // the non-delivery is never posted, and the buyer's pinned clock, which
  // exists precisely to be independent of the seller, is overridden. The pin
  // is the buyer's answer to "when was this due"; the seller's schedule is
  // only a last resort for a buyer that has no answer of its own.
  // `reporting-schedule.json` defines exactly one offset — `delivery_sla`,
  // "expected_at equals the resolved period end plus this duration" — with no
  // finality qualifier, and `official_after` appears nowhere in the 3.2.0-rc.3
  // schemas. It is an extension this repo's own producer and ingest carry, so
  // `officialAfterSeconds` is a courtesy for sellers that use it and
  // `deliverySlaSeconds` stays the spec-defined answer when they do not.
  //
  // An earlier revision refused that fallback, on the theory that the seller
  // would reject the result. Measured false: with no `officialAfterMilliseconds`
  // configured the seller accepts the `delivery_sla`-derived instant, so
  // refusing silenced a conformant period. A wrong deadline is at least visible
  // as an item-local rejection in `failedConsumerStatuses`; silence is not.
  const offset = expectedOffset(expected);
  const periodEnd = Date.parse(expected.periodEnd);
  if (offset !== undefined && Number.isFinite(periodEnd)) {
    const pinned = periodEnd + offset.seconds * 1_000;
    // `undefined` here would be classified as a missing pin, which is the one
    // thing it is not — the adopter recorded it and it overflowed. Named by the
    // field the value actually came from, so the adopter is sent to a pin they
    // can fix rather than to an empty one.
    return isRepresentableInstant(pinned)
      ? { instant: new Date(pinned).toISOString() }
      : { overflowedField: `ExpectedReportingPeriod.${offset.field}` };
  }
  // `reporting-schedule.json`: "expected_at equals the resolved period end plus
  // this duration". With no pin of its own the buyer has nothing better, and
  // this cannot override anything — before it existed the answer was simply
  // "no deadline".
  return reportingScheduledExpectedAt(obligation, expected.periodEnd);
}

/**
 * The offset the buyer itself recorded for this period, with the field it came
 * from.
 *
 * One definition, used both to derive the deadline and to name the pin in a
 * diagnostic, so the two cannot disagree about which field was consulted.
 * Returning the *name* alongside the value is the point: dispatching on
 * `requiredFinality` alone cannot tell which of the two offsets was actually
 * consulted, so an overflow in `deliverySlaSeconds` under official finality
 * would be attributed to `officialAfterSeconds`, a field the adopter may have
 * left empty. (`14.0.0-rc.38` named no field at all for an overflow; it is the
 * `missing_pin` remedy that named only the extension there.)
 */
function expectedOffset(
  expected: ExpectedReportingPeriod
): { seconds: number; field: 'officialAfterSeconds' | 'deliverySlaSeconds' } | undefined {
  const usable = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  // `officialAfterSeconds` is consulted only for official finality, and only
  // when it is actually usable; otherwise the spec-defined `delivery_sla`
  // answer applies to both finalities.
  if (expected.requiredFinality === 'official') {
    const official = usable(expected.officialAfterSeconds);
    if (official !== undefined) return { seconds: official, field: 'officialAfterSeconds' };
  }
  const sla = usable(expected.deliverySlaSeconds);
  return sla === undefined ? undefined : { seconds: sla, field: 'deliverySlaSeconds' };
}

/** `period.end` plus whichever offset the buyer recorded, or `undefined`. */
function pinnedExpectedAt(expected: ExpectedReportingPeriod): string | undefined {
  const offset = expectedOffset(expected);
  const periodEnd = Date.parse(expected.periodEnd);
  if (offset === undefined || !Number.isFinite(periodEnd)) return undefined;
  const pinned = periodEnd + offset.seconds * 1_000;
  return isRepresentableInstant(pinned) ? new Date(pinned).toISOString() : undefined;
}

function localExpectedAtPin(expected: ExpectedReportingPeriod): string {
  // Reached only when *neither* offset is recorded, so there is no consumed
  // field to name. `reporting-schedule.json` defines `delivery_sla` and nothing
  // else, so that is the field to record; `official_after` appears nowhere in
  // the 3.2.0-rc.3 schemas and is an SDK-local extension, offered second rather
  // than first. Naming only the extension sent adopters to a field the spec
  // does not have.
  return expected.requiredFinality === 'official'
    ? 'deliverySlaSeconds (or the SDK-local officialAfterSeconds)'
    : 'deliverySlaSeconds';
}

/**
 * `expected_at` recomputed as "the resolved period end plus `delivery_sla`".
 *
 * Calendar-aware, because `reporting-schedule.json` permits `Y` and `M` on
 * `delivery_sla` and names `period_timezone` as the zone its "calendar
 * arithmetic" happens in. A parser that only understood `D`/`H`/`M`/`S` would
 * reject `P1M` — a value the schema allows and this SDK's own validator
 * accepts — and silence a conformant seller, which is the whole failure this
 * fallback exists to prevent.
 *
 * The overflow arm names `schedule.delivery_sla`, because that is the field an
 * adopter would have to take up with the seller; `undefined` means there was
 * nothing to resolve at all.
 */
function reportingScheduledExpectedAt(
  obligation: ManagedReportingObligation | undefined,
  periodEnd: string
): DerivedDeadline {
  const schedule = (
    obligation as { schedule?: { delivery_sla?: unknown; period_timezone?: unknown; alignment?: unknown } } | undefined
  )?.schedule;
  if (typeof schedule?.delivery_sla !== 'string') return undefined;
  const duration = parseIso8601Duration(schedule.delivery_sla);
  const anchor = Date.parse(periodEnd);
  if (!duration || !Number.isFinite(anchor)) return undefined;
  // A duration with no calendar component is exact elapsed time. Taking the
  // fast path matters: it is the only shape this repo's own seller emits
  // (`handler.ts` renders `delivery_sla` as `PT{n}S`), and routing it through
  // wall-clock conversion was lossy — `PT0S` across an ambiguous local hour
  // came back an hour early, and sub-second precision was dropped entirely.
  if (duration.years === 0 && duration.months === 0 && duration.days === 0) {
    const exact = anchor + duration.seconds * 1_000;
    // An overflow here is not "no schedule to read", and it is the seller's
    // duration that overflowed, not anything the buyer recorded.
    return isRepresentableInstant(exact) ? { instant: new Date(exact).toISOString() } : OVERFLOWED_SCHEDULE;
  }
  const timeZone = calendarTimeZone(obligation, schedule);
  if (timeZone === undefined) return undefined;
  const shifted = addCalendarDuration(anchor, duration, timeZone);
  // Range-checked before it becomes a string. `delivery_sla` is seller-supplied
  // and the schema's pattern permits arbitrarily many digits, so `P999999999D`
  // is a legal value that lands outside the representable range — and
  // `toISOString` throws on that, from a call site with nothing to catch it.
  if (shifted === undefined) return undefined;
  if (shifted === 'overflow') return OVERFLOWED_SCHEDULE;
  return isRepresentableInstant(shifted) ? { instant: new Date(shifted).toISOString() } : OVERFLOWED_SCHEDULE;
}

/** The seller's own duration overflowed — the field the adopter would raise. */
const OVERFLOWED_SCHEDULE = {
  // The wire path, not the internal type name: `ManagedReportingObligation` is
  // not exported, so an adopter grepping their .d.ts for it finds nothing.
  overflowedField: "the seller's obligation.schedule.delivery_sla",
} as const;

/**
 * The zone a calendar `delivery_sla` is resolved in, or `undefined` to derive
 * nothing.
 *
 * `period_timezone` is the explicit answer, but the schema forbids it for
 * `utc` and `account_timezone` alignment. `utc` needs no zone. For
 * `account_timezone` the calendar is *"the account's resolved IANA
 * timezone"*, which is not on this payload — the obligation's echoed
 * `period.source_timezone` is the closest thing and is required, so it is
 * preferred over guessing UTC; with neither, nothing is derived rather than a
 * guess, which is the same posture as an unresolvable zone.
 */
function calendarTimeZone(
  obligation: ManagedReportingObligation | undefined,
  schedule: { period_timezone?: unknown; alignment?: unknown }
): string | undefined {
  // Present but unrecognized is a non-conformant configuration, not an
  // invitation to pick a different zone: "Reject unknown identifiers ... do not
  // silently substitute the host timezone or a numeric offset."
  if (schedule.period_timezone !== undefined) return ianaTimeZone(schedule.period_timezone);
  if (schedule.alignment === 'utc') return 'UTC';
  return ianaTimeZone((obligation as { period?: { source_timezone?: unknown } } | undefined)?.period?.source_timezone);
}

/**
 * A recognized IANA zone name, or `undefined`.
 *
 * `iana_timezone` is a MUST: *"Reject unknown identifiers ... do not silently
 * substitute the host timezone or a numeric offset."* A length check is not
 * enough — Node's `Intl` accepts `"+05:30"` as a `timeZone`, which would
 * silently compute against a fixed offset with no DST transitions, precisely
 * the substitution the clause forbids.
 */
function ianaTimeZone(value: unknown): string | undefined {
  const name = boundedSourceTimezone(value);
  if (name === undefined) return undefined;
  // Numeric offsets only. `Intl` accepts `+05:30` and `+0530` as a `timeZone`,
  // and adopting one would compute against a fixed offset with no DST
  // transitions — the substitution `iana_timezone` forbids by name. A
  // slash-free *link* like `Japan`, `GB` or `Zulu` is explicitly permitted
  // ("zone name or link") and this repo's own producer accepts them, so
  // requiring a slash would refuse a configuration the seller already took.
  if (/^[+-]/.test(name)) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    // The caller's own spelling, never a canonicalized one: this value is part
    // of the chain's logical key and the seller compares it byte-for-byte
    // against the obligation it echoed.
    return name;
  } catch {
    return undefined;
  }
}

interface Iso8601Duration {
  years: number;
  months: number;
  days: number;
  seconds: number;
}

/** The non-negative subset `reporting-schedule.json` permits on `delivery_sla`. */
function parseIso8601Duration(value: string): Iso8601Duration | undefined {
  const match =
    /^P(?=\d|T)(?=.*\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) return undefined;
  const [, years, months, days, hours, minutes, seconds] = match;
  return {
    years: Number(years ?? 0),
    months: Number(months ?? 0),
    days: Number(days ?? 0),
    seconds: Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0),
  };
}

/**
 * Add a duration to an instant, following `period_generation` exactly:
 * *"Calendar durations use local civil-time arithmetic in the selected IANA
 * timezone, including DST transitions; they are not converted to fixed
 * seconds"*, applying *"years, months, days"* in that order, and *"clamping to
 * the target month's final valid day when necessary"*.
 *
 * Days are civil, not 86,400 seconds. Across a spring-forward boundary the two
 * differ by an hour, and the spec is explicit about which one it means.
 * Hours/minutes/seconds stay exact elapsed time — they are not calendar
 * components, and treating them as civil would make `PT24H` and `P1D`
 * synonyms, which is the distinction the rule exists to preserve.
 */
function addCalendarDuration(instant: number, duration: Iso8601Duration, timeZone: string): CalendarShift {
  const parts = zonedParts(instant, timeZone);
  if (!parts) return undefined;
  const totalMonths = parts.month - 1 + duration.years * 12 + duration.months;
  const year = parts.year + Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  // Clamp before adding days, so "a clamped February boundary does not shift a
  // March 31 anchor" holds and the day count starts from the clamped date.
  const clamped = Math.min(parts.day, daysInMonth(year, month));
  // Both guards below are range failures, not "no zone to resolve in", and the
  // two are reported differently: an overflow names the field that overflowed,
  // an unresolvable zone names the pin the adopter never recorded. Collapsing
  // them sent adopters to fix `deliverySlaSeconds` for a `P999999999Y` they had
  // in fact recorded.
  const wall = utcWallTime(year, month, clamped + duration.days, parts.hour, parts.minute, parts.second);
  if (wall === undefined) return 'overflow';
  const resolved = instantForWallTime(wall, timeZone);
  if (resolved === undefined) return 'overflow';
  // `zonedParts` has no millisecond field, so the anchor's sub-second remainder
  // is carried across rather than silently truncated.
  const subSecond = ((instant % 1_000) + 1_000) % 1_000;
  return resolved + subSecond + duration.seconds * 1_000;
}

/**
 * A calendar shift that landed, one that fell outside the representable range,
 * or `undefined` for a zone that could not be resolved at all.
 */
type CalendarShift = number | 'overflow' | undefined;

/** Within the ±8.64e15 ms ECMAScript time range, so `toISOString` cannot throw. */
function isRepresentableInstant(value: number): boolean {
  // Deliberately tighter than the ±8.64e15 ECMAScript range: `toISOString`
  // renders a year outside 0000-9999 in expanded form (`+010026-09-02T…`),
  // which is not a valid RFC 3339 `date-time` and would be re-emitted onto a
  // plan an adopter may persist or forward.
  return Number.isFinite(value) && value >= MIN_RFC3339_INSTANT && value <= MAX_RFC3339_INSTANT;
}

/** 0000-01-01T00:00:00Z and 9999-12-31T23:59:59.999Z, the RFC 3339 year range. */
const MIN_RFC3339_INSTANT = -62_167_219_200_000;
const MAX_RFC3339_INSTANT = 253_402_300_799_999;

function daysInMonth(year: number, month: number): number {
  // Same two-digit-year hazard `utcWallTime` exists for: `Date.UTC(50, …)`
  // means 1950, and year 0 is a leap year where 1900 is not.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0);
  return probe.getUTCDate();
}

/**
 * `Date.UTC` for a possibly small year.
 *
 * `Date.UTC(50, …)` means 1950, which would silently relocate a year-0050
 * period by nineteen centuries. `setUTCFullYear` is the documented way to mean
 * the year you wrote.
 */
function utcWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number | undefined {
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(hour, minute, second, 0);
  const time = value.getTime();
  return isRepresentableInstant(time) ? time : undefined;
}

/** Calendar fields of an instant as read in `timeZone`. */
function zonedParts(
  instant: number,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | undefined {
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // Read the era so a proleptic year can be refused rather than silently
      // relocated: without it `en-US` renders year 0 (1 BC) as year `1`.
      era: 'short',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));
    const field = (type: string): number => Number(formatted.find(part => part.type === type)?.value);
    // Anything before year 1 is refused outright. Deriving a deadline from a
    // relocated year would be a guess, and this arithmetic has no business
    // reaching back past the Common Era anyway.
    if (/^b/i.test(formatted.find(part => part.type === 'era')?.value ?? '')) return undefined;
    const parts = {
      year: field('year'),
      month: field('month'),
      day: field('day'),
      // The locale here is hardcoded `en-US` with `hour12: false`, which ICU
      // renders as `"00"`, so this cannot fire today — the hourCycle that
      // renders midnight as 24 is not reachable from a fixed locale. Kept as a
      // statement of the field's range, not claimed as tested.
      hour: field('hour') % 24,
      minute: field('minute'),
      second: field('second'),
    };
    return Object.values(parts).every(Number.isFinite) ? parts : undefined;
  } catch {
    // An unknown IANA zone: the seller named something this runtime cannot
    // resolve, so there is no instant to derive rather than a guessed one.
    return undefined;
  }
}

/**
 * The instant at which `timeZone` reads the given wall-clock time, resolving
 * DST edges the way `period_generation` requires: *"A nonexistent local
 * boundary advances by the timezone gap; an ambiguous local boundary uses the
 * earlier offset."*
 *
 * Both rules fall out of preferring the offset in effect *before* the
 * transition. On an ambiguous wall time that offset is the larger one, so it
 * yields the earlier instant — the spec's choice. On a nonexistent one neither
 * candidate reads back, and applying the pre-transition offset lands exactly
 * one gap later, which is the advance the spec asks for.
 */
function instantForWallTime(wall: number, timeZone: string): number | undefined {
  const dayMs = 86_400_000;
  const offsetBefore = zoneOffset(wall - dayMs, timeZone);
  const offsetAfter = zoneOffset(wall + dayMs, timeZone);
  if (offsetBefore === undefined || offsetAfter === undefined) return undefined;
  const fromBefore = wall - offsetBefore;
  const fromAfter = wall - offsetAfter;
  if (readsBackAs(fromBefore, wall, timeZone)) return fromBefore;
  if (readsBackAs(fromAfter, wall, timeZone)) return fromAfter;
  // Nonexistent: advance by the gap.
  return fromBefore;
}

/** Offset of `timeZone` at an instant, in milliseconds east of UTC. */
function zoneOffset(instant: number, timeZone: string): number | undefined {
  if (!isRepresentableInstant(instant)) return undefined;
  const parts = zonedParts(instant, timeZone);
  if (!parts) return undefined;
  const asUtc = utcWallTime(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc === undefined ? undefined : asUtc - instant;
}

/** Whether `timeZone` reads `instant` as exactly the given wall-clock time. */
function readsBackAs(instant: number, wall: number, timeZone: string): boolean {
  if (!isRepresentableInstant(instant)) return false;
  const parts = zonedParts(instant, timeZone);
  if (!parts) return false;
  return utcWallTime(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second) === wall;
}

/**
 * The rc.3 posting deadline: `expected_at` + `automated_recovery_window_seconds`.
 *
 * The window is advertised on `reporting-delivery-capabilities.json`, not on
 * the obligation, so it comes from the buyer's own pin. `undefined` when either
 * half is missing — the caller then treats the status as *not* owed, because
 * inventing a deadline would post on a clock the seller never advertised.
 */
function consumerStatusSchedule(
  expectedAt: string | undefined,
  expected: ExpectedReportingPeriod,
  now: Date,
  malformedExpectedAt?: string,
  overflowedField?: string
): { deadline?: string; overdue: boolean; deadlineGap?: ConsumerStatusDraft['deadlineGap'] } {
  const windowSeconds = expected.automatedRecoveryWindowSeconds;
  if (overflowedField !== undefined) {
    return {
      overdue: false,
      deadlineGap: { cause: 'deadline_overflow', field: overflowedField },
    };
  }
  if (expectedAt === undefined) {
    // Distinguish the causes: a pin the buyer never recorded, versus an
    // obligation whose own `expected_at` the buyer could not read. Overflow is
    // handled above, with the field that overflowed.
    return {
      overdue: false,
      deadlineGap:
        malformedExpectedAt !== undefined
          ? { cause: 'unreadable_expected_at', value: malformedExpectedAt }
          : { cause: 'missing_pin', pin: localExpectedAtPin(expected) },
    };
  }
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds < 0) {
    return { overdue: false, deadlineGap: { cause: 'missing_pin', pin: 'automatedRecoveryWindowSeconds' } };
  }
  const deadlineAt = Date.parse(expectedAt) + windowSeconds * 1_000;
  // Guarded here too: `expected_at` is range-checked where it is derived, but
  // the window is added afterwards, so a value just inside the range plus a
  // seller-advertised window lands outside it — and `toISOString` throws from
  // a call site that nothing wraps, aborting the whole reconcile.
  if (!isRepresentableInstant(deadlineAt)) {
    return {
      overdue: false,
      deadlineGap: { cause: 'deadline_overflow', field: 'ExpectedReportingPeriod.automatedRecoveryWindowSeconds' },
    };
  }
  const deadline = new Date(deadlineAt).toISOString();
  return { deadline, overdue: now.getTime() >= Date.parse(deadline) };
}

/**
 * Deliberately as permissive as the `date-time` format this SDK validates
 * seller payloads with (`ajv-formats`), which accepts a lowercase `t`/`z`, a
 * space separator, and `+hhmm` or `+hh` offsets. A stricter reader here would
 * silence a seller the SDK itself just told was conformant.
 *
 * Not *looser* either: RFC 3339 bounds the offset hour at 23 and `ajv-formats`
 * enforces it. An unbounded `\d{2}` let `+30:00` through — V8's ISO parser
 * refuses it, but the legacy parser reached via the space separator does not,
 * so widening the separator quietly opened it.
 */
const RFC3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[Tt\s](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3])(?::?(\d{2}))?)$/;

/**
 * One canonical spelling of a seller-supplied instant, or `undefined`.
 *
 * Normalising rather than echoing matters twice over: `Date.parse` silently
 * rolls an out-of-range date forward, so `2026-02-30T00:00:00Z` passes every
 * syntactic check and then means March 2 — and re-emitting the seller's bytes
 * would put that contradiction on a statement the buyer signs, where a
 * validator doing real calendar checking rejects it forever.
 */
function normalizedInstant(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = RFC3339_INSTANT.exec(value);
  if (!match) return undefined;
  const [, isoYear, isoMonth, isoDay, isoHour, isoMinute, isoSecond, offsetMinute] = match;
  const year = Number(isoYear);
  const month = Number(isoMonth);
  const day = Number(isoDay);
  // Calendar-validated on the literal fields, before any parsing and
  // regardless of offset. `Date.parse` rolls an out-of-range day forward, so
  // `2026-02-30` silently means March 2 — and checking the parsed result
  // instead cannot distinguish that roll from a legitimate offset moving the
  // UTC date, which is why an earlier version of this only caught the `Z` case.
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  // The hour bound is load-bearing; the two minute bounds are not — `Date.parse`
  // already returns `NaN` for `00:99` and for a `+00:99` offset, and the
  // `Number.isFinite` check below refuses it. Kept as an explicit statement of
  // the format, deliberately not claimed as tested.
  if (Number(isoHour) > 23 || Number(isoMinute) > 59) return undefined;
  if (offsetMinute !== undefined && Number(offsetMinute) > 59) return undefined;
  // A leap second is inserted at 23:59:60 **UTC**, which is what `ajv-formats`
  // checks — it converts the local time through the offset first. Testing the
  // local fields instead rejected a genuine `18:59:60-05:00` and accepted a
  // bogus `23:59:60+01:00`, i.e. wrong in both directions at once.
  const leapSecond = isoSecond === '60';
  if (leapSecond && utcMinuteOfDay(value, Number(isoHour), Number(isoMinute)) !== 23 * 60 + 59) return undefined;
  // `Date.parse` is narrower than the format the SDK validates seller payloads
  // with: it returns NaN for a bare `+hh` offset and for a leap second, both of
  // which `ajv-formats` accepts. Widening the pattern without handling these
  // would have left the conformant seller silenced anyway.
  let candidate = value.replace(/([+-]\d{2})$/, '$1:00');
  if (leapSecond) candidate = candidate.replace(/:60/, ':59');
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) return undefined;
  // A leap second is the instant immediately before the next one.
  const instant = parsed + (leapSecond ? 1_000 : 0);
  // Range-checked like every sibling derivation. `RFC3339_INSTANT` allows
  // offsets to ±23:59, so `9999-12-31T23:59:59-23:59` is a value this SDK's own
  // validator calls conformant and which parses past the RFC 3339 year range,
  // and `toISOString` would render it expanded (`+010000-…`).
  //
  // Reachable from the wire, not defence in depth: the seller's own
  // `obligation.expected_at` is read through here, so that exact string is all
  // it takes. Without the guard the buyer derives a live deadline from a value
  // it cannot re-emit; with it, the period says `deadline_unknown` and names
  // the seller's field.
  return isRepresentableInstant(instant) ? new Date(instant).toISOString() : undefined;
}

/**
 * Whether two zone names name the same zone.
 *
 * `iana_timezone` accepts "a recognized IANA Time Zone Database zone name **or
 * link**", so `Japan` and `Asia/Tokyo` — and `US/Eastern` and
 * `America/New_York` — are the same zone differently spelled. Comparing the
 * strings made a *correct* pin break a configuration that worked with no pin
 * at all, and silenced the period permanently, which `buyer_duty` forbids.
 * Every serious tzdb consumer resolves links rather than string-comparing
 * them; `Temporal`'s `equals()` is the published precedent.
 */
function sameZone(left: string, right: string): boolean {
  if (left === right) return true;
  const canonicalLeft = canonicalZone(left);
  const canonicalRight = canonicalZone(right);
  // Two zones neither of which resolves are not thereby "the same": an
  // unresolvable name yields `undefined`, which never compares equal here.
  return canonicalLeft !== undefined && canonicalLeft === canonicalRight;
}

/**
 * The runtime's canonical spelling of a zone, for comparison only.
 *
 * Never put on the wire. ICU canonicalization is version-dependent and does not
 * always agree with the tzdb canonical name — this runtime resolves
 * `Asia/Kolkata` to `Asia/Calcutta`, i.e. toward the link — so emitting it
 * would be its own source of churn.
 *
 * A non-string is returned unchanged; an unrecognized string resolves to
 * `undefined`, which collapses every unreadable value together, so a caller
 * that needs them distinguished falls back to the raw value itself.
 */
function canonicalZone(name: unknown): unknown {
  // A non-string keeps its own identity; an unrecognized *string* resolves to
  // `undefined`, so callers that must not collapse them fall back to the raw
  // value themselves — `reportingRevisionScopeKey` does.
  if (typeof name !== 'string') return name;
  // Bounded before `Intl`, because the input is a raw seller string and
  // constructing a formatter costs time proportional to its length: a 1 MB zone
  // name measured 8.2 ms against 32 µs for a real one. `ianaTimeZone` already
  // applies this bound; these two did not, and they are on the hot path.
  if (name.length === 0 || name.length > MAX_SOURCE_TIMEZONE_LENGTH) return undefined;
  const cached = CANONICAL_ZONE_CACHE.get(name);
  if (cached !== undefined) return cached === CANONICAL_ZONE_UNRESOLVED ? undefined : cached;
  let resolved: string | typeof CANONICAL_ZONE_UNRESOLVED;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    resolved = CANONICAL_ZONE_UNRESOLVED;
  }
  // Bounded so a seller cycling distinct garbage strings cannot grow it without
  // limit. The real zone-name space is a few hundred entries, so the cap is
  // only ever reached under attack, and dropping the cache then is correct —
  // the length bound above already makes each miss cheap.
  if (CANONICAL_ZONE_CACHE.size >= MAX_CANONICAL_ZONE_CACHE) CANONICAL_ZONE_CACHE.clear();
  CANONICAL_ZONE_CACHE.set(name, resolved);
  return resolved === CANONICAL_ZONE_UNRESOLVED ? undefined : resolved;
}

/**
 * Memoized because zone comparison is on an O(obligations x revisions) path.
 *
 * `new Intl.DateTimeFormat(...)` measured ~62 us, so a seller could make every
 * revision-to-obligation comparison reconstruct one simply by spelling its zone
 * differently from its own obligation — both spellings conformant under
 * `iana_timezone`. Measured 84 ms to 6,068 ms on a 150x150 ledger, synchronous,
 * which starves the whole event loop and is reached after receipts are synced.
 */
const CANONICAL_ZONE_CACHE = new Map<string, string | symbol>();
const CANONICAL_ZONE_UNRESOLVED = Symbol('unresolved-zone');
const MAX_CANONICAL_ZONE_CACHE = 4_096;
const MAX_SOURCE_TIMEZONE_LENGTH = 255;

/** A usable, bounded source timezone, or `undefined` to fall through. */
function boundedSourceTimezone(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SOURCE_TIMEZONE_LENGTH
    ? value
    : undefined;
}

/**
 * Minute-of-day in UTC for a local wall time plus the value's own offset, the
 * way `ajv-formats` resolves a leap second.
 */
function utcMinuteOfDay(value: string, hour: number, minute: number): number {
  const offset = /([+-])(\d{2}):?(\d{2})?$/.exec(value);
  const offsetMinutes = offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) : 0;
  return (((hour * 60 + minute - offsetMinutes) % 1_440) + 1_440) % 1_440;
}

/** Strip control characters and bound any string headed for an adopter's log. */
function boundedDiagnostic(value: unknown): string {
  // A non-string still has to render as *something*: `''` produced diagnostics
  // reading "period.source_timezone () is not a recognized IANA zone", which
  // names neither the value nor the fault.
  if (value === undefined) return '';
  if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`;
  // Sliced before the replace: the input can be seller-supplied and arbitrarily
  // long, and bounding after the copy pays for the whole thing first.
  return value.slice(0, 256).replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** Latest of a set of possibly-absent RFC 3339 instants. */
function latestInstant(values: ReadonlyArray<string | undefined>): string | undefined {
  let latest: string | undefined;
  for (const value of values) {
    // Normalized, not echoed. `RFC3339_INSTANT` was widened to accept a space
    // separator, a lowercase `t`/`z` and a bare `+hh`; echoing one of those
    // would put it on a statement the buyer signs, which is the thing
    // `normalizedInstant` exists to prevent.
    const normalized = normalizedInstant(value);
    if (normalized === undefined) continue;
    const parsed = Date.parse(normalized);
    if (latest === undefined || parsed > Date.parse(latest)) latest = normalized;
  }
  return latest;
}

/**
 * The superseded leaf's `status_as_of`, only when the buyer could plausibly
 * have issued it.
 *
 * `time` floors a new statement at the leaf's instant, and the leaf is a record
 * the *seller* hands back. Adopting it unchecked lets a seller — or one with a
 * skewed clock — date the buyer's own durable statement arbitrarily far into
 * the future and, because the floor applies to every later statement, poison
 * the chain permanently. A leaf the buyer could not have issued is the same
 * class of problem as one the seller never disclosed.
 */
function usableLeafInstant(statement: ReportingConsumerStatus | undefined, now: Date): string | undefined {
  const value = normalizedInstant(statement?.status_as_of);
  if (value === undefined || Date.parse(value) > now.getTime()) return undefined;
  return value;
}

/** Facts the accepted generation froze, drawn from the obligation plus the buyer's own pins. */
function contractFactsFor(
  obligation: ManagedReportingObligation,
  expected: ExpectedReportingPeriod
): ReportingContractFactsV1 {
  return {
    ...(Array.isArray(obligation.media_buy_ids) ? { mediaBuyIds: obligation.media_buy_ids } : {}),
    ...(obligation.coverage?.covered_package_ids ? { coveredPackageIds: obligation.coverage.covered_package_ids } : {}),
    period: { start: expected.periodStart, end: expected.periodEnd },
    ...(expected.committedMetrics ? { committedMetrics: expected.committedMetrics } : {}),
    ...(expected.metricUnits ? { metricUnits: expected.metricUnits } : {}),
  };
}

/**
 * Flatten seller-reported issues into a page-a-human shape, carrying the rc.3
 * lifecycle fields and the advertised escalation destination.
 */
/** Escalations built from one obligation's `issues`. Seller-supplied, so bounded. */
const MAX_OBLIGATION_ISSUES = 256;

function collectReportingEscalations(
  ledger: ReportingLedger,
  options?: { operationsContact?: { url?: string; email?: string } }
): ReportingEscalationV1[] {
  // Not read from the ledger: `operations_contact` lives on
  // reporting-delivery-capabilities.json, and get_reporting_status's `scope` is
  // additionalProperties:false with no such key. Reading it there was dead code
  // that could never populate, so the buyer supplies its own recorded copy.
  const operationsContact = options?.operationsContact;
  const escalations: ReportingEscalationV1[] = [];
  for (const obligation of ledger.obligations) {
    const declaredIssues = (obligation as { issues?: unknown }).issues;
    // Guarded: this runs *after* receipts have been synced, so a non-array or a
    // null entry from an adopter client that does not schema-validate would
    // abort the whole reconcile and lose the record of durable work — the exact
    // hazard the canonicalizer guard exists for, two functions upstream.
    // Capped as well as guarded: `issues` is seller-supplied and counts against
    // no ledger limit, so an unbounded array is a cheap way to make the buyer
    // build and retain an escalation per entry. Far above any real obligation's
    // issue count.
    for (const candidate of (Array.isArray(declaredIssues) ? declaredIssues : []).slice(0, MAX_OBLIGATION_ISSUES)) {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) continue;
      const issue = candidate as Record<string, unknown>;
      const recommendedAction = boundedDiagnostic(String(issue.recommended_action ?? ''));
      escalations.push({
        reportingObligationId: obligation.reporting_obligation_id,
        issueId: boundedDiagnostic(String(issue.issue_id ?? '')),
        code: boundedDiagnostic(String(issue.code ?? '')),
        severity: boundedDiagnostic(String(issue.severity ?? '')),
        responsibleParty: boundedDiagnostic(String(issue.responsible_party ?? '')),
        recommendedAction,
        ...(typeof issue.opened_at === 'string' ? { openedAt: issue.opened_at } : {}),
        ...(typeof issue.issue_state === 'string' ? { issueState: issue.issue_state } : {}),
        ...(typeof issue.external_ref === 'string' ? { externalRef: boundedDiagnostic(issue.external_ref) } : {}),
        ...(typeof issue.reporting_status_id === 'string' ? { reportingStatusId: issue.reporting_status_id } : {}),
        ...(operationsContact ? { operationsContact } : {}),
        requiresHumanContact: recommendedAction.startsWith('contact_'),
      });
    }
  }
  return escalations;
}

/** A `period` the buyer can compare — both half-open bounds present as strings. */
function isReportingPeriodShape(value: unknown): value is { start: string; end: string } {
  if (typeof value !== 'object' || value === null) return false;
  const period = value as { start?: unknown; end?: unknown };
  return typeof period.start === 'string' && typeof period.end === 'string';
}

function expectedPeriodMatches(
  expected: ExpectedReportingPeriod,
  obligation: ManagedReportingObligation,
  ledger: ReportingLedger
): boolean {
  // A period-less obligation cannot match any expected period, and reaching
  // this after receipts have synced used to throw out of `reconcileReporting`
  // and lose the record of durable work. Classified like the other malformed
  // ledger payloads instead.
  if (!isReportingPeriodShape(obligation.period)) return false;
  if (
    obligation.delivery_config_id !== expected.deliveryConfigId ||
    obligation.delivery_config_version !== expected.deliveryConfigVersion ||
    obligation.report_definition_id !== expected.reportDefinitionId ||
    obligation.feed_purpose !== expected.feedPurpose ||
    obligation.reporting_profile !== expected.reportingProfile ||
    !Array.isArray(obligation.media_buy_ids) ||
    !same([...obligation.media_buy_ids].sort(), [...expected.mediaBuyIds].sort()) ||
    obligation.destination_ref !== expected.destinationRef ||
    obligation.required_finality !== expected.requiredFinality ||
    obligation.reconciliation_mode !== expected.reconciliationMode ||
    (expected.coverageRequirement === 'full' && obligation.coverage?.status !== 'full') ||
    obligation.period.start !== expected.periodStart ||
    obligation.period.end !== expected.periodEnd ||
    !isReportingCoverageEvidence(obligation.coverage) ||
    !coverageMatchesExpected(obligation.coverage, expected.coverage)
  ) {
    return false;
  }
  const attempts = ledger.materializations.filter(
    materialization => materialization.reporting_obligation_id === obligation.reporting_obligation_id
  );
  return (
    attempts.length === 0 ||
    (attempts.every(materialization => materialization.method === expected.deliveryMethod) &&
      attempts
        .filter(materialization => materialization.status === 'available' || materialization.status === 'delivered')
        .every(materialization => materialization.verification?.verification_profile === expected.verificationProfile))
  );
}

function expectedIdentityKey(value: ExpectedReportingPeriod | ManagedReportingObligation): string {
  if ('deliveryConfigId' in value) {
    return canonical([
      value.deliveryConfigId,
      value.deliveryConfigVersion,
      value.reportDefinitionId,
      value.feedPurpose,
      value.reportingProfile,
      value.destinationRef,
      value.periodStart,
      value.periodEnd,
    ]);
  }
  return canonical([
    value.delivery_config_id,
    value.delivery_config_version,
    value.report_definition_id,
    value.feed_purpose,
    value.reporting_profile,
    value.destination_ref,
    value.period?.start,
    value.period?.end,
  ]);
}

function buildExpectedIdentityIndex(
  obligations: readonly ManagedReportingObligation[],
  expectedPeriods: readonly ExpectedReportingPeriod[]
): {
  expectedByIdentity: Map<string, ExpectedReportingPeriod[]>;
  obligationCounts: Map<string, number>;
} {
  const expectedByIdentity = new Map<string, ExpectedReportingPeriod[]>();
  const obligationCounts = new Map<string, number>();
  for (const expected of expectedPeriods) {
    const key = expectedIdentityKey(expected);
    expectedByIdentity.set(key, [...(expectedByIdentity.get(key) ?? []), expected]);
  }
  for (const obligation of obligations) {
    const key = expectedIdentityKey(obligation);
    obligationCounts.set(key, (obligationCounts.get(key) ?? 0) + 1);
  }
  return { expectedByIdentity, obligationCounts };
}

export function evaluateReportingLedger(
  ledger: ReportingLedger,
  expectedPeriods: ExpectedReportingPeriod[] | undefined,
  now = new Date(),
  /**
   * The seller's advertised `operations_contact`, as the buyer recorded it from
   * the capability document. It is not carried on any `get_reporting_status`
   * response, so it cannot be derived here.
   */
  operationsContact?: { url?: string; email?: string }
): Omit<ReportingReconciliationResult, 'submittedReceipts'> {
  assertDirectReportingLedgerGraph(ledger);
  const obligationResults: ObligationReconciliation[] = [];
  const uniqueRevisions = new Map<string, ManagedReportingRevision>();
  const { expectedByIdentity, obligationCounts } = buildExpectedIdentityIndex(
    ledger.obligations,
    expectedPeriods ?? []
  );

  for (const obligation of ledger.obligations) {
    const identity = expectedIdentityKey(obligation);
    const matchingExpected = expectedByIdentity.get(identity) ?? [];
    const bijective = matchingExpected.length === 1 && obligationCounts.get(identity) === 1;
    const expected = bijective ? matchingExpected[0] : undefined;
    const selected = selectCurrent(obligation, ledger, expected);
    const reasons = [...selected.reasons];
    if (matchingExpected.length > 0 && !bijective) reasons.push('EXPECTED_PERIOD_NOT_BIJECTIVE');
    // Guarded and bounded: `health` is seller-supplied, so a non-string threw
    // here after receipts had synced, and an arbitrary string was interpolated
    // straight into a reason code.
    if (obligation.health !== 'complete') {
      const health = typeof obligation.health === 'string' ? boundedDiagnostic(obligation.health) : 'UNKNOWN';
      reasons.push(`OBLIGATION_${health.toUpperCase()}`);
    }
    if (selected.materialization?.resource && new Date(selected.materialization.resource.expires_at) <= now)
      reasons.push('RESOURCE_EXPIRED');
    if (
      !obligation.resource_retained_until ||
      (selected.materialization?.resource &&
        Date.parse(selected.materialization.resource.expires_at) < Date.parse(obligation.resource_retained_until))
    ) {
      reasons.push('RESOURCE_RETENTION_MISMATCH');
    }
    if (selected.revision) uniqueRevisions.set(selected.revision.reporting_revision_id, selected.revision);
    if (obligation.reconciliation_mode === 'consumer_receipt' && selected.revision && selected.materialization) {
      const accepted = ledger.receipts.some(receipt =>
        receiptMatches(receipt, selected.revision!, selected.materialization!)
      );
      if (!accepted) reasons.push('MISSING_MATCHING_CONSUMER_RECEIPT');
    }
    obligationResults.push({
      reportingObligationId: obligation.reporting_obligation_id,
      definitive: reasons.length === 0,
      reportingRevisionId: selected.revision?.reporting_revision_id,
      reportingMaterializationId: selected.materialization?.reporting_materialization_id,
      reasons,
    });
  }

  const missingExpectedPeriods = (expectedPeriods ?? []).filter(
    expected => !ledger.obligations.some(obligation => expectedPeriodMatches(expected, obligation, ledger))
  );
  const consumerStatuses = planReportingConsumerStatuses(ledger, expectedPeriods ?? [], missingExpectedPeriods, now);
  const escalations = collectReportingEscalations(ledger, { ...(operationsContact ? { operationsContact } : {}) });
  const scopeDefinitive = ledger.scope.scope_closed && ledger.scope.coverage_complete;
  return {
    definitive:
      expectedPeriods !== undefined &&
      scopeDefinitive &&
      missingExpectedPeriods.length === 0 &&
      obligationResults.every(item => item.definitive),
    ledger,
    obligations: obligationResults,
    missingExpectedPeriods,
    consumerStatuses,
    postedConsumerStatuses: [],
    failedConsumerStatuses: [],
    escalations,
    totalsByRevision: [...uniqueRevisions.values()].map(item => ({
      reportingRevisionId: item.reporting_revision_id,
      rowCount: item.row_count,
      controlTotals: item.control_totals,
      coverageStatus: item.coverage?.status ?? 'unknown',
      coveredPackageIds: item.coverage?.covered_package_ids ?? [],
      packageIds: item.coverage?.package_ids ?? [],
    })),
  };
}

export function buildReportingReceipt(
  context: ReportingInspectionContext,
  observation: ReportingObservation,
  reportingReceiptId = `reporting-receipt:${generateIdempotencyKey()}`,
  observedAt = new Date().toISOString()
): ReportingReceipt {
  const { obligation, revision, materialization } = context;
  if (!materialization.verification || !materialization.resource) {
    throw new ReportingReconciliationError('MATERIALIZATION_NOT_READY', 'cannot receipt an unverified materialization');
  }
  const rejectionCodes: string[] = [];
  if (observation.rowCount !== revision.row_count) rejectionCodes.push('ROW_COUNT_MISMATCH');
  if (!same(normalizedTotals(observation.controlTotals), normalizedTotals(revision.control_totals)))
    rejectionCodes.push('CONTROL_TOTAL_MISMATCH');
  const profile = materialization.verification.verification_profile;
  if (
    profile === 'canonical_digest' &&
    (!revision.canonical_content_digest ||
      !sameCanonicalDigest(observation.canonicalContentDigest, revision.canonical_content_digest))
  ) {
    rejectionCodes.push('CANONICAL_DIGEST_MISMATCH');
  }
  if (
    profile === 'manifest_checksums' &&
    !sameSha256(observation.manifestSha256, materialization.resource.manifest_sha256)
  ) {
    rejectionCodes.push('MANIFEST_DIGEST_MISMATCH');
  }
  if (profile === 'native_commit' && observation.nativeVersionRef !== materialization.resource.native_version_ref) {
    rejectionCodes.push('NATIVE_VERSION_MISMATCH');
  }
  const [firstRejectionCode, ...remainingRejectionCodes] = rejectionCodes;

  return {
    reporting_receipt_id: reportingReceiptId,
    reporting_obligation_id: obligation.reporting_obligation_id,
    reporting_revision_id: revision.reporting_revision_id,
    reporting_materialization_id: materialization.reporting_materialization_id,
    status: rejectionCodes.length === 0 ? 'accepted' : 'rejected',
    verification_profile: profile,
    observed_row_count: observation.rowCount,
    observed_control_totals: observation.controlTotals,
    ...(observation.canonicalContentDigest
      ? { observed_canonical_content_digest: observation.canonicalContentDigest }
      : {}),
    ...(observation.manifestSha256 ? { observed_manifest_sha256: observation.manifestSha256 } : {}),
    ...(observation.nativeVersionRef ? { observed_native_version_ref: observation.nativeVersionRef } : {}),
    ...(observation.consumerCommitRef ? { consumer_commit_ref: observation.consumerCommitRef } : {}),
    ...(firstRejectionCode !== undefined ? { rejection_codes: [firstRejectionCode, ...remainingRejectionCodes] } : {}),
    observed_at: observedAt,
  };
}

async function inspectWithRetry(
  inspect: NonNullable<ReconcileReportingOptions['inspect']>,
  context: ReportingInspectionContext,
  maxAttempts: number,
  retryBaseDelayMs: number
): Promise<ReportingObservation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await inspect(context);
    } catch (error) {
      lastError = error;
      if (error instanceof ReportingInspectionError && !error.retryable) throw error;
      if (attempt < maxAttempts && retryBaseDelayMs > 0) {
        const delayMs = Math.min(retryBaseDelayMs * 2 ** (attempt - 1), 5_000);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  if (lastError instanceof ReportingInspectionError) throw lastError;
  throw new ReportingReconciliationError(
    'INSPECTION_FAILED',
    `materialization inspection failed after ${maxAttempts} attempts`
  );
}

function buildCheckpointKey(
  consumerScope: string,
  accountId: string,
  context: ReportingInspectionContext
): ReportingCheckpointKey {
  return {
    consumerScope,
    accountId,
    reportingObligationId: context.obligation.reporting_obligation_id,
    reportingRevisionId: context.revision.reporting_revision_id,
    reportingMaterializationId: context.materialization.reporting_materialization_id,
    destinationRef: context.materialization.destination_ref,
  };
}

function checkpointMatchesContext(checkpoint: ReportingCheckpoint, context: ReportingInspectionContext): boolean {
  const { receipt } = checkpoint;
  return Boolean(
    checkpoint.receiptSyncIdempotencyKey &&
    checkpoint.contextFingerprint === checkpointContextFingerprint(context) &&
    context.materialization.verification &&
    receipt.reporting_obligation_id === context.obligation.reporting_obligation_id &&
    receipt.reporting_revision_id === context.revision.reporting_revision_id &&
    receipt.reporting_materialization_id === context.materialization.reporting_materialization_id &&
    receipt.verification_profile === context.materialization.verification.verification_profile
  );
}

function checkpointContextFingerprint(context: ReportingInspectionContext): string {
  return createHash('sha256').update(canonical(context)).digest('hex');
}

export async function reconcileReporting<TCredential = unknown>(
  options: ReconcileReportingOptions<TCredential>
): Promise<ReportingReconciliationResult> {
  // Receipts accepted by the seller are recorded here as they land, so a later
  // failure — most importantly the ledger re-read that happens *after* the
  // writes — can hand them back on the error instead of losing them. Without
  // this the caller could not tell "nothing was written" from "receipts are at
  // the seller and the reload failed", which is the difference between starting
  // over and retrying.
  const synced: ReportingReceipt[] = [];
  try {
    return await runReconcileReporting(options, synced);
  } catch (error) {
    throw withSubmittedReceipts(error, synced);
  }
}

async function runReconcileReporting<TCredential = unknown>(
  options: ReconcileReportingOptions<TCredential>,
  synced: ReportingReceipt[]
): Promise<ReportingReconciliationResult> {
  if (
    !options.inspect &&
    (!options.resourceReader || !options.manifestInspectorOptions?.referenceAllowedOrigins?.length)
  ) {
    throw new ReportingReconciliationError(
      'INSPECTOR_CONFIGURATION_REQUIRED',
      'Built-in inspection requires resourceReader and consumer-approved reference origins'
    );
  }
  if (options.checkpointStore && !options.checkpointScope) {
    throw new ReportingReconciliationError(
      'CHECKPOINT_SCOPE_REQUIRED',
      'checkpointStore requires a stable seller and authenticated-principal scope'
    );
  }
  const maxInspectionAttempts = options.maxInspectionAttempts ?? 3;
  const inspectionRetryBaseDelayMs = options.inspectionRetryBaseDelayMs ?? 100;
  if (!Number.isSafeInteger(maxInspectionAttempts) || maxInspectionAttempts < 1 || maxInspectionAttempts > 10) {
    throw new ReportingReconciliationError(
      'INVALID_INSPECTION_RETRY_POLICY',
      'maxInspectionAttempts must be an integer from 1 through 10'
    );
  }
  if (
    !Number.isSafeInteger(inspectionRetryBaseDelayMs) ||
    inspectionRetryBaseDelayMs < 0 ||
    inspectionRetryBaseDelayMs > 60_000
  ) {
    throw new ReportingReconciliationError(
      'INVALID_INSPECTION_RETRY_POLICY',
      'inspectionRetryBaseDelayMs must be an integer from 0 through 60000'
    );
  }
  let ledger = await loadReportingLedger(
    options.client,
    options.request,
    options.maxSnapshotRestarts,
    options.ledgerLimits
  );
  const newReceipts: ReportingReceipt[] = [];
  const pendingSubmissions: Array<{ receipt: ReportingReceipt; idempotencyKey: string }> = [];
  const inspect =
    options.inspect ??
    (options.resourceReader
      ? createReportingManifestInspector({
          ...options.manifestInspectorOptions,
          reader: options.resourceReader,
          credentialProvider: options.credentialProvider,
        })
      : undefined);
  const { expectedByIdentity, obligationCounts } = buildExpectedIdentityIndex(
    ledger.obligations,
    options.expectedPeriods
  );

  for (const obligation of ledger.obligations) {
    if (obligation.reconciliation_mode !== 'consumer_receipt') continue;
    const identity = expectedIdentityKey(obligation);
    const matches = expectedByIdentity.get(identity) ?? [];
    if (matches.length !== 1 || obligationCounts.get(identity) !== 1) continue;
    const expected = matches[0]!;
    const selected = selectCurrent(obligation, ledger, expected);
    if (!selected.revision || !selected.materialization || selected.reasons.length) continue;
    if (ledger.receipts.some(receipt => receiptMatches(receipt, selected.revision!, selected.materialization!)))
      continue;
    if (!inspect) {
      throw new ReportingReconciliationError(
        'INSPECTOR_REQUIRED',
        'Provide inspect or resourceReader for consumer-receipt reconciliation'
      );
    }

    const context = {
      obligation,
      revision: selected.revision,
      materialization: selected.materialization,
      expected: expected!,
    };
    const checkpointKey = buildCheckpointKey(options.checkpointScope ?? 'ephemeral', ledger.accountId, context);
    let checkpoint = await options.checkpointStore?.get(checkpointKey);
    if (!checkpoint || !checkpointMatchesContext(checkpoint, context)) {
      let receipt: ReportingReceipt;
      try {
        const observation = await inspectWithRetry(inspect, context, maxInspectionAttempts, inspectionRetryBaseDelayMs);
        receipt = buildReportingReceipt(context, observation);
      } catch (error) {
        if (!(error instanceof ReportingInspectionError) || error.retryable || !error.observation) throw error;
        receipt = buildReportingReceipt(context, error.observation);
        if (receipt.status !== 'rejected') throw error;
      }
      checkpoint = {
        receipt,
        receiptSyncIdempotencyKey: generateIdempotencyKey(),
        contextFingerprint: checkpointContextFingerprint(context),
      };
      await options.checkpointStore?.put(checkpointKey, checkpoint);
    }
    newReceipts.push(checkpoint.receipt);
    pendingSubmissions.push({ receipt: checkpoint.receipt, idempotencyKey: checkpoint.receiptSyncIdempotencyKey });
  }

  for (const submission of pendingSubmissions) {
    const receiptDeadline = Date.now() + (options.ledgerLimits?.maxLoadMs ?? 60_000);
    const response = await callBeforeDeadline(
      signal =>
        options.client.syncReportingReceipts(
          {
            account: options.request.account,
            idempotency_key: submission.idempotencyKey,
            receipts: [submission.receipt],
          },
          { signal }
        ),
      receiptDeadline,
      'RECEIPT_WRITE_FAILED',
      'sync_reporting_receipts exceeded the reporting request deadline'
    );
    const results = response.status === 'completed' && Array.isArray(response.results) ? response.results : [];
    const result = results[0] as { result?: string; receipt?: ReportingReceipt } | undefined;
    const acknowledgedReceipt = result?.receipt;
    const withoutReceivedAt = (receipt: ReportingReceipt): Omit<ReportingReceipt, 'received_at'> => {
      const { received_at: _receivedAt, ...immutable } = receipt;
      return immutable;
    };
    if (
      results.length !== 1 ||
      !result ||
      !['recorded', 'unchanged'].includes(result.result ?? '') ||
      !acknowledgedReceipt ||
      !same(withoutReceivedAt(acknowledgedReceipt), withoutReceivedAt(submission.receipt))
    )
      throw new ReportingReconciliationError(
        'RECEIPT_WRITE_FAILED',
        'seller did not return one matching successful receipt acknowledgement'
      );
    // Acknowledged `recorded` or `unchanged`, so it is durably at the seller.
    synced.push(submission.receipt);
  }
  if (pendingSubmissions.length) {
    ledger = await loadReportingLedger(
      options.client,
      options.request,
      options.maxSnapshotRestarts,
      options.ledgerLimits
    );
  }

  // One clock for the whole run: planning, attestation and every timestamp the
  // buyer puts its name to come from here.
  const now = options.now ?? new Date();
  const evaluated = evaluateReportingLedger(ledger, options.expectedPeriods, now, options.operationsContact);

  // rc.3 buyer duty: a current status is owed by `expected_at` plus the
  // seller's advertised recovery window — not merely before the scope closes.
  // Only overdue statuses are posted; posting early would churn the chain for
  // periods the buyer may still resolve on its own.
  // One budget across every revision this run. When it runs out the remaining
  // revisions are left unread rather than accused: `unreadable` says the seller
  // advertised bytes the buyer could not consume, and a buyer that stopped
  // reading to stay inside its own limit has not established that.
  const readDeadline = Date.now() + (options.ledgerLimits?.maxLoadMs ?? 60_000);
  const attested: ReportingConsumerStatusPlanV1[] = [];
  let budgetExhausted = false;
  for (const plan of evaluated.consumerStatuses) {
    if (!plan.overdue) {
      attested.push(plan);
      continue;
    }
    // A plan suppressed before attestation is not going to be posted whatever
    // the read says, so reading would only spend the shared budget that later
    // revisions need. `unchanged` is deliberately *not* decided before
    // attestation — that comparison includes the recomputed digest, which is
    // how a revision rewritten under a stable id gets caught.
    if (plan.suppressed !== undefined) {
      attested.push(plan);
      continue;
    }
    if (budgetExhausted || (plan.requiresConsumption && Date.now() >= readDeadline)) {
      attested.push(
        plan.requiresConsumption
          ? {
              ...plan,
              suppressed: 'local_budget_exhausted' as const,
              reason: suppressionReason('local_budget_exhausted', plan.reason),
            }
          : plan
      );
      continue;
    }
    const next = await attestConsumerStatusPlan(plan, ledger, options, readDeadline, now);
    // Only the shared wall-clock budget stops the loop; a per-revision page or
    // record limit is that revision's problem alone.
    if (next.suppressed === 'local_budget_exhausted' && next.budgetScope === 'run') budgetExhausted = true;
    const { budgetScope: _scope, budgetLimit: _limit, ...carried } = next;
    attested.push(carried);
  }
  const consumerStatuses = attested;
  const postedConsumerStatuses: ReportingConsumerStatusPlanV1[] = [];
  const failedConsumerStatuses: ReportingReconciliationResult['failedConsumerStatuses'] = [];
  const confirmed: ReportingPendingConsumerStatusKey[] = [];
  // `batch_identity`: "A batch MUST contain at most one statement for each
  // logical chain ... sellers reject every duplicate-chain entry in that batch
  // without evaluating their supersession order." Two expected periods can
  // differ on fields the chain key does not carry (destination, feed purpose,
  // coverage) and still collapse onto one chain, so posting both guarantees
  // that neither lands — every run, forever.
  // A missing poster is a reason for silence exactly as a missing reader is.
  // Without this the plan comes back live, due and unsuppressed while going
  // nowhere — the one no-op an adopter has no way to see.
  if (!options.client.syncReportingStatus) {
    for (const [index, plan] of consumerStatuses.entries()) {
      if (!plan.overdue || plan.suppressed !== undefined) continue;
      consumerStatuses[index] = {
        ...plan,
        suppressed: 'posting_unavailable',
        reason: suppressionReason('posting_unavailable', plan.reason),
      };
    }
  }
  const owed: ReportingConsumerStatusPlanV1[] = [];
  const claimedChains = new Set<string>();
  for (const plan of consumerStatuses) {
    if (!plan.overdue || plan.suppressed !== undefined) continue;
    const chain = canonical(pendingConsumerStatusKey(ledger.accountId, plan));
    if (claimedChains.has(chain)) {
      failedConsumerStatuses.push({
        plan,
        errors: [
          {
            code: 'DUPLICATE_STATUS_CHAIN',
            message:
              'two expected periods resolve to one consumer-status chain; a batch may carry at most one statement per chain',
          },
        ],
      });
      continue;
    }
    claimedChains.add(chain);
    owed.push(plan);
  }
  if (owed.length > 0 && options.client.syncReportingStatus) {
    // One batch per request, up to the schema's maxItems, each with its own
    // budget — matching the receipt path. A single budget shared across every
    // batch exhausts mid-loop on a backlog first run, which is precisely when
    // there are most statuses to post.
    for (let offset = 0; offset < owed.length; offset += CONSUMER_STATUS_BATCH_MAX) {
      const batch = owed.slice(offset, offset + CONSUMER_STATUS_BATCH_MAX);
      const deadline = Date.now() + (options.ledgerLimits?.maxLoadMs ?? 60_000);
      // A statement already built for this exact claim is replayed verbatim.
      // Rebuilding it would re-derive `status_as_of` from the buyer's clock,
      // and a body that changed under a stable claim is what turns a retry into
      // an idempotency conflict.
      const wireStatuses: Record<string, unknown>[] = [];
      // Parallel to `wireStatuses`: the plan each one actually carries, which
      // is not always the freshly re-planned object.
      const posted: ReportingConsumerStatusPlanV1[] = [];
      for (const plan of batch) {
        const key = pendingConsumerStatusKey(ledger.accountId, plan);
        const fingerprint = consumerStatusClaimFingerprint(plan);
        const pending = await options.pendingConsumerStatusStore?.get(key);
        // A stored blob is durable state from an earlier process. Replaying it
        // unchecked would bypass every guard in `wireConsumerStatus` and post
        // whatever the store happens to hold, so it is re-verified against the
        // plan it stands in for. The posted record also takes the replayed
        // body's `status_as_of`, so the result reports what went on the wire
        // rather than the instant this run happened to re-derive.
        if (pending && pending.claimFingerprint === fingerprint && replayMatchesPlan(pending.statement, plan, now)) {
          wireStatuses.push(pending.statement);
          // The replayed values, not the freshly re-planned ones: reporting the
          // recomputed digest while the wire carried the stored one made the
          // result lie about what it posted.
          posted.push({
            ...plan,
            statusAsOf: String(pending.statement.status_as_of),
            ...(typeof pending.statement.observed_revision_content_sha256 === 'string'
              ? { observedRevisionContentSha256: pending.statement.observed_revision_content_sha256 }
              : {}),
          });
          continue;
        }
        const statement = wireConsumerStatus(plan);
        await options.pendingConsumerStatusStore?.put(key, { statement, claimFingerprint: fingerprint });
        wireStatuses.push(statement);
        posted.push(plan);
      }
      // A batch that fails is recorded and ends the loop rather than thrown.
      // Throwing from the second batch discarded the record of everything the
      // first one had already appended — statements that are durably the
      // caller's current leaves whether or not this function returns.
      let response;
      try {
        response = await callBeforeDeadline(
          signal =>
            options.client.syncReportingStatus!(
              {
                ...(options.request.account ? { account: options.request.account } : {}),
                idempotency_key: consumerStatusBatchKey(wireStatuses),
                statuses: wireStatuses,
              },
              { signal }
            ),
          deadline,
          'CONSUMER_STATUS_WRITE_FAILED',
          'sync_reporting_status exceeded the reporting request deadline'
        );
      } catch (error) {
        recordConsumerStatusBatchFailure(
          failedConsumerStatuses,
          posted.length === batch.length ? posted : batch,
          boundedDiagnostic(error instanceof Error ? error.message : 'sync_reporting_status failed')
        );
        break;
      }
      const results = Array.isArray(response.results) ? response.results : [];
      if (response.status !== 'completed' || results.length !== batch.length) {
        recordConsumerStatusBatchFailure(
          failedConsumerStatuses,
          batch,
          'seller did not return one result per submitted consumer status'
        );
        break;
      }
      // Partial success: each status is independent, so a failed sibling must
      // not be reported as posted and must not discard its successful peers.
      // A rejection is carried out with its errors rather than dropped — a
      // buyer that silently loses one believes it discharged a duty it did not.
      posted.forEach((plan, index) => {
        const result = results[index] as
          | { result?: string; reporting_status_id?: unknown; errors?: unknown }
          | undefined;
        if (result && ['recorded', 'unchanged'].includes(result.result ?? '')) {
          postedConsumerStatuses.push(plan);
          // Confirmed durable at the seller, so it is no longer pending. A
          // failure deliberately leaves it, because the next run must retry
          // that exact statement rather than mint a competing one.
          confirmed.push(pendingConsumerStatusKey(ledger.accountId, plan));
          return;
        }
        failedConsumerStatuses.push({
          plan,
          ...(typeof result?.reporting_status_id === 'string' ? { reportingStatusId: result.reporting_status_id } : {}),
          // Bounded: seller objects of arbitrary size and shape that land
          // wherever the adopter logs its reconciliation result.
          errors: Array.isArray(result?.errors) ? result.errors.slice(0, 16) : [],
        });
      });
    }
  }

  for (const key of confirmed) await options.pendingConsumerStatusStore?.clear(key);

  const consumerStatusPending = await readReportingConsumerStatusPending(options);

  return {
    ...evaluated,
    consumerStatuses,
    submittedReceipts: newReceipts,
    postedConsumerStatuses,
    failedConsumerStatuses,
    ...(consumerStatusPending !== undefined ? { consumerStatusPending } : {}),
  };
}

/** Evidence that the buyer itself read the exact revision the seller requires. */
interface ConsumedReportingRevisionV1 {
  /** SHA-256 of RFC 8785 JCS over the binding object, recomputed locally. */
  digest: string;
  /** When this consumer finished consuming it — buyer-attributed arrival evidence. */
  consumedAt: string;
  rowCount: number;
  /** The complete ordered row sequence, concatenated across every cursor page. */
  rows: readonly unknown[];
}

interface UnconsumableReportingRevisionV1 {
  failureCode: NonNullable<ReportingConsumerStatusPlanV1['failureCode']>;
  detail: string;
}

/**
 * The buyer ran out of its own budget. Not a seller failure and therefore not
 * a `failure_code` — the caller stays silent for this revision this run.
 *
 * The scope matters. `run` is the wall-clock budget, which is genuinely shared,
 * so nothing after it can succeed either and the loop stops. `revision` is a
 * per-revision page or record limit that resets on the next call: latching on
 * it would let one pathologically paginating revision starve every revision
 * ordered after it, run after run, without a single read being attempted.
 */
interface ExhaustedReportingReadBudgetV1 {
  budgetExhausted: 'run' | 'revision';
  /**
   * The ceiling that was actually reached, as an adopter-facing phrase.
   *
   * Rendered into `reason`. A single "your `ledgerLimits` ran out" sentence
   * covered every producer, including `maxRevisionBytes`, which the caller may
   * only tighten — so the advice was wrong for the one ceiling an adopter
   * cannot raise.
   */
  budgetLimit: string;
}

/**
 * Complete a planned `received` / `content_mismatch` by actually consuming the
 * revision, or downgrade it to the `unreadable` it turned out to be.
 *
 * Nothing here trusts the ledger's own `revision_content_sha256`: the whole
 * evidentiary value of `observed_revision_content_sha256` is that the consumer
 * recomputed it. A revision the buyer cannot read is `unreadable`, and one
 * whose bytes do not hash to what the seller published is
 * `unreadable`/`integrity_mismatch` — not a `content_mismatch`, because a
 * `content_mismatch` has to name the exact bytes it disagrees with.
 */
async function attestConsumerStatusPlan(
  plan: ReportingConsumerStatusPlanV1,
  ledger: ReportingLedger,
  options: ReconcileReportingOptions,
  deadline: number,
  now: Date
): Promise<AttestedConsumerStatusPlan> {
  if (!plan.requiresConsumption || !plan.reportingRevisionId) return plan;
  if (!options.client.getMediaBuyDelivery) {
    return {
      ...plan,
      suppressed: 'consumption_unavailable',
      reason: suppressionReason('consumption_unavailable', plan.reason),
    };
  }

  const outcome = await consumeReportingRevision(options, plan.reportingRevisionId, deadline, now);
  const leaf = currentConsumerLeaf(ledger, plan, plan.supersedesReportingStatusId);

  if ('budgetExhausted' in outcome) {
    return {
      ...plan,
      suppressed: 'local_budget_exhausted',
      reason: suppressionReason(
        'local_budget_exhausted',
        `${outcome.budgetLimit} was reached before the revision could be consumed`
      ),
      budgetScope: outcome.budgetExhausted,
      budgetLimit: outcome.budgetLimit,
    };
  }

  if ('failureCode' in outcome) {
    return withSuppression(
      {
        ...plan,
        consumerStatus: 'unreadable',
        failureCode: outcome.failureCode,
        mismatchCode: undefined,
        observedRevisionContentSha256: undefined,
        requiresConsumption: false,
        statusAsOf: latestInstant([now.toISOString(), plan.statusAsOfFloor]) ?? plan.statusAsOfFloor,
        reason: outcome.detail,
      },
      leaf
    );
  }

  // The ledger's declared digest and the recomputed one must agree. When they
  // do not, the buyer cannot say which bytes the seller currently requires, so
  // it reports the integrity failure rather than picking one.
  const declared = ledger.revisions.find(
    revision => revision.reporting_revision_id === plan.reportingRevisionId
  )?.revision_content_sha256;
  if (declared !== undefined && !sameSha256(outcome.digest, declared)) {
    return withSuppression(
      {
        ...plan,
        consumerStatus: 'unreadable',
        failureCode: 'integrity_mismatch',
        mismatchCode: undefined,
        observedRevisionContentSha256: undefined,
        requiresConsumption: false,
        statusAsOf: latestInstant([outcome.consumedAt, plan.statusAsOfFloor]) ?? plan.statusAsOfFloor,
        reason: 'the consumed rows do not hash to the revision_content_sha256 the ledger declares',
      },
      leaf
    );
  }

  // Now that rows are in hand, re-run detection with the row evidence the
  // planner could not have. Four of the six codes are row-level predicates, so
  // without this pass they are unreachable through the reconciler no matter
  // what the seller published.
  const expected = options.expectedPeriods.find(
    candidate =>
      candidate.deliveryConfigId === plan.deliveryConfigId &&
      candidate.deliveryConfigVersion === plan.deliveryConfigVersion &&
      candidate.reportDefinitionId === plan.reportDefinitionId &&
      candidate.periodStart === plan.period.start &&
      candidate.periodEnd === plan.period.end
  );
  const obligation = ledger.obligations.find(
    candidate => candidate.reporting_obligation_id === plan.reportingObligationId
  );
  const revision = ledger.revisions.find(candidate => candidate.reporting_revision_id === plan.reportingRevisionId);
  const mismatch =
    expected && obligation && revision
      ? detectReportingContentMismatch(
          contractFactsFor(obligation, expected),
          revision,
          rowEvidenceFor(contractFactsFor(obligation, expected), revision, outcome.rows)
        )
      : undefined;

  return withSuppression(
    {
      ...plan,
      consumerStatus: mismatch ? 'content_mismatch' : 'received',
      mismatchCode: mismatch?.mismatchCode,
      observedRevisionContentSha256: outcome.digest,
      requiresConsumption: false,
      // `status_as_of` is when the revision became consumable to *this*
      // consumer, floored by the superseded leaf so the chain never moves
      // backwards.
      statusAsOf: latestInstant([outcome.consumedAt, plan.statusAsOfFloor]) ?? plan.statusAsOfFloor,
      reason: mismatch?.detail ?? 'the exact revision content was consumed and honors every frozen contract fact',
    },
    leaf
  );
}

/**
 * A plan plus the internal note of *which* budget ran out, so the caller can
 * tell a shared wall-clock budget from a per-revision page limit. Stripped
 * before the plan reaches the result: it is loop bookkeeping, not a claim.
 */
type AttestedConsumerStatusPlan = ReportingConsumerStatusPlanV1 & {
  budgetScope?: 'run' | 'revision';
  budgetLimit?: string;
};

/** Re-apply the unchanged/undisclosed test after a plan's meaning has changed. */
function withSuppression(plan: ReportingConsumerStatusPlanV1, leaf: ConsumerStatusLeaf): ReportingConsumerStatusPlanV1 {
  const suppressed = consumerStatusSuppression(plan, leaf);
  if (suppressed) return { ...plan, suppressed, reason: suppressionReason(suppressed, plan.reason) };
  const { suppressed: _cleared, ...unsuppressed } = plan;
  return unsuppressed;
}

/**
 * Page every row of one exact revision and recompute its Core binding digest.
 *
 * `reporting_revision_binding` repeats on every page and binds "the complete
 * ordered reporting_rows sequence obtained by concatenating every cursor page",
 * so the digest is only meaningful once the last page is in hand.
 */
async function consumeReportingRevision(
  options: ReconcileReportingOptions,
  reportingRevisionId: string,
  deadline: number,
  now: Date
): Promise<ConsumedReportingRevisionV1 | UnconsumableReportingRevisionV1 | ExhaustedReportingReadBudgetV1> {
  const read = options.client.getMediaBuyDelivery!;
  const maxPages = options.ledgerLimits?.maxPages ?? 1_000;
  // Clamped on re-read, not merely validated on entry: a side-effecting getter
  // can pass validation with a small value and return `MAX_SAFE_INTEGER` here.
  const maxRows = revisionRowCeiling(options.ledgerLimits);
  const maxBytes = revisionByteCeiling(options.ledgerLimits);
  const rows: unknown[] = [];
  let bytes = 0;
  let totalCount: number | undefined;
  const seenCursors = new Set<string>();
  let binding:
    | {
        reporting_revision_id?: string;
        row_count?: number;
        control_totals?: ReportingControlTotal[];
        content_sha256?: string;
      }
    | undefined;
  let cursor: string | undefined;
  let pages = 0;

  try {
    do {
      pages += 1;
      if (pages > maxPages) return { budgetExhausted: 'revision', budgetLimit: 'ledgerLimits.maxPages' };
      const response = await callBeforeDeadline(
        signal =>
          read(
            {
              ...(options.request.account ? { account: options.request.account } : {}),
              reporting_revision_id: reportingRevisionId,
              ...(cursor ? { pagination: { cursor } } : {}),
            },
            { signal }
          ),
        deadline,
        'CONSUMER_STATUS_READ_FAILED',
        'get_media_buy_delivery exceeded the reporting request deadline'
      );
      if (response.status !== undefined && response.status !== 'completed') {
        return { failureCode: 'reader_incompatible', detail: 'the exact-revision read did not complete' };
      }
      const page = response.reporting_revision_binding;
      if (
        !page ||
        page.reporting_revision_id !== reportingRevisionId ||
        typeof page.content_sha256 !== 'string' ||
        typeof page.row_count !== 'number' ||
        !Array.isArray(page.control_totals)
      ) {
        return {
          failureCode: 'reader_incompatible',
          detail: 'the seller did not return a reporting_revision_binding for the exact revision requested',
        };
      }
      if (binding && !same(binding, page)) {
        return { failureCode: 'integrity_mismatch', detail: 'the revision binding changed between cursor pages' };
      }
      binding = page;
      if (typeof response.pagination?.total_count === 'number') totalCount = response.pagination.total_count;
      // Bounded by size as well as by count: 100,000 rows is a count budget a
      // ten-kilobyte row walks straight through, and everything here is
      // accumulated in memory and then serialized again by `canonicalize`.
      for (const row of response.reporting_rows ?? []) {
        rows.push(row);
        const sized = approximateRowBytes(row);
        if (sized === TOO_DEEP_TO_SIZE) {
          // Depth is the seller's shape. Charging it to the buyer's budget
          // would suppress the whole period, letting an under-delivering seller
          // escape a `content_mismatch` permanently for the price of one small
          // strange row — so this side of the split accuses instead.
          return {
            failureCode: 'reader_incompatible',
            detail: 'a revision row nests deeper than this reader will walk',
          };
        }
        if (sized === undefined) {
          // Accused, not suppressed — the same side as depth, and for the same
          // reason. An earlier version called this "the buyer's own walk bound"
          // and pointed the adopter at `ledgerLimits`, but the bound is a
          // hardcoded constant no knob raises, and a *quarter of a million
          // containers in one row* is not a shape any conformant tabular report
          // has: an array of a hundred thousand numbers is one container. On
          // the silent side it was a measured 786 KB purchase of permanent
          // immunity from `content_mismatch`.
          return {
            failureCode: 'reader_incompatible',
            detail: `a revision row describes more than ${MAX_ROW_ESTIMATE_CONTAINERS} containers, which this reader will not walk`,
          };
        }
        bytes += sized;
        if (rows.length > maxRows) {
          return { budgetExhausted: 'revision', budgetLimit: 'ledgerLimits.maxRevisionRows' };
        }
        if (bytes > maxBytes) {
          return {
            budgetExhausted: 'revision',
            budgetLimit:
              maxBytes < MAX_CONSUMED_REVISION_BYTES
                ? 'ledgerLimits.maxRevisionBytes'
                : `this SDK's ${MAX_CONSUMED_REVISION_BYTES}-byte per-revision ceiling, which maxRevisionBytes can only tighten`,
          };
        }
      }
      if (response.pagination?.has_more) {
        const next = response.pagination.cursor;
        if (!next || seenCursors.has(next)) {
          return { failureCode: 'transport_failed', detail: 'revision row pagination did not advance' };
        }
        seenCursors.add(next);
        cursor = next;
      } else {
        cursor = undefined;
      }
    } while (cursor);
  } catch (error) {
    // The reconciler's own deadline is not the seller's fault; anything else is
    // a read that genuinely failed. Either way the provider's error body stays
    // out of the diagnostic: it is untrusted text, and the wire carries a
    // closed `failure_code` precisely so agents dispatch on the code.
    if (error instanceof ReportingReconciliationError && error.code === 'CONSUMER_STATUS_READ_FAILED') {
      return { budgetExhausted: 'run', budgetLimit: 'ledgerLimits.maxLoadMs' };
    }
    return { failureCode: 'transport_failed', detail: 'the exact-revision read failed before the rows were complete' };
  }

  // The run's own clock, not a second one: `options.now` is where every other
  // instant in this reconcile comes from, and a statement dated off a different
  // clock cannot be reasoned about against the leaf it supersedes.
  const consumedAt = now.toISOString();
  if (!binding) {
    return { failureCode: 'reader_incompatible', detail: 'the exact-revision read returned no binding' };
  }
  if (totalCount !== undefined && totalCount !== binding.row_count) {
    return {
      failureCode: 'integrity_mismatch',
      detail: `the read declares ${totalCount} total rows and the binding declares ${binding.row_count}`,
    };
  }
  if (rows.length !== binding.row_count) {
    return {
      failureCode: 'integrity_mismatch',
      detail: `the revision declares ${binding.row_count} rows and the read returned ${rows.length}`,
    };
  }
  let digest: string;
  try {
    // Inside the guard: `canonicalize` builds the whole binding object as one
    // string, and a `RangeError` escaping here would abort `reconcileReporting`
    // outright, discarding receipts and statuses this run already appended.
    digest = createHash('sha256')
      .update(
        canonicalize({
          reporting_revision_id: reportingRevisionId,
          row_count: binding.row_count,
          control_totals: binding.control_totals,
          reporting_rows: rows,
        }),
        'utf8'
      )
      .digest('hex');
  } catch (error) {
    // Never rethrow. The only caller does not catch, so an escape here aborts
    // `reconcileReporting` after it has already synced receipts — losing the
    // caller's record of durable work, which is the hazard this guard exists
    // for. And the trigger is wire-reachable: `JSON.parse('1e999')` is
    // `Infinity`, which `canonicalize` rejects, so one seller-supplied number
    // is enough.
    //
    // A `RangeError` is a size failure — the canonical string exceeding the
    // engine's limit, or a nesting depth exceeding the stack — so it is the
    // buyer's own ceiling and stays silent. Anything else is content this
    // reader cannot digest, which is what `reader_incompatible` names.
    //
    // No reachable trigger for the `RangeError` arm is known today: the byte
    // ceiling pre-empts the string limit and `MAX_ROW_ESTIMATE_DEPTH`
    // pre-empts the stack, so an 8,000-deep row never reaches `canonicalize`.
    // It is kept because the alternative if one is ever found is aborting a
    // reconcile that already synced receipts, and it is deliberately not
    // claimed as tested.
    if (error instanceof RangeError)
      return { budgetExhausted: 'revision', budgetLimit: "this runtime's own size limit for the canonical form" };
    // The message is this SDK's own canonicalizer talking, not a provider
    // response body, so carrying it is safe and it is the only clue a genuine
    // defect leaves. `detail` stays local — the wire carries the closed code.
    const detail = error instanceof Error ? boundedDiagnostic(error.message) : '';
    return {
      failureCode: 'reader_incompatible',
      detail: detail
        ? `the revision rows could not be canonicalized: ${detail}`
        : 'the revision rows could not be canonicalized',
    };
  }
  if (!sameSha256(digest, binding.content_sha256)) {
    return {
      failureCode: 'integrity_mismatch',
      detail: 'the recomputed revision binding digest does not match the content_sha256 the seller published',
    };
  }
  return { digest, consumedAt, rowCount: rows.length, rows };
}

/** Hard bound on rows accumulated from one revision read. */
const MAX_CONSUMED_REVISION_ROWS = 10_000_000;

/** The caller's row ceiling, never above the SDK's own — see the byte twin. */
function revisionRowCeiling(limits: ReportingLedgerLimits | undefined): number {
  const requested = limits?.maxRevisionRows;
  return typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, MAX_CONSUMED_REVISION_ROWS)
    : 100_000;
}

/**
 * The caller's byte ceiling, never above the SDK's own.
 *
 * `loadReportingLedger` refuses a value above `MAX_CONSUMED_REVISION_BYTES`
 * outright, and `reconcileReporting` always calls it before any read, so this
 * clamp has no reachable path today and is deliberately not claimed as tested.
 * It is kept because the ceiling bounds this process's memory, which is not the
 * caller's to spend, and this is the only place that decision is enforced if a
 * future caller reaches the read without the validation.
 */
function revisionByteCeiling(limits: ReportingLedgerLimits | undefined): number {
  const requested = limits?.maxRevisionBytes;
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_CONSUMED_REVISION_BYTES)
    : MAX_CONSUMED_REVISION_BYTES;
}

/** Sentinel for a row too deeply nested to walk. Never a byte count. */
const TOO_DEEP_TO_SIZE = -1;

/**
 * Cheap upper bound on a row's in-memory cost.
 *
 * Deliberately approximate and deliberately cheap: the point is to stop an
 * unbounded accumulation, not to measure it, and a serializing measurement
 * would itself be the cost being guarded against.
 *
 * Returns `TOO_DEEP_TO_SIZE` for a row that nests past
 * `MAX_ROW_ESTIMATE_DEPTH`, `undefined` for one that exceeds
 * `MAX_ROW_ESTIMATE_CONTAINERS`, and a byte estimate otherwise. The caller
 * treats those three answers differently, and states why where it decides.
 */
function approximateRowBytes(row: unknown): number | undefined {
  // Strings and primitives are sized in O(1) and never consume budget: they
  // carry the bytes, and charging them a flat constant is what created both
  // failure directions. Only *containers* are budgeted, because they are what
  // makes the walk expensive.
  //
  // Depth returns `TOO_DEEP_TO_SIZE` and breadth returns `undefined`; the
  // caller decides what each means, and states the trade-off where the
  // decision is made.
  let containers = MAX_ROW_ESTIMATE_CONTAINERS;
  const visit = (value: unknown, depth: number): number | undefined => {
    // Per-value floors, sized against *retained heap* rather than wire bytes —
    // the ceiling exists to bound memory, and a two-byte `0,` on the wire is
    // eight bytes in an array slot. The previous shape charged an empty string
    // zero, so hundreds of megabytes of them slipped past the ceiling
    // entirely; that was the real hole. The constants are reasoned from V8's
    // object and slot layout rather than measured, so treat them as an
    // ordering — every value costs something, containers cost more than the
    // values they hold — and not as a byte-accurate figure. What is pinned by
    // test is that ordering: `maxRevisionBytes` exists so an adopter can
    // exercise the ceiling, and a row of empty strings has to reach it.
    if (typeof value === 'string') return 16 + value.length * 2;
    if (value === null || typeof value !== 'object') return 8;
    // Depth and breadth are both the seller's shape, reported rather than
    // suppressed, and they are still separate answers because the diagnostics
    // differ. No conformant tabular row nests 64 deep, and none describes a
    // quarter of a million containers either — an array of a hundred thousand
    // numbers is one container, so the bound is far from any real row.
    if (depth >= MAX_ROW_ESTIMATE_DEPTH) return TOO_DEEP_TO_SIZE;
    containers -= 1;
    if (containers < 0) return undefined;
    if (Array.isArray(value)) {
      let total = 40 + 8 * value.length;
      for (const item of value) {
        const child = visit(item, depth + 1);
        if (child === undefined || child === TOO_DEEP_TO_SIZE) return child;
        total += child;
      }
      return total;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    let total = 40 + 8 * entries.length;
    for (const [key, child] of entries) {
      const sized = visit(child, depth + 1);
      if (sized === undefined || sized === TOO_DEEP_TO_SIZE) return sized;
      total += key.length * 2 + sized;
    }
    return total;
  };
  return visit(row, 0);
}

/**
 * What the buyer's reader observed in the rows it just consumed.
 *
 * Only `observedMetricNames` is derived, and only when the buyer pinned
 * `committedMetrics`. The other three row-level predicates would need the
 * profile's own row shape — which media buy a row belongs to, which time
 * dimension the pinned grain declares, whether the rows validate against the
 * pinned schema — and guessing at any of them risks a false `content_mismatch`,
 * which pins the caller's view at `action_required` until the buyer backs down.
 *
 * Even the metric derivation is deliberately timid: a metric counts as present
 * if any row carries it at top level or under `totals` (the shape the reporting
 * profile's own control totals are computed from), **or** if the revision
 * declares a control total for it. A metric absent from every one of those is
 * absent in any reading.
 */
function rowEvidenceFor(
  facts: ReportingContractFactsV1,
  revision: ManagedReportingRevision,
  rows: readonly unknown[]
): ReportingRowEvidenceV1 {
  if (!facts.committedMetrics) return {};
  const observed = new Set((revision.control_totals ?? []).map(total => total.name));
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  for (const row of rows) {
    const fields = record(row);
    if (!fields) continue;
    for (const key of Object.keys(fields)) observed.add(key);
    const totals = record(fields.totals);
    if (totals) for (const key of Object.keys(totals)) observed.add(key);
  }
  return { observedMetricNames: [...observed] };
}

/**
 * Whether a remembered statement still describes the plan it is replayed for.
 *
 * The claim fingerprint already covers the semantic fields; this re-checks them
 * on the serialized statement itself, so a store entry that was corrupted,
 * crossed between tenants, or written by a different version cannot be posted
 * as this buyer's durable claim.
 */
const REPLAYABLE_STATEMENT_KEYS = new Set([
  'reporting_status_id',
  'supersedes_reporting_status_id',
  'delivery_config_id',
  'delivery_config_version',
  'report_definition_id',
  'period',
  'consumer_status',
  'status_as_of',
  'reporting_obligation_id',
  'reporting_revision_id',
  'observed_revision_content_sha256',
  'mismatch_code',
  'failure_code',
]);

function replayMatchesPlan(
  statement: Record<string, unknown>,
  plan: ReportingConsumerStatusPlanV1,
  now: Date
): boolean {
  const period = statement.period as { start?: unknown; end?: unknown; source_timezone?: unknown } | undefined;
  // The digest is the one fact the buyer establishes itself, so a replay that
  // does not carry the same one is not this statement — omitting it let a
  // poisoned store post a consumption the buyer never performed. The id is
  // recomputed rather than trusted, `status_as_of` may not be in the future,
  // and an unknown key means the blob is not a statement this SDK wrote.
  if (typeof statement.status_as_of !== 'string') return false;
  if (usableLeafInstant({ status_as_of: statement.status_as_of } as ReportingConsumerStatus, now) === undefined) {
    return false;
  }
  // A floor as well as a ceiling. The non-future check alone let a store
  // poisoner backdate a statement to before the period it describes, which
  // `expected_period` makes invalid; the plan already carries the earliest
  // instant this claim can honestly bear.
  const replayed = normalizedInstant(statement.status_as_of);
  if (replayed === undefined || Date.parse(replayed) < Date.parse(plan.statusAsOfFloor)) return false;
  if (Object.keys(statement).some(key => !REPLAYABLE_STATEMENT_KEYS.has(key))) return false;
  // An explicit `null` is not an absent field. The comparisons below use
  // `?? undefined`, so a stored `null` matched a plan that simply had nothing
  // there, and the blob then reached the wire verbatim and was refused by the
  // seller's schema — on every run, because a failed post deliberately keeps
  // the pending entry. A statement this SDK wrote never carries one.
  if (Object.values(statement).some(value => value === null)) return false;
  if (
    !sameOptionalSha256(
      statement.observed_revision_content_sha256 as string | undefined,
      plan.observedRevisionContentSha256
    )
  ) {
    return false;
  }
  if (statement.reporting_status_id !== consumerStatusId({ ...plan, statusAsOf: statement.status_as_of })) {
    return false;
  }
  return (
    statement.delivery_config_id === plan.deliveryConfigId &&
    statement.delivery_config_version === plan.deliveryConfigVersion &&
    statement.report_definition_id === plan.reportDefinitionId &&
    // Replayable, and previously compared to nothing — so it was in neither the
    // claim fingerprint nor the recomputed id, and a forged value reached the
    // wire verbatim.
    (statement.reporting_obligation_id ?? undefined) === plan.reportingObligationId &&
    period?.start === plan.period.start &&
    period?.end === plan.period.end &&
    period?.source_timezone === plan.period.source_timezone &&
    statement.consumer_status === plan.consumerStatus &&
    (statement.reporting_revision_id ?? undefined) === plan.reportingRevisionId &&
    (statement.mismatch_code ?? undefined) === plan.mismatchCode &&
    (statement.failure_code ?? undefined) === plan.failureCode &&
    (statement.supersedes_reporting_status_id ?? undefined) === plan.supersedesReportingStatusId &&
    typeof statement.reporting_status_id === 'string' &&
    typeof statement.status_as_of === 'string'
  );
}

/** Record a whole-batch failure per statement, so none of it is lost. */
function recordConsumerStatusBatchFailure(
  failed: ReportingReconciliationResult['failedConsumerStatuses'],
  batch: readonly ReportingConsumerStatusPlanV1[],
  message: string
): void {
  for (const plan of batch) {
    failed.push({ plan, errors: [{ code: 'CONSUMER_STATUS_WRITE_FAILED', message }] });
  }
}

/**
 * Immutable identity for one statement.
 *
 * `immutability` makes ID reuse with different content an idempotency conflict,
 * so the derivation covers **everything on the wire**, including `status_as_of`.
 * Leaving it out looks like it buys retry stability, but `status_as_of` for
 * `received` and `unreadable` is the buyer's own clock and genuinely moves
 * between re-plans — an ID that ignored it would come back identical with a
 * different body, which is the conflict rather than the replay.
 *
 * Retry stability is bought by not re-deriving that timestamp at all:
 * `pendingConsumerStatusStore` replays the exact statement until the seller
 * confirms it. Without that store a re-plan is simply a *new* statement, which
 * the seller accepts — a post that did not land leaves the leaf where it was,
 * so the supersession still resolves and the chain still ends with exactly one
 * statement.
 *
 * `supersedes_reporting_status_id` is included for a second reason: it keeps a
 * claim that genuinely recurs later in the chain — `received` on a revision,
 * then `unreadable` on it after a flaky read, then `received` again — from
 * colliding with the earlier identical one.
 */
function consumerStatusId(plan: ReportingConsumerStatusPlanV1): string {
  return `adcp-sdk.${createHash('sha256')
    .update(canonicalize([...consumerStatusClaim(plan), plan.statusAsOf ?? null]))
    .digest('hex')
    .slice(0, 32)}`;
}

/** Everything the statement asserts, excluding when the buyer established it. */
function consumerStatusClaim(plan: ReportingConsumerStatusPlanV1): unknown[] {
  return [
    plan.deliveryConfigId,
    plan.deliveryConfigVersion,
    plan.reportDefinitionId,
    plan.period,
    plan.consumerStatus,
    plan.mismatchCode ?? null,
    plan.failureCode ?? null,
    plan.reportingRevisionId ?? null,
    plan.observedRevisionContentSha256 ?? null,
    plan.supersedesReportingStatusId ?? null,
  ];
}

/** Identity of the *claim*, deciding whether a pending statement still applies. */
function consumerStatusClaimFingerprint(plan: ReportingConsumerStatusPlanV1): string {
  return createHash('sha256')
    .update(canonicalize(consumerStatusClaim(plan)))
    .digest('hex');
}

function pendingConsumerStatusKey(
  accountId: string,
  plan: ReportingConsumerStatusPlanV1
): ReportingPendingConsumerStatusKey {
  return {
    accountId,
    deliveryConfigId: plan.deliveryConfigId,
    deliveryConfigVersion: plan.deliveryConfigVersion,
    reportDefinitionId: plan.reportDefinitionId,
    periodStart: plan.period.start,
    periodEnd: plan.period.end,
  };
}

/**
 * Batch key derived from the batch body.
 *
 * `idempotency_key` is documented as "Exact retries reuse the key and body", so
 * a key minted fresh per attempt makes the seller's batch replay unreachable by
 * construction: a transport-level retry of the identical request would be
 * ingested as a new batch instead of replaying the original ordered result.
 * Deriving it from the body makes "same body" and "same key" the same
 * condition.
 */
function consumerStatusBatchKey(statuses: ReadonlyArray<Record<string, unknown>>): string {
  // RFC 8785, not the local `canonical()` helper: that one orders keys with
  // `localeCompare`, which is ICU- and locale-dependent, and these hashes have
  // to come out byte-identical in a different process for a retry to replay.
  return `adcp-sdk-batch.${createHash('sha256').update(canonicalize(statuses)).digest('hex').slice(0, 32)}`;
}

/** Project a planned status onto the `sync_reporting_status` wire shape. */
function wireConsumerStatus(plan: ReportingConsumerStatusPlanV1): Record<string, unknown> {
  // Both guards are unreachable through `reconcileReporting`, which only posts
  // attested plans. They are here because the alternative failure is silent:
  // an unattested `received` would go out claiming a consumption that never
  // happened, which is the one thing this loop must never do.
  if (!plan.statusAsOf) {
    throw new ReportingReconciliationError(
      'CONSUMER_STATUS_UNATTESTED',
      'cannot post a consumer status before its status_as_of is established'
    );
  }
  if (
    (plan.consumerStatus === 'received' || plan.consumerStatus === 'content_mismatch') &&
    !plan.observedRevisionContentSha256
  ) {
    throw new ReportingReconciliationError(
      'CONSUMER_STATUS_UNATTESTED',
      'received and content_mismatch require a locally recomputed revision binding digest'
    );
  }
  return {
    reporting_status_id: consumerStatusId(plan),
    ...(plan.supersedesReportingStatusId ? { supersedes_reporting_status_id: plan.supersedesReportingStatusId } : {}),
    delivery_config_id: plan.deliveryConfigId,
    delivery_config_version: plan.deliveryConfigVersion,
    report_definition_id: plan.reportDefinitionId,
    period: plan.period,
    consumer_status: plan.consumerStatus,
    // The buyer's own instant, and part of the ID derivation above so the two
    // can never disagree. For `received` the spec wants when the revision
    // became consumable to this consumer, which genuinely moves between
    // re-plans; `pendingConsumerStatusStore` is what makes a retry reuse it.
    status_as_of: plan.statusAsOf,
    ...(plan.reportingObligationId ? { reporting_obligation_id: plan.reportingObligationId } : {}),
    ...(plan.reportingRevisionId ? { reporting_revision_id: plan.reportingRevisionId } : {}),
    ...(plan.observedRevisionContentSha256
      ? { observed_revision_content_sha256: plan.observedRevisionContentSha256 }
      : {}),
    ...(plan.mismatchCode ? { mismatch_code: plan.mismatchCode } : {}),
    ...(plan.failureCode ? { failure_code: plan.failureCode } : {}),
  };
}

/**
 * Read the seller's own `obligation_counts.consumer_status_pending`.
 *
 * It lives on the summary view while reconciliation reads periods, so this is
 * a separate call. A seller that does not advertise `consumer_status_task`
 * omits the field, and a failed read must not fail reconciliation — the count
 * is visibility, not evidence.
 */
async function readReportingConsumerStatusPending<TCredential>(
  options: ReconcileReportingOptions<TCredential>
): Promise<number | undefined> {
  // Only a seller advertising `consumer_status_task` populates the field, and
  // the client only carries `syncReportingStatus` for such a seller. Skipping
  // otherwise avoids an unconditional extra round trip for every adopter.
  if (!options.client.syncReportingStatus) return undefined;
  // The summary view forbids `health` and `changes_after`, and `pagination` /
  // `reporting_revision_id` are periods/revision concerns. Spreading the
  // periods request wholesale made the call fail exactly on the incremental
  // path, where the bare catch then hid it.
  const {
    health: _health,
    changes_after: _changesAfter,
    pagination: _pagination,
    reporting_revision_id: _revisionId,
    ...summaryRequest
  } = options.request as Record<string, unknown>;
  try {
    const summary = await callBeforeDeadline(
      signal =>
        options.client.getReportingStatus(
          { ...(summaryRequest as unknown as GetReportingStatusRequest), view: 'summary' },
          { signal }
        ),
      Date.now() + (options.ledgerLimits?.maxLoadMs ?? 60_000),
      'CONSUMER_STATUS_PENDING_READ_FAILED',
      'summary get_reporting_status exceeded the reporting request deadline'
    );
    const counts = (summary as { obligation_counts?: { consumer_status_pending?: unknown } }).obligation_counts;
    const pending = counts?.consumer_status_pending;
    return typeof pending === 'number' && Number.isInteger(pending) && pending >= 0 ? pending : undefined;
  } catch {
    // Visibility, not evidence: a seller that omits the field and a read that
    // failed are both "unknown", and neither should fail reconciliation.
    return undefined;
  }
}
