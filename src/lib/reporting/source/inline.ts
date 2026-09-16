import { createHash } from 'node:crypto';

import { buildReportingSourceManifestV1 } from './builder';
import { validateReportingSourceRequestAgainstCapabilitiesV1 } from './conformance';
import { canonicalJsonV1, REPORTING_SOURCE_CONTRACT_VERSION_V1 } from './manifest';
import {
  completedReportingSourceResponseV1,
  reportingIsoDurationMillisecondsV1,
  reportingSourceCapabilitiesV1,
  ReportingSourceErrorV1Schema,
  ReportingSourceOfferingV1Schema,
  ReportingSourceSliceRequestV1Schema,
  type ReportingSourceErrorV1,
  type ReportingSourceExecutorResultV1,
  type ReportingSourceOfferingV1,
  type ReportingSourceSliceRequestV1,
  type ReportingSourceExecutorV1,
  type ReportingSourceStagedObjectReaderV1,
} from './source';

export interface InlineReportingDeliveryRequestV1 {
  account: { account_id: string };
  media_buy_ids: string[];
  start_date: string;
  end_date: string;
  /** Exact source observation ceiling for snapshot reads within the requested period. */
  source_read_cutoff_at: string;
  requested_metrics: string[];
  reporting_dimensions: Record<string, Record<string, never>>;
}

export interface InlineReportingDeliveryResponseV1 {
  reporting_period?: Readonly<{ start: string; end: string }>;
  currency?: string;
  reporting_rows?: readonly unknown[];
  media_buy_deliveries?: readonly unknown[];
  partial_data?: boolean;
  data_through?: string;
  observed_at?: string;
  unavailable_count?: number;
  errors?: readonly unknown[];
  pagination?: Readonly<{ has_more?: boolean; next_cursor?: string | null }>;
  status?: string;
  is_final?: boolean;
  notification_type?: 'scheduled' | 'final' | 'delayed' | 'adjusted' | 'window_update';
}

export type InlineReportingDeliveryResultV1 = readonly unknown[] | InlineReportingDeliveryResponseV1 | null;

export type InlineReportingDeliveryFetchV1 = (
  request: InlineReportingDeliveryRequestV1,
  context: Readonly<{
    signal: AbortSignal;
    sourceScope: Record<string, unknown>;
    reporting_obligation_id: string;
    sourceSettings: ReportingSourceSliceRequestV1['sourceSettings'];
    contract: ReportingSourceSliceRequestV1['contract'];
  }>
) => InlineReportingDeliveryResultV1 | Promise<InlineReportingDeliveryResultV1>;

export class ReportingSourceNotReadyError extends Error {
  constructor(message = 'Reporting data is not ready') {
    super(message);
    this.name = 'ReportingSourceNotReadyError';
  }
}

export class InlineReportingSourceError extends Error {
  readonly sourceError: ReportingSourceErrorV1;

  constructor(error: ReportingSourceErrorV1) {
    const parsed = ReportingSourceErrorV1Schema.parse(error);
    super(parsed.safeMessage);
    this.name = 'InlineReportingSourceError';
    this.sourceError = parsed;
  }
}

export type InlineReportingSourceExecutorV1 = ReportingSourceExecutorV1 & ReportingSourceStagedObjectReaderV1;

type SealedExecution = {
  requestFingerprint: string;
  result: ReportingSourceExecutorResultV1;
};

type ExecutionEntry = {
  scopeKey: string;
  requestFingerprint: string;
  promise: Promise<SealedExecution>;
  controller: AbortController;
  pending: boolean;
  waiters: number;
};

type StoredObject = {
  request: ReportingSourceSliceRequestV1;
  generation: string;
  bytes: Uint8Array;
};

const INLINE_MAX_EXECUTIONS_V1 = 1_000;
const INLINE_MAX_EXECUTIONS_PER_SCOPE_V1 = 100;
const INLINE_MAX_CONCURRENT_EXECUTIONS_V1 = 16;
const INLINE_MAX_OBJECT_BYTES_V1 = 64 * 1_024 * 1_024;
const INLINE_MAX_TOTAL_OBJECT_BYTES_V1 = 256 * 1_024 * 1_024;
const INLINE_MAX_SCOPE_OBJECT_BYTES_V1 = 32 * 1_024 * 1_024;
const INLINE_MAX_ROWS_V1 = 100_000;

/**
 * Adapt a synchronous delivery handler to the reporting-source contract.
 * The returned object is both the executor and its generation-pinned reader.
 */
/**
 * Explicit replay-retention policy for the inline executor.
 *
 * By default every admitted execution is retained, which is what makes an
 * admitted key replayable for the executor's lifetime — and what caps a scope
 * at `INLINE_MAX_EXECUTIONS_PER_SCOPE_V1` slices. A scheduled feed that outlives
 * that ceiling must either install a durable executor or opt in here, which
 * trades the lifetime replay guarantee for a bounded window: a replay of an
 * evicted key re-executes instead of returning its recorded result. Opting in
 * is safe against the ledger, which binds each obligation to an immutable
 * revision and refuses to rewrite one, but it is never applied silently.
 */
