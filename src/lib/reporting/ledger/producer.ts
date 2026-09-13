import { createHash, randomUUID } from 'node:crypto';

import type { ReportingAdjustment, ReportingControlTotal, ReportingRevision } from '../../types';
import { ReportingAdjustmentSchema, ReportingRevisionSchema } from '../../schemas';
import { canonicalize } from '../../utils/jcs';
import {
  canonicalJsonV1,
  reportingIsoDurationMillisecondsV1,
  reportingCoverageDenominatorFingerprintV1,
  REPORTING_SOURCE_CONTRACT_VERSION_V1,
  validateReportingSourceExecutionV1,
  type ReportingSourceManifestV1,
  type ReportingSourceOfferingV1,
  type ReportingSourceSliceRequestV1,
} from '../source';
import { reportingLedgerSuccessor } from './coverage';
import {
  reconcileReportingStatusDeadlinesV1,
  reconcileReportingStatusLifecycleV1,
  retryReportingStatusNotificationsV1,
} from './lifecycle';
import type {
  CreateReportingProducerOptionsV1,
  ReportingLedgerAdjustmentV1,
  ReportingLedgerConfigurationV1,
  ReportingLedgerObligationV1,
  ReportingLedgerRevisionV1,
  ReportingProducerV1,
} from './types';

const DEFAULT_LEASE_MS = 300_000;
const EXECUTION_DEADLINE_MS = 240_000;
const DEFAULT_SETTLEMENT_GRACE_MS = 10_000;
const MAX_SETTLEMENT_GRACE_MS = 30_000;
const MAX_REVISION_OBJECTS = 10_000;
const MAX_REVISION_BYTES = 64 * 1024 * 1024;
const MAX_REVISION_ROWS = 1_000_000;

