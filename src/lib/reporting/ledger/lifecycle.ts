import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import { projectReportingObligationHealthV1 } from './health';
import type {
  ReportingLedgerRevisionV1,
  ReportingLedgerStatusTransitionV1,
  ReportingLedgerStore,
  ReportingLedgerSubscriberV1,
  ReportingObservedFinalityV1,
} from './types';

export async function reconcileReportingStatusLifecycleV1(input: {
  store: ReportingLedgerStore;
  reporting_obligation_id: string;
  ledgerAsOf: string;
  subscribers?: readonly ReportingLedgerSubscriberV1[];
}): Promise<ReportingLedgerStatusTransitionV1 | null> {
  const obligation = await input.store.getObligation(input.reporting_obligation_id);
  if (!obligation) throw new Error('Reporting obligation is unavailable');
  const transactionalNotifications = input.store.transactionalNotificationActivity === true;
  if (transactionalNotifications && (input.subscribers?.length ?? 0) > 0) {
    throw new Error('Transactional reporting notification activity and legacy subscribers are mutually exclusive');
  }
  const revisions = await input.store.listRevisions(obligation.reporting_obligation_id);
  const projection = projectReportingObligationHealthV1(
    obligation,
    revisions,
    input.ledgerAsOf,
    Date.parse(obligation.period.end) <= Date.parse(input.ledgerAsOf)
  );
  const transitions = await input.store.listTransitions(obligation.reporting_obligation_id);
  const pendingTransitions = transitions.filter(value => !value.notifiedAt);
  if (transactionalNotifications && pendingTransitions.length > 0) {
    throw new Error(
      'Drain or explicitly resolve legacy pending reporting transitions before enabling transactional notification activity'
    );
  }
  for (const pending of pendingTransitions) {
    if (pending.previousHealth === pending.health) {
      await input.store.markTransitionNotified(pending.transitionId, input.ledgerAsOf);
      continue;
    }
    if (await notifyTransition(pending, obligation.account.account_id, input.subscribers)) {
      await input.store.markTransitionNotified(pending.transitionId, input.ledgerAsOf);
    }
  }
  const latest = transitions.at(-1);
  if (latest && Date.parse(input.ledgerAsOf) < Date.parse(latest.occurredAt)) return null;
  const previousHealth = latest?.health ?? 'waiting';
  const finality = observedFinality(revisions);
  const previousFinality = await resolveFinalityBaseline(
    input.store,
    obligation.reporting_obligation_id,
    latest,
    finality
  );
  const nextIssueIds = new Set(projection.issues.map(issue => issue.issueId));
  const transition: ReportingLedgerStatusTransitionV1 | undefined =
    previousHealth === projection.health && previousFinality === finality
      ? undefined
      : {
          transitionId: `rst_${createHash('sha256')
            .update(
              canonicalJsonV1([
                obligation.reporting_obligation_id,
                previousHealth,
                projection.health,
                previousFinality,
                finality,
                [...nextIssueIds].sort(),
                input.ledgerAsOf,
              ])
            )
            .digest('base64url')
            .slice(0, 32)}`,
          reporting_obligation_id: obligation.reporting_obligation_id,
          previousHealth,
          health: projection.health,
          previousFinality,
          finality,
          issueIds: [...nextIssueIds].sort(),
          occurredAt: input.ledgerAsOf,
        };
  const applied = await input.store.applyLifecycleProjection({
    reporting_obligation_id: obligation.reporting_obligation_id,
    expectedRevisionIds: revisions.map(value => value.reporting_revision_id),
    expectedPreviousHealth: previousHealth,
    expectedPreviousFinality: previousFinality,
    expectedObligationState: obligation.state,
    expectedAttemptCount: obligation.attemptCount,
    projectedIssues: projection.issues,
    ledgerAsOf: input.ledgerAsOf,
    ...(transition ? { transition } : {}),
  });
  if (!applied.applied || !transition || !applied.transitionInserted) return null;
  if (transactionalNotifications) return { ...transition, notifiedAt: input.ledgerAsOf };
  if (transition.previousHealth === transition.health) {
    await input.store.markTransitionNotified(transition.transitionId, input.ledgerAsOf);
    return { ...transition, notifiedAt: input.ledgerAsOf };
  }
  const notified = await notifyTransition(transition, obligation.account.account_id, input.subscribers);
  if (notified) await input.store.markTransitionNotified(transition.transitionId, input.ledgerAsOf);
  return notified ? { ...transition, notifiedAt: input.ledgerAsOf } : transition;
}

