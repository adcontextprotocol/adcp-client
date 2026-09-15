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
    pagination?: { has_more?: boolean; cursor?: string };
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
  consumerStatuses: ReportingConsumerStatus[];
}

export interface ReportingLedgerLimits {
  maxPages?: number;
  maxRecords?: number;
  maxLoadMs?: number;
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
   * `period.source_timezone` for the accepted generation. Used only when the
   * seller omitted the obligation, since the chain's logical key needs it and
   * there is then no obligation to read it from.
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
  earliestStatusAsOf: string;
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
   * - `budget_exhausted` — the buyer's own read budget ran out before it could
   *   consume the revision. Self-inflicted, so it is silence rather than an
   *   `unreadable` claim against a seller that did nothing wrong.
   */
  suppressed?: 'unchanged' | 'leaf_undisclosed' | 'consumption_unavailable' | 'budget_exhausted';
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
   * `undefined` when the seller does not advertise `consumer_status_task`.
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
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ReportingReconciliationError';
  }
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
  if (request.delivery_config_ids) {
    const resolved = [...new Set(scope.delivery_config_generations.map(item => item.delivery_config_id))];
    if (!sameStringSet(resolved, request.delivery_config_ids)) return false;
  }
  if (request.feed_purposes && !sameStringSet(scope.feed_purposes, request.feed_purposes)) return false;
  if (request.finality && !sameStringSet(scope.finality, request.finality)) return false;
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
        for (const item of response.periods ?? [])
          addImmutable(obligations, item.reporting_obligation_id, item, 'obligation');
        for (const item of response.revisions ?? [])
          addImmutable(revisions, item.reporting_revision_id, item as ManagedReportingRevision, 'revision');
        for (const item of response.materializations ?? [])
          addImmutable(materializations, item.reporting_materialization_id, item, 'materialization');
        for (const item of response.receipts ?? []) addImmutable(receipts, item.reporting_receipt_id, item, 'receipt');
        // Counted separately: `total_count` is the obligation/revision/adjustment
        // denominator, and consumer statements are the caller's own append-only
        // history rather than ledger records, so folding them into the record
        // reconciliation below would make every page appear to overrun.
        for (const item of response.consumer_statuses ?? [])
          addImmutable(consumerStatuses, item.reporting_status_id, item, 'consumer status');
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
    same(revision.period, obligation.period)
  );
}