export interface InlineReportingReplayRetentionV1 {
  /** Reclaim the oldest settled execution to admit new work. */
  readonly evictSettled: true;
}

export interface CreateInlineReportingSourceExecutorOptionsV1 {
  readonly replayRetention?: InlineReportingReplayRetentionV1;
}

export function createInlineReportingSourceExecutor(
  deliveryFetch: InlineReportingDeliveryFetchV1,
  offeringInput: ReportingSourceOfferingV1,
  executorOptions: CreateInlineReportingSourceExecutorOptionsV1 = {}
): InlineReportingSourceExecutorV1 {
  const evictSettled = executorOptions.replayRetention?.evictSettled === true;
  const parsedOffering = ReportingSourceOfferingV1Schema.parse(offeringInput);
  if (!parsedOffering.sourceExecution.manifestLevels.includes('basic')) {
    throw new TypeError('Inline reporting requires a basic manifest offering');
  }
  if (!parsedOffering.applicability.constituentKinds.includes('media_buy')) {
    throw new TypeError('Inline reporting requires media_buy constituent applicability');
  }
  if (
    parsedOffering.grain !== 'source_day' ||
    parsedOffering.windowing.kind !== 'fixed_closed_window' ||
    reportingIsoDurationMillisecondsV1(parsedOffering.windowing.minimumWindow) % 86_400_000 !== 0 ||
    reportingIsoDurationMillisecondsV1(parsedOffering.windowing.maximumWindow) % 86_400_000 !== 0
  ) {
    throw new TypeError('Inline reporting requires whole source-day fixed windows');
  }
  const format = parsedOffering.formats.find(
    candidate =>
      candidate.compression === 'none' &&
      (candidate.mediaType === 'application/json' || candidate.mediaType === 'application/x-ndjson')
  ) as { mediaType: 'application/json' | 'application/x-ndjson'; compression: 'none' } | undefined;
  if (!format) {
    throw new TypeError('Inline reporting requires uncompressed JSON or NDJSON');
  }
  const offering = ReportingSourceOfferingV1Schema.parse({
    ...parsedOffering,
    applicability: { ...parsedOffering.applicability, constituentKinds: ['media_buy'] },
    formats: [format],
    sourceExecution: {
      ...parsedOffering.sourceExecution,
      pagination: 'none',
      asyncJobs: 'unsupported',
      supportsCancellation: true,
      manifestLevels: ['basic'],
    },
  });

  const capabilities = reportingSourceCapabilitiesV1([offering], `inline-${offering.adapterBuild.adapterVersion}`);
  const executions = new Map<string, ExecutionEntry>();
  const storage = {
    objects: new Map<string, StoredObject>(),
    totalBytes: 0,
    scopeBytes: new Map<string, number>(),
  };
  let activeExecutions = 0;

  const executor: InlineReportingSourceExecutorV1 = {
    capabilities,

    async execute(requestInput, context) {
      let request: ReportingSourceSliceRequestV1;
      try {
        request = withoutUndefined(
          ReportingSourceSliceRequestV1Schema.parse(structuredClone(requestInput))
        ) as ReportingSourceSliceRequestV1;
      } catch {
        return failure('INVALID_REQUEST', 'terminal', 'Inline reporting request is invalid');
      }
      if (context.signal.aborted) {
        return failure('CANCELLED', 'cancelled', 'Inline reporting execution was cancelled');
      }
      if (Date.parse(request.deadline.deadlineAt) <= Date.now()) {
        return failure('DEADLINE_EXCEEDED', 'retryable', 'Inline reporting execution deadline elapsed');
      }
      try {
        validateReportingSourceRequestAgainstCapabilitiesV1(capabilities, request, 'basic');
      } catch {
        return failure('UNSUPPORTED_OFFERING', 'terminal', 'Request does not match the inline reporting offering');
      }
      if (request.sourceRequest.groupIds.length > 0) {
        return failure('UNSUPPORTED_OFFERING', 'terminal', 'Inline reporting does not support source group reads');
      }
      let deliveryDates: { start: string; end: string };
      try {
        deliveryDates = inlineDeliveryDates(request);
      } catch {
        return failure(
          'UNSUPPORTED_OFFERING',
          'terminal',
          'Inline reporting requires source-local midnight delivery windows'
        );
      }
      if (
        request.publicationClass === 'AUTHORITATIVE' &&
        Date.parse(request.period.sourceReadCutoffAt) < Date.parse(request.period.end)
      ) {
        return failure('NOT_READY', 'retryable', 'Authoritative inline reporting has not reached period end');
      }
      const requestFingerprint = inlineSemanticRequestFingerprint(request);
      const scopeKey = digest(canonicalJsonV1({ sourceScope: request.sourceScope, account: request.account }));
      const key = digest(
        canonicalJsonV1({
          sourceScope: request.sourceScope,
          account: request.account,
          delivery_config_id: request.delivery_config_id,
          delivery_config_version: request.delivery_config_version,
          report_definition_id: request.report_definition_id,
          reporting_obligation_id: request.reporting_obligation_id,
          sourceExecutionKey: request.identity.sourceExecutionKey,
        })
      );
      const existing = executions.get(key);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return failure('INTEGRITY_FAILED', 'terminal', 'sourceExecutionKey was reused with a different request');
        }
        return awaitInlineExecution(existing, context.signal, request.deadline.deadlineAt);
      }

      const scopeCount = [...executions.values()].filter(candidate => candidate.scopeKey === scopeKey).length;
      const exhaustedGlobally = executions.size >= INLINE_MAX_EXECUTIONS_V1;
      const exhaustedForScope = scopeCount >= INLINE_MAX_EXECUTIONS_PER_SCOPE_V1;
      if ((exhaustedGlobally || exhaustedForScope) && !evictSettled) {
        return failure(
          'QUOTA_EXHAUSTED',
          'terminal',
          `Inline reporting ${exhaustedGlobally ? 'replay' : 'scope replay'} capacity is exhausted; supply a ` +
            'durable executor or an explicit replayRetention policy for long-lived feeds'
        );
      }
      // Admission is decided before anything is reclaimed. Evicting first and
      // then refusing the request would destroy a replayable execution to admit
      // work that never ran.
      if (activeExecutions >= INLINE_MAX_CONCURRENT_EXECUTIONS_V1) {
        return failure('RATE_LIMITED', 'retryable', 'Inline reporting concurrency capacity is exhausted');
      }
      // Plan every reclamation before mutating anything. Reclaiming for the
      // global ceiling first and only then discovering the scope cannot be
      // satisfied would return a terminal refusal having already destroyed a
      // replay entry, its staged evidence, and its generation state. The scope
      // recount also has to account for what the global plan already freed, or
      // a victim in this scope is paid for twice.
      const planned: string[] = [];
      if (exhaustedGlobally) {
        const victim = planReclaim(executions, planned);
        if (victim === undefined) {
          return failure(
            'QUOTA_EXHAUSTED',
            'terminal',
            'Inline reporting replay capacity is exhausted; supply a durable executor or an explicit ' +
              'replayRetention policy for long-lived feeds'
          );
        }
        planned.push(victim);
      }
      const freedFromScope = planned.filter(key => executions.get(key)?.scopeKey === scopeKey).length;
      if (scopeCount - freedFromScope >= INLINE_MAX_EXECUTIONS_PER_SCOPE_V1) {
        const victim = planReclaim(executions, planned, scopeKey);
        if (victim === undefined) {
          return failure(
            'QUOTA_EXHAUSTED',
            'terminal',
            'Inline reporting scope replay capacity is exhausted; supply a durable executor or an explicit ' +
              'replayRetention policy for long-lived feeds'
          );
        }
        planned.push(victim);
      }
      // Admission is certain; commit the planned reclamations.
      for (const victim of planned) commitReclaim(executions, storage, victim);

      activeExecutions += 1;
      const controller = new AbortController();
      // Publish the replay entry before synchronous adopter code can re-enter.
      const pending = Promise.resolve()
        .then(() =>
          executeAndSeal(
            deliveryFetch,
            offering,
            format,
            request,
            deliveryDates,
            request.deadline.deadlineAt,
            controller.signal,
            storage,
            key,
            scopeKey
          )
        )
        .then(result => ({ requestFingerprint, result }))
        .catch(() => ({
          requestFingerprint,
          result: failure('SOURCE_PERMANENT', 'terminal', 'Inline reporting could not seal delivery evidence'),
        }))
        .finally(() => {
          activeExecutions -= 1;
          entry.pending = false;
        });
      const entry: ExecutionEntry = {
        scopeKey,
        requestFingerprint,
        promise: pending,
        controller,
        pending: true,
        waiters: 0,
      };
      executions.set(key, entry);
      void pending.then(sealed => {
        if (!sealed.result.ok && executions.get(key) === entry) executions.delete(key);
      });
      return awaitInlineExecution(entry, context.signal, request.deadline.deadlineAt);
    },

    async read(input) {
      if (input.signal.aborted) throw input.signal.reason;
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
        throw new RangeError('Inline staged object maxBytes must be a nonnegative safe integer');
      }
      const object = storage.objects.get(input.objectRef);
      if (!object) throw new Error('Inline staged object was not found');
      if (
        object.generation !== input.objectGeneration ||
        !sameJson(object.request.sourceScope, input.sourceScope) ||
        !sameJson(object.request.account, input.account) ||
        object.request.delivery_config_id !== input.delivery_config_id ||
        object.request.delivery_config_version !== input.delivery_config_version ||
        object.request.report_definition_id !== input.report_definition_id ||
        object.request.reporting_obligation_id !== input.reporting_obligation_id
      ) {
        throw new Error('Inline staged object scope mismatch');
      }
      if (object.bytes.byteLength > input.maxBytes) throw new RangeError('Inline staged object exceeds maxBytes');
      return Uint8Array.from(object.bytes);
    },
  };
  return executor;
}