export function createReportingProducer(options: CreateReportingProducerOptionsV1): ReportingProducerV1 {
  const offeringById = new Map(options.offerings.map(offering => [offering.offeringId, offering]));
  if (offeringById.size !== options.offerings.length) throw new TypeError('Reporting offering IDs must be unique');
  if (!options.contact.name.trim()) throw new TypeError('Reporting producer contact name is required');
  const subscribersByAccount = new Map<string, number>();
  for (const subscriber of options.subscribers ?? []) {
    const count = (subscribersByAccount.get(subscriber.account_id) ?? 0) + 1;
    if (count > 64) throw new Error('Reporting status subscriber fanout exceeds 64');
    subscribersByAccount.set(subscriber.account_id, count);
  }

  return {
    async installConfiguration(input) {
      const normalizedInput = {
        ...structuredClone(input),
        schedule: {
          ...structuredClone(input.schedule),
          anchor: new Date(instant(input.schedule.anchor, 'schedule.anchor')).toISOString(),
        },
        ...(input.supersededAt
          ? { supersededAt: new Date(instant(input.supersededAt, 'supersededAt')).toISOString() }
          : {}),
      };
      const offering = requiredOffering(offeringById, normalizedInput.offeringId);
      validateConfigurationAgainstOffering(normalizedInput, offering);
      const existing = (await options.store.listConfigurations(normalizedInput.account.account_id)).filter(
        value => value.delivery_config_id === normalizedInput.delivery_config_id
      );
      if (existing.some(value => value.delivery_config_version > normalizedInput.delivery_config_version)) {
        throw new Error('Reporting configuration version cannot regress');
      }
      const semantic = { ...normalizedInput };
      const semanticFingerprint = prefixedDigest(semantic);
      const replay = existing.find(value => value.delivery_config_version === normalizedInput.delivery_config_version);
      if (replay) {
        if (replay.semanticFingerprint !== semanticFingerprint) {
          throw new Error('Reporting configuration generation is immutable');
        }
        return replay;
      }
      const installedAt = new Date().toISOString();
      const configuration: ReportingLedgerConfigurationV1 = {
        ...normalizedInput,
        sourceTimezone: normalizedInput.sourceTimezone,
        configurationId: `rcfg_${digest([
          normalizedInput.account.account_id,
          normalizedInput.delivery_config_id,
          normalizedInput.delivery_config_version,
        ]).slice(0, 32)}`,
        installedAt,
        semanticFingerprint,
      };
      return (await options.store.putConfiguration(configuration)).value;
    },

    async planObligations(now = new Date().toISOString(), planOptions = {}) {
      const nowMs = instant(now, 'now');
      const maxObligations = planOptions.maxObligations ?? 1_000;
      positiveInteger(maxObligations, 'maxObligations');
      const created: ReportingLedgerObligationV1[] = [];
      let attempted = 0;
      const configurations = await options.store.listConfigurations(planOptions.account_id);
      const obligationsByAccount = new Map<string, ReportingLedgerObligationV1[]>();
      for (const configuration of configurations) {
        const anchor = instant(configuration.schedule.anchor, 'schedule.anchor');
        const effectiveFrom = Math.max(anchor, instant(configuration.installedAt, 'installedAt'));
        const successor = reportingLedgerSuccessor(configuration, configurations);
        const generationEndValue = Math.min(
          successor ? instant(successor.installedAt, 'successor.installedAt') : Number.POSITIVE_INFINITY,
          configuration.supersededAt ? instant(configuration.supersededAt, 'supersededAt') : Number.POSITIVE_INFINITY
        );
        const generationEnd = Number.isFinite(generationEndValue) ? generationEndValue : undefined;
        const effectiveUntil = Math.min(nowMs, generationEnd ?? nowMs);
        const first = Math.max(0, Math.ceil((effectiveFrom - anchor) / configuration.schedule.periodMilliseconds));
        const ownershipLast = generationEnd
          ? Math.ceil((effectiveUntil - anchor) / configuration.schedule.periodMilliseconds) - 1
          : Number.POSITIVE_INFINITY;
        const latestClosed = Math.floor((nowMs - anchor) / configuration.schedule.periodMilliseconds) - 1;
        const last = Math.min(ownershipLast, latestClosed);
        let accountObligations = obligationsByAccount.get(configuration.account.account_id);
        if (!accountObligations) {
          accountObligations = await options.store.listObligations(configuration.account.account_id);
          obligationsByAccount.set(configuration.account.account_id, accountObligations);
        }
        const existingOrdinals = accountObligations
          .filter(value => value.configurationId === configuration.configurationId)
          .map(value => value.periodOrdinal);
        const candidates = missingOrdinals(first, last, existingOrdinals, maxObligations - attempted);
        for (const ordinal of candidates) {
          attempted += 1;
          const obligation = planObligation(configuration, ordinal, now);
          const written = await options.store.putObligation(obligation);
          if (written.inserted) {
            created.push(written.value);
            await reconcileReportingStatusLifecycleV1({
              store: options.store,
              reporting_obligation_id: written.value.reporting_obligation_id,
              ledgerAsOf: now,
              subscribers: options.subscribers,
            });
          }
          if (attempted >= maxObligations) return created;
        }
      }
      return created;
    },

    async runWorker(workerOptions = {}) {
      const now = workerOptions.now ?? (() => new Date());
      const maxIterations = workerOptions.maxIterations ?? 25;
      const retryDelay = workerOptions.retryDelayMilliseconds ?? 30_000;
      const executionDeadline = workerOptions.executionDeadlineMilliseconds ?? EXECUTION_DEADLINE_MS;
      const settlementGrace = workerOptions.settlementGraceMilliseconds ?? DEFAULT_SETTLEMENT_GRACE_MS;
      positiveInteger(maxIterations, 'maxIterations');
      positiveInteger(retryDelay, 'retryDelayMilliseconds');
      positiveInteger(executionDeadline, 'executionDeadlineMilliseconds');
      positiveInteger(settlementGrace, 'settlementGraceMilliseconds');
      if (executionDeadline > EXECUTION_DEADLINE_MS) {
        throw new RangeError(`executionDeadlineMilliseconds must not exceed ${EXECUTION_DEADLINE_MS}`);
      }
      if (settlementGrace > MAX_SETTLEMENT_GRACE_MS) {
        throw new RangeError(`settlementGraceMilliseconds must not exceed ${MAX_SETTLEMENT_GRACE_MS}`);
      }
      const owner = `reporting-worker-${randomUUID()}`;
      const counts = { claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 };
      await retryReportingStatusNotificationsV1({
        store: options.store,
        ledgerAsOf: now().toISOString(),
        ...(workerOptions.account_id ? { account_id: workerOptions.account_id } : {}),
        subscribers: options.subscribers,
      });
      await reconcileReportingStatusDeadlinesV1({
        store: options.store,
        ledgerAsOf: now().toISOString(),
        ...(workerOptions.account_id ? { account_id: workerOptions.account_id } : {}),
        subscribers: options.subscribers,
      });
      for (let iteration = 0; iteration < maxIterations; iteration += 1) {
        workerOptions.signal?.throwIfAborted();
        const nowValue = now();
        const lease = await options.store.claimObligation({
          owner,
          now: nowValue.toISOString(),
          leaseMilliseconds: DEFAULT_LEASE_MS,
          ...(workerOptions.account_id ? { account_id: workerOptions.account_id } : {}),
        });
        if (!lease) break;
        counts.claimed += 1;
        let executionDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
        let activeRecoveryDeadlineAt = lease.obligation.recoveryDeadlineAt;
        try {
          const obligation = lease.obligation;
          const offering = requiredOffering(offeringById, obligation.offeringId);
          const previous = await options.store.listRevisions(obligation.reporting_obligation_id);
          const adjustments = await options.store.listAdjustments(obligation.reporting_obligation_id);
          const publicationCount = previous.length + adjustments.length;
          if (publicationCount > 0) {
            const scheduledAt = nextPublicationAt(obligation, publicationCount);
            if (scheduledAt) {
              const recoveryWindow =
                instant(obligation.recoveryDeadlineAt, 'recoveryDeadlineAt') -
                instant(obligation.expectedAt, 'expectedAt');
              activeRecoveryDeadlineAt = new Date(
                instant(scheduledAt, 'nextPublicationAt') + recoveryWindow
              ).toISOString();
            }
          }
          if (publicationCount > 0) {
            const nextExisting = nextPublicationAt(obligation, publicationCount);
            if (!nextExisting || instant(nextExisting, 'nextPublicationAt') > nowValue.getTime()) {
              obligation.state = nextExisting ? 'pending' : 'terminal';
              obligation.nextAttemptAt = nextExisting ?? nowValue.toISOString();
              await options.store.updateObligation(obligation, lease);
              await reconcileReportingStatusLifecycleV1({
                store: options.store,
                reporting_obligation_id: obligation.reporting_obligation_id,
                ledgerAsOf: nowValue.toISOString(),
                subscribers: options.subscribers,
              });
              continue;
            }
          }
          const request = sourceRequest(obligation, offering, previous, adjustments, nowValue);
          const executionController = new AbortController();
          executionDeadlineTimer = setTimeout(
            () => executionController.abort(new Error('Reporting source execution deadline elapsed')),
            executionDeadline
          );
          const executionSignal = workerOptions.signal
            ? AbortSignal.any([workerOptions.signal, executionController.signal])
            : executionController.signal;
          const result = await settleAfterAbort(
            Promise.resolve().then(() => options.source.execute(request, { signal: executionSignal })),
            executionSignal,
            settlementGrace
          );
          workerOptions.signal?.throwIfAborted();
          if (!result.ok) {
            const retryable =
              (result.error.retry === 'retryable' ||
                (result.error.retry === 'cancelled' && !workerOptions.signal?.aborted)) &&
              nowValue.getTime() < instant(activeRecoveryDeadlineAt, 'activeRecoveryDeadlineAt');
            obligation.attemptCount += 1;
            obligation.nextAttemptAt = new Date(
              retryable
                ? nowValue.getTime() + retryDelay
                : instant(activeRecoveryDeadlineAt, 'activeRecoveryDeadlineAt')
            ).toISOString();
            if (!retryable) obligation.state = 'terminal';
            await options.store.updateObligation(obligation, lease);
            if (result.error.code === 'NOT_READY' || result.error.code === 'PARTIAL_RESULT') counts.notReady += 1;
            else counts.failed += 1;
            await reconcileReportingStatusLifecycleV1({
              store: options.store,
              reporting_obligation_id: obligation.reporting_obligation_id,
              ledgerAsOf: nowValue.toISOString(),
              subscribers: options.subscribers,
            });
            continue;
          }
          const manifest = await validateReportingSourceExecutionV1({
            level: result.response.manifest.level,
            capabilities: options.source.capabilities,
            request,
            result,
            objectReader: {
              read: input =>
                settleAfterAbort(
                  Promise.resolve().then(() => options.source.read(input)),
                  executionSignal,
                  settlementGrace
                ),
            },
            objectReadLimits: {
              maxObjectBytes: MAX_REVISION_BYTES,
              maxTotalBytes: MAX_REVISION_BYTES,
            },
            signal: executionSignal,
          });
          assertPublicationProgress(adjustments.at(-1) ?? previous.at(-1), manifest);
          const rows = await readManifestRows(options.source, obligation, manifest, executionSignal, settlementGrace);
          validateManifestFinalityForObligation(obligation, manifest);
          if (previous.some(value => value.finality === 'official')) {
            const official = previous.find(value => value.finality === 'official')!;
            const adjustment = buildAdjustment(
              obligation,
              official,
              result.response.manifest,
              manifest,
              rows,
              adjustments
            );
            const committed = await options.store.commitAdjustment(adjustment, lease);
            if (committed.inserted) counts.revisionsCommitted += 1;
          } else {
            const revision = buildRevision(obligation, result.response.manifest, manifest, rows, previous);
            const committed = await options.store.commitRevision(revision, lease);
            if (committed.inserted) counts.revisionsCommitted += 1;
          }
          const nextAt = nextPublicationAt(obligation, publicationCount + 1);
          obligation.state = nextAt ? 'pending' : 'terminal';
          obligation.nextAttemptAt = nextAt ?? nowValue.toISOString();
          obligation.attemptCount += 1;
          await options.store.updateObligation(obligation, lease);
          await options.store.resolveIssue(sourceExecutionIssueId(obligation), nowValue.toISOString());
          await reconcileReportingStatusLifecycleV1({
            store: options.store,
            reporting_obligation_id: obligation.reporting_obligation_id,
            ledgerAsOf: nowValue.toISOString(),
            subscribers: options.subscribers,
          });
        } catch (error) {
          if (workerOptions.signal?.aborted) workerOptions.signal.throwIfAborted();
          if (isLeaseLost(error)) continue;
          counts.failed += 1;
          const obligation = lease.obligation;
          const retryable = nowValue.getTime() < instant(activeRecoveryDeadlineAt, 'activeRecoveryDeadlineAt');
          obligation.attemptCount += 1;
          obligation.state = retryable ? 'pending' : 'terminal';
          obligation.nextAttemptAt = new Date(
            retryable ? nowValue.getTime() + retryDelay : instant(activeRecoveryDeadlineAt, 'activeRecoveryDeadlineAt')
          ).toISOString();
          try {
            await options.store.updateObligation(
              obligation,
              lease,
              sourceExecutionIssue(obligation, nowValue.toISOString())
            );
            await reconcileReportingStatusLifecycleV1({
              store: options.store,
              reporting_obligation_id: obligation.reporting_obligation_id,
              ledgerAsOf: nowValue.toISOString(),
              subscribers: options.subscribers,
            });
          } catch (recoveryError) {
            if (!isLeaseLost(recoveryError)) throw recoveryError;
          }
        } finally {
          if (executionDeadlineTimer) clearTimeout(executionDeadlineTimer);
          await options.store.releaseObligationLease(lease);
        }
      }
      await retryReportingStatusNotificationsV1({
        store: options.store,
        ledgerAsOf: now().toISOString(),
        ...(workerOptions.account_id ? { account_id: workerOptions.account_id } : {}),
        subscribers: options.subscribers,
      });
      await reconcileReportingStatusDeadlinesV1({
        store: options.store,
        ledgerAsOf: now().toISOString(),
        ...(workerOptions.account_id ? { account_id: workerOptions.account_id } : {}),
        subscribers: options.subscribers,
      });
      return counts;
    },
  };
}

