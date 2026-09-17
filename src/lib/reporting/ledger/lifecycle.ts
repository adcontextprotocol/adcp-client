import { createHash } from 'node:crypto';

import { canonicalJsonV1 } from '../source';
import { moreSevereReportingHealthV1, projectManagedDelivery } from './handler';
import { compareReportingInstants } from './instant';
import { projectReportingObligationHealthV1 } from './health';
import type { ReportingAdjustmentReceipt, ReportingReceipt } from '../../types';
import type {
  ReportingLedgerIssueV1,
  ReportingLedgerRevisionV1,
  ReportingLedgerStatusTransitionV1,
  ReportingLedgerStore,
  ReportingLedgerSubscriberV1,
  ReportingObservedFinalityV1,
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
  const resolved = (await input.store.readLedgerInstant?.()) ?? (input.now ?? (() => new Date()))().toISOString();
  if (input.ledgerAsOf === undefined) return resolved;
  // A pin wins on the first attempt, but never past the ledger's own clock.
  // A caller pinning an instant ahead of the database — a fast host, or a
  // synthetic time replayed against a live store — had that instant written
  // into the watermark, and every database-timestamped change inside the
  // skew was then permanently behind it: excluded from the projection that
  // wrote it, and never due again. Clamping keeps a backdated replay exact
  // while making a forward pin harmless.
  //
  // A store with its own clock therefore never returns anything but that
  // clock on a retry. Taking the later of the two instead put the caller's
  // future pin straight back: the database was at 04:45, the retry resolved
  // 04:46, and the pinned 06:00 won again — so the first attempt's clamp was
  // undone by the very CAS retry that exists to take a fresh cutoff.
  if (input.store.readLedgerInstant) {
    return attempt === 0 && compareReportingInstants(input.ledgerAsOf, resolved) <= 0 ? input.ledgerAsOf : resolved;
  }
  // No authoritative clock at all. There is nothing here to clamp a pin
  // against — `resolved` is the host's own `now`, which is exactly what the
  // caller overrode by pinning — so the first attempt takes the pin as given.
  // Clamping it against the host clock instead made a deliberately backdated
  // replay jump forward: a cutoff of 2026-01-01 against a host at 2026-01-04
  // persisted `action_required` at Jan 4 where the obligation was still
  // `waiting` at Jan 1, which is a reconcile of a moment the caller never
  // asked about.
  if (attempt === 0) return input.ledgerAsOf;
  // Retries still take a fresh instant, and keep the pin when it is later:
  // a simulated-time driver replaying synthetic instants has nothing else to
  // order by, and a cutoff must never move backwards past a transition
  // already recorded at a later instant.
  // `compareReportingInstants`, never `Date.parse`. Date truncates to
  // milliseconds, so a retry moving .123500Z to .123600Z compared equal and
  // kept the old cutoff — the projection then excluded a .123550Z write while
  // the digest, which is not cutoff-bounded, included it. That is exactly the
  // pairing the CAS cannot catch.
  return compareReportingInstants(resolved, input.ledgerAsOf) > 0 ? resolved : input.ledgerAsOf;
}

/**
 * Reconciles each obligation independently.
 *
 * A sweep spans tenants, so one obligation's failure — a failing external
 * roster callback, an unreachable subscriber, a corrupt row — must not stop
 * the obligations queued behind it, which in a fair-ordered sweep are the
 * ones that have waited longest. Errors are contained per obligation and
 * never carried across accounts; the count returned is what was attempted, so
 * a caller paging through a backlog still advances.
 */