async function executeAndSeal(
  deliveryFetch: InlineReportingDeliveryFetchV1,
  offering: ReportingSourceOfferingV1,
  format: { mediaType: 'application/json' | 'application/x-ndjson'; compression: 'none' },
  request: ReportingSourceSliceRequestV1,
  deliveryDates: { start: string; end: string },
  deadlineAt: string,
  signal: AbortSignal,
  storage: {
    objects: Map<string, StoredObject>;
    totalBytes: number;
    scopeBytes: Map<string, number>;
  },
  executionNamespace: string,
  scopeKey: string
): Promise<ReportingSourceExecutorResultV1> {
  let fetched: InlineReportingDeliveryResultV1;
  try {
    // Await the owned fetch even after abort. A cooperative handler receives
    // the same signal; an uncooperative handler is never detached.
    fetched = await deliveryFetch(
      {
        account: structuredClone(request.account),
        media_buy_ids: [...request.coverage.mediaBuyIds],
        start_date: deliveryDates.start,
        end_date: deliveryDates.end,
        source_read_cutoff_at: request.period.sourceReadCutoffAt,
        requested_metrics: [...request.requestedMetrics],
        reporting_dimensions: Object.fromEntries(request.requestedDimensions.map(dimension => [dimension, {}])),
      },
      {
        signal,
        sourceScope: structuredClone(request.sourceScope),
        reporting_obligation_id: request.reporting_obligation_id,
        sourceSettings: structuredClone(request.sourceSettings),
        contract: structuredClone(request.contract),
      }
    );
  } catch (error) {
    if (signal.aborted) {
      return failure('CANCELLED', 'cancelled', 'Inline reporting execution was cancelled');
    }
    const typedError = inlineSourceError(error);
    if (typedError) {
      return { ok: false, error: typedError };
    }
    if (isNotReadyError(error)) {
      return failure('NOT_READY', 'retryable', 'Reporting data is not ready');
    }
    return failure('SOURCE_TRANSIENT', 'retryable', 'Inline delivery fetch failed');
  }
  if (signal.aborted) {
    return failure('CANCELLED', 'cancelled', 'Inline reporting execution was cancelled');
  }
  if (fetched === null) {
    return failure('NOT_READY', 'retryable', 'Reporting data is not ready');
  }
  const responseStatus = !isRows(fetched) ? fetched.status?.toLowerCase() : undefined;
  if (['failed', 'error', 'canceled', 'cancelled', 'rejected'].includes(responseStatus ?? '')) {
    return failure('SOURCE_TRANSIENT', 'retryable', 'Inline delivery fetch reported failure');
  }
  if (responseStatus === 'unavailable') {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch reported unavailable data');
  }
  if (
    !isRows(fetched) &&
    (['working', 'submitted', 'input_required', 'deferred', 'reporting_delayed', 'not_ready', 'pending'].includes(
      responseStatus ?? ''
    ) ||
      (request.publicationClass === 'AUTHORITATIVE' && fetched.is_final === false))
  ) {
    return failure('NOT_READY', 'retryable', 'Reporting data is not ready');
  }
  if (
    request.publicationClass === 'AUTHORITATIVE' &&
    (isRows(fetched) || (fetched.is_final !== true && !['final', 'adjusted'].includes(fetched.notification_type ?? '')))
  ) {
    return failure('NOT_READY', 'retryable', 'Authoritative inline reporting requires source finality evidence');
  }
  if (
    !isRows(fetched) &&
    (fetched.partial_data || (fetched.unavailable_count ?? 0) > 0 || (fetched.errors?.length ?? 0) > 0)
  ) {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch returned partial data');
  }
  if (
    !isRows(fetched) &&
    fetched.pagination !== undefined &&
    (fetched.pagination.has_more !== false || Boolean(fetched.pagination.next_cursor))
  ) {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch returned unfinished pagination');
  }
  if (!isRows(fetched) && fetched.reporting_rows === undefined && fetched.media_buy_deliveries === undefined) {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch omitted its row collection');
  }
  if (
    !isRows(fetched) &&
    (!fetched.reporting_period ||
      !deliveryPeriodBoundaryMatches(fetched.reporting_period.start, deliveryDates.start, request.period.start) ||
      !deliveryPeriodBoundaryMatches(fetched.reporting_period.end, deliveryDates.end, request.period.end))
  ) {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch did not prove the requested half-open period');
  }
  if (!isRows(fetched) && fetched.currency !== undefined && fetched.currency !== request.sourceSettings.currency) {
    return failure(
      'INTEGRITY_FAILED',
      'terminal',
      'Inline delivery currency does not match the frozen source settings'
    );
  }
  if (
    !isRows(fetched) &&
    ((fetched.reporting_rows?.length ?? 0) > INLINE_MAX_ROWS_V1 ||
      (fetched.media_buy_deliveries?.length ?? 0) > INLINE_MAX_ROWS_V1 ||
      (fetched.reporting_rows?.length ?? 0) + (fetched.media_buy_deliveries?.length ?? 0) > INLINE_MAX_ROWS_V1)
  ) {
    return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline delivery fetch exceeded the row limit');
  }
  if (
    !isRows(fetched) &&
    fetched.reporting_rows !== undefined &&
    fetched.media_buy_deliveries !== undefined &&
    (fetched.reporting_rows.length === 0) !== (fetched.media_buy_deliveries.length === 0)
  ) {
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row collections disagree about zero delivery');
  }

  const sourceRows = isRows(fetched)
    ? [...fetched]
    : fetched.reporting_rows !== undefined
      ? [...fetched.reporting_rows]
      : [...(fetched.media_buy_deliveries ?? [])];
  if (sourceRows.length > INLINE_MAX_ROWS_V1) {
    return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline delivery fetch exceeded the row limit');
  }
  const evidenceRows = isRows(fetched)
    ? sourceRows
    : [...(fetched.reporting_rows ?? []), ...(fetched.media_buy_deliveries ?? [])];
  if (evidenceRows.some(row => rowIsUnavailable(row))) {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch returned an unavailable row');
  }
  if (sourceRows.length > 0) {
    const admittedMediaBuyIds = new Set(
      request.coverage.constituents.flatMap(constituent => (constituent.mediaBuyId ? [constituent.mediaBuyId] : []))
    );
    if (evidenceRows.some(row => !admittedMediaBuyIds.has(rowMediaBuyId(row) ?? ''))) {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery fetch returned an out-of-scope row');
    }
    if (
      evidenceRows.some(row => rowCurrency(row) !== undefined && rowCurrency(row) !== request.sourceSettings.currency)
    ) {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row currency does not match source settings');
    }
    if (
      request.coverage.constituents.some(constituent => {
        if (constituent.constituentKind !== 'media_buy' || !constituent.mediaBuyId) return true;
        const constituentRows = sourceRows.filter(row => rowMediaBuyId(row) === constituent.mediaBuyId);
        return (
          constituentRows.length === 0 ||
          constituentRows.some(
            row =>
              request.requestedMetrics.some(metric => !rowHasField(row, metric)) ||
              request.requestedDimensions.some(dimension => !rowHasDimension(row, dimension))
          )
        );
      })
    ) {
      return failure(
        'PARTIAL_RESULT',
        'retryable',
        'Inline delivery fetch did not prove every requested constituent-metric cell'
      );
    }
  }
  const remainingCapacity = Math.min(
    INLINE_MAX_OBJECT_BYTES_V1,
    INLINE_MAX_TOTAL_OBJECT_BYTES_V1 - storage.totalBytes,
    INLINE_MAX_SCOPE_OBJECT_BYTES_V1 - (storage.scopeBytes.get(scopeKey) ?? 0)
  );
  let projectionBudget = remainingCapacity;
  let rows: readonly Record<string, unknown>[];
  try {
    rows = sourceRows.map(row =>
      projectEvidenceRow(row, request, upperBound => {
        if (upperBound > projectionBudget) throw new RangeError('Inline projection capacity exhausted');
        projectionBudget -= upperBound;
      })
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return failure('STAGING_FAILED', 'terminal', 'Inline delivery evidence exceeds the bounded replay capacity');
    }
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row contains invalid evidence values');
  }
  const readsPartialPeriod = Date.parse(request.period.sourceReadCutoffAt) < Date.parse(request.period.end);
  if (
    readsPartialPeriod &&
    (isRows(fetched) || fetched.data_through === undefined || fetched.observed_at === undefined)
  ) {
    return failure(
      'PARTIAL_RESULT',
      'retryable',
      'Inline delivery fetch did not provide temporal evidence for the source read cutoff'
    );
  }
  const observedAt = isRows(fetched)
    ? request.period.sourceReadCutoffAt
    : normalizeDeliveryInstant(fetched.observed_at ?? request.period.sourceReadCutoffAt, deliveryDates, request.period);
  const defaultDataThrough =
    request.publicationClass === 'AUTHORITATIVE'
      ? request.period.end
      : Date.parse(request.period.sourceReadCutoffAt) < Date.parse(request.period.end)
        ? request.period.sourceReadCutoffAt
        : request.period.end;
  const dataThrough = isRows(fetched)
    ? defaultDataThrough
    : normalizeDeliveryInstant(fetched.data_through ?? defaultDataThrough, deliveryDates, request.period);
  const acquiredAt = new Date().toISOString();
  const startMs = Date.parse(request.period.start);
  const endMs = Date.parse(request.period.end);
  const cutoffMs = Date.parse(request.period.sourceReadCutoffAt);
  const dataThroughMs = Date.parse(dataThrough);
  const observedMs = Date.parse(observedAt);
  const acquiredMs = Date.parse(acquiredAt);
  if (request.publicationClass === 'AUTHORITATIVE' && dataThroughMs < endMs) {
    return failure('NOT_READY', 'retryable', 'Authoritative inline reporting has not reached period end');
  }
  if (
    ![dataThroughMs, observedMs].every(Number.isFinite) ||
    dataThroughMs < startMs ||
    dataThroughMs > endMs ||
    dataThroughMs > cutoffMs ||
    dataThroughMs > observedMs ||
    observedMs > acquiredMs ||
    (rows.length > 0 && dataThroughMs <= startMs)
  ) {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned invalid temporal evidence');
  }
  let bytes: Uint8Array;
  try {
    bytes = encodeRows(rows, format.mediaType, remainingCapacity);
  } catch {
    return failure('STAGING_FAILED', 'terminal', 'Inline delivery evidence exceeds the bounded replay capacity');
  }
  const objectDigest = digest(bytes);
  const objectRef = `inline-${executionNamespace.slice(0, 32)}`;
  const generation = `sha256-${objectDigest}`;
  const object = {
    ordinal: 0,
    objectRef,
    objectGeneration: generation,
    mediaType: format.mediaType,
    compression: format.compression,
    sha256: objectDigest,
    byteCount: bytes.byteLength,
    rowCount: rows.length,
  } as const;
  const explicitZero = rows.length === 0;
  const status = explicitZero ? ('explicit_zero' as const) : ('present' as const);
  const coverageConstituents = request.coverage.constituents.map(constituent => ({
    ...constituent,
    status,
    dataThrough,
  }));
  const declaredMetrics = new Map(offering.metrics.map(metric => [metric.name, metric]));
  const built = buildReportingSourceManifestV1({
    level: 'basic',
    request,
    stagedCommitRef: `inline-manifest-${executionNamespace.slice(0, 32)}`,
    objects: [object],
    completeness: {
      terminal: true as const,
      rowsComplete: true as const,
      requestedGroupsComplete: true as const,
    },
    controlTotals: [],
    metricAvailability: request.coverage.constituents.flatMap(constituent =>
      request.requestedMetrics.map(metricName => {
        const metric = declaredMetrics.get(metricName);
        if (!metric) throw new TypeError(`Offering does not declare ${metricName}`);
        return {
          constituentId: constituent.constituentId,
          metric: metricName,
          semanticContractId: metric.semanticContractId,
          semanticContractVersion: metric.semanticContractVersion,
          semanticContractSha256: metric.semanticContractSha256,
          status,
          dataThrough,
        };
      })
    ),
    coverage: {
      status: 'full' as const,
      constituents: coverageConstituents,
    },
    observedAt,
    dataThrough,
    finalityEvidence: {
      owner: 'adapter' as const,
      basis:
        request.publicationClass === 'PROVISIONAL_SNAPSHOT'
          ? ('provisional_observation' as const)
          : ('source_declared' as const),
      observedAt,
      ...(request.publicationClass === 'AUTHORITATIVE' ? { evidenceRef: 'get_media_buy_delivery.is_final' } : {}),
    },
    explicitZero,
    acquiredAt,
    ...(explicitZero ? {} : { eventTimeRange: { start: request.period.start, end: dataThrough } }),
    warnings: [],
  });
  // A synchronous adopter callback can block the event loop past the timer.
  // Check the absolute deadline before publishing any replayable evidence.
  if (Date.parse(deadlineAt) <= Date.now()) {
    return failure('DEADLINE_EXCEEDED', 'retryable', 'Inline reporting execution deadline elapsed');
  }
  storage.objects.set(objectRef, { request: structuredClone(request), generation, bytes: Uint8Array.from(bytes) });
  storage.totalBytes += bytes.byteLength;
  storage.scopeBytes.set(scopeKey, (storage.scopeBytes.get(scopeKey) ?? 0) + bytes.byteLength);
  return {
    ok: true,
    response: completedReportingSourceResponseV1({ request, manifest: built.reference }),
    manifestBytes: built.manifestBytes,
  };
}