function sourceExecutionIssue(
  obligation: ReportingLedgerObligationV1,
  observedAt: string
): import('./types').ReportingLedgerIssueV1 {
  return {
    issueId: sourceExecutionIssueId(obligation),
    reporting_obligation_id: obligation.reporting_obligation_id,
    code: 'PRODUCTION_FAILED',
    severity: Date.parse(observedAt) < Date.parse(obligation.recoveryDeadlineAt) ? 'delayed' : 'action_required',
    responsibleParty: 'seller',
    recommendedAction:
      Date.parse(observedAt) < Date.parse(obligation.recoveryDeadlineAt) ? 'wait_for_retry' : 'contact_seller',
    openedAt: observedAt,
    observedAt,
  };
}

function sourceExecutionIssueId(obligation: ReportingLedgerObligationV1): string {
  return `rpti_${digest(['source-execution-failed-v1', obligation.reporting_obligation_id]).slice(0, 32)}`;
}

function planObligation(
  configuration: ReportingLedgerConfigurationV1,
  periodOrdinal: number,
  createdAt: string
): ReportingLedgerObligationV1 {
  const anchor = instant(configuration.schedule.anchor, 'schedule.anchor');
  const start = anchor + periodOrdinal * configuration.schedule.periodMilliseconds;
  const end = start + configuration.schedule.periodMilliseconds;
  const expectedOffset =
    configuration.requiredFinality === 'official'
      ? (configuration.schedule.officialAfterMilliseconds ?? configuration.schedule.deliverySlaMilliseconds)
      : configuration.schedule.deliverySlaMilliseconds;
  const expectedAt = end + expectedOffset;
  const recoveryDeadlineAt = expectedAt + configuration.schedule.recoveryWindowMilliseconds;
  const semantic = {
    configurationId: configuration.configurationId,
    periodOrdinal,
    period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    constituents: configuration.constituents,
    coverageRequirement: 'full',
  };
  const semanticFingerprint = prefixedDigest(semantic);
  return {
    reporting_obligation_id: `robl_${digest(semantic).slice(0, 32)}`,
    configurationId: configuration.configurationId,
    account: structuredClone(configuration.account),
    sourceScope: structuredClone(configuration.sourceScope),
    delivery_config_id: configuration.delivery_config_id,
    delivery_config_version: configuration.delivery_config_version,
    offeringId: configuration.offeringId,
    report_definition_id: configuration.report_definition_id,
    feedPurpose: configuration.feedPurpose,
    requiredFinality: configuration.requiredFinality,
    ...(configuration.finalityPolicy ? { finalityPolicy: structuredClone(configuration.finalityPolicy) } : {}),
    ...(configuration.canonicalization ? { canonicalization: structuredClone(configuration.canonicalization) } : {}),
    periodOrdinal,
    period: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      sourceTimezone: configuration.sourceTimezone,
    },
    schedule: structuredClone(configuration.schedule),
    scopeResolvedAt: new Date(end).toISOString(),
    coverage: {
      status: 'full',
      evaluatedAt: new Date(end).toISOString(),
      mediaBuyIds: [...configuration.mediaBuyIds].sort(),
      fullyCoveredMediaBuyIds: [...configuration.mediaBuyIds].sort(),
      partiallyCoveredMediaBuyIds: [],
      unsupportedMediaBuyIds: [],
      unknownMediaBuyIds: [],
    },
    requestedMetrics: [...configuration.requestedMetrics],
    requestedDimensions: [...configuration.requestedDimensions],
    constituents: structuredClone(configuration.constituents),
    mediaBuyIds: [...configuration.mediaBuyIds].sort(),
    sourceSettings: structuredClone(configuration.sourceSettings),
    contract: structuredClone(configuration.contract),
    expectedAt: new Date(expectedAt).toISOString(),
    recoveryDeadlineAt: new Date(recoveryDeadlineAt).toISOString(),
    publicationOffsets: [...new Set(configuration.schedule.restatementMilliseconds ?? [])]
      .filter(value => Number.isSafeInteger(value) && value > expectedOffset)
      .sort((left, right) => left - right),
    nextAttemptAt: new Date(expectedAt).toISOString(),
    attemptCount: 0,
    state: 'pending',
    semanticFingerprint,
    createdAt,
  };
}

