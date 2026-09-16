import { createHash } from 'node:crypto';

import { ADCP_MAJOR_VERSION, ADCP_VERSION } from '../../version';
import { AdcpError } from '../../server/decisioning/async-outcome';
import type { GetReportingStatusResponse } from '../../types';
import { canonicalJsonV1, reportingDeriveScheduleAlignmentV1 } from '../source';
import {
  evaluateReportingLedgerCoverageV1,
  relevantReportingLedgerConfigurations,
  reportingLedgerConfigurationMatchesScope,
  reportingLedgerEffectivePeriod,
  reportingLedgerScopeClosed,
} from './coverage';
import {
  aggregateReportingHealthV1,
  assertReportingConsumerMismatchEscalation,
  projectReportingConsumerStatusMismatchV1,
  projectReportingObligationHealthV1,
} from './health';
import { compareReportingInstants } from './instant';
import { ReportingLedgerSnapshotUnavailableError } from './types';
import type {
  ReportingConsumerMismatchEscalationV1,
  ReportingHealthV1,
  ReportingLedgerConfigurationV1,
  ReportingLedgerConsumerStatementV1,
  ReportingLedgerCoverageV1,
  ReportingLedgerIssueV1,
  ReportingLedgerObligationV1,
  ReportingLedgerSnapshotQueryV1,
  ReportingLedgerStore,
  ReportingDeliveryHandlerV1,
  ReportingStatusHandlerV1,
} from './types';

export interface ReportingStatusConsumerScopeOptionsV1<TContext = unknown> {
  resolveConsumerId(context: TContext): string | Promise<string>;
  /**
   * Mirror of the seller's advertised `consumer_mismatch_escalation_seconds` +
   * `operations_contact` capability block. Supply it only when the capability
   * document actually advertises both — the projection uses it to decide when
   * an unattended `CONSUMER_STATUS_MISMATCH` must become `action_required`
   * with a `contact_*` action, and advertising a window the reads don't honor
   * (or honoring one the document doesn't advertise) is worse than silence.
   */
  consumerMismatchEscalation?: ReportingConsumerMismatchEscalationV1;
}