function encodeRows(
  rows: readonly unknown[],
  mediaType: 'application/json' | 'application/x-ndjson',
  maxBytes: number
): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Inline staging capacity exhausted');
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  const append = (value: string) => {
    const valueBytes = Buffer.byteLength(value, 'utf8');
    if (valueBytes > maxBytes - byteCount) throw new RangeError('Inline staging capacity exhausted');
    const bytes = Buffer.from(value, 'utf8');
    byteCount += valueBytes;
    chunks.push(bytes);
  };
  if (mediaType === 'application/json') append('[');
  for (const [index, row] of rows.entries()) {
    const serialized = JSON.stringify(row);
    if (serialized === undefined) throw new TypeError('Inline delivery row is not JSON serializable');
    if (mediaType === 'application/json') {
      if (index > 0) append(',');
      append(serialized);
    } else {
      append(serialized);
      append('\n');
    }
  }
  if (mediaType === 'application/json') append(']');
  return Buffer.concat(chunks, byteCount);
}

function failure(
  code: ReportingSourceErrorV1['code'],
  retry: ReportingSourceErrorV1['retry'],
  safeMessage: string
): ReportingSourceExecutorResultV1 {
  return {
    ok: false,
    error: ReportingSourceErrorV1Schema.parse({
      contractVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
      code,
      retry,
      scope: 'slice',
      safeMessage,
    }),
  };
}