function reportingRevisionScopeKey(value: ManagedReportingRevision | ManagedReportingObligation): string {
  return canonical({
    account_id: value.account_id,
    report_definition_id: value.report_definition_id,
    reporting_profile: value.reporting_profile,
    media_buy_ids: [...value.media_buy_ids].sort(),
    period: value.period,
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
  const candidates = ledger.revisions.filter(item => {
    if (attempts.length > 0) return revisionIds.has(item.reporting_revision_id);
    return isDirectCoreObligation(obligation) && revisionMatchesObligationScope(item, obligation);
  });
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
        !same(item.period, obligation.period)
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
    !same(revision.period, obligation.period)
  ) {
    reasons.push('REVISION_SCOPE_MISMATCH');
  }
  if (obligation.scope_resolved_at !== obligation.period.end) reasons.push('SCOPE_CUTOFF_MISMATCH');
  if (
    !isReportingCoverageEvidence(obligation.coverage) ||
    obligation.coverage.evaluated_at !== obligation.scope_resolved_at ||
    !sameStringSet(obligation.coverage.media_buy_ids, obligation.media_buy_ids ?? []) ||
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
  const periodEnd = Date.parse(revision.period.end);
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
    // `source_timezone` is part of the consumer-status chain's logical key, so
    // a wrong value forks the chain rather than failing loudly. Prefer the
    // seller's own obligation, fall back to the buyer's pin, and only then to
    // UTC.
    const period = {
      start: expected.periodStart,
      end: expected.periodEnd,
      source_timezone:
        (obligationForPeriod as { period?: { source_timezone?: string } } | undefined)?.period?.source_timezone ??
        expected.periodSourceTimezone ??
        'UTC',
    };
    const base = {
      deliveryConfigId: expected.deliveryConfigId,
      deliveryConfigVersion: expected.deliveryConfigVersion,
      reportDefinitionId: expected.reportDefinitionId,
      period,
    };
    const expectedAt = reportingExpectedAt(obligationForPeriod, expected);
    const schedule = consumerStatusSchedule(expectedAt, expected, now);
    const leaf = currentConsumerLeaf(
      ledger,
      base,
      (obligationForPeriod as { current_consumer_status_id?: unknown } | undefined)?.current_consumer_status_id
    );
    // `expected_period`: obligation_missing and revision_missing are valid only
    // at or after expected_at. Dating them from the period end instead makes a
    // conformant seller reject every one of them.
    const establishedAt = expectedAt ?? expected.periodEnd;

    if (missing.has(expected) || !obligationForPeriod) {
      return finalizeConsumerStatusPlan(
        {
          ...base,
          ...schedule,
          consumerStatus: 'obligation_missing',
          establishedAt,
          reason: missing.has(expected)
            ? 'the independently expected period is absent from the seller ledger'
            : 'no obligation in the ledger matches this expected period',
        },
        leaf
      );
    }

    const obligation = obligationForPeriod;
    const selected = selectCurrent(obligation, ledger, expected);
    const revision = selected.revision;

    if (!revision) {
      return finalizeConsumerStatusPlan(
        {
          ...base,
          ...schedule,
          reportingObligationId: obligation.reporting_obligation_id,
          consumerStatus: 'revision_missing',
          establishedAt,
          reason: 'the obligation exists but no required revision was available',
        },
        leaf
      );
    }

    const mismatch = detectReportingContentMismatch(contractFactsFor(obligation, expected), revision);
    return finalizeConsumerStatusPlan(
      {
        ...base,
        ...schedule,
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
      leaf
    );
  });
}

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
  leaf: ConsumerStatusLeaf
): ReportingConsumerStatusPlanV1 {
  const earliestStatusAsOf = latestInstant([draft.establishedAt, leaf.statement?.status_as_of]) ?? draft.establishedAt;
  const { establishedAt: _establishedAt, ...carried } = draft;
  const plan: ReportingConsumerStatusPlanV1 = {
    ...carried,
    ...(leaf.statusId ? { supersedesReportingStatusId: leaf.statusId } : {}),
    earliestStatusAsOf,
    // A statement the buyer can already date is dated now; one that still owes
    // a read is left open for `attestConsumerStatusPlan`.
    ...(draft.requiresConsumption ? {} : { statusAsOf: earliestStatusAsOf }),
  };
  const suppressed = consumerStatusSuppression(plan, leaf);
  return suppressed ? { ...plan, suppressed } : plan;
}

/** Why this statement must not be posted, or `undefined` when it may be. */
function consumerStatusSuppression(
  plan: ReportingConsumerStatusPlanV1,
  leaf: ConsumerStatusLeaf
): ReportingConsumerStatusPlanV1['suppressed'] {
  if (leaf.undisclosed) return 'leaf_undisclosed';
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
  return (
    statement.consumer_status === plan.consumerStatus &&
    (statement.reporting_revision_id ?? undefined) === plan.reportingRevisionId &&
    (statement.mismatch_code ?? undefined) === plan.mismatchCode &&
    (statement.failure_code ?? undefined) === plan.failureCode
  );
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
): string | undefined {
  const declared = obligation?.expected_at;
  if (typeof declared === 'string' && Number.isFinite(Date.parse(declared))) return declared;
  const slaSeconds = expected.deliverySlaSeconds;
  const periodEnd = Date.parse(expected.periodEnd);
  if (typeof slaSeconds !== 'number' || !Number.isFinite(slaSeconds) || slaSeconds < 0) return undefined;
  if (!Number.isFinite(periodEnd)) return undefined;
  return new Date(periodEnd + slaSeconds * 1_000).toISOString();
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
  now: Date
): { deadline?: string; overdue: boolean } {
  const windowSeconds = expected.automatedRecoveryWindowSeconds;
  if (expectedAt === undefined) return { overdue: false };
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds < 0) {
    return { overdue: false };
  }
  const deadline = new Date(Date.parse(expectedAt) + windowSeconds * 1_000).toISOString();
  return { deadline, overdue: now.getTime() >= Date.parse(deadline) };
}

