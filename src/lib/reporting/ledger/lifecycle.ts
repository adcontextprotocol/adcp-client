import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import { moreSevereReportingHealthV1, projectManagedDelivery } from './handler';
import { projectReportingObligationHealthV1 } from './health';
import type { ReportingAdjustmentReceipt, ReportingReceipt } from '../../types';
import type {
  ReportingLedgerIssueV1,
  ReportingLedgerStatusTransitionV1,
  ReportingLedgerStore,
  ReportingLedgerSubscriberV1,
} from './types';

/**
 * The instant this reconcile runs at.
 *
 * A caller-pinned cutoff wins on the first attempt, because a deadline sweep
 * legitimately replays synthetic times. Everything else prefers the store's
 * own clock: a host `Date` is millisecond-truncated while the ledger's
 * timestamps are microsecond, so a cutoff taken in the same millisecond as a
 * write sorts before that write and the row vanishes from the projection.
 * Retries never reuse the pinned value, and the cutoff never moves backwards
 * past a transition already recorded at a later instant.
 */
async function resolveLedgerAsOf(
  input: { store: ReportingLedgerStore; ledgerAsOf?: string; now?: () => Date },
  attempt: number
): Promise<string> {
  if (attempt === 0 && input.ledgerAsOf !== undefined) return input.ledgerAsOf;
  const resolved = (await input.store.readLedgerInstant?.()) ?? (input.now ?? (() => new Date()))().toISOString();
  if (input.ledgerAsOf === undefined) return resolved;
  return Date.parse(resolved) > Date.parse(input.ledgerAsOf) ? resolved : input.ledgerAsOf;
}

/** Bounded so a contended obligation falls back to the sweep instead of spinning. */
const MAX_LIFECYCLE_CAS_ATTEMPTS = 3;

/**
 * Re-runs a reconcile whose compare-and-set was refused.
 *
 * Core evidence, managed state or the external roster moved under us.
 * Recompute rather than waiting for the next deadline sweep, which for a
 * managed-only change may not be scheduled at all — that is how a stale
 * `complete` would otherwise stay persisted and notified.
 *
 * The retry deliberately drops the pinned cutoff so the store resolves a fresh
 * authoritative instant at full precision. Reusing the original would re-read
 * the same as-of bounded view that just lost the race and reapply the health
 * the CAS refused, and a host-taken replacement would reintroduce the
 * millisecond truncation the projection exists to avoid.
 */
async function retryLifecycle(
  input: Parameters<typeof reconcileReportingStatusLifecycleV1>[0],
  attempt: number
): Promise<ReportingLedgerStatusTransitionV1 | null> {
  if (attempt + 1 >= MAX_LIFECYCLE_CAS_ATTEMPTS) return null;
  return reconcileReportingStatusLifecycleV1(input, attempt + 1);
}