export function createReportingStatusHandler<TContext = unknown>(
  store: ReportingLedgerStore,
  options?: ReportingStatusConsumerScopeOptionsV1<TContext>
): ReportingStatusHandlerV1 {
  // Fail at wiring time, not on the first escalated read. Inherit the store's
  // setting when the handler was not given one, and refuse a disagreement
  // outright: the store applies the `health` filter while building the
  // snapshot and the handler projects severity afterwards, so two different
  // windows would make a filtered periods read contradict the summary.
  const consumerMismatchEscalation = assertReportingConsumerMismatchEscalation(
    resolveConsumerMismatchEscalation(options?.consumerMismatchEscalation, store)
  );
  const activeReadsByAccount = new Map<string, number>();
  return async (request, context) => {
    const raw = request as unknown as Record<string, unknown>;
    const resolvedAccount = isRecord(context.account) ? context.account : {};
    const resolvedAccountId =
      typeof resolvedAccount.id === 'string'
        ? resolvedAccount.id
        : typeof resolvedAccount.account_id === 'string'
          ? resolvedAccount.account_id
          : undefined;
    if (!resolvedAccountId) throw new Error('get_reporting_status requires a resolved account');
    const accountId = resolvedAccountId;
    const consumerId = options ? await options.resolveConsumerId(context as TContext) : undefined;
    if (options && !consumerId) throw new Error('get_reporting_status requires an authenticated consumer');
    const view = raw.view;
    if (view !== 'summary' && view !== 'periods' && view !== 'revision') {
      throw new Error('Unsupported reporting status view');
    }
    let releaseReadSlot: () => void;
    try {
      releaseReadSlot = acquireAccountReadSlot(activeReadsByAccount, accountId, 16, 256);
    } catch (error) {
      if (error instanceof ReportingReadCapacityError) return operationalUnavailable(view);
      throw error;
    }
    try {
      const query: ReportingLedgerSnapshotQueryV1 = {
        account_id: accountId,
        ...(consumerId ? { consumer_id: consumerId } : {}),
        view,
        ...copyArray(raw, 'media_buy_ids'),
        ...copyArray(raw, 'delivery_config_ids'),
        ...copyArray(raw, 'feed_purposes'),
        ...copyArray(raw, 'health'),
        ...copyArray(raw, 'finality'),
        ...(typeof raw.reporting_revision_id === 'string' ? { reporting_revision_id: raw.reporting_revision_id } : {}),
        ...(typeof raw.changes_after === 'string' ? { changes_after: raw.changes_after } : {}),
        ...(isRecord(raw.period) ? { period: raw.period as { start?: string; end?: string } } : {}),
      } as ReportingLedgerSnapshotQueryV1;
      const pagination = isRecord(raw.pagination) ? raw.pagination : {};
      const limitValue = pagination.max_results ?? pagination.limit ?? 100;
      const limit =
        typeof limitValue === 'number' && Number.isFinite(limitValue)
          ? Math.max(1, Math.min(500, Math.trunc(limitValue)))
          : 100;
      const cursor = typeof pagination.cursor === 'string' ? pagination.cursor : undefined;
      let snapshotId: string | undefined;
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { snapshotId?: unknown };
          if (typeof decoded.snapshotId === 'string') snapshotId = decoded.snapshotId;
        } catch {
          return lookupUnavailable(view);
        }
      }
      let snapshot = null;
      if (!snapshotId) {
        try {
          snapshot = await store.createSnapshot(query);
        } catch (error) {
          if (error instanceof ReportingLedgerSnapshotUnavailableError || error instanceof ReportingReadCapacityError) {
            return lookupUnavailable(view);
          }
          if (isContinuityError(error)) return operationalUnavailable(view);
          throw error;
        }
      }
      let page;
      if (view === 'periods' || view === 'revision') {
        try {
          page = await store.readSnapshotPage(snapshotId ?? snapshot!.snapshotId, accountId, cursor, limit);
        } catch (error) {
          if (error instanceof ReportingLedgerSnapshotUnavailableError || error instanceof ReportingReadCapacityError) {
            return lookupUnavailable(view);
          }
          if (isContinuityError(error)) return operationalUnavailable(view);
          throw error;
        }
      } else {
        if (!snapshot) return lookupUnavailable(view);
        page = {
          snapshot,
          obligations: snapshot.obligations,
          revisions: snapshot.revisions,
          adjustments: snapshot.adjustments,
          totalCount: snapshot.obligations.length + snapshot.revisions.length + snapshot.adjustments.length,
          offset: 0,
          limit: snapshot.obligations.length || 1,
          hasMore: false,
        };
      }
      if (canonicalJsonV1(page.snapshot.query) !== canonicalJsonV1(query)) return lookupUnavailable(view);
      if (
        query.delivery_config_ids &&
        query.delivery_config_ids.some(
          deliveryConfigId =>
            !page.snapshot.configurations.some(configuration => configuration.delivery_config_id === deliveryConfigId)
        )
      ) {
        return lookupUnavailable(view);
      }
      if (
        query.media_buy_ids &&
        query.media_buy_ids.some(
          mediaBuyId =>
            !page.snapshot.configurations.some(configuration => configuration.mediaBuyIds.includes(mediaBuyId))
        )
      ) {
        return lookupUnavailable(view);
      }
      const ledgerCoverage = evaluateReportingLedgerCoverageV1(
        query,
        page.snapshot.configurations,
        page.snapshot.coverageOrdinals,
        page.snapshot.ledgerAsOf
      );
      const projected = page.snapshot.obligations.map(obligation => {
        const revisions = page.snapshot.revisions.filter(
          revision => revision.reporting_obligation_id === obligation.reporting_obligation_id
        );
        const projection = projectReportingObligationHealthV1(
          obligation,
          revisions,
          page.snapshot.ledgerAsOf,
          reportingLedgerScopeClosed(query, page.snapshot.ledgerAsOf, ledgerCoverage.complete)
        );
        const persistedIssues =
          projection.health === 'delayed' || projection.health === 'action_required'
            ? page.snapshot.issues.filter(
                issue =>
                  issue.reporting_obligation_id === obligation.reporting_obligation_id &&
                  !issue.resolvedAt &&
                  // A CONSUMER_STATUS_MISMATCH is caller-scoped, but the issue
                  // store is keyed by obligation alone and carries no consumer
                  // dimension. Republishing a persisted one would hand every
                  // other consumer on the same obligation the causing
                  // `reporting_status_id`, its `opened_at` (i.e. another
                  // tenant's exact ingest timing), and any `external_ref`
                  // ticket key — the precise cross-tenant leak the field's own
                  // contract forbids. This projection recomputes the mismatch
                  // from the caller's current leaf on every read, so the
                  // persisted copy is redundant as well as unsafe.
                  issue.code !== 'CONSUMER_STATUS_MISMATCH' &&
                  // Retiring an issue removes it from the projection rather
                  // than publishing it at a terminal state, which is what lets
                  // a reader treat a nonempty `issues[]` as degradation.
                  issue.issueState !== 'resolved' &&
                  issue.issueState !== 'waived'
              )
            : [];
        const consumerStatusHistory = (page.snapshot.consumerStatuses ?? []).filter(value =>
          consumerStatusMatchesObligation(value, obligation)
        );
        const consumerStatusProjection = (
          page.snapshot.consumerStatusProjection ??
          page.snapshot.consumerStatuses ??
          []
        ).filter(value => consumerStatusMatchesObligation(value, obligation));
        const currentConsumerStatus = currentStatusLeaf(consumerStatusProjection);
        // Gated on the authenticated consumer like every other consumer-derived
        // output here. The bundled store returns no statuses without a
        // `consumer_id`, but the `ReportingLedgerStore` interface does not
        // require that, and an unscoped custom store would otherwise publish
        // one caller's statement id into the shared `issues[]`.
        const mismatch =
          consumerId === undefined
            ? undefined
            : projectReportingConsumerStatusMismatchV1(
                obligation,
                currentConsumerStatus,
                revisions,
                projection.health,
                page.snapshot.ledgerAsOf,
                consumerMismatchEscalation
              );
        // A buyer that owes a status and has not posted one is a counted
        // unknown, never a conflict: it creates no issue, changes no health,
        // and is invisible to every other caller.
        const consumerStatusPending =
          consumerId !== undefined &&
          consumerStatusProjection.length === 0 &&
          // Strictly after: the duty is to post "no later than" the deadline, so
          // a buyer that posts at exactly that instant has met it.
          compareReportingInstants(page.snapshot.ledgerAsOf, obligation.recoveryDeadlineAt) > 0;
        return {
          obligation,
          revisions,
          consumerStatusHistory,
          consumerStatusProjection,
          currentConsumerStatus,
          consumerStatusPending,
          projection: {
            ...projection,
            ...(mismatch ? { health: mismatch.health } : {}),
            issues: uniqueIssues([...persistedIssues, ...projection.issues, ...(mismatch ? [mismatch.issue] : [])]),
          },
        };
      });
      const healthFilter = view === 'periods' && query.health ? new Set(query.health) : undefined;
      const selected = healthFilter ? projected.filter(value => healthFilter.has(value.projection.health)) : projected;
      const base = {
        status: 'completed',
        adcp_version: wireAdcpVersion(),
        adcp_major_version: ADCP_MAJOR_VERSION,
        view,
        ledger_snapshot_id: page.snapshot.snapshotId,
        ledger_as_of: page.snapshot.ledgerAsOf,
        account_id: accountId,
      };

      if (view === 'revision') {
        const id = query.reporting_revision_id;
        const inSnapshot = id ? page.snapshot.revisions.some(value => value.reporting_revision_id === id) : false;
        let revision = null;
        if (id && inSnapshot) {
          try {
            revision = await store.getRevision(id, accountId);
          } catch (error) {
            if (error instanceof ReportingReadCapacityError) return lookupUnavailable(view);
            throw error;
          }
        }
        if (!revision) {
          return lookupUnavailable(view);
        }
        return {
          ...base,
          view: 'revision',
          revision: revision.wireRevision,
          reporting_revision_binding: {
            reporting_revision_id: revision.reporting_revision_id,
            revision_content_sha256: revision.wireRevision.revision_content_sha256,
            row_count: revision.binding.rowCount,
          },
          reporting_rows: revision.rows,
          adjustments: page.adjustments
            .filter(value => value.adjusts_reporting_revision_id === revision.reporting_revision_id)
            .map(value => value.wireAdjustment),
          ...(consumerId ? { consumer_statuses: (page.consumerStatuses ?? []).map(wireConsumerStatus) } : {}),
          adjustment_receipts: [],
          materializations: [],
          receipts: [],
          errors: [],
          pagination: {
            has_more: page.hasMore,
            total_count: page.totalCount,
            ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
          },
        } as never;
      }

      if (view === 'periods') {
        const pageIds = new Set(page.obligations.map(value => value.reporting_obligation_id));
        const pageProjected = selected.filter(value => pageIds.has(value.obligation.reporting_obligation_id));
        return {
          ...base,
          view: 'periods',
          changes_checkpoint: page.snapshot.changesCheckpoint,
          scope: publicScope(query, page.snapshot.configurations, page.snapshot.ledgerAsOf, ledgerCoverage),
          ...(!ledgerCoverage.complete
            ? { issues: [wireIssue(historyUnavailableIssue(query, page.snapshot.ledgerAsOf))] }
            : {}),
          periods: pageProjected.map(value =>
            wireObligation(
              value.obligation,
              value.revisions.length,
              page.snapshot.adjustments.filter(
                adjustment => adjustment.reporting_obligation_id === value.obligation.reporting_obligation_id
              ).length,
              value.projection,
              value.currentConsumerStatus,
              consumerId ? value.consumerStatusProjection.length : undefined
            )
          ),
          revisions: page.revisions
            .filter(value => !query.finality || query.finality.includes(value.finality))
            .map(value => value.wireRevision),
          adjustments: page.adjustments.map(value => value.wireAdjustment),
          ...(consumerId ? { consumer_statuses: (page.consumerStatuses ?? []).map(wireConsumerStatus) } : {}),
          adjustment_receipts: [],
          materializations: [],
          receipts: [],
          pagination: {
            has_more: page.hasMore,
            total_count: page.totalCount,
            ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
          },
        } as never;
      }

      const healthValues = selected.map(value => value.projection.health);
      const issues = selected.flatMap(value => value.projection.issues);
      if (!ledgerCoverage.complete) issues.push(historyUnavailableIssue(query, page.snapshot.ledgerAsOf));
      return {
        ...base,
        view: 'summary',
        scope: publicScope(query, page.snapshot.configurations, page.snapshot.ledgerAsOf, ledgerCoverage),
        health: aggregateReportingHealthV1(healthValues, {
          closed: reportingLedgerScopeClosed(query, page.snapshot.ledgerAsOf, ledgerCoverage.complete),
          coverageComplete: ledgerCoverage.complete,
        }),
        coverage: aggregateReportingCoverageV1(
          selected.map(value => value.obligation.coverage),
          page.snapshot.ledgerAsOf
        ),
        data_through: aggregateDataThrough(selected),
        ...nextExpectedAt(selected),
        obligation_counts: counts(
          healthValues,
          // Required whenever the seller advertises consumer_status_task, which
          // in this handler is exactly when a consumer principal is resolved.
          // It overlaps the health counts rather than partitioning them.
          consumerId !== undefined ? selected.filter(value => value.consumerStatusPending).length : undefined
        ),
        issues: issues.map(wireIssue),
      } as never;
    } finally {
      releaseReadSlot();
    }
  };
}

