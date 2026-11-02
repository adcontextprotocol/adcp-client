/**
 * The buyer's receipts policy for `client.reporting.reconcile` (experimental, AdCP 3.3). Names follow
 * the Python SDK's `adcp.reporting.subscriptions.receipts`.
 *
 * A receipt says the buyer verified and committed the data, so it is never sent on read. With
 * `receipts: { mode: 'verified', commit }`, for each `consumer_receipt` obligation whose current
 * revision is materialized and not yet receipted:
 *
 * 1. The SDK verifies the materialization itself, through `resourceReader` (the built-in manifest
 *    inspector) or your `inspect` adapter, giving the observed row count, control totals and digest.
 * 2. A materialization that can't be read, or whose content the built-in inspector refuses, is listed
 *    in `report.receipts.failed` with its code, and nothing is receipted for it. An `inspect` adapter
 *    that returns a mismatched observation gets a `rejected` receipt with the SDK's codes
 *    (`ROW_COUNT_MISMATCH` and friends), and `commit` is not called.
 * 3. Otherwise your `commit(revision)` hook runs, **at least once** per revision. When it throws (the
 *    revision is listed in `failed` as `COMMIT_FAILED`), or when the receipt write after it fails, the
 *    next reconcile calls it again, so make it idempotent on `revision.resource`. Return
 *    `{ commitRef }` (an `accepted` receipt with `consumer_commit_ref`), `'defer'` (try again next
 *    run) or `{ reject: codes }` (a `rejected` receipt with your codes).
 *
 * Receipt ids are stable per (obligation, revision, materialization), and a materialization already
 * receipted, accepted or rejected, is not receipted again. Adjustments are offered to
 * `adjustments(adjustment)` and deferred: billing never auto-accepts. Accept or reject them with
 * `client.reporting.submitReceipts`.
 *
 * @packageDocumentation
 */
import { createHash, randomUUID } from 'node:crypto';

import { ReportingSubscriptionError } from '../errors';
import { createReportingManifestInspector, type ReportingResourceReader } from '../reporting/inspection';
import {
  buildReportingReceipt,
  selectReportingReceiptCandidate,
  type ExpectedReportingPeriod,
  type ReportingInspectionContext,
  type ReportingLedger,
  type ReportingObservation,
} from '../reporting/reconciliation';
import type {
  ReportingAdjustment,
  ReportingMaterialization,
  ReportingReceipt,
  ReportingRevision,
} from '../types/tools.generated';

type Json = Record<string, unknown>;

/** Your commit loaded the data: submit an `accepted` receipt with this reference. */
export interface CommitResult {
  commitRef: string;
}

/** Your commit refused the data: submit a `rejected` receipt with these codes. */
export interface Reject {
  reject: readonly [string, ...string[]];
}

/** What `commit` returns. */
export type CommitOutcome = CommitResult | Reject | 'defer';

/** What the SDK verified, handed to your `commit` hook. */
export interface VerifiedRevision {
  accountId: string;
  obligation: ReportingInspectionContext['obligation'];
  revision: ReportingRevision;
  materialization: ReportingMaterialization;
  observation: ReportingObservation;
  /** The materialized resource (`materialization.resource`). */
  resource: ReportingMaterialization['resource'];
}

/**
 * How `reconcile` handles `consumer_receipt` revisions. `mode: 'off'` (the default) submits nothing.
 * `mode: 'verified'` needs `commit` and exactly one of `resourceReader` (with
 * `referenceAllowedOrigins`, for the built-in manifest inspector) or `inspect`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface ReceiptPolicy {
  mode: 'off' | 'verified';
  /** Runs after the SDK verified the revision. Load the data, then return the outcome. */
  commit?: (revision: VerifiedRevision) => Promise<CommitOutcome> | CommitOutcome;
  /** Sees each pending adjustment of a revision; only `'defer'` is applied. */
  adjustments?: (adjustment: ReportingAdjustment) => Promise<string> | string;
  /** Reads materialized resources for the built-in manifest inspector. */
  resourceReader?: ReportingResourceReader;
  /** Origins the built-in inspector may fetch schemas and contracts from. Required with `resourceReader`. */
  referenceAllowedOrigins?: readonly string[];
  /** Your verifier: return what you observed in the materialization. */
  inspect?: (context: ReportingInspectionContext) => Promise<ReportingObservation>;
}

/**
 * What the receipts policy did in one `reconcile`.
 *
 * @experimental Reporting subscriptions (AdCP 3.3).
 */