async function reconcileEachIsolated(
  input: {
    store: ReportingLedgerStore;
    /** Only pinned when the caller explicitly asked for a synthetic cutoff. */
    pinnedLedgerAsOf?: string;
    ledgerAsOf: string;
    subscribers?: readonly ReportingLedgerSubscriberV1[];
  },
  obligationIds: readonly string[]
): Promise<number> {
  for (const reporting_obligation_id of obligationIds) {
    try {
      await reconcileReportingStatusLifecycleV1({
        store: input.store,
        reporting_obligation_id,
        // Selection needs one instant; each reconcile resolves its own so the
        // watermark it writes is the cutoff it actually read at. The sweep's
        // instant is handed down only as a fallback clock, for a store that
        // has none of its own — pinning it would put the sweep's cutoff into
        // every watermark, which is the skew problem over again.
        ...(input.pinnedLedgerAsOf !== undefined ? { ledgerAsOf: input.pinnedLedgerAsOf } : {}),
        now: () => new Date(input.ledgerAsOf),
        subscribers: input.subscribers,
      });
    } catch {
      // Contained per obligation, then backed off. Swallowing alone was not
      // enough: an oldest-first page of failing tenants re-selected the same
      // obligations on every sweep and no healthy work behind them ever ran.
      // The backoff never advances the watermark, so the work stays visible
      // as unresolved rather than being quietly dropped.
      await input.store.recordLifecycleFailure?.({ reporting_obligation_id }).catch(() => undefined);
    }
  }
  return obligationIds.length;
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
  if (attempt + 1 >= MAX_LIFECYCLE_CAS_ATTEMPTS) {
    // Exhausting the retry budget is a failure, not a completion. Returning
    // null quietly left the obligation with no watermark and no backoff, so a
    // continuously contended one stayed at the head of every oldest-first
    // page and starved every tenant behind it.
    await input.store
      .recordLifecycleFailure?.({ reporting_obligation_id: input.reporting_obligation_id })
      .catch(() => undefined);
    return null;
  }
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
  const transactionalNotifications = input.store.transactionalNotificationActivity === true;
  if (transactionalNotifications && (input.subscribers?.length ?? 0) > 0) {
    throw new Error('Transactional reporting notification activity and legacy subscribers are mutually exclusive');
  }
  // Resolve the cutoff before anything reads against it. A retry always takes
  // a fresh one: the previous attempt lost a race, so re-evaluating at the
  // instant it already failed at can only fail again or apply a stale health.
  let ledgerAsOf = await resolveLedgerAsOf(input, attempt);
  // Two revision sets, deliberately. `revisions` is everything the store
  // holds and is what the compare-and-set fences on — that is a concurrency
  // check about the row set, not a statement about an instant. `projected` is
  // what the obligation had AT the cutoff, and is what the health and the
  // managed fold are computed from.
  const revisions = await input.store.listRevisions(obligation.reporting_obligation_id);
  let projected = revisions;
  const projectCore = (at: string) =>
    projectReportingObligationHealthV1(
      obligation,
      projected,
      at,
      compareReportingInstants(obligation.period.end, at) <= 0
    );
  let coreProjection = projectCore(ledgerAsOf);
  // Persist and notify the same health `get_reporting_status` returns. Before
  // this, the transition log carried Core health only: a managed delivery
  // failure or an outstanding consumer receipt could webhook `complete` with no
  // issues while a read of the same obligation returned `action_required` with
  // `RECEIPT_REQUIRED`, and a managed-only change produced no transition at all
  // so nothing was ever notified. The read path and this path now call the one
  // `projectManagedDelivery`, so the rule itself cannot drift again.
  let composed = await composeManagedLifecycleProjection(
    { store: input.store, ledgerAsOf },
    obligation,
    projected,
    coreProjection
  );
  // The store may resolve a different instant than the one asked for — a
  // microsecond cutoff where the caller had only milliseconds, or its own
  // clock. That resolved instant is the one the managed projection was
  // actually computed at, so everything downstream has to use it too: leaving
  // the host value in place watermarked a moment later than the projection
  // read, and every change in between was buried. Re-project once against it;
  // pinning it is idempotent, so this converges rather than looping.
  //
  // The same pass reports which revisions the cutoff actually held. Managed
  // evidence is cutoff-bounded, so a revision committed after the cutoff
  // arrived with no materialization and no receipt in scope and read as an
  // unmet obligation — a premature RECEIPT_REQUIRED for a revision that did
  // not exist at the instant being described.
  const visibleRevisionIds = composed.visibleRevisionIds;
  const scoped = visibleRevisionIds
    ? revisions.filter(value => visibleRevisionIds.includes(value.reporting_revision_id))
    : revisions;
  if (
    (composed.resolvedLedgerAsOf !== undefined &&
      compareReportingInstants(composed.resolvedLedgerAsOf, ledgerAsOf) !== 0) ||
    scoped.length !== projected.length
  ) {
    ledgerAsOf = composed.resolvedLedgerAsOf ?? ledgerAsOf;
    projected = scoped;
    coreProjection = projectCore(ledgerAsOf);
    composed = await composeManagedLifecycleProjection(
      { store: input.store, ledgerAsOf },
      obligation,
      projected,
      coreProjection
    );
  }
  const projection = composed.projection;
  const transitions = await input.store.listTransitions(obligation.reporting_obligation_id);
  const pendingTransitions = transitions.filter(value => !value.notifiedAt);
  if (transactionalNotifications && pendingTransitions.length > 0) {
    throw new Error(
      'Drain or explicitly resolve legacy pending reporting transitions before enabling transactional notification activity'
    );
  }
  for (const pending of pendingTransitions) {
    if (pending.previousHealth === pending.health) {
      await input.store.markTransitionNotified(pending.transitionId, ledgerAsOf);
      continue;
    }
    if (await notifyTransition(pending, obligation.account.account_id, input.subscribers)) {
      await input.store.markTransitionNotified(pending.transitionId, ledgerAsOf);
    }
  }
  const latest = transitions.at(-1);
  if (latest && compareReportingInstants(ledgerAsOf, latest.occurredAt) < 0) return null;
  const previousHealth = latest?.health ?? 'waiting';
  const finality = observedFinality(projected);
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
                ledgerAsOf,
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
    expectedPreviousFinality: previousFinality,
    expectedObligationState: obligation.state,
    expectedAttemptCount: obligation.attemptCount,
    projectedIssues: projection.issues,
    ledgerAsOf: ledgerAsOf,
    ...(transition ? { transition } : {}),
    ...(composed.managedStateVersion !== undefined
      ? {
          expectedManagedStateVersion: composed.managedStateVersion,
          processedManagedStateVersion: composed.managedStateVersion,
        }
      : {}),
    ...(composed.obligatedConsumerRosterVersion !== undefined
      ? {
          processedObligatedConsumerRosterVersion: composed.obligatedConsumerRosterVersion,
          // The re-check above is outside any transaction, so it leaves a
          // window the store closes by fencing on the same value.
          expectedObligatedConsumerRosterVersion: composed.obligatedConsumerRosterVersion,
        }
      : {}),
  });
  if (!applied.applied) return retryLifecycle(input, attempt);
  if (!transition || !applied.transitionInserted) return null;
  if (transactionalNotifications) return { ...transition, notifiedAt: ledgerAsOf };
  if (transition.previousHealth === transition.health) {
    await input.store.markTransitionNotified(transition.transitionId, ledgerAsOf);
    return { ...transition, notifiedAt: ledgerAsOf };
  }
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
  visibleRevisionIds?: readonly string[];
}> {
  if (!input.store.getManagedLifecycleProjection) return { projection: coreProjection };
  const managed = await input.store.getManagedLifecycleProjection({
    reporting_obligation_id: obligation.reporting_obligation_id,
    ledgerAsOf: input.ledgerAsOf,
  });
  if (!managed) return { projection: coreProjection };
  // Scoped to the cutoff, exactly as the receipts are: an adjustment the
  // ledger did not hold yet is not part of the moment this reconcile
  // describes, and folding it in demanded a receipt whose own row the same
  // cutoff filtered out. The store decides membership when it can, because
  // only it knows the column the cutoff is measured against — an adjustment
  // body's `createdAt` is the producer's host clock, and trusting it hid
  // committed corrections from a fast producer. `createdAt` remains the
  // fallback for a store that reports no visible set, where it is the only
  // instant available.
  const stored = await input.store.listAdjustments(obligation.reporting_obligation_id);
  const visibleAdjustmentIds = managed.visibleAdjustmentIds;
  const adjustments = visibleAdjustmentIds
    ? stored.filter(value => visibleAdjustmentIds.includes(value.reporting_adjustment_id))
    : stored.filter(value => compareReportingInstants(value.createdAt, input.ledgerAsOf) <= 0);
  // Aggregate over the obligated roster, not merely over whoever has already
  // submitted. A consumer that owes a receipt and has sent nothing has no
  // receipt row, so aggregating observed consumers alone let it disappear as
  // soon as another consumer accepted — the transition and its webhook went
  // reconciled while that consumer's own read still said `action_required`.
  // A complete roster is authoritative here too. Seeding from observed
  // principals first and only then layering the roster on top meant the
  // lifecycle folded in principals the roster excludes — the same widening
  // the live projection and the digest already refuse, so the three would
  // disagree about who owes a receipt.
  // Truncated receipt evidence is exactly as unproven as an unlisted roster:
  // in both cases some principal's receipts are not in hand, so neither may
  // be treated as authoritative about who has filed.
  const rosterAuthoritative =
    managed.obligatedConsumerRosterComplete === true && managed.receiptEvidenceComplete !== false;
  const observed = rosterAuthoritative ? [] : managed.consumers;
  const byConsumer = new Map(observed.map(value => [value.consumer_id, value]));
  for (const consumerId of managed.obligatedConsumerIds ?? []) {
    if (!byConsumer.has(consumerId)) {
      const submitted = managed.consumers.find(value => value.consumer_id === consumerId);
      byConsumer.set(consumerId, submitted ?? { consumer_id: consumerId, receipts: [], adjustmentReceipts: [] });
    }
  }
  const consumers: Array<{
    consumer_id?: string;
    receipts: ReportingReceipt[];
    adjustmentReceipts: ReportingAdjustmentReceipt[];
  }> = [...byConsumer.values()];
  // Fail safe while the roster is not provably complete: keep one zero-receipt
  // consumer in the fold so a `consumer_receipt` obligation is never called
  // reconciled on the strength of the consumers that happened to be observed.
  // Also covers the plain "nobody has submitted yet" case for either mode.
  if (!consumers.length || (managed.binding.reconciliation_mode === 'consumer_receipt' && !rosterAuthoritative)) {
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
      input.ledgerAsOf,
      // Scoped to the consumer being projected. An acceptance A left behind
      // must never settle the obligation for B, which would let a webhook go
      // complete while B's own read still says action_required.
      // The anonymous fail-safe consumer owns no acceptances. Matching every
      // tombstone to it let one consumer's pruned acceptance satisfy the
      // stand-in for "someone unknown may still owe a receipt", flipping an
      // incomplete-roster obligation to complete while real consumers were
      // still pending.
      consumer.consumer_id === undefined
        ? []
        : (managed.tombstonedAcceptedSubjects ?? []).filter(value => value.consumerId === consumer.consumer_id),
      managed.tombstonedDeliveredRevisionIds ?? []
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
    ...(managed.visibleRevisionIds !== undefined ? { visibleRevisionIds: managed.visibleRevisionIds } : {}),
  };
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
  /** Omit to let the store supply an authoritative instant. */
  ledgerAsOf?: string;
  /**
   * Clock to use only when the store cannot supply its own instant.
   *
   * A store backed by a database is authoritative and this is ignored. An
   * in-memory or simulated-time store has no clock of its own, so a driver
   * that advances time must still be able to say what "now" means without
   * pinning a cutoff that would be written into the watermark verbatim.
   */
  fallbackLedgerAsOf?: string;
  account_id?: string;
  subscribers?: readonly ReportingLedgerSubscriberV1[];
  limit?: number;
}): Promise<number> {
  const pending = await input.store.listPendingTransitions({
    ...(input.account_id ? { account_id: input.account_id } : {}),
    limit: input.limit ?? 100,
  });
  const ledgerAsOf =
    input.ledgerAsOf ??
    (await input.store.readLedgerInstant?.()) ??
    input.fallbackLedgerAsOf ??
    new Date().toISOString();
  const obligationIds = [...new Set(pending.map(value => value.reporting_obligation_id))];
  return reconcileEachIsolated({ ...input, ledgerAsOf, pinnedLedgerAsOf: input.ledgerAsOf }, obligationIds);
}