/**
 * One escalation commitment for both the snapshot pre-filter and the
 * projection. Throws when the handler and the store were configured with
 * different windows rather than letting the two views silently diverge.
 */
function resolveConsumerMismatchEscalation(
  fromOptions: ReportingConsumerMismatchEscalationV1 | undefined,
  store: ReportingLedgerStore
): ReportingConsumerMismatchEscalationV1 | undefined {
  const fromStore = (store as { consumerMismatchEscalation?: ReportingConsumerMismatchEscalationV1 })
    .consumerMismatchEscalation;
  if (!fromOptions) return fromStore;
  if (!fromStore) return fromOptions;
  if (
    fromOptions.escalationSeconds !== fromStore.escalationSeconds ||
    fromOptions.operationsContact.url !== fromStore.operationsContact.url ||
    fromOptions.operationsContact.email !== fromStore.operationsContact.email
  ) {
    throw new TypeError(
      'consumerMismatchEscalation differs between createReportingStatusHandler and the reporting ledger store; ' +
        'configure one value so a health-filtered periods read cannot disagree with the summary'
    );
  }
  return fromOptions;
}

/** Exact revision reader for createAdcpServer's getMediaBuyDelivery slot. */
export function createReportingDeliveryHandler(store: ReportingLedgerStore): ReportingDeliveryHandlerV1 {
  const activeReadsByAccount = new Map<string, number>();
  return async (request, context) => {
    const accountId = resolvedAccountId(context.account);
    let releaseReadSlot: () => void;
    try {
      releaseReadSlot = acquireAccountReadSlot(activeReadsByAccount, accountId, 16, 256);
    } catch (error) {
      if (error instanceof ReportingReadCapacityError) {
        throw new AdcpError('SERVICE_UNAVAILABLE', {
          message: 'Reporting delivery read capacity is temporarily exhausted',
        });
      }
      throw error;
    }
    try {
      const raw = request as unknown as Record<string, unknown>;
      if (typeof raw.reporting_revision_id !== 'string' || !raw.reporting_revision_id) {
        throw new Error('Ledger delivery reads require reporting_revision_id');
      }
      const revision = await store.getRevision(raw.reporting_revision_id, accountId);
      if (!revision) throw new Error('Reporting revision is unavailable');
      const obligation = await store.getObligation(revision.reporting_obligation_id);
      if (!obligation || obligation.account.account_id !== accountId) {
        throw new Error('Reporting revision is unavailable');
      }
      const pagination = isRecord(raw.pagination) ? raw.pagination : {};
      const maxResults =
        typeof pagination.max_results === 'number' && Number.isFinite(pagination.max_results)
          ? Math.max(1, Math.min(500, Math.trunc(pagination.max_results)))
          : 100;
      let offset = 0;
      if (typeof pagination.cursor === 'string') {
        try {
          const cursor = JSON.parse(Buffer.from(pagination.cursor, 'base64url').toString('utf8')) as {
            revisionId?: unknown;
            offset?: unknown;
          };
          if (
            cursor.revisionId !== revision.reporting_revision_id ||
            typeof cursor.offset !== 'number' ||
            !Number.isSafeInteger(cursor.offset) ||
            cursor.offset < 0 ||
            cursor.offset >= revision.rows.length
          ) {
            throw new Error('invalid');
          }
          offset = cursor.offset;
        } catch {
          throw new Error('Reporting delivery cursor is invalid');
        }
      }
      const reportingRows = revision.rows.slice(offset, offset + maxResults);
      const nextOffset = offset + reportingRows.length;
      const hasMore = nextOffset < revision.rows.length;
      return {
        reporting_period: { start: obligation.period.start, end: obligation.period.end },
        media_buy_deliveries: [],
        reporting_rows: reportingRows,
        notification_type:
          revision.finality === 'official' ? 'final' : revision.revisionNumber > 1 ? 'adjusted' : 'scheduled',
        partial_data: false,
        unavailable_count: 0,
        sequence_number: revision.revisionNumber,
        reporting_revision_binding: {
          reporting_revision_id: revision.reporting_revision_id,
          content_sha256: revision.wireRevision.revision_content_sha256,
          row_count: revision.binding.rowCount,
          control_totals: revision.wireRevision.control_totals,
        },
        reporting_revision: revision.wireRevision,
        currency: obligation.sourceSettings.currency,
        errors: [],
        pagination: {
          has_more: hasMore,
          total_count: revision.rows.length,
          ...(hasMore
            ? {
                cursor: Buffer.from(
                  JSON.stringify({ revisionId: revision.reporting_revision_id, offset: nextOffset }),
                  'utf8'
                ).toString('base64url'),
              }
            : {}),
        },
      } as never;
    } finally {
      releaseReadSlot();
    }
  };
}