function inlineSourceError(error: unknown): ReportingSourceErrorV1 | undefined {
  if (typeof error !== 'object' || error === null || !('sourceError' in error)) return undefined;
  const parsed = ReportingSourceErrorV1Schema.safeParse((error as { sourceError: unknown }).sourceError);
  return parsed.success ? parsed.data : undefined;
}

function isNotReadyError(error: unknown): boolean {
  return (
    error instanceof ReportingSourceNotReadyError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ReportingSourceNotReadyError')
  );
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

function inlineSemanticRequestFingerprint(request: ReportingSourceSliceRequestV1): string {
  const { trigger: _trigger, deadline: _deadline, priorCheckpoint: _priorCheckpoint, ...semanticSlice } = request;
  return digest(canonicalJsonV1(withoutUndefined(semanticSlice)));
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)])
    );
  }
  return value;
}

async function awaitInlineExecution(
  entry: ExecutionEntry,
  signal: AbortSignal,
  deadlineAt: string
): Promise<ReportingSourceExecutorResultV1> {
  let deadlineElapsed = Date.parse(deadlineAt) <= Date.now();
  const deadlineController = new AbortController();
  const cancelDeadline = scheduleDeadline(deadlineAt, () => {
    deadlineElapsed = true;
    deadlineController.abort(new Error('Inline reporting execution deadline elapsed'));
  });
  const waitSignal = AbortSignal.any([signal, deadlineController.signal]);
  entry.waiters += 1;
  if (waitSignal.aborted || deadlineElapsed) {
    entry.waiters -= 1;
    if (entry.pending && entry.waiters === 0) {
      entry.controller.abort(waitSignal.reason);
      await entry.promise;
    }
    cancelDeadline();
    return deadlineElapsed
      ? failure('DEADLINE_EXCEEDED', 'retryable', 'Inline reporting execution deadline elapsed')
      : failure('CANCELLED', 'cancelled', 'Inline reporting execution was cancelled');
  }
  let releaseWaiter = true;
  let announceAbort!: () => void;
  const aborted = new Promise<{ kind: 'aborted' }>(resolve => {
    announceAbort = () => resolve({ kind: 'aborted' });
  });
  waitSignal.addEventListener('abort', announceAbort, { once: true });
  try {
    const outcome = await Promise.race([entry.promise.then(sealed => ({ kind: 'sealed' as const, sealed })), aborted]);
    if (outcome.kind === 'sealed') return structuredClone(outcome.sealed.result);
    entry.waiters -= 1;
    releaseWaiter = false;
    if (entry.pending && entry.waiters === 0) {
      entry.controller.abort(waitSignal.reason);
      await entry.promise;
    }
    return deadlineElapsed
      ? failure('DEADLINE_EXCEEDED', 'retryable', 'Inline reporting execution deadline elapsed')
      : failure('CANCELLED', 'cancelled', 'Inline reporting execution was cancelled');
  } finally {
    cancelDeadline();
    waitSignal.removeEventListener('abort', announceAbort);
    if (releaseWaiter) entry.waiters -= 1;
  }
}