/** Reconcile bounded clock-driven waiting→delayed→action_required transitions. */
export async function reconcileReportingStatusDeadlinesV1(input: {
  store: ReportingLedgerStore;
  /** Omit to let the store supply an authoritative instant. */
  ledgerAsOf?: string;
  /**
   * Clock to use only when the store cannot supply its own instant.
   *
   * A store backed by a database is authoritative and this is ignored. An
   * in-memory or simulated-time store has no clock of its own, so a driver
   * that advances time must still be able to say what "now" means without
   * pinning a cutoff that would be written into the watermark verbatim.
   */
  fallbackLedgerAsOf?: string;
  account_id?: string;
  subscribers?: readonly ReportingLedgerSubscriberV1[];
  limit?: number;
}): Promise<number> {
  const limit = input.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('limit must be 1..1000');
  // Prefer the ledger's own clock. A production sweep that pinned host time
  // wrote that instant straight into the watermark, so a host running even a
  // minute fast permanently buried every database-timestamped receipt
  // committed inside that minute.
  const ledgerAsOf =
    input.ledgerAsOf ??
    (await input.store.readLedgerInstant?.()) ??
    input.fallbackLedgerAsOf ??
    new Date().toISOString();
  if (!Number.isFinite(Date.parse(ledgerAsOf))) throw new TypeError('ledgerAsOf must be an RFC 3339 instant');
  // Publish current roster versions first. A roster change is only visible to
  // due selection once someone records it, and recording it only inside a
  // reconcile is circular: the reconcile needs the obligation to already be
  // due, which is what the roster change was supposed to cause.
  await input.store.refreshObligatedConsumerRosterVersions?.({
    ...(input.account_id ? { account_id: input.account_id } : {}),
    limit,
  });
  const due = (
    await input.store.listLifecycleDueObligations({
      ledgerAsOf,
      ...(input.account_id ? { account_id: input.account_id } : {}),
      limit,
    })
  ).map(value => value.reporting_obligation_id);
  return reconcileEachIsolated({ ...input, ledgerAsOf, pinnedLedgerAsOf: input.ledgerAsOf }, due);
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