function resolvedAccountId(account: unknown): string {
  const resolved = isRecord(account) ? account : {};
  const accountId =
    typeof resolved.id === 'string'
      ? resolved.id
      : typeof resolved.account_id === 'string'
        ? resolved.account_id
        : undefined;
  if (!accountId) throw new Error('Reporting reads require a resolved account');
  return accountId;
}

function wireObligation(
  obligation: ReportingLedgerObligationV1,
  revisionCount: number,
  adjustmentCount: number,
  projection: ReturnType<typeof projectReportingObligationHealthV1>,
  currentConsumerStatus?: ReportingLedgerConsumerStatementV1,
  consumerStatusCount?: number
) {
  return {
    reporting_obligation_id: obligation.reporting_obligation_id,
    delivery_config_id: obligation.delivery_config_id,
    delivery_config_version: obligation.delivery_config_version,
    report_definition_id: obligation.report_definition_id,
    feed_purpose: obligation.feedPurpose,
    reporting_profile: obligation.contract.reportingProfile,
    account_id: obligation.account.account_id,
    media_buy_ids: obligation.mediaBuyIds,
    scope_resolved_at: obligation.scopeResolvedAt,
    coverage: wireCoverage(obligation.coverage),
    period: {
      start: obligation.period.start,
      end: obligation.period.end,
      source_timezone: obligation.period.sourceTimezone,
    },
    expected_at: obligation.expectedAt,
    schedule: wireSchedule(obligation),
    required_finality: obligation.requiredFinality,
    reconciliation_mode: 'delivery_only',
    reconciliation_status: 'not_required',
    health: projection.health,
    production_status: projection.productionStatus,
    revision_count: revisionCount,
    adjustment_count: adjustmentCount,
    ...(consumerStatusCount !== undefined
      ? {
          consumer_status_count: consumerStatusCount,
          ...(currentConsumerStatus ? { current_consumer_status_id: currentConsumerStatus.reporting_status_id } : {}),
        }
      : {}),
    issues: projection.issues.map(wireIssue),
  };
}

