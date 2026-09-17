import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import { compareReportingInstants, compareReportingInstantToOffset } from './instant';
import type {
  ReportingConsumerMismatchEscalationV1,
  ReportingOperationsContactV1,
  ReportingLedgerConsumerMismatchIssueV1,
  ReportingHealthV1,
  ReportingLedgerConsumerStatementV1,
  ReportingLedgerIssueV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionSnapshotV1,
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

/**
 * Validate an advertised escalation commitment at configuration time.
 *
 * An unchecked window is worse than none: `NaN` makes every comparison false so
 * escalation *silently never fires*, and a negative window makes every open
 * mismatch escalate on its first read. Both look like a working policy from the
 * outside. The wire schema also conditions
 * `consumer_mismatch_escalation_seconds` on `operations_contact` with at least
 * one of `url` / `email`, so a window advertised with nowhere to escalate to is
 * rejected here rather than emitted.
 */
export function assertReportingConsumerMismatchEscalation(
  escalation: ReportingConsumerMismatchEscalationV1 | undefined
): ReportingConsumerMismatchEscalationV1 | undefined {
  if (escalation === undefined) return undefined;
  const { escalationSeconds, operationsContact } = escalation;
  if (!Number.isSafeInteger(escalationSeconds) || escalationSeconds < 0) {
    throw new TypeError('consumerMismatchEscalation.escalationSeconds must be a non-negative safe integer');
  }
  if (!operationsContact || (!operationsContact.url && !operationsContact.email)) {
    throw new TypeError(
      'consumerMismatchEscalation.operationsContact requires at least one of url or email; ' +
        'the escalation window is only advertisable with a destination'
    );
  }
  return escalation;
}

/**
 * Resolve the one escalation commitment in force.
 *
 * The window can be configured on the ledger store, on the status handler, or
 * both, and the store's value is honoured when the handler is given none. A
 * caller that advertises only what it was handed directly therefore publishes
 * nothing for a store-only deployment while still enforcing the store's
 * window — buyers age issues against a clock the capability document denies.
 * Resolve through here for both enforcement and advertisement, and refuse two
 * disagreeing values rather than letting the views diverge.
 */
export function reportingEffectiveConsumerMismatchEscalationV1(
  fromOptions: ReportingConsumerMismatchEscalationV1 | undefined,
  store: unknown,
  configuredBy: string
): ReportingConsumerMismatchEscalationV1 | undefined {
  const fromStore = (store as { consumerMismatchEscalation?: ReportingConsumerMismatchEscalationV1 } | undefined)
    ?.consumerMismatchEscalation;
  if (!fromOptions) return fromStore;
  if (!fromStore) return fromOptions;
  if (
    fromOptions.escalationSeconds !== fromStore.escalationSeconds ||
    fromOptions.operationsContact.url !== fromStore.operationsContact.url ||
    fromOptions.operationsContact.email !== fromStore.operationsContact.email
  ) {
    throw new TypeError(
      `consumerMismatchEscalation differs between ${configuredBy} and the reporting ledger store; ` +
        'configure one value so a health-filtered periods read cannot disagree with the summary'
    );
  }
  return fromOptions;
}

/**
 * Project an escalation commitment into the wire fields of the seller's
 * `media_buy.reporting_delivery` capability block.
 *
 * The point is a single source of truth. The read handler decides escalation
 * from `consumerMismatchEscalation`, and the capability document tells buyers
 * what to expect; if an adopter hand-writes the document separately, the two
 * drift silently and buyers age issues against a window the seller does not
 * actually honor. Spread the result into the capability block built from the
 * same option value:
 *
 * ```ts
 * const escalation = { escalationSeconds: 86_400, operationsContact: { email: 'ops@seller.example' } };
 * const reportingDelivery = {
 *   reliable_reporting_version: '1.0',
 *   consumer_status_task: 'sync_reporting_status',
 *   ...reportingConsumerStatusCapabilityV1(escalation),
 * };
 * const getReportingStatus = createReportingStatusHandler(store, { resolveConsumerId, consumerMismatchEscalation: escalation });
 * ```
 *
 * Returns an empty object when no commitment is advertised — absence means the
 * seller publishes no escalation clock, never an unbounded one.
 */
export function reportingConsumerStatusCapabilityV1(escalation: ReportingConsumerMismatchEscalationV1 | undefined): {
  consumer_mismatch_escalation_seconds?: number;
  operations_contact?: ReportingOperationsContactV1;
} {
  const validated = assertReportingConsumerMismatchEscalation(escalation);
  if (!validated) return {};
  return {
    consumer_mismatch_escalation_seconds: validated.escalationSeconds,
    operations_contact: {
      ...(validated.operationsContact.url ? { url: validated.operationsContact.url } : {}),
      ...(validated.operationsContact.email ? { email: validated.operationsContact.email } : {}),
    },
  };
}

/**
 * Caller-scoped consumer-status disagreement, projected from immutable ledger
 * facts only.
 *
 * `health` is the caller/account view this mismatch forces. Everything except
 * a stale-`received` statement inside its grace window is immediately
 * `action_required`.
 */
export interface ReportingConsumerStatusMismatchProjectionV1 {
  issue: ReportingLedgerConsumerMismatchIssueV1;
  health: 'delayed' | 'action_required';
  /**
   * Boundary at which a `received` statement made stale by a seller
   * restatement stops being `delayed`. Absent for every other conflict kind,
   * which never had a grace window to begin with.
   */
  staleReceivedGraceDeadline?: string;
}

/**
 * Project the caller-scoped consumer-status mismatch for one obligation.
 *
 * Separately attributed by construction: it degrades only this authenticated
 * caller's view and never touches seller-authored obligation, revision, or
 * reliability evidence. Returns `undefined` when the caller's current leaf
 * agrees with the seller's projection, when there is no leaf at all (silence
 * is a counted unknown, not a conflict — see `consumer_status_pending`), or
 * when the seller's own projection is already degraded and therefore carries
 * its own production issue.
 */
export function projectReportingConsumerStatusMismatchV1(
  obligation: ReportingLedgerObligationV1,
  status: ReportingLedgerConsumerStatementV1 | undefined,
  revisions: readonly Pick<
    ReportingLedgerRevisionSnapshotV1,
    'reporting_revision_id' | 'revisionNumber' | 'supersedes_reporting_revision_id' | 'createdAt'
  >[],
  sellerHealth: ReportingHealthV1,
  ledgerAsOf: string,
  escalation?: ReportingConsumerMismatchEscalationV1
): ReportingConsumerStatusMismatchProjectionV1 | undefined {
  if (!status || (sellerHealth !== 'healthy' && sellerHealth !== 'complete')) return undefined;

  // The earliest instant the seller could have observed *any* conflict: the
  // projection only emits while seller health is healthy/complete, which
  // requires a qualifying revision. Dating an issue before that would let a
  // statement filed during a seller outage surface, on recovery, already past
  // its escalation boundary — the same defect the stale-received branch fixes
  // by taking the later of two instants.
  const earliestObservable = [...revisions]
    .map(value => value.createdAt)
    .sort((left, right) => compareReportingInstants(left, right))[0];

  let staleReceivedGraceDeadline: string | undefined;
  // Decided exactly against the anchor rather than against the rendered
  // deadline: materializing the deadline goes through `Date`, which floors to
  // milliseconds and would close the window early for a legal sub-millisecond
  // supersession instant. The rendered string is still the reported boundary.
  let withinGrace = false;
  // `openedAt` must survive re-emission, so both branches anchor it to an
  // immutable ledger instant rather than to `ledgerAsOf`. Using the read time
  // would restart the escalation clock on every poll.
  let openedAt =
    earliestObservable !== undefined && compareReportingInstants(earliestObservable, status.recorded_at) > 0
      ? earliestObservable
      : status.recorded_at;

  if (status.consumer_status === 'received') {
    const current = [...revisions].sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
    // The buyer named the revision the seller still requires: no disagreement.
    if (current && status.reporting_revision_id === current.reporting_revision_id) return undefined;
    const firstSuperseding = firstSupersedingRevision(revisions, status.reporting_revision_id);
    if (firstSuperseding) {
      // Stale only because the seller restated. The buyer consumed exactly what
      // was then required and has not yet had a bounded chance to re-read, so
      // the deadline is anchored to the FIRST supersession of the revision the
      // buyer named. Later restatements supersede later revisions, so they
      // cannot restart this window — a seller cannot hold a genuinely
      // unresolved mismatch below `action_required` by restating on a timer.
      const slaMilliseconds = obligation.schedule.deliverySlaMilliseconds;
      const graceMilliseconds = slaMilliseconds > 0 ? slaMilliseconds : obligation.schedule.recoveryWindowMilliseconds;
      staleReceivedGraceDeadline = new Date(
        instant(firstSuperseding.createdAt, 'revision createdAt') + graceMilliseconds
      ).toISOString();
      withinGrace = compareReportingInstantToOffset(ledgerAsOf, firstSuperseding.createdAt, graceMilliseconds) < 0;
      // The grace deadline is anchored to the supersession; the *issue* is not.
      // A buyer may post `received` naming an already-superseded revision, and
      // dating the issue to the earlier supersession would open it before the
      // seller could possibly have observed the disagreement — with an
      // advertised escalation window shorter than that gap, the issue would be
      // emitted already escalated on its very first read. Take the later.
      openedAt =
        compareReportingInstants(firstSuperseding.createdAt, status.recorded_at) >= 0
          ? firstSuperseding.createdAt
          : status.recorded_at;
    }
    // No revision claims to supersede the one the buyer named, so the SDK
    // cannot prove the buyer read what the seller then required. Fail closed
    // to the immediate-escalation path rather than granting an unearned grace.
  }

  // `compareReportingInstantToOffset` is exact: it keeps sub-millisecond
  // fractions and accepts the leap seconds this module's own parser allows,
  // both of which `Date.parse` silently mangles — the first by truncating a
  // deadline to something earlier than it really is, the second by yielding NaN
  // and throwing out of a read handler that otherwise never throws.
  const escalated =
    escalation !== undefined &&
    compareReportingInstantToOffset(ledgerAsOf, openedAt, escalation.escalationSeconds * 1_000) >= 0;
  // The escalation boundary takes precedence over the grace window when the
  // two overlap: an unattended mismatch is an escalation, not a retry.
  const severity: 'delayed' | 'action_required' = !escalated && withinGrace ? 'delayed' : 'action_required';
  const responsibleParty: ReportingLedgerIssueV1['responsibleParty'] =
    status.consumer_status === 'unreadable' ? 'provider' : 'seller';

  return {
    issue: {
      issueId: consumerStatusMismatchIssueId(obligation, status),
      reporting_obligation_id: obligation.reporting_obligation_id,
      reporting_status_id: status.reporting_status_id,
      code: 'CONSUMER_STATUS_MISMATCH',
      severity,
      responsibleParty,
      recommendedAction: consumerStatusMismatchAction(status, severity, responsibleParty, escalated),
      openedAt,
      observedAt: ledgerAsOf,
    },
    health: severity,
    ...(staleReceivedGraceDeadline ? { staleReceivedGraceDeadline } : {}),
  };
}

/**
 * Earliest revision that explicitly supersedes `reportingRevisionId`.
 *
 * Ordered by `createdAt` with `revisionNumber` as the tie-break so the anchor
 * is stable even when two revisions share a commit instant.
 */
function firstSupersedingRevision<
  T extends { revisionNumber: number; supersedes_reporting_revision_id?: string; createdAt: string },
>(revisions: readonly T[], reportingRevisionId: string | undefined): T | undefined {
  if (!reportingRevisionId) return undefined;
  return revisions
    .filter(revision => revision.supersedes_reporting_revision_id === reportingRevisionId)
    .sort(
      (left, right) =>
        compareReportingInstants(left.createdAt, right.createdAt) || left.revisionNumber - right.revisionNumber
    )[0];
}

/**
 * The issue identity is one logical condition: this obligation plus the exact
 * consumer statement that caused it. Deliberately excludes severity and the
 * read time so the same `issueId` and `openedAt` carry across the `delayed` →
 * `action_required` transition and consumers age one work item instead of two.
 * A consumer superseding the causing statement is a new condition and
 * correctly produces a new `issueId`.
 */
function consumerStatusMismatchIssueId(
  obligation: ReportingLedgerObligationV1,
  status: ReportingLedgerConsumerStatementV1
): string {
  const digest = createHash('sha256')
    .update(
      canonicalJsonV1({
        kind: 'consumer_status_mismatch',
        reporting_obligation_id: obligation.reporting_obligation_id,
        reporting_status_id: status.reporting_status_id,
      })
    )
    .digest('hex')
    .slice(0, 32);
  return `rpti_${digest}`;
}

function consumerStatusMismatchAction(
  status: ReportingLedgerConsumerStatementV1,
  severity: 'delayed' | 'action_required',
  responsibleParty: ReportingLedgerIssueV1['responsibleParty'],
  escalated: boolean
): ReportingLedgerIssueV1['recommendedAction'] {
  // Past the advertised escalation boundary the action must name a human on
  // the diagnosed party. `wait_for_retry` and `repair_access` are both
  // automation hints, so neither may survive that boundary.
  if (escalated) {
    return responsibleParty === 'provider' ? 'contact_provider' : 'contact_seller';
  }
  if (severity === 'delayed') return 'wait_for_retry';
  return status.consumer_status === 'unreadable' ? 'repair_access' : 'contact_seller';
}
