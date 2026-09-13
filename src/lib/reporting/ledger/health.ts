import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import type {
  ReportingHealthV1,
  ReportingLedgerIssueV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionV1,
} from './types';

export interface ReportingObligationHealthProjectionV1 {
  health: ReportingHealthV1;
  productionStatus: 'not_due' | 'pending' | 'published' | 'failed';
  issues: ReportingLedgerIssueV1[];
  satisfied: boolean;
}

export function projectReportingObligationHealthV1(
  obligation: ReportingLedgerObligationV1,
  revisions: readonly Pick<ReportingLedgerRevisionV1, 'finality'>[],
  ledgerAsOf: string,
  scopeClosed = true
): ReportingObligationHealthProjectionV1 {
  const now = instant(ledgerAsOf, 'ledgerAsOf');
  const qualifying = revisions.filter(
    revision => obligation.requiredFinality === 'snapshot' || revision.finality === 'official'
  );
  if (qualifying.length > 0 && obligation.coverage.status === 'full') {
    return {
      health: scopeClosed ? 'complete' : 'healthy',
      productionStatus: 'published',
      issues: [],
      satisfied: true,
    };
  }
  if (qualifying.length > 0) {
    return {
      health: 'action_required',
      productionStatus: 'published',
      issues: [incompleteCoverageIssue(obligation, ledgerAsOf)],
      satisfied: false,
    };
  }
  const expectedAt = instant(obligation.expectedAt, 'expectedAt');
  if (now < expectedAt) {
    return {
      health: 'waiting',
      productionStatus: revisions.length ? 'published' : 'not_due',
      issues: [],
      satisfied: false,
    };
  }
  const recoveryDeadline = instant(obligation.recoveryDeadlineAt, 'recoveryDeadlineAt');
  const severity = obligation.state === 'terminal' || now >= recoveryDeadline ? 'action_required' : 'delayed';
  return {
    health: severity,
    productionStatus: revisions.length ? 'published' : obligation.state === 'terminal' ? 'failed' : 'pending',
    issues: [overdueIssue(obligation, severity, ledgerAsOf)],
    satisfied: false,
  };
}

function incompleteCoverageIssue(obligation: ReportingLedgerObligationV1, observedAt: string): ReportingLedgerIssueV1 {
  const digest = createHash('sha256')
    .update(canonicalJsonV1(['report-coverage-incomplete-v1', obligation.reporting_obligation_id]))
    .digest('base64url')
    .slice(0, 32);
  return {
    issueId: `rpti_${digest}`,
    reporting_obligation_id: obligation.reporting_obligation_id,
    code: 'REPORTING_COVERAGE_INCOMPLETE',
    severity: 'action_required',
    responsibleParty: 'seller',
    recommendedAction: 'contact_seller',
    openedAt: obligation.scopeResolvedAt,
    observedAt,
  };
}

export function aggregateReportingHealthV1(
  values: readonly ReportingHealthV1[],
  scope: { closed: boolean; coverageComplete: boolean }
): ReportingHealthV1 {
  if (!scope.coverageComplete || values.includes('action_required')) return 'action_required';
  if (values.length === 0) return scope.closed ? 'complete' : 'waiting';
  if (values.includes('delayed')) return 'delayed';
  if (scope.closed && values.every(value => value === 'complete')) return 'complete';
  if (values.some(value => value === 'healthy' || value === 'complete')) return 'healthy';
  return 'waiting';
}

function overdueIssue(
  obligation: ReportingLedgerObligationV1,
  severity: 'delayed' | 'action_required',
  observedAt: string
): ReportingLedgerIssueV1 {
  const digest = createHash('sha256')
    .update(canonicalJsonV1(['report-overdue-v1', obligation.reporting_obligation_id, obligation.requiredFinality]))
    .digest('base64url')
    .slice(0, 32);
  return {
    issueId: `rpti_${digest}`,
    reporting_obligation_id: obligation.reporting_obligation_id,
    code: 'REPORT_OVERDUE',
    severity,
    responsibleParty: 'seller',
    recommendedAction: severity === 'delayed' ? 'wait_for_retry' : 'contact_seller',
    openedAt: obligation.expectedAt,
    observedAt,
  };
}

function instant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an RFC 3339 instant`);
  return parsed;
}