function rowMediaBuyId(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const value = ownDataValue(row as Record<string, unknown>, 'media_buy_id');
  return typeof value === 'string' ? value : undefined;
}

function rowHasField(row: unknown, field: string): boolean {
  return rowFieldValue(row, field) !== undefined;
}

function rowFieldValue(row: unknown, field: string): string | number | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const record = row as Record<string, unknown>;
  const direct = ownDataValue(record, field);
  if (isEvidenceValue(direct)) return direct;
  const totals = ownDataValue(record, 'totals');
  if (typeof totals !== 'object' || totals === null) return undefined;
  const nested = ownDataValue(totals as Record<string, unknown>, field);
  return isEvidenceValue(nested) ? nested : undefined;
}

function isEvidenceValue(value: unknown): value is string | number {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= INLINE_MAX_OBJECT_BYTES_V1)
  );
}

function rowHasDimension(row: unknown, dimension: string): boolean {
  return dimension === 'media_buy_id' ? rowMediaBuyId(row) !== undefined : rowHasField(row, dimension);
}

function isRows(value: InlineReportingDeliveryResultV1): value is readonly unknown[] {
  return Array.isArray(value);
}

function ownDataValue(record: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function rowCurrency(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null) return undefined;
  const value = ownDataValue(row as Record<string, unknown>, 'currency');
  return typeof value === 'string' ? value : undefined;
}

