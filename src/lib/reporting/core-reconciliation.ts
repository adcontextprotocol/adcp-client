import type { ReportingObligation, ReportingRevision } from '../types';
import {
  aggregateReportingHealthV1,
  projectReportingObligationHealthV1,
  type ReportingObligationHealthProjectionV1,
} from './ledger/health';
import { canonicalReportingInstant } from './ledger/instant';
import type { ReportingHealthV1 } from './ledger/types';

const MAX_CORE_LEDGER_RECORDS = 100_000;

/** Wire obligation fields used by Core buyer reconciliation. */
export type CoreReportingObligationV1 = Pick<
  ReportingObligation,
  | 'reporting_obligation_id'
  | 'account_id'
  | 'report_definition_id'
  | 'reporting_profile'
  | 'media_buy_ids'
  | 'scope_resolved_at'
  | 'coverage'
  | 'period'
  | 'expected_at'
  | 'required_finality'
>;

/** Wire revision fields used by Core buyer reconciliation. */
export type CoreReportingRevisionV1 = Pick<
  ReportingRevision,
  | 'reporting_revision_id'
  | 'account_id'
  | 'report_definition_id'
  | 'reporting_profile'
  | 'media_buy_ids'
  | 'period'
  | 'finality'
  | 'row_count'
>;

export interface CoreReportingScopeV1 {
  /** Whether no more obligations can enter the evaluated scope. */
  closed: boolean;
  /** Whether the buyer has the complete obligation denominator. */
  coverageComplete: boolean;
}

export interface CoreReportingClocksV1 {
  /** Buyer evaluation clock. Boundary comparisons are inclusive at due time. */
  ledgerAsOf: string;
  /** Seller-advertised Core recovery window from reporting capabilities. */
  automatedRecoveryWindowSeconds: number;
}

/**
 * Core-only buyer input. The absence of managed-delivery and receipt hooks is
 * intentional: callers that need those tiers continue to use
 * `reconcileReporting`.
 */
export interface ReconcileReportingCoreInputV1 {
  obligations: readonly CoreReportingObligationV1[];
  revisions: readonly CoreReportingRevisionV1[];
  scope: CoreReportingScopeV1;
  clocks: CoreReportingClocksV1;
}

export interface CoreReportingObligationResultV1 extends ReportingObligationHealthProjectionV1 {
  reportingObligationId: string;
  /** Every immutable Core revision joined to this logical reporting slice. */
  reportingRevisionIds: string[];
  revisionCount: number;
  qualifyingRevisionCount: number;
}

export interface ReconcileReportingCoreResultV1 {
  health: ReportingHealthV1;
  obligations: CoreReportingObligationResultV1[];
}

/**
 * Reconcile the required reporting Core tier from ledger facts alone.
 *
 * A revision is joined by the protocol's Core logical-slice identity because
 * Core revisions intentionally do not carry destination, materialization, or
 * obligation identifiers. A zero-row revision is still a revision and
 * therefore satisfies the obligation when its finality and coverage qualify.
 *
 * This function performs no I/O and cannot invoke managed delivery, inspect a
 * resource, or submit a receipt. Rich existing callers remain on the separate
 * `reconcileReporting` path.
 */
export function reconcileReportingCoreV1(input: ReconcileReportingCoreInputV1): ReconcileReportingCoreResultV1 {
  const ledgerAsOf = canonicalReportingInstant(input.clocks.ledgerAsOf);
  const recoveryWindowMilliseconds = recoveryWindow(input.clocks.automatedRecoveryWindowSeconds);
  if (input.obligations.length + input.revisions.length > MAX_CORE_LEDGER_RECORDS) {
    throw new TypeError(`Core reporting input exceeds ${MAX_CORE_LEDGER_RECORDS} records`);
  }
  assertUnique(input.obligations, item => item.reporting_obligation_id, 'reporting obligation');
  assertUnique(input.revisions, item => item.reporting_revision_id, 'reporting revision');

  const revisionsByScope = new Map<string, CoreReportingRevisionV1[]>();
  for (const revision of input.revisions) {
    const key = reportingSliceKey(revision);
    const revisions = revisionsByScope.get(key);
    if (revisions) revisions.push(revision);
    else revisionsByScope.set(key, [revision]);
  }

  let associatedRecordCount = 0;
  const obligationScopes = input.obligations.map(obligation => {
    const revisions = revisionsByScope.get(reportingSliceKey(obligation)) ?? [];
    associatedRecordCount += revisions.length;
    if (associatedRecordCount > MAX_CORE_LEDGER_RECORDS) {
      throw new TypeError(`Core reporting associations exceed ${MAX_CORE_LEDGER_RECORDS} records`);
    }
    return { obligation, revisions };
  });

  const obligations = obligationScopes.map(({ obligation, revisions }) => {
    const qualifyingRevisionCount = revisions.filter(
      revision => obligation.required_finality === 'snapshot' || revision.finality === 'official'
    ).length;
    const projection = projectReportingObligationHealthV1(
      {
        reporting_obligation_id: obligation.reporting_obligation_id,
        scopeResolvedAt: obligation.scope_resolved_at,
        expectedAt: obligation.expected_at,
        recoveryWindowMilliseconds,
        requiredFinality: obligation.required_finality,
        coverage: { status: obligation.coverage.status },
        state: 'pending',
      },
      revisions,
      ledgerAsOf,
      input.scope.closed
    );
    return {
      reportingObligationId: obligation.reporting_obligation_id,
      reportingRevisionIds: revisions.map(revision => revision.reporting_revision_id).sort(),
      revisionCount: revisions.length,
      qualifyingRevisionCount,
      ...projection,
    };
  });

  return {
    health: aggregateReportingHealthV1(
      obligations.map(obligation => obligation.health),
      input.scope
    ),
    obligations,
  };
}

function reportingSliceKey(value: CoreReportingRevisionV1 | CoreReportingObligationV1): string {
  const mediaBuyIds = [...value.media_buy_ids].sort();
  if (new Set(mediaBuyIds).size !== mediaBuyIds.length) {
    throw new TypeError('Core reporting media_buy_ids must be unique');
  }
  return JSON.stringify([
    value.account_id,
    value.report_definition_id,
    value.reporting_profile,
    mediaBuyIds,
    canonicalReportingInstant(value.period.start),
    canonicalReportingInstant(value.period.end),
    value.period.source_timezone,
  ]);
}

function assertUnique<T>(values: readonly T[], id: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const valueId = id(value);
    if (seen.has(valueId)) throw new TypeError(`duplicate ${label} id`);
    seen.add(valueId);
  }
}

function recoveryWindow(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new TypeError('clocks.automatedRecoveryWindowSeconds must be a non-negative safe integer');
  }
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError('clocks.automatedRecoveryWindowSeconds is outside the supported range');
  }
  return milliseconds;
}