function sourceRequest(
  obligation: ReportingLedgerObligationV1,
  offering: ReportingSourceOfferingV1,
  previous: readonly ReportingLedgerRevisionV1[],
  adjustments: readonly ReportingLedgerAdjustmentV1[],
  now: Date
): ReportingSourceSliceRequestV1 {
  const latest = adjustments.at(-1) ?? previous.at(-1);
  const revisionKind =
    offering.publicationClass === 'AUTHORITATIVE' ? (latest ? 'correction' : 'authoritative') : 'snapshot';
  const periodEnd = instant(obligation.period.end, 'period.end');
  const cutoff = new Date(Math.min(now.getTime(), periodEnd)).toISOString();
  const productIds = [...new Set(obligation.constituents.map(value => value.productId))].sort();
  return {
    contractVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
    identity: {
      sourceExecutionKey: `execute:${obligation.reporting_obligation_id}:${previous.length + adjustments.length + 1}`,
      logicalSliceFingerprint: obligation.semanticFingerprint,
    },
    sourceScope: structuredClone(obligation.sourceScope),
    account: structuredClone(obligation.account),
    delivery_config_id: obligation.delivery_config_id,
    delivery_config_version: obligation.delivery_config_version,
    report_definition_id: obligation.report_definition_id,
    reporting_obligation_id: obligation.reporting_obligation_id,
    adapterBuild: structuredClone(offering.adapterBuild),
    offeringId: offering.offeringId,
    publicationNamespace: offering.publicationNamespace,
    publicationClass: offering.publicationClass,
    contract: structuredClone(obligation.contract),
    period: {
      periodKey: `period-${obligation.periodOrdinal}`,
      sourceLocalDate: sourceLocalDate(obligation.period.start, obligation.period.sourceTimezone),
      start: obligation.period.start,
      end: obligation.period.end,
      sourceTimezone: obligation.period.sourceTimezone,
      sourceReadCutoffAt: cutoff,
      grain: offering.grain,
      windowing: structuredClone(offering.windowing),
    },
    finality:
      revisionKind === 'correction'
        ? { revisionKind, supersedesPublicationId: latest!.sourcePublicationId }
        : { revisionKind },
    trigger: { kind: obligation.attemptCount ? 'retry' : 'scheduled_poll', id: `trigger-${obligation.attemptCount}` },
    sourceRequest: { groupIds: [] },
    coverage: {
      expected: 'full',
      constituents: structuredClone(obligation.constituents),
      productIds,
      mediaBuyIds: [...obligation.mediaBuyIds],
      packageIds: [],
      denominatorFingerprint: reportingCoverageDenominatorFingerprintV1(obligation.constituents),
    },
    requestedMetrics: [...obligation.requestedMetrics],
    requestedDimensions: [...obligation.requestedDimensions],
    sourceSettings: structuredClone(obligation.sourceSettings),
    deadline: {
      // Scheduling clocks may be simulated or replayed. The execution deadline
      // is a real cancellation boundary and must remain in the caller's future.
      deadlineAt: new Date(Date.now() + EXECUTION_DEADLINE_MS).toISOString(),
      cancellationIdentity: `cancel-${obligation.reporting_obligation_id}-${obligation.attemptCount}`,
    },
  };
}