export async function reconcileReportingStatusLifecycleV1(
  input: {
    store: ReportingLedgerStore;
    reporting_obligation_id: string;
    /**
     * Cutoff to reconcile at. Omit it — and prefer omitting it outside a
     * deadline sweep — to let the store supply an authoritative instant at
     * full precision instead of a millisecond-truncated host `Date`.
     */
    ledgerAsOf?: string;
    /** Fallback clock for a store that cannot supply its own instant. */
    now?: () => Date;
    subscribers?: readonly ReportingLedgerSubscriberV1[];
  },
  attempt = 0
): Promise<ReportingLedgerStatusTransitionV1 | null> {
  const obligation = await input.store.getObligation(input.reporting_obligation_id);
  if (!obligation) throw new Error('Reporting obligation is unavailable');
  // Resolve the cutoff before anything reads against it. A retry always takes
  // a fresh one: the previous attempt lost a race, so re-evaluating at the
  // instant it already failed at can only fail again or apply a stale health.
  const ledgerAsOf = await resolveLedgerAsOf(input, attempt);
  const revisions = await input.store.listRevisions(obligation.reporting_obligation_id);
  const coreProjection = projectReportingObligationHealthV1(
    obligation,
    revisions,
    ledgerAsOf,
    Date.parse(obligation.period.end) <= Date.parse(ledgerAsOf)
  );
  // Persist and notify the same health `get_reporting_status` returns. Before
  // this, the transition log carried Core health only: a managed delivery
  // failure or an outstanding consumer receipt could webhook `complete` with no
  // issues while a read of the same obligation returned `action_required` with
  // `RECEIPT_REQUIRED`, and a managed-only change produced no transition at all
  // so nothing was ever notified. The read path and this path now call the one
  // `projectManagedDelivery`, so the rule itself cannot drift again.
  const composed = await composeManagedLifecycleProjection(
    { store: input.store, ledgerAsOf },
    obligation,
    revisions,
    coreProjection
  );
  const projection = composed.projection;
  const transitions = await input.store.listTransitions(obligation.reporting_obligation_id);
  for (const pending of transitions.filter(value => !value.notifiedAt)) {
    if (await notifyTransition(pending, obligation.account.account_id, input.subscribers)) {
      await input.store.markTransitionNotified(pending.transitionId, ledgerAsOf);
    }
  }
  const latest = transitions.at(-1);
  if (latest && Date.parse(ledgerAsOf) < Date.parse(latest.occurredAt)) return null;
  const previousHealth = latest?.health ?? 'waiting';
  const nextIssueIds = new Set(projection.issues.map(issue => issue.issueId));
  const transition: ReportingLedgerStatusTransitionV1 | undefined =
    previousHealth === projection.health
      ? undefined
      : {
          transitionId: `rst_${createHash('sha256')
            .update(
              canonicalJsonV1([
                obligation.reporting_obligation_id,
                previousHealth,
                projection.health,
                [...nextIssueIds].sort(),
                ledgerAsOf,
              ])
            )
            .digest('base64url')
            .slice(0, 32)}`,
          reporting_obligation_id: obligation.reporting_obligation_id,
          previousHealth,
          health: projection.health,
          issueIds: [...nextIssueIds].sort(),
          occurredAt: ledgerAsOf,
        };
  // The roster lives outside the database, so the apply transaction cannot
  // re-read it. Re-check its version here, immediately before the apply and
  // outside any transaction, and treat a change exactly like a CAS failure —
  // otherwise a roster edit concurrent with this reconcile would ride through
  // unfenced and settle an obligation against a membership that no longer
  // holds.
  if (composed.obligatedConsumerRosterVersion !== undefined && input.store.readObligatedConsumerRosterVersion) {
    const current = await input.store.readObligatedConsumerRosterVersion({
      reporting_obligation_id: obligation.reporting_obligation_id,
    });
    if (current !== composed.obligatedConsumerRosterVersion) {
      return retryLifecycle(input, attempt);
    }
  }
  const applied = await input.store.applyLifecycleProjection({
    reporting_obligation_id: obligation.reporting_obligation_id,
    expectedRevisionIds: revisions.map(value => value.reporting_revision_id),
    expectedPreviousHealth: previousHealth,
    expectedObligationState: obligation.state,
    expectedAttemptCount: obligation.attemptCount,
    projectedIssues: projection.issues,
    ledgerAsOf: ledgerAsOf,
    ...(transition ? { transition } : {}),
    ...(composed.managedStateVersion !== undefined
      ? { expectedManagedStateVersion: composed.managedStateVersion }
      : {}),
  });
  if (!applied.applied) return retryLifecycle(input, attempt);
  if (!transition || !applied.transitionInserted) return null;
  const notified = await notifyTransition(transition, obligation.account.account_id, input.subscribers);
  if (notified) await input.store.markTransitionNotified(transition.transitionId, ledgerAsOf);
  return notified ? { ...transition, notifiedAt: ledgerAsOf } : transition;
}

/**
 * Receipt issues describe one consumer's own reconciliation, and their
 * `openedAt` is that consumer's exact receipt ingest instant.
 *
 * The issue store is keyed by obligation and carries no consumer dimension, and
 * `get_reporting_status` republishes persisted issues to whichever consumer is
 * reading. Persisting these would therefore hand every other consumer on the
 * same obligation another tenant's receipt state and timing — the same
 * cross-tenant leak the handler already refuses to republish
 * `CONSUMER_STATUS_MISMATCH` for. Their severity still folds into the
 * obligation's `health`, which is a seller-side fact and leaks nothing; the
 * issues themselves are recomputed per caller on every read from that caller's
 * own receipts.
 */
const CONSUMER_SCOPED_RECEIPT_ISSUE_CODES: ReadonlySet<string> = new Set([
  'RECEIPT_REQUIRED',
  'RECEIPT_REJECTED',
  'ADJUSTMENT_RECEIPT_REQUIRED',
  'ADJUSTMENT_RECEIPT_REJECTED',
]);

/**
 * Folds the Managed Delivery projection into the Core projection for one
 * obligation, per consumer, keeping the most severe result.
 *
 * A store without `getManagedLifecycleProjection`, or an obligation with no
 * managed binding, returns the Core projection untouched.
 */