function consumerStatusMatchesObligation(
  status: ReportingLedgerConsumerStatementV1,
  obligation: ReportingLedgerObligationV1
): boolean {
  return (
    status.delivery_config_id === obligation.delivery_config_id &&
    status.delivery_config_version === obligation.delivery_config_version &&
    status.report_definition_id === obligation.report_definition_id &&
    compareReportingInstants(status.period.start, obligation.period.start) === 0 &&
    compareReportingInstants(status.period.end, obligation.period.end) === 0 &&
    status.period.source_timezone === obligation.period.sourceTimezone
  );
}

function currentStatusLeaf(
  statuses: ReportingLedgerConsumerStatementV1[]
): ReportingLedgerConsumerStatementV1 | undefined {
  const superseded = new Set(
    statuses.map(value => value.supersedes_reporting_status_id).filter((value): value is string => Boolean(value))
  );
  return statuses.find(value => !superseded.has(value.reporting_status_id));
}

function wireConsumerStatus(status: ReportingLedgerConsumerStatementV1) {
  const { consumerId: _consumerId, account_id: _accountId, ...wire } = status;
  return wire;
}

export class ReportingReadCapacityError extends Error {}

export function acquireAccountReadSlot(
  active: Map<string, number>,
  accountId: string,
  perAccountLimit = 16,
  globalLimit = 256
): () => void {
  const current = active.get(accountId) ?? 0;
  const global = [...active.values()].reduce((sum, value) => sum + value, 0);
  if (current >= perAccountLimit || global >= globalLimit) throw new ReportingReadCapacityError();
  active.set(accountId, current + 1);
  return () => {
    const remaining = (active.get(accountId) ?? 1) - 1;
    if (remaining > 0) active.set(accountId, remaining);
    else active.delete(accountId);
  };
}