async function readManifestRows(
  source: CreateReportingProducerOptionsV1['source'],
  obligation: ReportingLedgerObligationV1,
  manifest: ReportingSourceManifestV1,
  signal = new AbortController().signal,
  settlementGraceMilliseconds = DEFAULT_SETTLEMENT_GRACE_MS
): Promise<Record<string, unknown>[]> {
  if (manifest.objects.length > MAX_REVISION_OBJECTS) {
    throw new Error('Reporting source revision exceeds the object limit');
  }
  if (manifest.rowCount > MAX_REVISION_ROWS) throw new Error('Reporting source revision exceeds the row limit');
  const declaredBytes = manifest.objects.reduce((sum, object) => sum + object.byteCount, 0);
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_REVISION_BYTES) {
    throw new Error('Reporting source revision exceeds the byte limit');
  }
  const rows: Record<string, unknown>[] = [];
  for (const object of manifest.objects) {
    if (object.compression !== 'none') throw new Error('Reporting producer supports uncompressed source objects');
    const bytes = await settleAfterAbort(
      Promise.resolve().then(() =>
        source.read({
          objectRef: object.objectRef,
          objectGeneration: object.objectGeneration,
          sourceScope: structuredClone(obligation.sourceScope),
          account: structuredClone(obligation.account),
          delivery_config_id: obligation.delivery_config_id,
          delivery_config_version: obligation.delivery_config_version,
          report_definition_id: obligation.report_definition_id,
          reporting_obligation_id: obligation.reporting_obligation_id,
          maxBytes: object.byteCount,
          signal,
        })
      ),
      signal,
      settlementGraceMilliseconds
    );
    if (bytes.byteLength !== object.byteCount || createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
      throw new Error('Reporting source object does not match its manifest binding');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed =
      object.mediaType === 'application/json'
        ? JSON.parse(text)
        : object.mediaType === 'application/x-ndjson'
          ? text
              .split('\n')
              .filter(Boolean)
              .map(line => JSON.parse(line))
          : (() => {
              throw new Error(`Unsupported reporting object media type: ${object.mediaType}`);
            })();
    if (
      !Array.isArray(parsed) ||
      parsed.some(value => typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      throw new Error('Reporting source object must contain an array or NDJSON sequence of rows');
    }
    for (const row of parsed as Record<string, unknown>[]) rows.push(row);
  }
  if (rows.length !== manifest.rowCount) throw new Error('Reporting source row count does not match its manifest');
  return rows;
}

function settleAfterAbort<T>(operation: Promise<T>, signal: AbortSignal, graceMilliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
    const onAbort = () => {
      if (timer) return;
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Reporting source did not settle after cancellation'));
      }, graceMilliseconds);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}

function buildRevision(
  obligation: ReportingLedgerObligationV1,
  manifestReference: ReportingLedgerRevisionV1['manifest'],
  manifest: ReportingSourceManifestV1,
  rows: Record<string, unknown>[],
  previous: readonly ReportingLedgerRevisionV1[]
): ReportingLedgerRevisionV1 {
  const revisionNumber = previous.length + 1;
  const revisionId = `rrev_${digest([
    obligation.reporting_obligation_id,
    manifest.publication.namespace,
    manifest.publication.publicationId,
  ]).slice(0, 32)}`;
  const controlTotals = reportingControlTotals(rows, obligation.requestedMetrics);
  const contentBytes = Buffer.from(
    canonicalize({
      reporting_revision_id: revisionId,
      row_count: rows.length,
      control_totals: controlTotals,
      reporting_rows: rows,
    }),
    'utf8'
  );
  const sha256 = createHash('sha256').update(contentBytes).digest('hex');
  const createdAt = new Date().toISOString();
  const finality = manifest.publication.publicationClass === 'AUTHORITATIVE' ? 'official' : 'snapshot';
  const kind = finality;
  const finalityBasis = finalityBasisForManifest(manifest);
  const wireRevision = ReportingRevisionSchema.parse({
    reporting_revision_id: revisionId,
    revision_content_sha256: sha256,
    report_definition_id: obligation.report_definition_id,
    report_definition_uri: obligation.contract.reportDefinitionUri,
    report_definition_sha256: obligation.contract.reportDefinitionSha256,
    reporting_profile: obligation.contract.reportingProfile,
    schema_version: obligation.contract.schemaVersion,
    schema_uri: obligation.contract.schemaUri,
    schema_sha256: obligation.contract.schemaSha256,
    schema_dialect: obligation.contract.schemaDialect,
    schema_ref_policy: obligation.contract.schemaRefPolicy,
    account_id: obligation.account.account_id,
    media_buy_ids: obligation.mediaBuyIds,
    coverage: wireCoverage(obligation),
    period: {
      start: obligation.period.start,
      end: obligation.period.end,
      source_timezone: obligation.period.sourceTimezone,
    },
    finality,
    ...(finality === 'official'
      ? {
          finality_basis: finalityBasis,
          finality_policy_id: obligation.finalityPolicy!.policyId,
          finalized_at: manifest.finality.evidence.observedAt,
        }
      : {}),
    observed_at: manifest.period.observedAt,
    data_through: manifest.period.dataThrough,
    data_through_precision: 'exact',
    ...(previous.at(-1) ? { supersedes_reporting_revision_id: previous.at(-1)!.reporting_revision_id } : {}),
    row_count: rows.length,
    control_totals: controlTotals,
    ...(obligation.feedPurpose === 'billing'
      ? {
          canonical_content_digest: {
            algorithm: 'sha256',
            value: canonicalRowsSha256(rows, obligation.canonicalization!.primaryKeys),
            canonicalization_id: obligation.canonicalization!.id,
            canonicalization_uri: obligation.canonicalization!.uri,
            canonicalization_sha256: obligation.canonicalization!.sha256,
          },
        }
      : {}),
    created_at: createdAt,
  }) as ReportingRevision;
  return {
    reporting_revision_id: revisionId,
    reporting_obligation_id: obligation.reporting_obligation_id,
    revisionNumber,
    finality,
    kind,
    ...(previous.at(-1) ? { supersedes_reporting_revision_id: previous.at(-1)!.reporting_revision_id } : {}),
    manifest: structuredClone(manifestReference),
    sourcePublicationId: manifest.publication.publicationId,
    binding: {
      algorithm: 'rfc8785_jcs_v1',
      sha256,
      byteCount: contentBytes.byteLength,
      rowCount: rows.length,
    },
    rows: structuredClone(rows),
    observedAt: manifest.period.observedAt,
    dataThrough: manifest.period.dataThrough,
    sourceReadCutoffAt: manifest.period.sourceReadCutoffAt,
    createdAt: (wireRevision as unknown as { created_at: string }).created_at,
    wireRevision,
  };
}

function finalityBasisForManifest(manifest: ReportingSourceManifestV1): 'source_final' | 'contractual_cutoff' {
  return manifest.finality.evidence.basis === 'elapsed_settlement_window' ? 'contractual_cutoff' : 'source_final';
}