export interface ReceiptReport {
  submitted: ReportingReceipt[];
  rejected: ReportingReceipt[];
  /** `reporting_obligation_id`s whose `commit` returned `'defer'`. */
  deferred: string[];
  /** `[reporting_obligation_id, code]` for revisions the SDK could not verify or commit. Nothing was receipted. */
  failed: Array<[string, string]>;
  /** `reporting_adjustment_id`s offered to `adjustments` and deferred. */
  adjustmentsDeferred: string[];
  /** Billing periods delivered but not receipted. */
  owedByBuyer: number;
}

/** @internal */
export function emptyReceiptReport(): ReceiptReport {
  return { submitted: [], rejected: [], deferred: [], failed: [], adjustmentsDeferred: [], owedByBuyer: 0 };
}

/** Refuses a policy that can't run, before anything is read. */
export function validateReceiptPolicy(policy: ReceiptPolicy | undefined): void {
  if (policy === undefined) return;
  const refuse = (message: string) => new ReportingSubscriptionError('INVALID_REQUEST', message, { dispatched: false });
  if (policy.mode !== 'off' && policy.mode !== 'verified') throw refuse("receipts.mode is 'off' or 'verified'.");
  if (policy.mode !== 'verified') return;
  if (typeof policy.commit !== 'function') {
    throw refuse(
      "receipts: { mode: 'verified' } needs commit: the hook that loads the data and returns { commitRef }, 'defer' or { reject }."
    );
  }
  if ((policy.resourceReader === undefined) === (policy.inspect === undefined)) {
    throw refuse(
      "receipts: { mode: 'verified' } needs exactly one of resourceReader (the built-in manifest inspector) or inspect (your verifier)."
    );
  }
  if (policy.resourceReader !== undefined && !Array.isArray(policy.referenceAllowedOrigins)) {
    throw refuse(
      'receipts.resourceReader needs referenceAllowedOrigins: the origins schemas and contracts may come from.'
    );
  }
}

/** A stable receipt id per (obligation, revision, materialization), so a resend replays. Same as Python. */
function receiptId(obligationId: string, revisionId: string, materializationId: string): string {
  const digest = createHash('sha256')
    .update([obligationId, revisionId, materializationId].join('\x1f'), 'utf8')
    .digest('hex');
  return `reporting-receipt:${digest.slice(0, 40)}`;
}

/**
 * The seller's own echo of what it promised, for the inspector. The subscription buyer pins no
 * independent contract, so canonical-digest materializations need an `inspect` adapter.
 */
function expectationOf(context: Omit<ReportingInspectionContext, 'expected'>): ExpectedReportingPeriod {
  const { obligation, revision, materialization } = context;
  return {
    deliveryConfigId: obligation.delivery_config_id,
    deliveryConfigVersion: obligation.delivery_config_version,
    reportDefinitionId: revision.report_definition_id,
    feedPurpose: obligation.feed_purpose,
    reportingProfile: revision.reporting_profile,
    mediaBuyIds: [...(obligation.media_buy_ids ?? [])],
    destinationRef: String(obligation.destination_ref ?? ''),
    deliveryMethod: materialization.method,
    requiredFinality: obligation.required_finality,
    reconciliationMode: obligation.reconciliation_mode,
    periodStart: obligation.period.start,
    periodEnd: obligation.period.end,
    verificationProfile: materialization.verification?.verification_profile ?? 'manifest_checksums',
  } as unknown as ExpectedReportingPeriod;
}

export interface ReceiptWriteClient {
  syncReportingReceipts?(params: Json): Promise<{ success: boolean; data?: unknown; error?: string }>;
}

/**
 * Verify, commit and receipt one account's unreceipted `consumer_receipt` revisions. Returns `true`
 * when it wrote receipts, so the caller reads the ledger again.
 *
 * @internal
 */