function wireCoverage(coverage: ReportingLedgerCoverageV1) {
  return {
    status: coverage.status,
    evaluated_at: coverage.evaluatedAt,
    media_buy_ids: coverage.mediaBuyIds,
    fully_covered_media_buy_ids: coverage.fullyCoveredMediaBuyIds,
    partially_covered_media_buy_ids: coverage.partiallyCoveredMediaBuyIds,
    unsupported_media_buy_ids: coverage.unsupportedMediaBuyIds,
    unknown_media_buy_ids: coverage.unknownMediaBuyIds,
    package_ids: [],
    covered_package_ids: [],
    unsupported_package_ids: [],
    unknown_package_ids: [],
    limitations: [],
  };
}

function wireIssue(issue: ReportingLedgerIssueV1) {
  return {
    issue_id: issue.issueId,
    code: issue.code,
    severity: issue.severity,
    responsible_party: issue.responsibleParty,
    recommended_action: issue.recommendedAction,
    opened_at: issue.openedAt,
    // Omission means `open`, so only emit a state a store actually set. A
    // retired issue is removed from the projection rather than published at
    // `resolved` / `waived`, which keeps "nonempty issues[] means degraded"
    // true for readers.
    ...(issue.issueState === 'open' || issue.issueState === 'acknowledged' ? { issue_state: issue.issueState } : {}),
    ...(issue.externalRef ? { external_ref: issue.externalRef } : {}),
    ...(issue.reporting_status_id ? { reporting_status_id: issue.reporting_status_id } : {}),
    ...(issue.reporting_obligation_id === 'scope' ? {} : { reporting_obligation_id: issue.reporting_obligation_id }),
  };
}