function validateManifestFinalityForObligation(
  obligation: ReportingLedgerObligationV1,
  manifest: ReportingSourceManifestV1
): void {
  if (manifest.publication.publicationClass !== 'AUTHORITATIVE') return;
  const finalityBasis = finalityBasisForManifest(manifest);
  if (obligation.finalityPolicy?.basis !== finalityBasis) {
    throw new Error('Authoritative source evidence does not match the pinned finality policy');
  }
  if (
    obligation.finalityPolicy.basis === 'source_final' &&
    manifest.finality.evidence.evidenceRef !== obligation.finalityPolicy.sourceSignal
  ) {
    throw new Error('Source-final evidence does not match the pinned source signal');
  }
  const finalizedAt = Date.parse(manifest.finality.evidence.observedAt);
  if (finalizedAt > Date.now()) throw new Error('Authoritative source evidence is future-dated');
  if (finalityBasis === 'source_final' && finalizedAt < Date.parse(obligation.period.end)) {
    throw new Error('Source-final evidence predates the reporting period close');
  }
  if (
    obligation.finalityPolicy.basis === 'contractual_cutoff' &&
    finalizedAt < Date.parse(obligation.period.end) + obligation.finalityPolicy.durationAfterPeriodEndMilliseconds
  ) {
    throw new Error('Authoritative source evidence predates the pinned contractual cutoff');
  }
}

