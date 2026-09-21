import type { ReportingObligation, ReportingRevision } from '../types';
import {
  aggregateReportingHealthV1,
  projectReportingObligationHealthV1,
  type ReportingObligationHealthProjectionV1,
} from './ledger/health';
import type { ReportingHealthV1 } from './ledger/types';

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
  const ledgerAsOf = instant(input.clocks.ledgerAsOf, 'clocks.ledgerAsOf');
  const recoveryWindowMilliseconds = recoveryWindow(input.clocks.automatedRecoveryWindowSeconds);
  assertUnique(input.obligations, item => item.reporting_obligation_id, 'reporting obligation');
  assertUnique(input.revisions, item => item.reporting_revision_id, 'reporting revision');

  const obligations = input.obligations.map(obligation => {
    const expectedAt = instant(obligation.expected_at, 'obligation.expected_at');
    const recoveryDeadlineAt = addMilliseconds(expectedAt, recoveryWindowMilliseconds);
    const revisions = input.revisions.filter(revision => revisionMatchesObligation(revision, obligation));
    const qualifyingRevisionCount = revisions.filter(
      revision => obligation.required_finality === 'snapshot' || revision.finality === 'official'
    ).length;
    const projection = projectReportingObligationHealthV1(
      {
        reporting_obligation_id: obligation.reporting_obligation_id,
        scopeResolvedAt: obligation.scope_resolved_at,
        expectedAt: obligation.expected_at,
        recoveryDeadlineAt,
        requiredFinality: obligation.required_finality,
        coverage: { status: obligation.coverage.status },
        state: 'pending',
      },
      revisions,
      new Date(ledgerAsOf).toISOString(),
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

function revisionMatchesObligation(revision: CoreReportingRevisionV1, obligation: CoreReportingObligationV1): boolean {
  return (
    revision.account_id === obligation.account_id &&
    revision.report_definition_id === obligation.report_definition_id &&
    revision.reporting_profile === obligation.reporting_profile &&
    sameStringSet(revision.media_buy_ids, obligation.media_buy_ids) &&
    revision.period.start === obligation.period.start &&
    revision.period.end === obligation.period.end &&
    revision.period.source_timezone === obligation.period.source_timezone
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return rightValues.size === right.length && left.every(value => rightValues.has(value));
}

function assertUnique<T>(values: readonly T[], id: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const valueId = id(value);
    if (seen.has(valueId)) throw new TypeError(`duplicate ${label} id: ${valueId}`);
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

function instant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an RFC 3339 instant`);
  return parsed;
}

function addMilliseconds(value: number, offset: number): string {
  const result = value + offset;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError('obligation recovery deadline is outside the supported range');
  }
  try {
    return new Date(result).toISOString();
  } catch {
    throw new TypeError('obligation recovery deadline is outside the supported range');
  }
}