function rowIsUnavailable(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false;
  const record = row as Record<string, unknown>;
  const status = ownDataValue(record, 'status');
  return (
    (typeof status === 'string' &&
      ['failed', 'reporting_delayed', 'not_ready', 'pending', 'unavailable', 'error'].includes(status.toLowerCase())) ||
    ownDataValue(record, 'partial_data') === true
  );
}

function projectEvidenceRow(
  row: unknown,
  request: ReportingSourceSliceRequestV1,
  consumeBudget: (upperBound: number) => void
): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new TypeError('Invalid row');
  const record = row as Record<string, unknown>;
  const projected: Record<string, unknown> = { media_buy_id: rowMediaBuyId(row) };
  for (const dimension of request.requestedDimensions) {
    if (dimension === 'media_buy_id') continue;
    const value = rowFieldValue(record, dimension);
    if (!isEvidenceValue(value)) throw new TypeError('Invalid dimension evidence');
    consumeBudget(jsonEvidenceUpperBound(value));
    projected[dimension] = value;
  }
  const totals = ownDataValue(record, 'totals');
  const projectedTotals: Record<string, unknown> = {};
  for (const metric of request.requestedMetrics) {
    const direct = ownDataValue(record, metric);
    if (isEvidenceValue(direct)) {
      consumeBudget(jsonEvidenceUpperBound(direct));
      projected[metric] = direct;
      continue;
    }
    const total =
      typeof totals === 'object' && totals !== null
        ? ownDataValue(totals as Record<string, unknown>, metric)
        : undefined;
    if (!isEvidenceValue(total)) throw new TypeError('Invalid metric evidence');
    consumeBudget(jsonEvidenceUpperBound(total));
    projectedTotals[metric] = total;
  }
  if (Object.keys(projectedTotals).length > 0) projected.totals = projectedTotals;
  return projected;
}