/** Latest of a set of possibly-absent RFC 3339 instants. */
function latestInstant(values: ReadonlyArray<string | undefined>): string | undefined {
  let latest: string | undefined;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (latest === undefined || parsed > Date.parse(latest)) latest = value;
  }
  return latest;
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
    for (const issue of (obligation as { issues?: Array<Record<string, unknown>> }).issues ?? []) {
      const recommendedAction = String(issue.recommended_action ?? '');
      escalations.push({
        reportingObligationId: obligation.reporting_obligation_id,
        issueId: String(issue.issue_id ?? ''),
        code: String(issue.code ?? ''),
        severity: String(issue.severity ?? ''),
        responsibleParty: String(issue.responsible_party ?? ''),
        recommendedAction,
        ...(typeof issue.opened_at === 'string' ? { openedAt: issue.opened_at } : {}),
        ...(typeof issue.issue_state === 'string' ? { issueState: issue.issue_state } : {}),
        ...(typeof issue.external_ref === 'string' ? { externalRef: issue.external_ref } : {}),
        ...(typeof issue.reporting_status_id === 'string' ? { reportingStatusId: issue.reporting_status_id } : {}),
        ...(operationsContact ? { operationsContact } : {}),
        requiresHumanContact: recommendedAction.startsWith('contact_'),
      });
    }
  }
  return escalations;
}