/**
 * Resolves the one authoritative finality baseline the transition decision and
 * the store's compare-and-set must both use.
 *
 * Transitions written from SDK 14 onward carry their own `finality`, so the
 * baseline is that committed value. Pre-SDK-14 rows carry none, and no stored
 * timestamp can recover which revisions had committed when such a row was
 * recorded — payload timestamps rank creation rather than commits, and insert
 * wall clocks tie and step backward. A store that implements the port therefore
 * commits `'none'` for those rows, which records at most one redundant
 * finality-only transition per obligation at upgrade.
 *
 * A store that does **not** implement the port cannot commit anything, and
 * cannot be assumed to persist the `finality` field either. Returning `'none'`
 * for such a store would make every reconciliation tick observe
 * `'none' -> official` and write another finality-only transition, forever. So
 * finality is treated as unobservable there: the baseline is the currently
 * observed finality, which makes the comparison a no-op. Such a store behaves
 * exactly as it did before finality existed — health transitions still fire,
 * finality-only ones simply never do — which is both stable and backward
 * compatible.
 */
async function resolveFinalityBaseline(
  store: ReportingLedgerStore,
  reporting_obligation_id: string,
  latest: ReportingLedgerStatusTransitionV1 | undefined,
  observed: ReportingObservedFinalityV1
): Promise<ReportingObservedFinalityV1> {
  if (!latest) return 'none';
  if (latest.finality) return latest.finality;
  if (store.resolveTransitionFinalityBaseline) {
    return store.resolveTransitionFinalityBaseline(reporting_obligation_id);
  }
  return observed;
}

function observedFinality(
  revisions: readonly Pick<ReportingLedgerRevisionV1, 'finality'>[]
): ReportingObservedFinalityV1 {
  if (revisions.some(value => value.finality === 'official')) return 'official';
  return revisions.length > 0 ? 'snapshot' : 'none';
}

export async function retryReportingStatusNotificationsV1(input: {
  store: ReportingLedgerStore;
  ledgerAsOf: string;
  account_id?: string;
  subscribers?: readonly ReportingLedgerSubscriberV1[];
  limit?: number;
}): Promise<number> {
  const pending = await input.store.listPendingTransitions({
    ...(input.account_id ? { account_id: input.account_id } : {}),
    limit: input.limit ?? 100,
  });
  const obligationIds = [...new Set(pending.map(value => value.reporting_obligation_id))];
  for (const reporting_obligation_id of obligationIds) {
    await reconcileReportingStatusLifecycleV1({
      store: input.store,
      reporting_obligation_id,
      ledgerAsOf: input.ledgerAsOf,
      subscribers: input.subscribers,
    });
  }
  return obligationIds.length;
}

/** Reconcile bounded clock-driven waiting→delayed→action_required transitions. */
export async function reconcileReportingStatusDeadlinesV1(input: {
  store: ReportingLedgerStore;
  ledgerAsOf: string;
  account_id?: string;
  subscribers?: readonly ReportingLedgerSubscriberV1[];
  limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('limit must be 1..1000');
  const asOf = Date.parse(input.ledgerAsOf);
  if (!Number.isFinite(asOf)) throw new TypeError('ledgerAsOf must be an RFC 3339 instant');
  const due = (
    await input.store.listLifecycleDueObligations({
      ledgerAsOf: input.ledgerAsOf,
      ...(input.account_id ? { account_id: input.account_id } : {}),
      limit,
    })
  ).map(value => value.reporting_obligation_id);
  for (const reporting_obligation_id of due) {
    await reconcileReportingStatusLifecycleV1({
      store: input.store,
      reporting_obligation_id,
      ledgerAsOf: input.ledgerAsOf,
      subscribers: input.subscribers,
    });
  }
  return due.length;
}

async function notifyTransition(
  transition: ReportingLedgerStatusTransitionV1,
  accountId: string,
  configured: readonly ReportingLedgerSubscriberV1[] | undefined
): Promise<boolean> {
  const subscribers = (configured ?? []).filter(value => value.account_id === accountId);
  if (subscribers.length === 0) return true;
  if (subscribers.length > 64) throw new Error('Reporting status subscriber fanout exceeds 64');
  const results = await Promise.allSettled(
    subscribers.map(subscriber =>
      withTimeout(
        Promise.resolve().then(() => subscriber.notify(structuredClone(transition))),
        10_000
      )
    )
  );
  return results.every(value => value.status === 'fulfilled');
}

async function withTimeout(value: void | Promise<void>, timeoutMilliseconds: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Reporting status subscriber notification timed out')),
          timeoutMilliseconds
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