function inlineDeliveryDates(request: ReportingSourceSliceRequestV1): { start: string; end: string } {
  const start = sourceLocalMidnightDate(request.period.start, request.period.sourceTimezone);
  const end = sourceLocalMidnightDate(request.period.end, request.period.sourceTimezone);
  if (start !== request.period.sourceLocalDate) throw new RangeError('sourceLocalDate does not match period start');
  return { start, end };
}

/**
 * Choose the oldest settled execution eligible for reclamation, without
 * mutating anything. Only settled entries with no waiters are eligible, and an
 * entry already planned for reclamation is never chosen twice.
 */
function planReclaim(
  executions: Map<string, ExecutionEntry>,
  planned: readonly string[],
  scopeKey?: string
): string | undefined {
  for (const [key, entry] of executions) {
    if (entry.pending || entry.waiters > 0) continue;
    if (scopeKey !== undefined && entry.scopeKey !== scopeKey) continue;
    if (planned.includes(key)) continue;
    return key;
  }
  return undefined;
}

/**
 * Reclaim one planned execution together with its staged evidence and byte
 * accounting. Dropping only the execution entry left the staged object behind
 * under its old generation, so a later replay of that key re-executed and
 * re-staged the same ref under a new generation — leaving a reader pinned to
 * the original generation unable to read it — while the scope byte budget
 * never recovered.
 */
function commitReclaim(
  executions: Map<string, ExecutionEntry>,
  storage: { objects: Map<string, StoredObject>; totalBytes: number; scopeBytes: Map<string, number> },
  key: string
): void {
  const entry = executions.get(key);
  if (!entry) return;
  executions.delete(key);
  const objectRef = `inline-${key.slice(0, 32)}`;
  const stored = storage.objects.get(objectRef);
  if (!stored) return;
  storage.objects.delete(objectRef);
  storage.totalBytes -= stored.bytes.byteLength;
  const remaining = (storage.scopeBytes.get(entry.scopeKey) ?? 0) - stored.bytes.byteLength;
  storage.scopeBytes.set(entry.scopeKey, Math.max(0, remaining));
}

function sourceLocalMidnightDate(instant: string, timeZone: string): string {
  const date = new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
  if (parts.hour !== '00' || parts.minute !== '00' || parts.second !== '00' || date.getUTCMilliseconds() !== 0) {
    throw new RangeError('Reporting boundary is not source-local midnight');
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function deliveryPeriodBoundaryMatches(actual: string, wireDate: string, instant: string): boolean {
  return actual === wireDate || Date.parse(actual) === Date.parse(instant);
}

function normalizeDeliveryInstant(
  value: string,
  deliveryDates: { start: string; end: string },
  period: ReportingSourceSliceRequestV1['period']
): string {
  if (value === deliveryDates.start) return period.start;
  if (value === deliveryDates.end) return period.end;
  return value;
}

function scheduleDeadline(deadlineAt: string, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled) return;
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
  };
  schedule();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

function jsonEvidenceUpperBound(value: string | number): number {
  return typeof value === 'number' ? 32 : Math.min(Number.MAX_SAFE_INTEGER, Buffer.byteLength(value, 'utf8') * 6 + 2);
}