export function aggregateReportingCoverageV1(values: ReportingLedgerCoverageV1[], asOf: string) {
  if (values.length === 0) {
    return wireCoverage({
      status: 'full',
      evaluatedAt: asOf,
      mediaBuyIds: [],
      fullyCoveredMediaBuyIds: [],
      partiallyCoveredMediaBuyIds: [],
      unsupportedMediaBuyIds: [],
      unknownMediaBuyIds: [],
    });
  }
  const ids = [...new Set(values.flatMap(value => value.mediaBuyIds))].sort();
  const fullCandidates = new Set(values.flatMap(value => value.fullyCoveredMediaBuyIds));
  const partialCandidates = new Set(values.flatMap(value => value.partiallyCoveredMediaBuyIds));
  const unsupportedCandidates = new Set(values.flatMap(value => value.unsupportedMediaBuyIds));
  const unknownCandidates = new Set(values.flatMap(value => value.unknownMediaBuyIds));
  const isCovered = (id: string) => fullCandidates.has(id) || partialCandidates.has(id);
  const isUncovered = (id: string) =>
    partialCandidates.has(id) || unsupportedCandidates.has(id) || unknownCandidates.has(id);
  const partial = ids.filter(id => isCovered(id) && isUncovered(id));
  const full = ids.filter(id => isCovered(id) && !isUncovered(id));
  const unknown = ids.filter(id => !isCovered(id) && unknownCandidates.has(id));
  const unsupported = ids.filter(id => !isCovered(id) && !unknownCandidates.has(id) && unsupportedCandidates.has(id));
  const status = values.every(value => value.status === 'full')
    ? 'full'
    : full.length || partial.length
      ? 'partial'
      : unknown.length
        ? 'unknown'
        : 'none';
  return wireCoverage({
    status,
    evaluatedAt: asOf,
    mediaBuyIds: ids,
    fullyCoveredMediaBuyIds: full,
    partiallyCoveredMediaBuyIds: partial,
    unsupportedMediaBuyIds: unsupported,
    unknownMediaBuyIds: unknown,
  });
}

function aggregateDataThrough(
  selected: Array<{
    revisions: Array<{ dataThrough: string | null }>;
    projection: { satisfied: boolean };
  }>
): string | null {
  const satisfied = selected.filter(value => value.projection.satisfied);
  if (!satisfied.length) return null;
  const watermarks = satisfied.map(value =>
    value.revisions
      .map(revision => revision.dataThrough)
      .filter((item): item is string => item !== null)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1)
  );
  return watermarks.some(value => !value)
    ? null
    : watermarks.sort((left, right) => Date.parse(left!) - Date.parse(right!))[0]!;
}

function nextExpectedAt(
  selected: Array<{ obligation: ReportingLedgerObligationV1; projection: { satisfied: boolean } }>
) {
  const values = selected
    .filter(value => !value.projection.satisfied)
    .map(value => value.obligation.expectedAt)
    .sort();
  return values[0] ? { next_expected_at: values[0] } : {};
}

function counts(values: ReportingHealthV1[], consumerStatusPending?: number) {
  return {
    total: values.length,
    waiting: values.filter(value => value === 'waiting').length,
    healthy: values.filter(value => value === 'healthy').length,
    delayed: values.filter(value => value === 'delayed').length,
    action_required: values.filter(value => value === 'action_required').length,
    complete: values.filter(value => value === 'complete').length,
    // Visibility count over the caller's own silence. Never a health input: it
    // must not change health, any other count, or advertised reliability
    // statistics, so it is computed independently of `values`.
    ...(consumerStatusPending !== undefined ? { consumer_status_pending: consumerStatusPending } : {}),
  };
}

function publicScope(
  query: ReportingLedgerSnapshotQueryV1,
  configurations: ReportingLedgerConfigurationV1[],
  ledgerAsOf: string,
  coverage: { complete: boolean; retainedFrom: string }
) {
  const { start: periodStart, end: periodEnd } = reportingLedgerEffectivePeriod(query, ledgerAsOf);
  configurations = relevantReportingLedgerConfigurations(configurations, periodStart, periodEnd).filter(configuration =>
    reportingLedgerConfigurationMatchesScope(query, configuration)
  );
  const generations = [
    ...new Map(
      configurations.map(value => [
        `${value.delivery_config_id}\0${value.delivery_config_version}`,
        {
          delivery_config_id: value.delivery_config_id,
          delivery_config_version: value.delivery_config_version,
          feed_purpose: value.feedPurpose,
        },
      ])
    ).values(),
  ];
  return {
    period_start: periodStart,
    period_end: periodEnd,
    scope_closed: Date.parse(periodEnd) <= Date.parse(ledgerAsOf) && coverage.complete,
    ...(query.media_buy_ids ? { media_buy_ids: [...query.media_buy_ids].sort() } : {}),
    all_accessible_media_buys: query.media_buy_ids === undefined,
    delivery_config_generations: generations,
    feed_purposes: query.feed_purposes ?? [...new Set(configurations.map(value => value.feedPurpose))].sort(),
    finality: query.finality ?? [...new Set(configurations.map(value => value.requiredFinality))].sort(),
    ledger_retained_from: coverage.retainedFrom,
    coverage_complete: coverage.complete,
  };
}

