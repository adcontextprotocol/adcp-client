import { createHash } from 'crypto';
import type {
  GetReportingStatusRequest,
  GetReportingStatusResponse,
  ReportingCanonicalContentDigest,
  ReportingControlTotal,
  ReportingMaterialization,
  ReportingObligation,
  ReportingReceipt,
  ReportingRevision,
  SyncReportingReceiptsRequest,
  SyncReportingReceiptsResponse,
} from '../types/tools.generated';
import { generateIdempotencyKey } from '../utils/idempotency';
import { isReportingControlTotals, isReportingReceiptEvidence, isReportingVerificationEvidence } from './evidence';
import {
  createReportingManifestInspector,
  ReportingInspectionError,
  type ReportingCredentialProvider,
  type ReportingManifestInspectorOptions,
  type ReportingResourceReader,
} from './inspection';

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

export interface ReportingReconciliationResult {
  definitive: boolean;
  ledger: ReportingLedger;
  obligations: ObligationReconciliation[];
  missingExpectedPeriods: ExpectedReportingPeriod[];
  submittedReceipts: ReportingReceipt[];
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
  for (const revision of revisions.values()) {
    if (
      revision.account_id !== accountId ||
      !referencedRevisions.has(revision.reporting_revision_id) ||
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
  const candidates = ledger.revisions.filter(item => revisionIds.has(item.reporting_revision_id));
  const receipts = ledger.receipts.filter(item => item.reporting_obligation_id === obligation.reporting_obligation_id);
  const successfulAttempts = attempts.filter(item => item.status === 'available' || item.status === 'delivered');
  const acceptedReceipts = receipts.filter(item => item.status === 'accepted');
  if (obligation.account_id !== ledger.accountId) reasons.push('OBLIGATION_ACCOUNT_MISMATCH');
  if (
    candidates.length !== obligation.revision_count ||
    attempts.length !== obligation.materialization_count ||
    successfulAttempts.length !== obligation.successful_materialization_count ||
    receipts.length !== obligation.receipt_count ||
    acceptedReceipts.length !== obligation.accepted_receipt_count
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
  now = new Date()
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

  return {
    ...evaluateReportingLedger(ledger, options.expectedPeriods, options.now),
    submittedReceipts: newReceipts,
  };
}