async function composeManagedLifecycleProjection(
  input: { store: ReportingLedgerStore; ledgerAsOf: string },
  obligation: Awaited<ReturnType<ReportingLedgerStore['getObligation']>> & object,
  revisions: Awaited<ReturnType<ReportingLedgerStore['listRevisions']>>,
  coreProjection: ReturnType<typeof projectReportingObligationHealthV1>
): Promise<{
  projection: ReturnType<typeof projectReportingObligationHealthV1>;
  managedStateVersion?: string;
  obligatedConsumerRosterVersion?: string;
  resolvedLedgerAsOf?: string;
}> {
  if (!input.store.getManagedLifecycleProjection) return { projection: coreProjection };
  const managed = await input.store.getManagedLifecycleProjection({
    reporting_obligation_id: obligation.reporting_obligation_id,
    ledgerAsOf: input.ledgerAsOf,
  });
  if (!managed) return { projection: coreProjection };
  const adjustments = await input.store.listAdjustments(obligation.reporting_obligation_id);
  // Aggregate over the obligated roster, not merely over whoever has already
  // submitted. A consumer that owes a receipt and has sent nothing has no
  // receipt row, so aggregating observed consumers alone let it disappear as
  // soon as another consumer accepted — the transition and its webhook went
  // reconciled while that consumer's own read still said `action_required`.
  const byConsumer = new Map(managed.consumers.map(value => [value.consumer_id, value]));
  for (const consumerId of managed.obligatedConsumerIds ?? []) {
    if (!byConsumer.has(consumerId)) {
      byConsumer.set(consumerId, { consumer_id: consumerId, receipts: [], adjustmentReceipts: [] });
    }
  }
  const consumers: Array<{ receipts: ReportingReceipt[]; adjustmentReceipts: ReportingAdjustmentReceipt[] }> = [
    ...byConsumer.values(),
  ];
  // Fail safe while the roster is not provably complete: keep one zero-receipt
  // consumer in the fold so a `consumer_receipt` obligation is never called
  // reconciled on the strength of the consumers that happened to be observed.
  // Also covers the plain "nobody has submitted yet" case for either mode.
  if (
    !consumers.length ||
    (managed.binding.reconciliation_mode === 'consumer_receipt' && managed.obligatedConsumerRosterComplete !== true)
  ) {
    consumers.push({ receipts: [], adjustmentReceipts: [] });
  }
  let health = coreProjection.health;
  let satisfied = coreProjection.satisfied;
  let suppressedReceiptIssue = false;
  const issues = new Map<string, ReportingLedgerIssueV1>(coreProjection.issues.map(value => [value.issueId, value]));
  for (const consumer of consumers) {
    const projected = projectManagedDelivery(
      obligation,
      managed.binding,
      revisions,
      adjustments,
      managed.materializations,
      managed.materializationHistory,
      consumer.receipts,
      consumer.adjustmentReceipts,
      coreProjection,
      input.ledgerAsOf
    );
    if (!projected) continue;
    health = moreSevereReportingHealthV1(health, projected.projection.health);
    // One consumer's outstanding receipt leaves the seller's obligation
    // unreconciled for the obligation as a whole. That is the seller-side
    // duty view and it is deliberate: `satisfied` is not caller-scoped.
    satisfied = satisfied && projected.projection.satisfied;
    for (const issue of projected.projection.issues) {
      if (CONSUMER_SCOPED_RECEIPT_ISSUE_CODES.has(issue.code)) {
        suppressedReceiptIssue = true;
        continue;
      }
      issues.set(issue.issueId, issue);
    }
  }
  // Suppressing the consumer-scoped issue must not leave the escalation
  // unexplained. With the bundled store the roster is never provably complete,
  // so a Reconciled Billing obligation sits at `action_required` from the
  // moment delivery succeeds; without this an operator would see that state,
  // and a webhook carrying it, with nothing at all saying why. Restate it once
  // at obligation scope from seller-visible facts only — no principal is named
  // and `openedAt` is the obligation's own expectation instant, never a
  // consumer's receipt ingest time — so it explains the health without
  // reintroducing the leak.
  //
  // It deliberately collapses all four suppressed codes into RECEIPT_REQUIRED
  // with a buyer-side action, even though the read path makes the two REJECTED
  // codes seller-responsible. Distinguishing them here would disclose that
  // some principal rejected the evidence, which is the cross-consumer fact the
  // suppression exists to withhold. The trade is a recommended action that can
  // point the wrong way on an obligation whose real problem is a rejection;
  // the operator still has the accurate, caller-scoped issue on any read.
  if (suppressedReceiptIssue) {
    const issueId = `reporting-issue.reconciliation-outstanding.${obligation.reporting_obligation_id}`;
    issues.set(issueId, {
      issueId,
      reporting_obligation_id: obligation.reporting_obligation_id,
      code: 'RECEIPT_REQUIRED',
      severity: 'action_required',
      responsibleParty: 'buyer',
      recommendedAction: 'contact_buyer',
      openedAt: obligation.expectedAt,
      observedAt: input.ledgerAsOf,
    });
  }
  return {
    projection: { ...coreProjection, health, satisfied, issues: [...issues.values()] },
    ...(managed.managedStateVersion !== undefined ? { managedStateVersion: managed.managedStateVersion } : {}),
    ...(managed.obligatedConsumerRosterVersion !== undefined
      ? { obligatedConsumerRosterVersion: managed.obligatedConsumerRosterVersion }
      : {}),
    ...(managed.resolvedLedgerAsOf !== undefined ? { resolvedLedgerAsOf: managed.resolvedLedgerAsOf } : {}),
  };
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