function expectedPeriodMatches(
  expected: ExpectedReportingPeriod,
  obligation: ManagedReportingObligation,
  ledger: ReportingLedger
): boolean {
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
    value.period.start,
    value.period.end,
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
    if (obligation.health !== 'complete') reasons.push(`OBLIGATION_${obligation.health.toUpperCase()}`);
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
  }
  if (pendingSubmissions.length) {
    ledger = await loadReportingLedger(
      options.client,
      options.request,
      options.maxSnapshotRestarts,
      options.ledgerLimits
    );
  }

  const evaluated = evaluateReportingLedger(ledger, options.expectedPeriods, options.now, options.operationsContact);

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
    if (budgetExhausted || (plan.requiresConsumption && Date.now() >= readDeadline)) {
      attested.push(plan.requiresConsumption ? { ...plan, suppressed: 'budget_exhausted' } : plan);
      continue;
    }
    const next = await attestConsumerStatusPlan(plan, ledger, options, readDeadline);
    // Only the shared wall-clock budget stops the loop; a per-revision page or
    // record limit is that revision's problem alone.
    if (next.suppressed === 'budget_exhausted' && next.budgetScope === 'run') budgetExhausted = true;
    const { budgetScope: _scope, ...carried } = next;
    attested.push(carried);
  }
  const consumerStatuses = attested;
  const owed = consumerStatuses.filter(plan => plan.overdue && plan.suppressed === undefined);
  const postedConsumerStatuses: ReportingConsumerStatusPlanV1[] = [];
  const failedConsumerStatuses: ReportingReconciliationResult['failedConsumerStatuses'] = [];
  const confirmed: ReportingPendingConsumerStatusKey[] = [];
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
      for (const plan of batch) {
        const key = pendingConsumerStatusKey(ledger.accountId, plan);
        const fingerprint = consumerStatusClaimFingerprint(plan);
        const pending = await options.pendingConsumerStatusStore?.get(key);
        if (pending && pending.claimFingerprint === fingerprint) {
          wireStatuses.push(pending.statement);
          continue;
        }
        const statement = wireConsumerStatus(plan);
        await options.pendingConsumerStatusStore?.put(key, { statement, claimFingerprint: fingerprint });
        wireStatuses.push(statement);
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
          batch,
          error instanceof Error ? error.message : 'sync_reporting_status failed'
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
      batch.forEach((plan, index) => {
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
          errors: Array.isArray(result?.errors) ? result.errors : [],
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
  deadline: number
): Promise<AttestedConsumerStatusPlan> {
  if (!plan.requiresConsumption || !plan.reportingRevisionId) return plan;
  if (!options.client.getMediaBuyDelivery) return { ...plan, suppressed: 'consumption_unavailable' };

  const outcome = await consumeReportingRevision(options, plan.reportingRevisionId, deadline);
  const leaf = currentConsumerLeaf(ledger, plan, plan.supersedesReportingStatusId);

  if ('budgetExhausted' in outcome) {
    return { ...plan, suppressed: 'budget_exhausted', budgetScope: outcome.budgetExhausted };
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
        statusAsOf: latestInstant([new Date().toISOString(), plan.earliestStatusAsOf]) ?? plan.earliestStatusAsOf,
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
        statusAsOf: latestInstant([outcome.consumedAt, plan.earliestStatusAsOf]) ?? plan.earliestStatusAsOf,
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
      statusAsOf: latestInstant([outcome.consumedAt, plan.earliestStatusAsOf]) ?? plan.earliestStatusAsOf,
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
type AttestedConsumerStatusPlan = ReportingConsumerStatusPlanV1 & { budgetScope?: 'run' | 'revision' };

/** Re-apply the unchanged/undisclosed test after a plan's meaning has changed. */
function withSuppression(plan: ReportingConsumerStatusPlanV1, leaf: ConsumerStatusLeaf): ReportingConsumerStatusPlanV1 {
  const suppressed = consumerStatusSuppression(plan, leaf);
  return suppressed ? { ...plan, suppressed } : { ...plan, suppressed: undefined };
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
  deadline: number
): Promise<ConsumedReportingRevisionV1 | UnconsumableReportingRevisionV1 | ExhaustedReportingReadBudgetV1> {
  const read = options.client.getMediaBuyDelivery!;
  const maxPages = options.ledgerLimits?.maxPages ?? 1_000;
  const maxRows = options.ledgerLimits?.maxRecords ?? 100_000;
  const rows: unknown[] = [];
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
      if (pages > maxPages) return { budgetExhausted: 'revision' };
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
      for (const row of response.reporting_rows ?? []) rows.push(row);
      if (rows.length > maxRows) {
        return {
          failureCode: 'transport_failed',
          detail: 'the revision row read exceeded the configured record limit',
        };
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
      return { budgetExhausted: 'run' };
    }
    return { failureCode: 'transport_failed', detail: 'the exact-revision read failed before the rows were complete' };
  }

  // Taken after the last page lands: this is when the revision actually became
  // consumable to this consumer, which is what `status_as_of` means.
  const consumedAt = new Date().toISOString();
  if (!binding) {
    return { failureCode: 'reader_incompatible', detail: 'the exact-revision read returned no binding' };
  }
  if (rows.length !== binding.row_count) {
    return {
      failureCode: 'integrity_mismatch',
      detail: `the revision declares ${binding.row_count} rows and the read returned ${rows.length}`,
    };
  }
  const digest = createHash('sha256')
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
  if (!sameSha256(digest, binding.content_sha256)) {
    return {
      failureCode: 'integrity_mismatch',
      detail: 'the recomputed revision binding digest does not match the content_sha256 the seller published',
    };
  }
  return { digest, consumedAt, rowCount: rows.length, rows };
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
    .update(canonical([...consumerStatusClaim(plan), plan.statusAsOf ?? null]))
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
    .update(canonical(consumerStatusClaim(plan)))
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
  return `adcp-sdk-batch.${createHash('sha256').update(canonical(statuses)).digest('hex').slice(0, 32)}`;
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
    // The buyer's own instant, deliberately outside the ID derivation above:
    // for `received` the spec wants when the revision became consumable to this
    // consumer, which moves between re-plans, and an ID that moved with it
    // could never be reused by a retry.
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