function canonicalRowsSha256(rows: readonly Record<string, unknown>[], primaryKeys: readonly string[]): string {
  const encoded = rows.map(row => {
    const keyValues = primaryKeys.map(key => {
      const value = row[key];
      if (
        value === undefined ||
        value === null ||
        (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      ) {
        throw new Error(`Reporting row primary key ${key} must be a present scalar`);
      }
      return value;
    });
    return { key: Buffer.from(canonicalize(keyValues)), row: canonicalize(row) };
  });
  encoded.sort((left, right) => Buffer.compare(left.key, right.key));
  for (let index = 1; index < encoded.length; index += 1) {
    if (Buffer.compare(encoded[index - 1]!.key, encoded[index]!.key) === 0) {
      throw new Error('Reporting rows contain duplicate primary-key tuples');
    }
  }
  const bytes = Buffer.from(`[${encoded.map(item => item.row).join(',')}]`, 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function buildAdjustment(
  obligation: ReportingLedgerObligationV1,
  official: ReportingLedgerRevisionV1,
  manifestReference: ReportingLedgerAdjustmentV1['manifest'],
  manifest: ReportingSourceManifestV1,
  rows: Record<string, unknown>[],
  previous: readonly ReportingLedgerAdjustmentV1[]
): ReportingLedgerAdjustmentV1 {
  if (obligation.feedPurpose === 'billing') {
    canonicalRowsSha256(rows, obligation.canonicalization!.primaryKeys);
  }
  const adjustmentNumber = previous.length + 1;
  const adjustmentId = `radj_${digest([
    obligation.reporting_obligation_id,
    adjustmentNumber,
    manifest.publication.contentFingerprint,
  ]).slice(0, 32)}`;
  const bytes = Buffer.from(canonicalize(rows), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const officialFinalizedAt = instant(official.wireRevision.finalized_at!, 'official.finalized_at');
  const correctionObservedAt = instant(manifest.period.observedAt, 'manifest.period.observedAt');
  if (correctionObservedAt < officialFinalizedAt) {
    throw new Error('Reporting correction observation predates the official finalization');
  }
  const createdAtValue = new Date();
  if (createdAtValue.getTime() < correctionObservedAt) {
    throw new Error('Reporting correction creation predates its source observation');
  }
  const createdAt = createdAtValue.toISOString();
  const correctedTotals = reportingControlTotals(rows, obligation.requestedMetrics);
  const effectiveTotals = effectiveControlTotals(official, previous);
  const controlTotalDeltas = correctedTotals.flatMap(total => {
    if (total.name === 'row_count') return [];
    const prior = effectiveTotals.get(total.name);
    return prior
      ? [
          {
            name: total.name,
            value: subtractDecimal(total.value, prior.value),
            value_type: total.value_type === 'decimal' || prior.value_type === 'decimal' ? 'decimal' : 'integer',
            ...(total.unit ? { unit: total.unit } : {}),
          },
        ]
      : [];
  });
  return {
    reporting_adjustment_id: adjustmentId,
    reporting_obligation_id: obligation.reporting_obligation_id,
    adjusts_reporting_revision_id: official.reporting_revision_id,
    adjustmentNumber,
    manifest: structuredClone(manifestReference),
    sourcePublicationId: manifest.publication.publicationId,
    binding: { algorithm: 'rfc8785_jcs_v1', sha256, byteCount: bytes.byteLength, rowCount: rows.length },
    rows: structuredClone(rows),
    observedAt: manifest.period.observedAt,
    dataThrough: manifest.period.dataThrough,
    sourceReadCutoffAt: manifest.period.sourceReadCutoffAt,
    createdAt,
    wireAdjustment: ReportingAdjustmentSchema.parse({
      reporting_adjustment_id: adjustmentId,
      adjusts_reporting_revision_id: official.reporting_revision_id,
      reason_code: 'source_correction',
      accounting_period: { start: obligation.period.start, end: obligation.period.end },
      control_total_deltas: [
        {
          name: 'row_count',
          value: String(rows.length - effectiveRowCount(official.binding.rowCount, previous)),
          value_type: 'integer',
        },
        ...controlTotalDeltas,
      ],
      correction_observed_at: manifest.period.observedAt,
      created_at: createdAt,
    }) as unknown as ReportingAdjustment,
  };
}

type Decimal = { coefficient: bigint; scale: number };

function reportingControlTotals(
  rows: readonly Record<string, unknown>[],
  metrics: readonly string[]
): ReportingControlTotal[] {
  return [...new Set(metrics)].sort().flatMap(name => {
    let sum: Decimal = { coefficient: 0n, scale: 0 };
    let valueType: 'integer' | 'decimal' = 'integer';
    for (const row of rows) {
      const totals = isRecord(row.totals) ? row.totals : undefined;
      const raw = row[name] ?? totals?.[name];
      if ((typeof raw !== 'string' && typeof raw !== 'number') || !isCanonicalDecimal(raw)) return [];
      const parsed = parseDecimal(raw);
      if (parsed.scale > 0) valueType = 'decimal';
      sum = addDecimal(sum, parsed);
    }
    return [{ name, value: formatDecimal(sum), value_type: valueType } as ReportingControlTotal];
  });
}

function isCanonicalDecimal(value: string | number): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}

function parseDecimal(value: string | number): Decimal {
  const text = typeof value === 'number' ? numberToDecimalString(value) : value;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [integer, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${integer}${fraction}` || '0') * (negative ? -1n : 1n);
  return { coefficient, scale: fraction.length };
}

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError('Reporting metric must be finite');
  if (Object.is(value, -0)) return '0';
  const rendered = String(value);
  if (!/[eE]/.test(rendered)) return rendered;
  const negative = rendered.startsWith('-');
  const unsigned = negative ? rendered.slice(1) : rendered;
  const [mantissa, exponentText] = unsigned.toLowerCase().split('e');
  const exponent = Number(exponentText);
  const [integer, fraction = ''] = mantissa!.split('.');
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer!.length + exponent;
  const expanded =
    decimalPosition <= 0
      ? `0.${'0'.repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${'0'.repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  return `${negative ? '-' : ''}${expanded}`;
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) + right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function formatDecimal(value: Decimal): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, '0');
  const integer = value.scale ? digits.slice(0, -value.scale) : digits;
  const fraction = value.scale ? digits.slice(-value.scale).replace(/0+$/, '') : '';
  const rendered = fraction ? `${integer}.${fraction}` : integer;
  return `${negative && rendered !== '0' ? '-' : ''}${rendered}`;
}

function subtractDecimal(left: string, right: string): string {
  const parsedRight = parseDecimal(right);
  return formatDecimal(addDecimal(parseDecimal(left), { ...parsedRight, coefficient: -parsedRight.coefficient }));
}

function effectiveControlTotals(
  official: ReportingLedgerRevisionV1,
  adjustments: readonly ReportingLedgerAdjustmentV1[]
): Map<string, ReportingControlTotal> {
  const totals = new Map(official.wireRevision.control_totals.map(value => [value.name, { ...value }]));
  for (const adjustment of adjustments) {
    for (const delta of adjustment.wireAdjustment.control_total_deltas) {
      if (delta.name === 'row_count') continue;
      const prior = totals.get(delta.name);
      if (!prior) continue;
      totals.set(delta.name, {
        ...prior,
        value: formatDecimal(addDecimal(parseDecimal(prior.value), parseDecimal(delta.value))),
        value_type: prior.value_type === 'decimal' || delta.value_type === 'decimal' ? 'decimal' : 'integer',
      });
    }
  }
  return totals;
}

function effectiveRowCount(officialRowCount: number, adjustments: readonly ReportingLedgerAdjustmentV1[]): number {
  return adjustments.reduce((count, adjustment) => {
    const delta = adjustment.wireAdjustment.control_total_deltas.find(value => value.name === 'row_count');
    return count + (delta ? Number(delta.value) : 0);
  }, officialRowCount);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPublicationProgress(
  previous: ReportingLedgerRevisionV1 | ReportingLedgerAdjustmentV1 | undefined,
  manifest: ReportingSourceManifestV1
): void {
  if (!previous) return;
  if (previous.sourcePublicationId === manifest.publication.publicationId) {
    throw new Error('Reporting source replay cannot be committed as a new publication');
  }
  if (Date.parse(manifest.period.observedAt) < Date.parse(previous.observedAt)) {
    throw new Error('Reporting source observedAt cannot regress');
  }
  if (
    previous.dataThrough !== null &&
    (manifest.period.dataThrough === null || Date.parse(manifest.period.dataThrough) < Date.parse(previous.dataThrough))
  ) {
    throw new Error('Reporting source dataThrough cannot regress');
  }
  if (Date.parse(manifest.period.sourceReadCutoffAt) < Date.parse(previous.sourceReadCutoffAt)) {
    throw new Error('Reporting source read cutoff cannot regress');
  }
}

function nextPublicationAt(obligation: ReportingLedgerObligationV1, completed: number): string | undefined {
  // The first publication occurs at expectedAt. Subsequent declared offsets
  // are relative to period end and remain immutable with the obligation.
  const base = instant(obligation.period.end, 'period.end');
  const next = obligation.publicationOffsets[completed - 1];
  return next === undefined ? undefined : new Date(base + next).toISOString();
}

function wireCoverage(obligation: ReportingLedgerObligationV1) {
  return {
    status: obligation.coverage.status,
    evaluated_at: obligation.coverage.evaluatedAt,
    media_buy_ids: obligation.coverage.mediaBuyIds,
    fully_covered_media_buy_ids: obligation.coverage.fullyCoveredMediaBuyIds,
    partially_covered_media_buy_ids: obligation.coverage.partiallyCoveredMediaBuyIds,
    unsupported_media_buy_ids: obligation.coverage.unsupportedMediaBuyIds,
    unknown_media_buy_ids: obligation.coverage.unknownMediaBuyIds,
    package_ids: [],
    covered_package_ids: [],
    unsupported_package_ids: [],
    unknown_package_ids: [],
    limitations: [],
  };
}

function requiredOffering(
  offerings: ReadonlyMap<string, ReportingSourceOfferingV1>,
  offeringId: string
): ReportingSourceOfferingV1 {
  const offering = offerings.get(offeringId);
  if (!offering) throw new Error(`Unknown reporting source offering: ${offeringId}`);
  return offering;
}

function validateConfigurationAgainstOffering(
  configuration: Omit<ReportingLedgerConfigurationV1, 'configurationId' | 'installedAt' | 'semanticFingerprint'>,
  offering: ReportingSourceOfferingV1
): void {
  positiveInteger(configuration.schedule.periodMilliseconds, 'periodMilliseconds');
  if (configuration.schedule.periodMilliseconds % 1_000 !== 0) {
    throw new Error('Reporting period must be representable as whole ISO 8601 seconds');
  }
  const minimumWindow = reportingIsoDurationMillisecondsV1(offering.windowing.minimumWindow);
  const maximumWindow = reportingIsoDurationMillisecondsV1(offering.windowing.maximumWindow);
  if (
    configuration.schedule.periodMilliseconds < minimumWindow ||
    configuration.schedule.periodMilliseconds > maximumWindow
  ) {
    throw new Error('Reporting period is outside its offering window bounds');
  }
  nonnegativeInteger(configuration.schedule.deliverySlaMilliseconds, 'deliverySlaMilliseconds');
  if (configuration.schedule.deliverySlaMilliseconds % 1_000 !== 0) {
    throw new Error('Reporting delivery SLA must be representable as whole ISO 8601 seconds');
  }
  positiveInteger(configuration.schedule.recoveryWindowMilliseconds, 'recoveryWindowMilliseconds');
  if (configuration.schedule.officialAfterMilliseconds !== undefined) {
    nonnegativeInteger(configuration.schedule.officialAfterMilliseconds, 'officialAfterMilliseconds');
    if (configuration.schedule.officialAfterMilliseconds % 1_000 !== 0) {
      throw new Error('Reporting official deadline must be representable as whole ISO 8601 seconds');
    }
  }
  for (const offset of configuration.schedule.restatementMilliseconds ?? []) {
    nonnegativeInteger(offset, 'restatementMilliseconds');
  }
  const anchor = instant(configuration.schedule.anchor, 'schedule.anchor');
  if (configuration.supersededAt && instant(configuration.supersededAt, 'supersededAt') <= anchor) {
    throw new Error('Reporting configuration supersession must follow its schedule anchor');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configuration.sourceTimezone }).format();
  } catch {
    throw new Error('Reporting configuration requires a valid IANA source timezone');
  }
  if (offering.sourceTimezone.ianaTimezone && offering.sourceTimezone.ianaTimezone !== configuration.sourceTimezone) {
    throw new Error('Reporting configuration source timezone does not match its offering');
  }
  if (canonicalize(configuration.contract) !== canonicalize(offering.contract)) {
    throw new Error('Reporting configuration contract does not match its offering');
  }
  if (configuration.requiredFinality === 'official' && offering.publicationClass !== 'AUTHORITATIVE') {
    throw new Error('Official reporting requires an authoritative offering');
  }
  if (configuration.requiredFinality === 'official') {
    if (!configuration.finalityPolicy || !/^[A-Za-z0-9_.:-]{1,255}$/.test(configuration.finalityPolicy.policyId)) {
      throw new Error('Official reporting requires a pinned finality policy');
    }
    if (
      configuration.finalityPolicy.basis === 'source_final' &&
      (!configuration.finalityPolicy.sourceSignal.trim() || configuration.finalityPolicy.sourceSignal.length > 512)
    ) {
      throw new Error('Source-final reporting requires a named source signal');
    }
    if (configuration.finalityPolicy.basis === 'contractual_cutoff') {
      nonnegativeInteger(
        configuration.finalityPolicy.durationAfterPeriodEndMilliseconds,
        'durationAfterPeriodEndMilliseconds'
      );
      const officialOffset =
        configuration.schedule.officialAfterMilliseconds ?? configuration.schedule.deliverySlaMilliseconds;
      if (configuration.finalityPolicy.durationAfterPeriodEndMilliseconds !== officialOffset) {
        throw new Error('Contractual cutoff must equal the official reporting deadline');
      }
    }
  } else if (configuration.finalityPolicy) {
    throw new Error('Snapshot reporting cannot declare an official finality policy');
  }
  positiveInteger(configuration.delivery_config_version, 'delivery_config_version');
  if (offering.publicationClass === 'AUTHORITATIVE' && configuration.requiredFinality !== 'official') {
    throw new Error('Authoritative source offerings require official ledger finality');
  }
  if (configuration.feedPurpose === 'billing') {
    if (
      !configuration.canonicalization ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(configuration.canonicalization.id) ||
      !/^https:\/\//.test(configuration.canonicalization.uri) ||
      !/^[a-f0-9]{64}$/i.test(configuration.canonicalization.sha256) ||
      !configuration.canonicalization.primaryKeys.length
    ) {
      throw new Error('Billing reporting requires a pinned canonicalization contract');
    }
  }
  const metricNames = new Set(offering.metrics.filter(value => value.support === 'exact').map(value => value.name));
  const dimensionNames = new Set(
    offering.dimensions.filter(value => value.support === 'exact').map(value => value.name)
  );
  if (configuration.requestedMetrics.some(value => !metricNames.has(value)))
    throw new Error('Unsupported reporting metric');
  if (configuration.requestedDimensions.some(value => !dimensionNames.has(value)))
    throw new Error('Unsupported reporting dimension');
  const applicableProducts = new Set(offering.applicability.productIds);
  const applicableKinds = new Set(offering.applicability.constituentKinds);
  if (configuration.constituents.some(value => !applicableProducts.has(value.productId))) {
    throw new Error('Reporting constituent product is outside its offering applicability');
  }
  if (configuration.constituents.some(value => !applicableKinds.has(value.constituentKind))) {
    throw new Error('Reporting constituent kind is outside its offering applicability');
  }
  if (!offering.sourceSettings.attributionModels.includes(configuration.sourceSettings.attributionModel)) {
    throw new Error('Reporting attribution model is outside its offering source settings');
  }
  if (!offering.sourceSettings.attributionWindows.includes(configuration.sourceSettings.attributionWindow)) {
    throw new Error('Reporting attribution window is outside its offering source settings');
  }
  if (
    !sameMembers(configuration.mediaBuyIds, [
      ...new Set(configuration.constituents.map(value => value.mediaBuyId).filter(Boolean) as string[]),
    ])
  ) {
    throw new Error('Reporting configuration media-buy scope must equal its constituent denominator');
  }
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJsonV1([...left].sort()) === canonicalJsonV1([...right].sort());
}

function missingOrdinals(first: number, last: number, existing: readonly number[], limit: number): number[] {
  if (last < first || limit <= 0) return [];
  const result: number[] = [];
  let candidate = first;
  for (const ordinal of [...new Set(existing)].sort((left, right) => left - right)) {
    if (ordinal < candidate) continue;
    while (candidate < ordinal && candidate <= last && result.length < limit) {
      result.push(candidate);
      candidate += 1;
    }
    if (result.length >= limit || candidate > last) return result;
    candidate = ordinal + 1;
  }
  while (candidate <= last && result.length < limit) {
    result.push(candidate);
    candidate += 1;
  }
  return result;
}

function instant(value: string, name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${name} must be an RFC 3339 instant`);
  return parsed;
}

function sourceLocalDate(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(valuePart => valuePart.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV1(value)).digest('hex');
}

function prefixedDigest(value: unknown): string {
  return `sha256:${digest(value)}`;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
}

function nonnegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
}

function isLeaseLost(value: unknown): boolean {
  return value instanceof Error && value.name === 'ReportingLedgerLeaseLostError';
}
