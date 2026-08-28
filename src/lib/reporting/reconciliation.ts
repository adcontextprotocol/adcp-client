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

export interface ReportingReconciliationClient {
  getReportingStatus(params: GetReportingStatusRequest): Promise<GetReportingStatusResponse>;
  syncReportingReceipts(params: SyncReportingReceiptsRequest): Promise<SyncReportingReceiptsResponse>;
}

export interface ReportingLedger {
  ledgerSnapshotId: string;
  ledgerAsOf: string;
  accountId: string;
  scope: NonNullable<GetReportingStatusResponse['scope']>;
  obligations: ReportingObligation[];
  revisions: ReportingRevision[];
  materializations: ReportingMaterialization[];
  receipts: ReportingReceipt[];
}

export interface ExpectedReportingPeriod {
  deliveryConfigId: string;
  deliveryConfigVersion: number;
  reportDefinitionId: string;
  feedPurpose: ReportingObligation['feed_purpose'];
  reportingProfile: string;
  mediaBuyIds: string[];
  periodStart: string;
  periodEnd: string;
}

export interface ReportingObservation {
  rowCount: number;
  controlTotals: ReportingControlTotal[];
  canonicalContentDigest?: ReportingCanonicalContentDigest;
  manifestSha256?: string;
  nativeVersionRef?: string;
  consumerCommitRef?: string;
}

export interface ReportingCheckpointStore {
  get(reportingMaterializationId: string): Promise<ReportingReceipt | undefined>;
  put(receipt: ReportingReceipt): Promise<void>;
}

export interface ReportingInspectionContext {
  obligation: ReportingObligation;
  revision: ReportingRevision;
  materialization: ReportingMaterialization;
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
  }>;
}

export interface ReconcileReportingOptions {
  client: ReportingReconciliationClient;
  request: Omit<GetReportingStatusRequest, 'view' | 'pagination'>;
  inspect: (context: ReportingInspectionContext) => Promise<ReportingObservation>;
  expectedPeriods: ExpectedReportingPeriod[];
  checkpointStore?: ReportingCheckpointStore;
  maxSnapshotRestarts?: number;
  maxInspectionAttempts?: number;
  now?: Date;
}

export class ReportingReconciliationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ReportingReconciliationError';
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

function normalizedTotals(totals: ReportingControlTotal[]): ReportingControlTotal[] {
  return [...totals].sort((left, right) => left.name.localeCompare(right.name));
}