export async function applyReceiptPolicy(
  client: ReceiptWriteClient,
  accountId: string,
  ledger: ReportingLedger,
  policy: ReceiptPolicy,
  report: ReceiptReport,
  now: number
): Promise<boolean> {
  if (policy.mode !== 'verified') return false;
  const inspect =
    policy.inspect ??
    createReportingManifestInspector({
      reader: policy.resourceReader!,
      referenceAllowedOrigins: policy.referenceAllowedOrigins ?? [],
    });
  const observedAt = new Date(now).toISOString();
  const outgoing: ReportingReceipt[] = [];
  for (const obligation of ledger.obligations) {
    if (obligation.reconciliation_mode !== 'consumer_receipt') continue;
    const { revision, materialization, reasons } = selectReportingReceiptCandidate(obligation, ledger);
    if (!revision || !materialization || reasons.length > 0) continue;
    // Adjustments correct an official revision after it was receipted, so they are offered whether or
    // not the revision itself still needs a receipt.
    const answered = new Set((ledger.adjustmentReceipts ?? []).map(item => item.reporting_adjustment_id));
    for (const adjustment of ledger.adjustments ?? []) {
      if (
        adjustment.adjusts_reporting_revision_id !== revision.reporting_revision_id ||
        answered.has(adjustment.reporting_adjustment_id)
      ) {
        continue;
      }
      const decision = policy.adjustments ? String(await policy.adjustments(adjustment)) : 'defer';
      if (decision !== 'defer') {
        console.warn(
          `adjustment ${adjustment.reporting_adjustment_id}: the receipts policy applies only 'defer'; accept or reject it with client.reporting.submitReceipts.`
        );
      }
      report.adjustmentsDeferred.push(adjustment.reporting_adjustment_id);
    }
    // Already receipted, rejected included: a refusal is stated once per materialization.
    if (
      ledger.receipts.some(
        item =>
          item.reporting_obligation_id === obligation.reporting_obligation_id &&
          item.reporting_revision_id === revision.reporting_revision_id &&
          item.reporting_materialization_id === materialization.reporting_materialization_id
      )
    ) {
      continue;
    }
    const base = { obligation, revision, materialization };
    const context: ReportingInspectionContext = { ...base, expected: expectationOf(base) };
    let observation: ReportingObservation;
    try {
      observation = await inspect(context);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      report.failed.push([obligation.reporting_obligation_id, typeof code === 'string' ? code : 'INSPECTION_FAILED']);
      continue;
    }
    const id = receiptId(
      obligation.reporting_obligation_id,
      revision.reporting_revision_id,
      materialization.reporting_materialization_id
    );
    const checked = buildReportingReceipt(context, observation, id, observedAt);
    if (checked.status === 'rejected') {
      outgoing.push(checked);
      report.rejected.push(checked);
      continue;
    }
    let outcome: CommitOutcome;
    try {
      outcome = await policy.commit!({
        accountId,
        obligation,
        revision,
        materialization,
        observation,
        resource: materialization.resource,
      });
    } catch {
      report.failed.push([obligation.reporting_obligation_id, 'COMMIT_FAILED']);
      continue;
    }
    if (outcome === 'defer') {
      report.deferred.push(obligation.reporting_obligation_id);
    } else if (outcome && typeof (outcome as CommitResult).commitRef === 'string') {
      const receipt = buildReportingReceipt(
        context,
        { ...observation, consumerCommitRef: (outcome as CommitResult).commitRef },
        id,
        observedAt
      );
      outgoing.push(receipt);
      report.submitted.push(receipt);
    } else if (outcome && Array.isArray((outcome as Reject).reject) && (outcome as Reject).reject.length > 0) {
      const receipt = {
        ...checked,
        status: 'rejected',
        rejection_codes: [...(outcome as Reject).reject],
      } as ReportingReceipt;
      outgoing.push(receipt);
      report.rejected.push(receipt);
    } else {
      throw new ReportingSubscriptionError(
        'INVALID_REQUEST',
        "commit returns { commitRef }, { reject: [codes] } or 'defer'.",
        { dispatched: false }
      );
    }
  }
  if (outgoing.length === 0) return false;
  await writeReceipts(client, accountId, { receipts: outgoing });
  return true;
}

/** @internal `sync_reporting_receipts` for one account, throwing on a failed write. */
export async function writeReceipts(
  client: ReceiptWriteClient,
  accountId: string,
  items: { receipts?: readonly unknown[]; adjustmentReceipts?: readonly unknown[] }
): Promise<Json> {
  if (typeof client.syncReportingReceipts !== 'function') {
    throw new ReportingSubscriptionError('UNSUPPORTED_FEATURE', 'The client has no syncReportingReceipts method.', {
      dispatched: false,
    });
  }
  const result = await client.syncReportingReceipts({
    account: { account_id: accountId },
    idempotency_key: `rrcpt-${randomUUID()}`,
    ...(items.receipts?.length ? { receipts: [...items.receipts] } : {}),
    ...(items.adjustmentReceipts?.length ? { adjustment_receipts: [...items.adjustmentReceipts] } : {}),
  });
  const data = result.data as Json | undefined;
  const errors = (data?.errors as Json[] | undefined) ?? [];
  if (!result.success || !data || data.status === 'failed' || errors.length > 0) {
    const first = errors[0];
    throw new ReportingSubscriptionError(
      String(first?.code ?? 'RECEIPT_WRITE_FAILED'),
      `The seller did not record the reporting receipts: ${String(first?.message ?? result.error ?? 'no response')}. Retry.`,
      { recovery: 'transient' }
    );
  }
  return data;
}