function wireAdcpVersion(): string {
  return ADCP_VERSION.replace(/^(\d+\.\d+)\.0-/, '$1-');
}

function uniqueIssues(issues: ReportingLedgerIssueV1[]): ReportingLedgerIssueV1[] {
  return [...new Map(issues.map(value => [value.issueId, value])).values()];
}

function lookupUnavailable(view: ReportingLedgerSnapshotQueryV1['view']): GetReportingStatusResponse {
  return {
    status: 'failed',
    view,
    failure_kind: 'lookup_unavailable',
    errors: [{ code: 'NOT_FOUND', message: 'Reporting status resource is unavailable.' }],
  } as GetReportingStatusResponse;
}

function operationalUnavailable(view: ReportingLedgerSnapshotQueryV1['view']): GetReportingStatusResponse {
  return {
    status: 'failed',
    view,
    failure_kind: 'operational',
    errors: [{ code: 'HISTORY_UNAVAILABLE', message: 'Reporting history is temporarily unavailable.' }],
  } as GetReportingStatusResponse;
}

function isContinuityError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ReportingLedgerContinuityError';
}

function historyUnavailableIssue(query: ReportingLedgerSnapshotQueryV1, observedAt: string): ReportingLedgerIssueV1 {
  const period = reportingLedgerEffectivePeriod(query, observedAt);
  const issueId = createHash('sha256')
    .update(canonicalJsonV1(['history-unavailable-v1', query.account_id, period]))
    .digest('base64url')
    .slice(0, 32);
  return {
    issueId: `rpti_${issueId}`,
    reporting_obligation_id: 'scope',
    code: 'HISTORY_UNAVAILABLE',
    severity: 'action_required',
    responsibleParty: 'seller',
    recommendedAction: 'contact_seller',
    // Anchored to the period, not the read. `issueId` is already stable across
    // polls for one account+period, and rc.3 emits `opened_at` on the wire, so
    // using `observedAt` here would advance a supposedly-fixed instant on every
    // poll of the same issue.
    openedAt: period.start,
    observedAt,
  };
}

function copyArray(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = raw[key];
  return Array.isArray(value) ? { [key]: [...value].sort() } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Project an obligation's schedule under the alignment it actually describes.
 *
 * `core/reporting-schedule.json` forbids `period_anchor` for every alignment
 * except `billing_cycle`, and forbids `period_timezone` for `utc`. Reporting a
 * spec-origin schedule as `billing_cycle` therefore both contradicts what the
 * offering advertised at discovery and carries a field the wire rejects for the
 * alignment the buyer was promised.
 */
function wireSchedule(obligation: ReportingLedgerObligationV1) {
  const anchorMs = Date.parse(obligation.schedule.anchor);
  // Echo the identity the configuration was installed with. Only a generation
  // that predates the stored identity falls back to deriving one, which keeps
  // pre-existing ledgers projecting exactly as they did before.
  const alignment =
    obligation.schedule.alignment ??
    reportingDeriveScheduleAlignmentV1({
      periodMilliseconds: obligation.schedule.periodMilliseconds,
      anchorMs,
      sourceTimezone: obligation.period.sourceTimezone,
    });
  const periodTimezone = obligation.schedule.periodTimezone ?? obligation.period.sourceTimezone;
  return {
    period_duration: obligation.schedule.periodDuration ?? `PT${obligation.schedule.periodMilliseconds / 1_000}S`,
    alignment,
    ...(alignment === 'billing_cycle' ? { period_anchor: obligation.schedule.anchor } : {}),
    ...(alignment === 'utc' ? {} : { period_timezone: periodTimezone }),
    // Echo the installed lexical duration. Recomputing it from expected_at
    // would answer PT3600S where the offering advertised PT1H — the same
    // instant, but not the same value installed_schedule_match compares.
    delivery_sla:
      obligation.schedule.deliverySlaDuration ??
      `PT${(Date.parse(obligation.expectedAt) - Date.parse(obligation.period.end)) / 1_000}S`,
  };
}