function receiptMatches(
  receipt: ReportingReceipt,
  revision: ReportingRevision,
  materialization: ReportingMaterialization
): boolean {
  if (receipt.status !== 'accepted' || !materialization.verification) return false;
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
      same(receipt.observed_canonical_content_digest, revision.canonical_content_digest)
    );
  }
  if (receipt.verification_profile === 'manifest_checksums') {
    return Boolean(
      materialization.resource?.manifest_sha256 &&
      receipt.observed_manifest_sha256 === materialization.resource.manifest_sha256
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
  maxSnapshotRestarts = 2
): Promise<ReportingLedger> {
  for (let restart = 0; restart <= maxSnapshotRestarts; restart += 1) {
    try {
      const obligations = new Map<string, ReportingObligation>();
      const revisions = new Map<string, ReportingRevision>();
      const materializations = new Map<string, ReportingMaterialization>();
      const receipts = new Map<string, ReportingReceipt>();
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let snapshotId: string | undefined;
      let ledgerAsOf: string | undefined;
      let accountId: string | undefined;
      let scope: NonNullable<GetReportingStatusResponse['scope']> | undefined;
      let totalCount: number | undefined;

      do {
        const response = await client.getReportingStatus({
          ...request,
          view: 'periods',
          ...(cursor ? { pagination: { cursor } } : {}),
        });
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
        for (const item of response.periods ?? [])
          addImmutable(obligations, item.reporting_obligation_id, item, 'obligation');
        for (const item of response.revisions ?? [])
          addImmutable(revisions, item.reporting_revision_id, item, 'revision');
        for (const item of response.materializations ?? [])
          addImmutable(materializations, item.reporting_materialization_id, item, 'materialization');
        for (const item of response.receipts ?? []) addImmutable(receipts, item.reporting_receipt_id, item, 'receipt');

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

function selectCurrent(
  obligation: ReportingObligation,
  ledger: ReportingLedger
): { revision?: ReportingRevision; materialization?: ReportingMaterialization; reasons: string[] } {
  const reasons: string[] = [];
  const attempts = ledger.materializations.filter(
    item => item.reporting_obligation_id === obligation.reporting_obligation_id
  );
  const revisionIds = new Set(attempts.map(item => item.reporting_revision_id));
  const candidates = ledger.revisions.filter(item => revisionIds.has(item.reporting_revision_id));
  const receipts = ledger.receipts.filter(item => item.reporting_obligation_id === obligation.reporting_obligation_id);
  const successfulAttempts = attempts.filter(item => item.status === 'available' || item.status === 'delivered');
  const acceptedReceipts = receipts.filter(item => item.status === 'accepted');
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
  const current = candidates.filter(item => !superseded.has(item.reporting_revision_id));
  if (current.length !== 1) {
    reasons.push(current.length === 0 ? 'MISSING_CURRENT_REVISION' : 'AMBIGUOUS_REVISION_CHAIN');
    return { reasons };
  }
  const revision = current[0]!;
  if (
    revision.account_id !== obligation.account_id ||
    revision.report_definition_id !== obligation.report_definition_id ||
    revision.reporting_profile !== obligation.reporting_profile ||
    !same([...(revision.media_buy_ids ?? [])].sort(), [...(obligation.media_buy_ids ?? [])].sort()) ||
    !same(revision.period, obligation.period)
  ) {
    reasons.push('REVISION_SCOPE_MISMATCH');
  }
  if (obligation.required_finality === 'official' && revision.finality !== 'official') reasons.push('FINALITY_NOT_MET');

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
  if (
    materialization.delivery_config_id !== obligation.delivery_config_id ||
    materialization.delivery_config_version !== obligation.delivery_config_version ||
    materialization.destination_ref !== obligation.destination_ref ||
    materialization.feed_purpose !== obligation.feed_purpose
  ) {
    reasons.push('MATERIALIZATION_SCOPE_MISMATCH');
  }
  if (
    materialization.verification.row_count !== revision.row_count ||
    !same(normalizedTotals(materialization.verification.control_totals), normalizedTotals(revision.control_totals))
  ) {
    reasons.push('PRODUCER_CONTROL_TOTAL_MISMATCH');
  }
  if (
    materialization.verification.verification_profile === 'canonical_digest' &&
    (!revision.canonical_content_digest ||
      !same(materialization.verification.canonical_content_digest, revision.canonical_content_digest))
  ) {
    reasons.push('PRODUCER_DIGEST_MISMATCH');
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

export function evaluateReportingLedger(
  ledger: ReportingLedger,
  expectedPeriods: ExpectedReportingPeriod[] | undefined,
  now = new Date()
): Omit<ReportingReconciliationResult, 'submittedReceipts'> {
  const obligationResults: ObligationReconciliation[] = [];
  const uniqueRevisions = new Map<string, ReportingRevision>();

  for (const obligation of ledger.obligations) {
    const selected = selectCurrent(obligation, ledger);
    const reasons = [...selected.reasons];
    if (obligation.health !== 'complete') reasons.push(`OBLIGATION_${obligation.health.toUpperCase()}`);
    if (selected.materialization?.resource && new Date(selected.materialization.resource.expires_at) <= now)
      reasons.push('RESOURCE_EXPIRED');
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

  const actualPeriods = new Set(
    ledger.obligations.map(obligation =>
      canonical({
        deliveryConfigId: obligation.delivery_config_id,
        deliveryConfigVersion: obligation.delivery_config_version,
        reportDefinitionId: obligation.report_definition_id,
        feedPurpose: obligation.feed_purpose,
        reportingProfile: obligation.reporting_profile,
        mediaBuyIds: [...(obligation.media_buy_ids ?? [])].sort(),
        periodStart: obligation.period.start,
        periodEnd: obligation.period.end,
      })
    )
  );
  const missingExpectedPeriods = (expectedPeriods ?? []).filter(
    expected =>
      !actualPeriods.has(
        canonical({
          ...expected,
          mediaBuyIds: [...expected.mediaBuyIds].sort(),
        })
      )
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
    (!revision.canonical_content_digest || !same(observation.canonicalContentDigest, revision.canonical_content_digest))
  ) {
    rejectionCodes.push('CANONICAL_DIGEST_MISMATCH');
  }
  if (profile === 'manifest_checksums' && observation.manifestSha256 !== materialization.resource.manifest_sha256) {
    rejectionCodes.push('MANIFEST_DIGEST_MISMATCH');
  }
  if (profile === 'native_commit' && observation.nativeVersionRef !== materialization.resource.native_version_ref) {
    rejectionCodes.push('NATIVE_VERSION_MISMATCH');
  }

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
    ...(rejectionCodes.length ? { rejection_codes: rejectionCodes } : {}),
    observed_at: observedAt,
  };
}

async function inspectWithRetry(
  inspect: ReconcileReportingOptions['inspect'],
  context: ReportingInspectionContext,
  maxAttempts: number
): Promise<ReportingObservation> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await inspect(context);
    } catch (error) {
      lastError = error;
    }
  }
  throw new ReportingReconciliationError(
    'INSPECTION_FAILED',
    `materialization inspection failed after ${maxAttempts} attempts: ${String(lastError)}`
  );
}

export async function reconcileReporting(options: ReconcileReportingOptions): Promise<ReportingReconciliationResult> {
  let ledger = await loadReportingLedger(options.client, options.request, options.maxSnapshotRestarts);
  const newReceipts: ReportingReceipt[] = [];

  for (const obligation of ledger.obligations) {
    if (obligation.reconciliation_mode !== 'consumer_receipt') continue;
    const selected = selectCurrent(obligation, ledger);
    if (!selected.revision || !selected.materialization || selected.reasons.length) continue;
    if (ledger.receipts.some(receipt => receiptMatches(receipt, selected.revision!, selected.materialization!)))
      continue;

    let receipt = await options.checkpointStore?.get(selected.materialization.reporting_materialization_id);
    if (!receipt || receipt.reporting_revision_id !== selected.revision.reporting_revision_id) {
      const observation = await inspectWithRetry(
        options.inspect,
        { obligation, revision: selected.revision, materialization: selected.materialization },
        options.maxInspectionAttempts ?? 3
      );
      receipt = buildReportingReceipt(
        { obligation, revision: selected.revision, materialization: selected.materialization },
        observation
      );
      await options.checkpointStore?.put(receipt);
    }
    newReceipts.push(receipt);
  }

  if (newReceipts.length) {
    const response = await options.client.syncReportingReceipts({
      account: options.request.account,
      idempotency_key: generateIdempotencyKey(),
      receipts: newReceipts,
    });
    const failed = response.results.filter(result => result.result === 'failed');
    if (failed.length)
      throw new ReportingReconciliationError(
        'RECEIPT_WRITE_FAILED',
        `${failed.length} reporting receipt(s) were rejected by the seller`
      );
    ledger = await loadReportingLedger(options.client, options.request, options.maxSnapshotRestarts);
  }

  return {
    ...evaluateReportingLedger(ledger, options.expectedPeriods, options.now),
    submittedReceipts: newReceipts,
  };
}
