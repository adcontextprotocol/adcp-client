import { createHash } from 'node:crypto';
import { z } from 'zod';

import { buildReportingSourceManifestV1 } from './builder';
import { validateReportingSourceRequestAgainstCapabilitiesV1 } from './conformance';
import {
  canonicalJsonV1,
  ReportingEvidenceReasonV1Schema,
  ReportingExternalIdV1Schema,
  REPORTING_SOURCE_CONTRACT_VERSION_V1,
  SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1,
  SourceBatchContractError,
  type ReportingSourceManifestV1,
} from './manifest';
import {
  completedReportingSourceResponseV1,
  reportingIsoDurationMillisecondsV1,
  ReportingMetricOrDimensionNameV1Schema,
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
  /** Frozen manifest constituents. Use constituent_id when returning availability evidence. */
  constituents: Array<Readonly<{ constituent_id: string; media_buy_id: string }>>;
  start_date: string;
  end_date: string;
  /** Exact source observation ceiling for snapshot reads within the requested period. */
  source_read_cutoff_at: string;
  requested_metrics: string[];
  reporting_dimensions: Record<string, Record<string, never>>;
}

export const INLINE_REPORTING_AVAILABILITY_EVIDENCE_VERSION_V1 = '1.0' as const;

type InlineReportingAvailableMetricEvidenceV1 = Readonly<{
  constituent_id: string;
  metric: string;
  status: 'present' | 'explicit_zero';
  data_through: string;
  reason?: never;
}>;

type InlineReportingUnavailableMetricEvidenceV1 = Readonly<{
  constituent_id: string;
  metric: string;
  status: 'unsupported' | 'delayed' | 'partial' | 'stale' | 'missing';
  reason: string;
  data_through?: string;
}>;

/** One bounded availability claim for an exact requested constituent-metric cell. */
export type InlineReportingMetricEvidenceV1 =
  | InlineReportingAvailableMetricEvidenceV1
  | InlineReportingUnavailableMetricEvidenceV1;

/**
 * Versioned inline evidence envelope. When supplied, cells must cover the exact
 * requested constituent-metric matrix once each.
 */
export interface InlineReportingAvailabilityEvidenceV1 {
  version: typeof INLINE_REPORTING_AVAILABILITY_EVIDENCE_VERSION_V1;
  cells: readonly InlineReportingMetricEvidenceV1[];
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
  availability_evidence?: InlineReportingAvailabilityEvidenceV1;
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
// One comprehensive budget for every per-row check availability verification performs:
// each requested metric and each requested dimension, once per row, once per constituent
// that names the row's media buy. Metrics alone left dimensions and constituent fanout
// unpriced, which admitted shapes demanding three orders of magnitude more work.
const INLINE_MAX_VALIDATION_WORK_UNITS_V1 = 5_000_000;
// Cumulative bytes validation may scan while measuring and canonicalizing claims. Held
// at the per-object staging ceiling: no response may be scanned more than a single
// staged object's worth, however the claims are distributed across rows and metrics.
const INLINE_MAX_VALIDATION_SCAN_BYTES_V1 = INLINE_MAX_OBJECT_BYTES_V1;
// Retained validation state is held to the per-object staging ceiling. Claims are kept
// columnar -- one value slot and one flag byte per captured field, in arrays shared by
// every row -- so what is held stays proportionate to what is staged; per-field claim
// objects in a Map cost roughly twenty-five times as much, which let a request inside
// every other limit hold most of a gigabyte before a completeness check could reject it.
//
// The ceiling is the per-object limit rather than the per-scope one because the estimate
// below is an upper bound on held bytes while the scope limit governs written bytes. Held
// against the scope limit it refused reports the staging cap admits: 100,000 rows over 32
// short metrics estimate 33,600,000 held bytes against a 33,554,432 scope limit, yet
// write 32,500,000 bytes, which that same limit accepts. With rows capped at 100,000 and
// the work budget capped at 5,000,000 units the widest admissible request holds about
// 48 MB, so this ceiling asserts that arithmetic rather than being a limit adopters meet.
const INLINE_MAX_VALIDATION_RETAINED_BYTES_V1 = INLINE_MAX_OBJECT_BYTES_V1;
// One shared value array and one shared flag array hold every row's claims, so a claim
// costs one pointer slot plus one flag byte and a row costs only its snapshot handle and
// its reserved capture. Per-row arrays cost their own headers instead, which made the
// bound stricter than the staging budget it is meant to mirror: a 100,000 row report over
// 20 short metrics stages in about 24 MB yet was refused outright.
const INLINE_RETAINED_BYTES_PER_ROW_V1 = 48;
const INLINE_RETAINED_BYTES_PER_CLAIM_V1 = 9;
// The longest status this adapter recognizes is `reporting_delayed`. A longer string
// cannot match one, so it is never case-folded: a huge status shared by every row used to
// be copied once per row before a failure that was already decided.
const INLINE_MAX_STATUS_CHARS_V1 = 32;
/** Offset of a snapshot that carries no claims: every slot reads as absent. */
const INLINE_NO_CLAIMS_OFFSET_V1 = -1;
// Evidence envelopes and cells carry a fixed, small field set. Both are checked against
// these lists before any descriptor is observed.
const INLINE_MAX_EVIDENCE_OBJECT_KEYS_V1 = 16;
// Comfortably above the longest evidence field the schema admits (a 512 character
// reason), so every valid value passes and an unbounded one is refused before validation.
const INLINE_MAX_EVIDENCE_FIELD_CHARS_V1 = 1_024;
const INLINE_EVIDENCE_ENVELOPE_KEYS_V1 = ['version', 'cells'] as const;
const INLINE_EVIDENCE_CELL_KEYS_V1 = ['constituent_id', 'metric', 'status', 'reason', 'data_through'] as const;
const INLINE_UNAVAILABLE_ROW_STATUSES_V1 = [
  'failed',
  'reporting_delayed',
  'not_ready',
  'pending',
  'unavailable',
  'error',
];
const INLINE_UNAVAILABLE_CELL_STATUSES_V1 = ['unsupported', 'delayed', 'missing'];
const INLINE_MAX_PROTOTYPE_CHAIN_DEPTH_V1 = 64;
const INLINE_MAX_DECIMAL_EXPONENT_V1 = 400;

const InlineReportingMetricEvidenceV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    constituent_id: ReportingExternalIdV1Schema,
    metric: ReportingMetricOrDimensionNameV1Schema,
    status: z.enum(['present', 'explicit_zero']),
    data_through: z.string().trim().min(1).max(64),
    reason: z.never().optional(),
  }),
  z.strictObject({
    constituent_id: ReportingExternalIdV1Schema,
    metric: ReportingMetricOrDimensionNameV1Schema,
    status: z.enum(['unsupported', 'delayed', 'partial', 'stale', 'missing']),
    reason: ReportingEvidenceReasonV1Schema,
    data_through: z.string().trim().min(1).max(64).optional(),
  }),
]);

const InlineReportingAvailabilityEvidenceV1Schema = z.strictObject({
  version: z.literal(INLINE_REPORTING_AVAILABILITY_EVIDENCE_VERSION_V1),
  cells: z.array(InlineReportingMetricEvidenceV1Schema).min(1).max(SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1),
});

/**
 * Adapt a synchronous delivery handler to the reporting-source contract.
 * The returned object is both the executor and its generation-pinned reader.
 */
export function createInlineReportingSourceExecutor(
  deliveryFetch: InlineReportingDeliveryFetchV1,
  offeringInput: ReportingSourceOfferingV1
): InlineReportingSourceExecutorV1 {
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

      if (executions.size >= INLINE_MAX_EXECUTIONS_V1) {
        return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline reporting replay capacity is exhausted');
      }
      if (
        [...executions.values()].filter(candidate => candidate.scopeKey === scopeKey).length >=
        INLINE_MAX_EXECUTIONS_PER_SCOPE_V1
      ) {
        return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline reporting scope replay capacity is exhausted');
      }
      if (activeExecutions >= INLINE_MAX_CONCURRENT_EXECUTIONS_V1) {
        return failure('RATE_LIMITED', 'retryable', 'Inline reporting concurrency capacity is exhausted');
      }

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
        constituents: request.coverage.constituents.map(constituent => ({
          constituent_id: constituent.constituentId,
          media_buy_id: constituent.mediaBuyId!,
        })),
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
  const fetchedRecord = !isRows(fetched) ? (fetched as unknown as Record<string, unknown>) : undefined;
  // `status` is the first thing observed, and the failures it decides are settled before
  // anything else is read. A response reporting `failed` alongside a row collection that
  // throws on access is a retryable source failure, not a terminal one -- capturing the
  // collections first turned the established precedence upside down.
  let rawStatus: unknown;
  try {
    rawStatus = fetchedRecord?.status;
  } catch {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned an unreadable response');
  }
  // A status that is present but is not a string is not an absent status: it is an
  // unreadable response. Narrowing it to absent let `status: 7` seal alongside valid rows.
  if (rawStatus !== undefined && typeof rawStatus !== 'string') {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch reported an unreadable status');
  }
  const responseStatus = boundedLowerCaseStatus(rawStatus);
  if (['failed', 'error', 'canceled', 'cancelled', 'rejected'].includes(responseStatus ?? '')) {
    return failure('SOURCE_TRANSIENT', 'retryable', 'Inline delivery fetch reported failure');
  }
  if (responseStatus === 'unavailable') {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch reported unavailable data');
  }
  // Each remaining response field is observed at most once, and only when a check needs
  // it. Reading a field twice let a stateful response answer differently per observation
  // -- a `currency` naming a foreign currency when its presence was tested and the frozen
  // currency when it was compared, or a `reporting_period` proving its start from one
  // object and its end from another -- and reading every field up front let a field no
  // check would have reached decide the outcome: a response reporting `working` beside a
  // throwing `reporting_period` came back terminal instead of retryable.
  const readResponseField = createResponseFieldReader(fetchedRecord);
  const scalarFailure = ((): ReportingSourceExecutorResultV1 | undefined => {
    try {
      if (
        !isRows(fetched) &&
        (['working', 'submitted', 'input_required', 'deferred', 'reporting_delayed', 'not_ready', 'pending'].includes(
          responseStatus ?? ''
        ) ||
          (request.publicationClass === 'AUTHORITATIVE' && readResponseField('is_final') === false))
      ) {
        return failure('NOT_READY', 'retryable', 'Reporting data is not ready');
      }
      if (
        request.publicationClass === 'AUTHORITATIVE' &&
        (isRows(fetched) ||
          (readResponseField('is_final') !== true &&
            !['final', 'adjusted'].includes(asStringOrUndefined(readResponseField('notification_type')) ?? '')))
      ) {
        return failure('NOT_READY', 'retryable', 'Authoritative inline reporting requires source finality evidence');
      }
      if (
        !isRows(fetched) &&
        (Boolean(readResponseField('partial_data')) ||
          looseCount(readResponseField('unavailable_count')) > 0 ||
          looseCount(lengthOfUnknown(readResponseField('errors'))) > 0)
      ) {
        return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch returned partial data');
      }
      const pagination = readResponseField('pagination');
      if (!isRows(fetched) && fetchedRecord !== undefined && pagination !== undefined) {
        const paginationRecord = asRowRecord(pagination);
        if (paginationRecord?.has_more !== false || Boolean(paginationRecord?.next_cursor)) {
          return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch returned unfinished pagination');
        }
      }
      return undefined;
    } catch {
      return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned an unreadable response');
    }
  })();
  if (scalarFailure) return scalarFailure;
  // Only now are the row collections read. Every failure the response's own status and
  // control fields decide has already been settled, so a response reporting `working`
  // beside a collection that throws on access stays retryable rather than being turned
  // terminal by the read. Each collection is read through the ordinary property channel,
  // so a class instance, a prototype-inherited value and an accessor-backed slot all keep
  // working, and each is read once: the collection that gets validated is the collection
  // that gets staged.
  let reportingRowsInput: unknown;
  let mediaBuyDeliveriesInput: unknown;
  try {
    reportingRowsInput = fetchedRecord ? fetchedRecord.reporting_rows : undefined;
    mediaBuyDeliveriesInput = fetchedRecord ? fetchedRecord.media_buy_deliveries : undefined;
  } catch {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned an invalid row collection');
  }
  // One bounded observation decides the evidence slot for the whole execution. A slot
  // that is not an own data property reads as omitted, which would silently downgrade
  // the response to legacy present inference, so it is refused here without reading the
  // accessor. Observing the slot a second time would let a stateful proxy answer
  // "accessor" once and "data" once, and that pair of answers reaches the same silent
  // downgrade -- so the captured snapshot below is the only answer anything consults.
  const availabilityEvidenceSlot: OwnDataSlotV1 = fetchedRecord
    ? resolveOwnDataSlot(fetchedRecord, 'availability_evidence')
    : { kind: 'absent' };
  if (
    (reportingRowsInput !== undefined && !Array.isArray(reportingRowsInput)) ||
    (mediaBuyDeliveriesInput !== undefined && !Array.isArray(mediaBuyDeliveriesInput))
  ) {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned an invalid row collection');
  }
  const reportingRows = reportingRowsInput as readonly unknown[] | undefined;
  const mediaBuyDeliveries = mediaBuyDeliveriesInput as readonly unknown[] | undefined;
  // Each collection declares its length exactly once. Reading it again let a collection
  // admit five rows and then hand back none, sealing five real rows as an observed empty
  // period: rowCount 0, explicit zero, coverage full.
  const reportingRowsLength = boundedCollectionLength(reportingRows);
  const mediaBuyDeliveriesLength = boundedCollectionLength(mediaBuyDeliveries);
  const sourceDeclaredLength = isRows(fetched)
    ? boundedCollectionLength(fetched)
    : reportingRows !== undefined
      ? reportingRowsLength
      : mediaBuyDeliveriesLength;
  if (
    reportingRowsLength === undefined ||
    mediaBuyDeliveriesLength === undefined ||
    sourceDeclaredLength === undefined
  ) {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned an invalid row collection');
  }
  if (!isRows(fetched) && reportingRows === undefined && mediaBuyDeliveries === undefined) {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch omitted its row collection');
  }
  let responsePeriod: { readonly present: boolean; readonly start: unknown; readonly end: unknown };
  let responseCurrency: unknown;
  try {
    // Each boundary is observed once and only that observation is validated: reading a
    // boundary for presence, then for type, then for value let a getter answer with
    // rubbish twice and the requested date on the third read.
    const period = asRowRecord(readResponseField('reporting_period'));
    const periodStart = period?.start;
    const periodEnd = period?.end;
    responsePeriod = {
      present: period !== undefined && periodStart !== undefined && periodEnd !== undefined,
      start: periodStart,
      end: periodEnd,
    };
    responseCurrency = readResponseField('currency');
  } catch {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned an unreadable response');
  }
  if (
    !isRows(fetched) &&
    (!responsePeriod.present ||
      !deliveryPeriodBoundaryMatches(responsePeriod.start, deliveryDates.start, request.period.start) ||
      !deliveryPeriodBoundaryMatches(responsePeriod.end, deliveryDates.end, request.period.end))
  ) {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch did not prove the requested half-open period');
  }
  if (!isRows(fetched) && responseCurrency !== undefined && responseCurrency !== request.sourceSettings.currency) {
    return failure(
      'INTEGRITY_FAILED',
      'terminal',
      'Inline delivery currency does not match the frozen source settings'
    );
  }
  if (
    !isRows(fetched) &&
    (reportingRowsLength > INLINE_MAX_ROWS_V1 ||
      mediaBuyDeliveriesLength > INLINE_MAX_ROWS_V1 ||
      reportingRowsLength + mediaBuyDeliveriesLength > INLINE_MAX_ROWS_V1)
  ) {
    return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline delivery fetch exceeded the row limit');
  }
  if (
    !isRows(fetched) &&
    reportingRows !== undefined &&
    mediaBuyDeliveries !== undefined &&
    (reportingRowsLength === 0) !== (mediaBuyDeliveriesLength === 0)
  ) {
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row collections disagree about zero delivery');
  }

  // Copy by index against the length that was already counted, never by spreading. A
  // collection reporting length zero can still yield through a custom iterator, so
  // spreading materialized far more rows than the cap admits before the cap was checked.
  const sourceCollection = isRows(fetched) ? fetched : (reportingRows ?? mediaBuyDeliveries ?? []);
  const auxiliaryDeclaredLength = !isRows(fetched) && reportingRows !== undefined ? mediaBuyDeliveriesLength : 0;
  if (sourceDeclaredLength > INLINE_MAX_ROWS_V1 || auxiliaryDeclaredLength > INLINE_MAX_ROWS_V1) {
    return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline delivery fetch exceeded the row limit');
  }
  const sourceRowInputs = captureRowCollection(sourceCollection, sourceDeclaredLength);
  const auxiliaryRowInputs =
    auxiliaryDeclaredLength > 0 ? captureRowCollection(mediaBuyDeliveries ?? [], auxiliaryDeclaredLength) : [];
  let availabilityEvidence: z.output<typeof InlineReportingAvailabilityEvidenceV1Schema> | undefined;
  if (!isRows(fetched) && availabilityEvidenceSlot.kind === 'unreadable') {
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery availability evidence is invalid');
  }
  if (!isRows(fetched) && availabilityEvidenceSlot.kind === 'data') {
    try {
      // Parse the captured value, never a re-read of the adopter slot.
      availabilityEvidence = parseInlineAvailabilityEvidence(
        availabilityEvidenceSlot.value as InlineReportingAvailabilityEvidenceV1,
        request
      );
    } catch {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery availability evidence is invalid');
    }
  }
  // Settle both observation budgets from counts alone, before a single row is read: one
  // identity read plus one read per requested metric and dimension, per row, and the
  // bytes the captured claims will occupy while validation runs.
  const captureLayout = captureLayoutFor(request);
  const claimBearingRowCount =
    sourceRowInputs.length + (availabilityEvidenceSlot.kind === 'data' ? auxiliaryRowInputs.length : 0);
  if (
    workUnitsExceedCap(
      claimBearingRowCount,
      1 + request.requestedMetrics.length + request.requestedDimensions.length,
      INLINE_MAX_VALIDATION_WORK_UNITS_V1
    ) ||
    workUnitsExceedCap(
      claimBearingRowCount,
      INLINE_RETAINED_BYTES_PER_ROW_V1 + captureLayout.fields.length * INLINE_RETAINED_BYTES_PER_CLAIM_V1,
      INLINE_MAX_VALIDATION_RETAINED_BYTES_V1
    )
  ) {
    return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline availability verification exceeded the work budget');
  }
  const strictClaims = availabilityEvidence !== undefined;
  let scanBudget = INLINE_MAX_VALIDATION_SCAN_BYTES_V1;
  const chargeScan = (units: number) => {
    if (units > scanBudget) throw new InlineWorkBudgetExhaustedError();
    scanBudget -= units;
  };
  // Each row's own reserved fields are observed once, here. Row status decides the
  // outcome for every row before any currency is considered, and currency before any
  // claim is captured -- the order these checks have always resolved in -- and a
  // requested field named after a reserved one reuses this same observation instead of
  // taking a second one the row could answer differently.
  // Row status is settled before any other row field is observed. Reading a row's whole
  // reserved set up front meant a failed row whose `totals` descriptor throws turned a
  // retryable partial result into a terminal one. Each field is still read exactly once:
  // status and `partial_data` in this pass, currency in the next, identity and `totals`
  // in the claim capture.
  const sourceReserved: (RowReservedV1 | undefined)[] = [];
  const auxiliaryReserved: (RowReservedV1 | undefined)[] = [];
  for (const [rows, captured] of [
    [sourceRowInputs, sourceReserved],
    [auxiliaryRowInputs, auxiliaryReserved],
  ] as const) {
    for (const row of rows) {
      const reserved = beginRowReserved(row);
      captured.push(reserved);
      // Stop at the first row that settles the outcome: nothing after it is read, and
      // within the row `partial_data` is only observed if the status did not settle it.
      if (reserved !== undefined && (rowStatusIsUnavailable(reserved) || rowDeclaresPartialData(reserved))) {
        return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery fetch returned an unavailable row');
      }
    }
  }
  for (const reserved of [...sourceReserved, ...auxiliaryReserved]) {
    if (reserved === undefined) continue;
    readRowCurrency(reserved);
    if (typeof reserved.currency === 'string' && reserved.currency !== request.sourceSettings.currency) {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row currency does not match source settings');
    }
  }
  // Observe every claim exactly once. Budgeting, scope checks, availability validation,
  // projection and the staged bytes all read these snapshots, so a row that answers
  // differently on a second read cannot charge one shape and perform another.
  let sourceSnapshots: readonly (RowSnapshotV1 | undefined)[];
  let auxiliarySnapshots: readonly (RowSnapshotV1 | undefined)[];
  try {
    // Only availability verification reads the auxiliary collection's claims. Capturing
    // them on the legacy path billed and observed metric and dimension descriptors that
    // nothing would consult: an unused auxiliary metric whose descriptor throws turned a
    // previously admitted response terminal, and wide auxiliary rows exhausted the work
    // budget outright.
    const claimRowCount = sourceReserved.length + (strictClaims ? auxiliaryReserved.length : 0);
    const store = createClaimStore(captureLayout, claimRowCount);
    sourceSnapshots = sourceReserved.map((reserved, index) =>
      captureRowSnapshot(reserved, store, index, strictClaims, chargeScan)
    );
    auxiliarySnapshots = auxiliaryReserved.map((reserved, index) =>
      strictClaims
        ? captureRowSnapshot(reserved, store, sourceReserved.length + index, strictClaims, chargeScan)
        : captureRowIdentityOnly(reserved, store)
    );
  } catch (error) {
    if (error instanceof InlineWorkBudgetExhaustedError) {
      return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline availability verification exceeded the scan budget');
    }
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row contains invalid evidence values');
  }
  const allSnapshots = [...sourceSnapshots, ...auxiliarySnapshots];
  // Now that the identities are captured, price the fanout from them: every constituent
  // naming a media buy re-checks that media buy's rows against its own cells.
  if (
    validationWorkExceedsCap(
      sourceSnapshots,
      auxiliarySnapshots,
      request,
      availabilityEvidence !== undefined,
      INLINE_MAX_VALIDATION_WORK_UNITS_V1
    )
  ) {
    return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline availability verification exceeded the work budget');
  }
  const admittedMediaBuyIds = new Set(
    request.coverage.constituents.flatMap(constituent => (constituent.mediaBuyId ? [constituent.mediaBuyId] : []))
  );
  const sourceSnapshotsByMediaBuyId = groupSnapshotsByMediaBuyId(sourceSnapshots, admittedMediaBuyIds);
  const auxiliarySnapshotsByMediaBuyId = groupSnapshotsByMediaBuyId(auxiliarySnapshots, admittedMediaBuyIds);
  if (sourceSnapshots.length > 0) {
    // The auxiliary collection is scope-checked too, including on the legacy path where
    // it is intentionally left unprojected.
    if (allSnapshots.some(snapshot => !admittedMediaBuyIds.has(snapshot?.mediaBuyId ?? ''))) {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery fetch returned an out-of-scope row');
    }
    if (
      request.coverage.constituents.some(constituent => {
        if (constituent.constituentKind !== 'media_buy' || !constituent.mediaBuyId) return true;
        const constituentRows = sourceSnapshotsByMediaBuyId.get(constituent.mediaBuyId) ?? NO_SNAPSHOTS;
        return (
          constituentRows.some(snapshot =>
            request.requestedDimensions.some(dimension => !snapshotHasDimension(snapshot, dimension))
          ) ||
          (availabilityEvidence === undefined &&
            (constituentRows.length === 0 ||
              constituentRows.some(snapshot =>
                request.requestedMetrics.some(metric => snapshotFieldValue(snapshot, metric) === undefined)
              )))
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
  if (availabilityEvidence !== undefined) {
    const rowEvidenceFailure = validateSnapshotsAgainstAvailabilityEvidence(
      sourceSnapshotsByMediaBuyId,
      auxiliarySnapshotsByMediaBuyId,
      request,
      availabilityEvidence.cells
    );
    if (rowEvidenceFailure === 'partial') {
      return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery rows do not prove every metric marked present');
    }
    if (rowEvidenceFailure === 'integrity') {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery rows contradict availability evidence');
    }
  }
  // Only once every semantic verdict is settled is the response projected. Projecting
  // first spent the staging budget proving nothing: a response missing a requested metric
  // came back terminal STAGING_FAILED instead of the retryable PARTIAL_RESULT its
  // incompleteness earns, and an out-of-scope row was masked the same way.
  const readsPartialPeriod = Date.parse(request.period.sourceReadCutoffAt) < Date.parse(request.period.end);
  if (
    readsPartialPeriod &&
    (isRows(fetched) ||
      readResponseField('data_through') === undefined ||
      readResponseField('observed_at') === undefined)
  ) {
    return failure(
      'PARTIAL_RESULT',
      'retryable',
      'Inline delivery fetch did not provide temporal evidence for the source read cutoff'
    );
  }
  const observedAt = isRows(fetched)
    ? request.period.sourceReadCutoffAt
    : normalizeDeliveryInstant(
        readResponseField('observed_at') ?? request.period.sourceReadCutoffAt,
        deliveryDates,
        request.period
      );
  const defaultDataThrough =
    request.publicationClass === 'AUTHORITATIVE'
      ? request.period.end
      : Date.parse(request.period.sourceReadCutoffAt) < Date.parse(request.period.end)
        ? request.period.sourceReadCutoffAt
        : request.period.end;
  const dataThrough = isRows(fetched)
    ? defaultDataThrough
    : normalizeDeliveryInstant(readResponseField('data_through') ?? defaultDataThrough, deliveryDates, request.period);
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
    (sourceSnapshots.length > 0 && dataThroughMs <= startMs)
  ) {
    return failure('SOURCE_PERMANENT', 'terminal', 'Inline delivery fetch returned invalid temporal evidence');
  }
  const declaredMetrics = new Map(offering.metrics.map(metric => [metric.name, metric]));
  const constituentIdsWithRows = new Set(
    request.coverage.constituents
      .filter(constituent => constituent.mediaBuyId && sourceSnapshotsByMediaBuyId.has(constituent.mediaBuyId))
      .map(constituent => constituent.constituentId)
  );
  let projectedAvailability: InlineAvailabilityProjection;
  if (availabilityEvidence) {
    try {
      projectedAvailability = projectInlineAvailabilityEvidence(
        availabilityEvidence.cells,
        request,
        declaredMetrics,
        deliveryDates,
        dataThrough,
        sourceSnapshots.length,
        constituentIdsWithRows
      );
    } catch {
      return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery availability evidence is contradictory');
    }
  } else {
    projectedAvailability = projectLegacyAvailability(request, declaredMetrics, dataThrough, sourceSnapshots.length);
  }
  if (request.coverage.expected === 'full' && projectedAvailability.coverageStatus !== 'full') {
    return failure('PARTIAL_RESULT', 'retryable', 'Inline delivery evidence does not satisfy full requested coverage');
  }
  if (
    request.publicationClass === 'AUTHORITATIVE' &&
    projectedAvailability.metricAvailability.some(
      cell => !['present', 'explicit_zero'].includes(cell.status) || Date.parse(cell.dataThrough ?? '') !== endMs
    )
  ) {
    return failure('PARTIAL_RESULT', 'retryable', 'Authoritative inline reporting has incomplete metric evidence');
  }
  // Only once every semantic verdict is settled -- scope, completeness, evidence
  // reconciliation, temporal evidence and coverage -- is the response projected.
  // Projecting earlier spent the staging budget proving nothing, so a response whose
  // own evidence already decided the outcome came back terminal STAGING_FAILED
  // instead of the verdict it earned.
  const remainingCapacity = Math.min(
    INLINE_MAX_OBJECT_BYTES_V1,
    INLINE_MAX_TOTAL_OBJECT_BYTES_V1 - storage.totalBytes,
    INLINE_MAX_SCOPE_OBJECT_BYTES_V1 - (storage.scopeBytes.get(scopeKey) ?? 0)
  );
  let projectionBudget = remainingCapacity;
  let rows: readonly Record<string, unknown>[];
  try {
    // Only the source collection is projected. The auxiliary collection is validated
    // from its captured claims and never staged, so projecting it charged a budget
    // against values nothing would read -- 20,000 valid auxiliary rows were enough to
    // fail a response whose staged object is sixty-eight bytes.
    rows = sourceSnapshots.map(snapshot =>
      projectSnapshotRow(
        snapshot,
        request,
        upperBound => {
          if (upperBound > projectionBudget) throw new RangeError('Inline projection capacity exhausted');
          projectionBudget -= upperBound;
        },
        {
          allowMissingMetrics: true,
          allowMissingDimensions: true,
          strictMetricClaims: availabilityEvidence !== undefined,
          includeDimensions: true,
        }
      )
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return failure('STAGING_FAILED', 'terminal', 'Inline delivery evidence exceeds the bounded replay capacity');
    }
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery row contains invalid evidence values');
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
  let built;
  try {
    built = buildReportingSourceManifestV1({
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
      metricAvailability: projectedAvailability.metricAvailability,
      coverage: {
        status: projectedAvailability.coverageStatus,
        constituents: projectedAvailability.coverageConstituents,
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
      explicitZero: projectedAvailability.explicitZero,
      acquiredAt,
      ...(rows.length === 0 ? {} : { eventTimeRange: { start: request.period.start, end: dataThrough } }),
      warnings: [],
    });
  } catch (error) {
    if (!availabilityEvidence) throw error;
    if (error instanceof SourceBatchContractError && error.code === 'SOURCE_MANIFEST_TOO_LARGE') {
      return failure('QUOTA_EXHAUSTED', 'terminal', 'Inline reporting manifest exceeded the bounded size limit');
    }
    return failure('INTEGRITY_FAILED', 'terminal', 'Inline delivery availability evidence is contradictory');
  }
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

type InlineAvailabilityCell = ReportingSourceManifestV1['metricAvailability'][number];
type InlineCoverageConstituent = ReportingSourceManifestV1['coverage']['constituents'][number];
type InlineAvailabilityProjection = {
  metricAvailability: InlineAvailabilityCell[];
  coverageConstituents: InlineCoverageConstituent[];
  coverageStatus: ReportingSourceManifestV1['coverage']['status'];
  explicitZero: boolean;
};

function parseInlineAvailabilityEvidence(
  input: InlineReportingAvailabilityEvidenceV1,
  request: ReportingSourceSliceRequestV1
): z.output<typeof InlineReportingAvailabilityEvidenceV1Schema> {
  if (typeof input !== 'object' || input === null) throw new TypeError('Availability evidence is not an envelope');
  // Validate a snapshot, never the adopter object. Handing the envelope to the schema
  // would re-read `cells` through the get channel, so a stateful proxy could satisfy the
  // cap below with one array and then present a different array -- or a restated claim
  // in the same array -- to the validator. Unknown keys are carried into the snapshot so
  // the strict schema still rejects them.
  const envelope = snapshotOwnDataObject(input as unknown as Record<string, unknown>, INLINE_EVIDENCE_ENVELOPE_KEYS_V1);
  const inputCells = envelope.cells;
  const cellCount = Array.isArray(inputCells) ? boundedCollectionLength(inputCells) : undefined;
  if (cellCount === undefined) throw new TypeError('Availability evidence cells are not a bounded array');
  if (cellCount > SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1) {
    throw new TypeError('Availability evidence exceeds the cell limit');
  }
  // Pin exactly the counted cells, in order, and snapshot each one from its own data
  // properties, so the cells that passed the cap are the cells that are validated and no
  // cell field is read through an accessor or inherited from a prototype.
  const cellSnapshot: unknown[] = new Array(cellCount);
  for (let index = 0; index < cellCount; index += 1) {
    const cell = (inputCells as unknown[])[index];
    if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) {
      throw new TypeError('Availability evidence cell is not an object');
    }
    cellSnapshot[index] = snapshotOwnDataObject(cell as Record<string, unknown>, INLINE_EVIDENCE_CELL_KEYS_V1);
  }
  const parsed = InlineReportingAvailabilityEvidenceV1Schema.parse({ ...envelope, cells: cellSnapshot });
  const expected = new Set(
    request.coverage.constituents.flatMap(constituent =>
      request.requestedMetrics.map(metric => availabilityCellKey(constituent.constituentId, metric))
    )
  );
  const seen = new Set<string>();
  for (const cell of parsed.cells) {
    const key = availabilityCellKey(cell.constituent_id, cell.metric);
    if (!expected.has(key) || seen.has(key)) throw new TypeError('Availability cell is duplicate or out of scope');
    seen.add(key);
  }
  if (seen.size !== expected.size) throw new TypeError('Availability evidence must cover the requested matrix');
  const cellsByKey = new Map(parsed.cells.map(cell => [availabilityCellKey(cell.constituent_id, cell.metric), cell]));
  return {
    ...parsed,
    cells: request.coverage.constituents.flatMap(constituent =>
      request.requestedMetrics.map(metric => {
        const cell = cellsByKey.get(availabilityCellKey(constituent.constituentId, metric));
        if (!cell) throw new TypeError('Availability evidence must cover the requested matrix');
        return cell;
      })
    ),
  };
}

const NO_SNAPSHOTS: readonly RowSnapshotV1[] = [];

/** Raised when a bounded validation budget is spent. Never escapes `executeAndSeal`. */
class InlineWorkBudgetExhaustedError extends Error {}

/** One claim for one field, from a single descriptor observation. */
type RowClaimV1 = { readonly claimed: boolean; readonly value?: unknown };

const UNCLAIMED_V1: RowClaimV1 = { claimed: false };

/**
 * Field ordinals shared by every row of one request. Claims are addressed by ordinal, so
 * a row retains two flat slots per field rather than a Map entry and a claim object:
 * 100,000 rows over 48 requested fields held roughly 4,800,000 claim objects and Map
 * entries -- near a gigabyte -- before a completeness check could reject the response.
 */
type CaptureLayoutV1 = {
  readonly fields: readonly string[];
  readonly indexOf: ReadonlyMap<string, number>;
  /** Requested fields that name one of the adapter's own row fields. */
  readonly reservedFields: ReadonlySet<string>;
};

function captureLayoutFor(request: ReportingSourceSliceRequestV1): CaptureLayoutV1 {
  const fields: string[] = [];
  const indexOf = new Map<string, number>();
  const reservedFields = new Set<string>();
  // `media_buy_id` needs no slot to serve as a dimension -- the row identity proves it --
  // but as a requested metric it does, and skipping it outright left the metric unproven
  // and the report a retryable partial result. It resolves to the identity observation
  // either way, so the slot costs no extra read.
  const requestedAsMetric = new Set(request.requestedMetrics);
  for (const field of [...request.requestedMetrics, ...request.requestedDimensions]) {
    if (indexOf.has(field)) continue;
    if (field === 'media_buy_id' && !requestedAsMetric.has(field)) continue;
    indexOf.set(field, fields.length);
    fields.push(field);
    if ((INLINE_RESERVED_ROW_FIELDS_V1 as readonly string[]).includes(field)) reservedFields.add(field);
  }
  return { fields, indexOf, reservedFields };
}

// Per-field capture flags. Only the resolved value is retained: the direct claim is what
// projection keeps whenever it is claimed and valid, and the `totals` claim otherwise, so
// both reduce to one slot plus these bits.
const CLAIM_DIRECT_CLAIMED_V1 = 1 << 0;
const CLAIM_NESTED_CLAIMED_V1 = 1 << 1;
const CLAIM_DIRECT_VALID_V1 = 1 << 2;
const CLAIM_NESTED_VALID_V1 = 1 << 3;
const CLAIM_VALUE_IS_ZERO_V1 = 1 << 4;
const CLAIM_CLAIM_IS_ZERO_V1 = 1 << 5;
const CLAIM_DISAGREE_V1 = 1 << 6;

/**
 * The row fields this adapter reads for its own purposes, observed once per row.
 *
 * A requested metric or dimension may be named after one of them. Re-observing the slot
 * for the requested field let a stateful row answer differently: a `currency` reading
 * `USD` when the row was checked and `EUR` when the dimension was captured validated one
 * value and staged another, and a `status` reading `failed` when it was captured staged a
 * failed row as complete. Any requested field named after a reserved one resolves to this
 * single observation.
 */
type RowReservedV1 = {
  readonly record: Record<string, unknown>;
  readonly status: unknown;
  /** Filled by `rowDeclaresPartialData`, once, only if status did not settle the row. */
  partialData?: unknown;
  /** Filled by `readRowCurrency`, once, after every row's status has been settled. */
  currency?: unknown;
  /** Filled by `readRowIdentityAndTotals`, once, when claims are captured. */
  mediaBuyId?: unknown;
  totals?: unknown;
};

const INLINE_RESERVED_ROW_FIELDS_V1 = ['media_buy_id', 'currency', 'status', 'partial_data', 'totals'] as const;

/** Observe only what row status needs, so a failed row costs nothing more than that. */
function beginRowReserved(row: unknown): RowReservedV1 | undefined {
  const record = asRowRecord(row);
  if (!record) return undefined;
  return { record, status: ownDataValue(record, 'status') };
}

/** True when the row's own status already settles it as unavailable. */
function rowStatusIsUnavailable(reserved: RowReservedV1): boolean {
  const status = boundedLowerCaseStatus(reserved.status);
  return status !== undefined && INLINE_UNAVAILABLE_ROW_STATUSES_V1.includes(status);
}

/**
 * Observe `partial_data`, once, only after the row's status has failed to settle it. A
 * failed row whose `partial_data` descriptor throws used to be turned from a retryable
 * partial result into a terminal one by a read nothing needed.
 */
function rowDeclaresPartialData(reserved: RowReservedV1): boolean {
  reserved.partialData = ownDataValue(reserved.record, 'partial_data');
  return reserved.partialData === true;
}

function readRowCurrency(reserved: RowReservedV1): void {
  reserved.currency = ownDataValue(reserved.record, 'currency');
}

function readRowIdentity(reserved: RowReservedV1): void {
  reserved.mediaBuyId = ownDataValue(reserved.record, 'media_buy_id');
}

function reservedFieldValue(reserved: RowReservedV1, field: string): unknown {
  switch (field) {
    case 'media_buy_id':
      return reserved.mediaBuyId;
    case 'currency':
      return reserved.currency;
    case 'status':
      return reserved.status;
    case 'partial_data':
      return reserved.partialData;
    default:
      return reserved.totals;
  }
}

/**
 * Claims for every captured row, stored in two arrays shared by all of them.
 *
 * A values array and a flag byte array per row cost their own headers, which dominated
 * the retained footprint for narrow requests: a 100,000 row report over 20 short metrics
 * stages in well under the budget yet was refused by the retained bound. One pair of
 * arrays for the whole response removes that per-row overhead, so the bound tracks the
 * claims themselves.
 */
type CapturedClaimStoreV1 = {
  readonly layout: CaptureLayoutV1;
  readonly values: (string | number | undefined)[];
  readonly flags: Uint8Array;
};

function createClaimStore(layout: CaptureLayoutV1, rowCount: number): CapturedClaimStoreV1 {
  const width = layout.fields.length;
  return {
    layout,
    values: new Array<string | number | undefined>(rowCount * width),
    flags: new Uint8Array(rowCount * width),
  };
}

/**
 * One delivery row observed exactly once.
 *
 * Work budgeting, scope checks, availability validation, projection and the staged bytes
 * all read this snapshot rather than the adopter row. Re-reading a row let a stateful
 * proxy answer differently per observation: a `media_buy_id` reporting a unique value
 * while the fanout budget was counted and a shared value while the rows were grouped
 * charged one constituent's work and then performed every constituent's.
 */
type RowSnapshotV1 = {
  readonly store: CapturedClaimStoreV1;
  /** Offset of this row's claims inside the shared arrays. */
  readonly offset: number;
  readonly mediaBuyId: string | undefined;
};

/** Layout ordinal of `field`, or -1 when the request did not ask for it. */
function fieldSlotOf(snapshot: RowSnapshotV1, field: string): number {
  return snapshot.store.layout.indexOf.get(field) ?? -1;
}

function slotValue(snapshot: RowSnapshotV1, slot: number): string | number | undefined {
  return slot < 0 || snapshot.offset < 0 ? undefined : snapshot.store.values[snapshot.offset + slot];
}

function slotFlags(snapshot: RowSnapshotV1, slot: number): number {
  return slot < 0 || snapshot.offset < 0 ? 0 : (snapshot.store.flags[snapshot.offset + slot] ?? 0);
}

/** The resolved value for `field`: the direct claim when valid, else the `totals` claim. */
function snapshotFieldValue(snapshot: RowSnapshotV1, field: string): string | number | undefined {
  return slotValue(snapshot, fieldSlotOf(snapshot, field));
}

/**
 * Capture one row's claims into the shared store. Returns undefined when the row was not
 * an object at all, so the status and currency passes keep their precedence over the
 * projection's rejection.
 */
function captureRowSnapshot(
  reserved: RowReservedV1 | undefined,
  store: CapturedClaimStoreV1,
  rowIndex: number,
  strictClaims: boolean,
  chargeScan: (units: number) => void
): RowSnapshotV1 | undefined {
  if (!reserved) return undefined;
  readRowIdentity(reserved);
  const { record } = reserved;
  const layout = store.layout;
  const offset = rowIndex * layout.fields.length;
  // `totals` is itself observed only when a nested claim is actually needed, and then
  // exactly once for the row. Reading the slot up front let a row whose `totals`
  // descriptor throws fail a response every direct value had already proven -- the
  // fallback never wanted the slot, so it must not be touched.
  let totalsObserved = false;
  let totalsRecord: Record<string, unknown> | undefined;
  // `totals` aliasing its own row addresses the same descriptor twice. Reuse the single
  // observation instead of taking a second one a stateful row could answer differently.
  let totalsAliasesRow = false;
  const observeTotals = (): unknown => {
    if (!totalsObserved) {
      totalsObserved = true;
      reserved.totals = ownDataValue(record, 'totals');
      totalsRecord =
        typeof reserved.totals === 'object' && reserved.totals !== null
          ? (reserved.totals as Record<string, unknown>)
          : undefined;
      totalsAliasesRow = totalsRecord === record;
    }
    return reserved.totals;
  };
  for (let slot = 0; slot < layout.fields.length; slot += 1) {
    const field = layout.fields[slot]!;
    // A requested field named after a reserved one resolves to the reserved observation.
    const direct = layout.reservedFields.has(field)
      ? claimOfValue(field === 'totals' ? observeTotals() : reservedFieldValue(reserved, field))
      : ownDataClaim(record, field);
    // Charge before anything measures the claim. A string's `length` is O(1), while its
    // byte width, the zero test and the decimal canonicalization are each O(length) and
    // each a separate pass, so charging one pass let a claim be scanned several times
    // over for a single charge. Only the retained value is charged against the projection
    // budget, so a long string appearing as the discarded half of a duplicate claim -- a
    // tiny direct value beside a huge `totals` restatement -- otherwise bought full scans
    // per row at no cost. Measuring costs the byte width always and the zero test only
    // where evidence cells will read it.
    const measurePasses = strictClaims ? 2 : 1;
    chargeScan(measureScanWidth(direct.value) * measurePasses);
    const measuredDirect = measureClaim(direct.value, strictClaims);

    // Without availability evidence a valid direct value settles the field and `totals`
    // is never consulted -- that is the direct-over-totals precedence this adapter has
    // always had, and reading `totals` anyway let a throwing descriptor fail a legacy
    // response the direct value had already proven. With evidence both claims are needed,
    // because a duplicate claim must be reconciled rather than silently preferred.
    let nested: RowClaimV1 = UNCLAIMED_V1;
    let measuredNested: MeasuredClaimV1 = UNMEASURED_CLAIM_V1;
    if (strictClaims || !measuredDirect.valid) {
      observeTotals();
      if (totalsRecord !== undefined) {
        if (totalsAliasesRow) {
          // The same descriptor: reuse the one observation and the one measurement.
          nested = direct;
          measuredNested = measuredDirect;
        } else {
          nested = ownDataClaim(totalsRecord, field);
          chargeScan(measureScanWidth(nested.value) * measurePasses);
          measuredNested = measureClaim(nested.value, strictClaims);
        }
      }
    }

    const resolved = measuredDirect.valid ? measuredDirect : measuredNested.valid ? measuredNested : undefined;
    const claimed = direct.claimed ? measuredDirect : measuredNested;
    let bits = 0;
    if (direct.claimed) bits |= CLAIM_DIRECT_CLAIMED_V1;
    if (nested.claimed) bits |= CLAIM_NESTED_CLAIMED_V1;
    if (measuredDirect.valid) bits |= CLAIM_DIRECT_VALID_V1;
    if (measuredNested.valid) bits |= CLAIM_NESTED_VALID_V1;
    if (resolved?.isZero === true) bits |= CLAIM_VALUE_IS_ZERO_V1;
    if (claimed.valid && claimed.isZero) bits |= CLAIM_CLAIM_IS_ZERO_V1;
    if (
      strictClaims &&
      direct.claimed &&
      nested.claimed &&
      measuredDirect.valid &&
      measuredNested.valid &&
      !Object.is(direct.value, nested.value)
    ) {
      // A canonical decimal form is only needed to reconcile a duplicate claim that is
      // not already identical, so it is charged and computed exactly there -- and only
      // here is a number charged the width it expands to, because only here is it
      // expanded. Charging that width for measuring refused direct-only numeric claims
      // that never cost more than a finite check.
      chargeScan(canonicalScanWidth(direct.value) + canonicalScanWidth(nested.value));
      const canonicalDirect = canonicalDecimalEvidence(measuredDirect.value as string | number);
      const canonicalNested = canonicalDecimalEvidence(measuredNested.value as string | number);
      if (canonicalDirect === undefined || canonicalDirect !== canonicalNested) bits |= CLAIM_DISAGREE_V1;
    }
    store.values[offset + slot] = resolved?.value;
    store.flags[offset + slot] = bits;
  }
  return {
    store,
    offset,
    mediaBuyId: typeof reserved.mediaBuyId === 'string' ? reserved.mediaBuyId : undefined,
  };
}

/**
 * A snapshot that carries only the row's identity. Used for the auxiliary collection when
 * no availability evidence will read its claims: the scope check needs `media_buy_id` and
 * nothing else, so no metric or dimension descriptor is observed or billed.
 */
function captureRowIdentityOnly(
  reserved: RowReservedV1 | undefined,
  store: CapturedClaimStoreV1
): RowSnapshotV1 | undefined {
  if (!reserved) return undefined;
  reserved.mediaBuyId = ownDataValue(reserved.record, 'media_buy_id');
  return {
    store,
    offset: INLINE_NO_CLAIMS_OFFSET_V1,
    mediaBuyId: typeof reserved.mediaBuyId === 'string' ? reserved.mediaBuyId : undefined,
  };
}

function claimOfValue(value: unknown): RowClaimV1 {
  return value === undefined ? UNCLAIMED_V1 : { claimed: true, value };
}

function asRowRecord(row: unknown): Record<string, unknown> | undefined {
  return typeof row !== 'object' || row === null || Array.isArray(row) ? undefined : (row as Record<string, unknown>);
}

/** Case-fold a status only when it is short enough to be one this adapter recognizes. */
function boundedLowerCaseStatus(status: unknown): string | undefined {
  return typeof status === 'string' && status.length <= INLINE_MAX_STATUS_CHARS_V1 ? status.toLowerCase() : undefined;
}

/**
 * One claim measured once: the byte-width test, the zero test and the canonical decimal
 * form are each computed at most one time and then reused by every later check.
 */
type MeasuredClaimV1 = {
  readonly value: string | number | undefined;
  readonly valid: boolean;
  readonly isZero: boolean;
};

const UNMEASURED_CLAIM_V1: MeasuredClaimV1 = { value: undefined, valid: false, isZero: false };

function measureClaim(value: unknown, strictClaims: boolean): MeasuredClaimV1 {
  // The only byte-width scan of this claim.
  if (!isEvidenceValue(value)) return UNMEASURED_CLAIM_V1;
  // The only zero test, and only where evidence cells will read it.
  return { value, valid: true, isZero: strictClaims ? isZeroEvidenceValue(value) : false };
}

/**
 * Cost of measuring a claim once: a string is walked by its byte-width test and its zero
 * test, while a number's are both constant time.
 */
function measureScanWidth(value: unknown): number {
  return typeof value === 'string' ? value.length + 1 : 1;
}

/**
 * Cost of canonicalizing a claim into plain decimal. A string is walked; a number is
 * expanded, and exponent notation expands by its exponent, so `5e-324` materializes 326
 * digits from six printed characters.
 */
function canonicalScanWidth(value: unknown): number {
  if (typeof value === 'string') return value.length + 1;
  if (typeof value !== 'number') return 1;
  return numericScanUnits(value);
}

/**
 * Characters a number can materialize while it is canonicalized.
 *
 * `String` prints a finite double in at most about 25 characters, but exponent notation
 * expands by the exponent once the decimal point is shifted into plain form: `5e-324`
 * becomes 326 digits. Charging one unit per number let 200,000 duplicate numeric claims
 * buy more than 130,000,000 characters of scanning for 400,000 units.
 */
function numericScanUnits(value: number): number {
  const printed = String(value);
  const exponent = /[eE]([+-]?\d+)$/.exec(printed);
  return printed.length + (exponent ? Math.abs(Number(exponent[1])) : 0) + 1;
}

/** True when `count` items at `unitsEach` each would exceed `cap`, without multiplying. */
function workUnitsExceedCap(count: number, unitsEach: number, cap: number): boolean {
  return unitsEach > 0 && count > Math.floor(cap / unitsEach);
}

/**
 * True when the cumulative per-constituent validation work exceeds `cap`.
 *
 * Every row is checked against the cells and dimensions of each constituent naming its
 * `media_buy_id`, so one media buy shared by many constituents multiplies the work by
 * that fanout, and each visit costs one unit per requested metric and one per requested
 * dimension. Pricing metrics without dimensions or fanout admitted a request inside every
 * declared limit -- 1,000 constituents sharing one media buy, 100,000 rows, 1,000
 * requested dimensions -- that demanded around 10^11 checks against a 5,000,000 cap.
 *
 * Identities come from the captured snapshots, so the shape priced here is the shape
 * performed. The per-constituent contribution is bounded before it is multiplied out and
 * the running total returns at the cap, so neither value leaves the safe-integer range.
 */
function validationWorkExceedsCap(
  sourceSnapshots: readonly (RowSnapshotV1 | undefined)[],
  auxiliarySnapshots: readonly (RowSnapshotV1 | undefined)[],
  request: ReportingSourceSliceRequestV1,
  includeAuxiliary: boolean,
  cap: number
): boolean {
  const unitsPerVisit = request.requestedMetrics.length + request.requestedDimensions.length;
  if (unitsPerVisit === 0) return false;
  const perConstituentCap = Math.floor(cap / unitsPerVisit);
  const sourceCounts = countSnapshotsByMediaBuyId(sourceSnapshots);
  const auxiliaryCounts = includeAuxiliary ? countSnapshotsByMediaBuyId(auxiliarySnapshots) : undefined;
  let work = 0;
  for (const constituent of request.coverage.constituents) {
    if (!constituent.mediaBuyId) continue;
    const visits =
      (sourceCounts.get(constituent.mediaBuyId) ?? 0) + (auxiliaryCounts?.get(constituent.mediaBuyId) ?? 0);
    if (visits > perConstituentCap) return true;
    work += visits * unitsPerVisit;
    if (work > cap) return true;
  }
  return false;
}

function countSnapshotsByMediaBuyId(snapshots: readonly (RowSnapshotV1 | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const snapshot of snapshots) {
    if (snapshot?.mediaBuyId === undefined) continue;
    counts.set(snapshot.mediaBuyId, (counts.get(snapshot.mediaBuyId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Group snapshots by captured `media_buy_id`, keeping only admitted media buys. Every
 * constituent naming a media buy reads the same array, so the fanout costs no copies.
 */
function groupSnapshotsByMediaBuyId(
  snapshots: readonly (RowSnapshotV1 | undefined)[],
  admittedMediaBuyIds: ReadonlySet<string>
): Map<string, RowSnapshotV1[]> {
  const grouped = new Map<string, RowSnapshotV1[]>();
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    const mediaBuyId = snapshot.mediaBuyId;
    if (mediaBuyId === undefined || !admittedMediaBuyIds.has(mediaBuyId)) continue;
    const existing = grouped.get(mediaBuyId);
    if (existing) existing.push(snapshot);
    else grouped.set(mediaBuyId, [snapshot]);
  }
  return grouped;
}

function snapshotHasDimension(snapshot: RowSnapshotV1, dimension: string): boolean {
  return dimension === 'media_buy_id'
    ? snapshot.mediaBuyId !== undefined
    : snapshotFieldValue(snapshot, dimension) !== undefined;
}

/**
 * Check every cell against the rows of each constituent that names its media buy.
 *
 * Each row is visited once per cell. The `present`/`explicit_zero` proof and the
 * duplicate-claim check used to be separate passes over the source rows, so a source row
 * was inspected twice per cell while the budget charged it once. Both checks now happen
 * on the single visit, which makes the charged work and the performed work the same
 * quantity.
 *
 * Verdict precedence is preserved: a `present` cell with no value anywhere in the source
 * rows is `partial` even when another row of the same cell also contradicts the claim, so
 * an integrity verdict is held until the pass completes rather than returned early.
 */
function validateSnapshotsAgainstAvailabilityEvidence(
  sourceSnapshotsByMediaBuyId: ReadonlyMap<string, readonly RowSnapshotV1[]>,
  auxiliarySnapshotsByMediaBuyId: ReadonlyMap<string, readonly RowSnapshotV1[]>,
  request: ReportingSourceSliceRequestV1,
  cells: readonly z.output<typeof InlineReportingMetricEvidenceV1Schema>[]
): 'partial' | 'integrity' | undefined {
  const cellsByConstituent = new Map<string, Array<(typeof cells)[number]>>();
  for (const constituent of request.coverage.constituents) cellsByConstituent.set(constituent.constituentId, []);
  for (const cell of cells) cellsByConstituent.get(cell.constituent_id)?.push(cell);

  let integrity = false;
  for (const constituent of request.coverage.constituents) {
    const sourceRows = constituent.mediaBuyId
      ? (sourceSnapshotsByMediaBuyId.get(constituent.mediaBuyId) ?? NO_SNAPSHOTS)
      : NO_SNAPSHOTS;
    const auxiliaryRows = constituent.mediaBuyId
      ? (auxiliarySnapshotsByMediaBuyId.get(constituent.mediaBuyId) ?? NO_SNAPSHOTS)
      : NO_SNAPSHOTS;
    for (const cell of cellsByConstituent.get(constituent.constituentId) ?? []) {
      if (cell.status === 'present' && sourceRows.length === 0) return 'partial';
      for (const snapshot of sourceRows) {
        const verdict = cellVerdictForSnapshot(cell, snapshot, true);
        if (verdict === 'partial') return 'partial';
        if (verdict === 'integrity') integrity = true;
      }
      for (const snapshot of auxiliaryRows) {
        const verdict = cellVerdictForSnapshot(cell, snapshot, false);
        if (verdict === 'partial') return 'partial';
        if (verdict === 'integrity') integrity = true;
      }
    }
  }
  return integrity ? 'integrity' : undefined;
}

/** One row, one cell, one visit: the availability proof and the claim check together. */
function cellVerdictForSnapshot(
  cell: z.output<typeof InlineReportingMetricEvidenceV1Schema>,
  snapshot: RowSnapshotV1,
  isSourceRow: boolean
): 'partial' | 'integrity' | undefined {
  const slot = fieldSlotOf(snapshot, cell.metric);
  const flags = slotFlags(snapshot, slot);
  if (isSourceRow) {
    if (cell.status === 'present' && slotValue(snapshot, slot) === undefined) return 'partial';
    if (cell.status === 'explicit_zero' && (flags & CLAIM_VALUE_IS_ZERO_V1) === 0) return 'integrity';
  }
  const directClaimed = (flags & CLAIM_DIRECT_CLAIMED_V1) !== 0;
  const nestedClaimed = (flags & CLAIM_NESTED_CLAIMED_V1) !== 0;
  const directValid = (flags & CLAIM_DIRECT_VALID_V1) !== 0;
  const nestedValid = (flags & CLAIM_NESTED_VALID_V1) !== 0;
  // Every claim that is actually present must be a usable evidence value. Checking only
  // the governing claim let an invalid duplicate ride along on a valid direct value --
  // `totals.impressions: null` beside `impressions: 10`. Projection rejects that on a
  // source row, but the auxiliary collection is validated here and never projected, so
  // this is the only place that sees it. Both claims are observed whenever evidence is
  // supplied, so nothing extra is read to check them; without evidence this function
  // never runs and the `totals` slot stays unobserved.
  if ((directClaimed && !directValid) || (nestedClaimed && !nestedValid)) return 'integrity';
  const claimValid = directClaimed ? directValid : nestedValid;
  // A row claiming the same metric twice with different quantities is a contradiction,
  // and that verdict belongs here rather than waiting for projection: deferred, an
  // unrelated row exhausting the staging budget first reported STAGING_FAILED and the
  // contradiction went unreported.
  if ((flags & CLAIM_DISAGREE_V1) !== 0) return 'integrity';
  if (!claimValid) return undefined;
  if (cell.status === 'explicit_zero' && (flags & CLAIM_CLAIM_IS_ZERO_V1) === 0) return 'integrity';
  return INLINE_UNAVAILABLE_CELL_STATUSES_V1.includes(cell.status) ? 'integrity' : undefined;
}

function projectInlineAvailabilityEvidence(
  cells: readonly z.output<typeof InlineReportingMetricEvidenceV1Schema>[],
  request: ReportingSourceSliceRequestV1,
  declaredMetrics: ReadonlyMap<string, ReportingSourceOfferingV1['metrics'][number]>,
  deliveryDates: { start: string; end: string },
  manifestDataThrough: string,
  rowCount: number,
  constituentIdsWithRows: ReadonlySet<string>
): InlineAvailabilityProjection {
  const startMs = Date.parse(request.period.start);
  const manifestDataThroughMs = Date.parse(manifestDataThrough);
  const metricAvailability = cells.map(cell => {
    const metric = declaredMetrics.get(cell.metric);
    if (!metric) throw new TypeError(`Offering does not declare ${cell.metric}`);
    const dataThrough = cell.data_through
      ? normalizeDeliveryInstant(cell.data_through, deliveryDates, request.period)
      : undefined;
    const dataThroughMs = dataThrough === undefined ? undefined : Date.parse(dataThrough);
    if (
      dataThroughMs !== undefined &&
      (!Number.isFinite(dataThroughMs) ||
        dataThroughMs < startMs ||
        dataThroughMs > manifestDataThroughMs ||
        (['present', 'explicit_zero'].includes(cell.status) &&
          constituentIdsWithRows.has(cell.constituent_id) &&
          dataThroughMs === startMs))
    ) {
      throw new TypeError('Availability dataThrough exceeds the manifest window');
    }
    return {
      constituentId: cell.constituent_id,
      metric: cell.metric,
      semanticContractId: metric.semanticContractId,
      semanticContractVersion: metric.semanticContractVersion,
      semanticContractSha256: metric.semanticContractSha256,
      status: cell.status,
      ...(dataThrough ? { dataThrough } : {}),
      ...(cell.reason ? { reason: cell.reason } : {}),
    } satisfies InlineAvailabilityCell;
  });
  const coverageConstituents = request.coverage.constituents.map(constituent => {
    const constituentCells = metricAvailability.filter(cell => cell.constituentId === constituent.constituentId);
    const status = rollUpInlineConstituentStatus(constituentCells.map(cell => cell.status));
    const dataThrough = earliestDataThrough(constituentCells);
    const reason = constituentCells.find(cell => cell.reason)?.reason;
    if (!['present', 'explicit_zero'].includes(status) && !reason) {
      throw new TypeError('Unavailable constituent roll-up requires supplied evidence');
    }
    return {
      ...constituent,
      status,
      ...(dataThrough ? { dataThrough } : {}),
      ...(reason && !['present', 'explicit_zero'].includes(status) ? { reason } : {}),
    } satisfies InlineCoverageConstituent;
  });
  const allCellsExplicitZero = metricAvailability.every(cell => cell.status === 'explicit_zero');
  if (
    rowCount === 0 &&
    metricAvailability.some(cell => ['present', 'explicit_zero'].includes(cell.status)) &&
    !allCellsExplicitZero
  ) {
    throw new TypeError('Zero-row evidence has contradictory available cells');
  }
  const fullyCovered = coverageConstituents.filter(constituent =>
    ['present', 'explicit_zero'].includes(constituent.status)
  ).length;
  const someCoverage = fullyCovered > 0 || coverageConstituents.some(constituent => constituent.status === 'partial');
  return {
    metricAvailability,
    coverageConstituents,
    coverageStatus: fullyCovered === coverageConstituents.length ? 'full' : someCoverage ? 'partial' : 'none',
    explicitZero: rowCount === 0 && allCellsExplicitZero,
  };
}

function projectLegacyAvailability(
  request: ReportingSourceSliceRequestV1,
  declaredMetrics: ReadonlyMap<string, ReportingSourceOfferingV1['metrics'][number]>,
  dataThrough: string,
  rowCount: number
): InlineAvailabilityProjection {
  const explicitZero = rowCount === 0;
  const status = explicitZero ? ('explicit_zero' as const) : ('present' as const);
  return {
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
    coverageConstituents: request.coverage.constituents.map(constituent => ({
      ...constituent,
      status,
      dataThrough,
    })),
    coverageStatus: 'full',
    explicitZero,
  };
}

function rollUpInlineConstituentStatus(
  statuses: readonly InlineAvailabilityCell['status'][]
): InlineCoverageConstituent['status'] {
  if (statuses.every(status => status === 'explicit_zero')) return 'explicit_zero';
  if (statuses.every(status => status === 'present' || status === 'explicit_zero')) return 'present';
  if (statuses.every(status => status === 'unsupported')) return 'unsupported';
  if (statuses.every(status => status === 'missing')) return 'missing';
  if (statuses.every(status => ['unsupported', 'delayed', 'missing'].includes(status))) return 'delayed';
  if (statuses.every(status => ['unsupported', 'delayed', 'stale', 'missing'].includes(status))) return 'stale';
  return 'partial';
}

function earliestDataThrough(cells: readonly InlineAvailabilityCell[]): string | undefined {
  return cells.reduce<string | undefined>((earliest, cell) => {
    if (!cell.dataThrough) return earliest;
    if (!earliest || Date.parse(cell.dataThrough) < Date.parse(earliest)) return cell.dataThrough;
    return earliest;
  }, undefined);
}

function availabilityCellKey(constituentId: string, metric: string): string {
  return `${constituentId}\0${metric}`;
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

function isEvidenceValue(value: unknown): value is string | number {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= INLINE_MAX_OBJECT_BYTES_V1)
  );
}

/**
 * Exact plain-decimal canonical form, or undefined when the claim is not a decimal
 * quantity. A number is canonicalized from its shortest round-trip digits, so exponent
 * notation reaches the same form as the equivalent plain decimal — `1e-7` and
 * `'0.0000001'` are one quantity, not a contradiction. A string is read literally and is
 * never coerced through Number, which would round away the very digits a contradiction
 * check depends on: `'1000000000000000000001'` stays distinct from `1e21`.
 */
function canonicalDecimalEvidence(value: string | number): string | undefined {
  let raw: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    raw = plainDecimalNumberEvidence(value);
  } else {
    raw = value.trim();
  }
  const parts = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!parts) return undefined;
  const integer = trimLeadingZeroDigits(parts[2] ?? '');
  const fraction = trimTrailingZeroDigits(parts[3] ?? '');
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  return magnitude === '0' ? '0' : `${parts[1] ?? ''}${magnitude}`;
}

const ZERO_CHAR_CODE = 48;

/**
 * Drop insignificant leading zeros, keeping the last digit. A single scan: the regex
 * this replaces (`/^0+(?=\d)/`) was anchored and so already linear, but the pair is
 * easier to reason about when both trims are plainly bounded by the input length.
 */
function trimLeadingZeroDigits(digits: string): string {
  let start = 0;
  while (start + 1 < digits.length && digits.charCodeAt(start) === ZERO_CHAR_CODE) start += 1;
  return digits.slice(start);
}

/**
 * Drop insignificant trailing zeros in one backward scan.
 *
 * The regex this replaces (`/0+$/`) is quadratic on a long run of zeros that does not
 * reach the end of the string: the engine retries the run from every offset, and each
 * retry walks it again. A metric claim may be a decimal string of up to
 * `INLINE_MAX_OBJECT_BYTES_V1`, and claims are reconciled before any projection budget
 * is charged, so `'0.' + '0'.repeat(n) + '1'` bought n^2 work for n bytes of input.
 */
function trimTrailingZeroDigits(digits: string): string {
  let end = digits.length;
  while (end > 0 && digits.charCodeAt(end - 1) === ZERO_CHAR_CODE) end -= 1;
  return digits.slice(0, end);
}

/**
 * Expand the exponent notation `String` emits outside 1e-6..1e21 into plain decimal by
 * shifting the decimal point across the printed digits. The digits are moved, never
 * recomputed, so nothing is rounded. An already-plain form is returned unchanged, as is
 * an exponent beyond what `String` can emit for a finite number — that form then fails
 * the plain-decimal match above and reads as not comparable rather than as agreement.
 */
function plainDecimalNumberEvidence(value: number): string {
  const raw = String(value);
  const parts = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!parts) return raw;
  const exponent = Number(parts[4]);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > INLINE_MAX_DECIMAL_EXPONENT_V1) return raw;
  const sign = parts[1] ?? '';
  const digits = `${parts[2] ?? ''}${parts[3] ?? ''}`;
  const pointIndex = (parts[2] ?? '').length + exponent;
  if (pointIndex <= 0) return `${sign}0.${'0'.repeat(-pointIndex)}${digits}`;
  if (pointIndex >= digits.length) return `${sign}${digits}${'0'.repeat(pointIndex - digits.length)}`;
  return `${sign}${digits.slice(0, pointIndex)}.${digits.slice(pointIndex)}`;
}

/**
 * Whether a claim states the quantity zero, under the same exact-decimal normalization
 * duplicate reconciliation uses: a value is zero exactly when its canonical form is `0`.
 *
 * Recognizing only a single leading zero put the two at odds -- `"00"` and `"0"` were the
 * same quantity when a duplicate claim was reconciled, yet only `"0"` satisfied an
 * `explicit_zero` cell, so a zero spelled with a redundant digit was refused. The
 * predicate is written out rather than delegating to `canonicalDecimalEvidence` so the
 * cost stays what the scan budget charges for measuring: one anchored linear pass for a
 * string, and a constant comparison for a number, with no decimal expansion. `0+` before
 * the point and after it admits every spelling of zero and no other quantity, since any
 * nonzero digit anywhere fails the match.
 */
function isZeroEvidenceValue(value: string | number): boolean {
  return typeof value === 'number' ? value === 0 : /^-?0+(?:\.0+)?$/.test(value);
}

function isRows(value: InlineReportingDeliveryResultV1): value is readonly unknown[] {
  return Array.isArray(value);
}

function ownDataValue(record: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function ownDataClaim(record: Record<string, unknown>, field: string): { claimed: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  return descriptor && 'value' in descriptor && descriptor.value !== undefined
    ? { claimed: true, value: descriptor.value }
    : { claimed: false };
}

/**
 * Copy `record`'s own data properties into a plain object, from a single descriptor
 * observation per key. Getters are never invoked: an own accessor is refused instead,
 * because an envelope that computes its own fields cannot be pinned to one observation.
 */
/**
 * Snapshot an evidence object from the own data descriptors of an allowlisted key set.
 *
 * The key list is checked against the allowlist and the key cap before any descriptor is
 * observed, so an envelope carrying 100,000 unknown keys costs one `ownKeys` call rather
 * than 100,000 descriptor reads. Only own data properties are copied: an accessor is
 * refused rather than invoked, and an inherited field simply is not there, so the strict
 * schema rejects the object for the field it is missing. A cell that computed or
 * inherited its `status` used to be admitted through the get channel.
 */
function snapshotOwnDataObject(
  record: Record<string, unknown>,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  const keys = Reflect.ownKeys(record);
  if (keys.length > INLINE_MAX_EVIDENCE_OBJECT_KEYS_V1) {
    throw new TypeError('Availability evidence object declares too many keys');
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      throw new TypeError('Availability evidence object declares an unknown key');
    }
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('Availability evidence field is not readable');
    // Bound the field before the schema ever sees it. Every evidence field is a short
    // identifier, name, reason or timestamp, and a validator that rejects an over-long
    // value may still walk it first -- so an unbounded string could allocate an unbounded
    // array during validation. `length` is O(1), so this refuses before anything scans.
    if (typeof descriptor.value === 'string' && descriptor.value.length > INLINE_MAX_EVIDENCE_FIELD_CHARS_V1) {
      throw new TypeError('Availability evidence field exceeds its bounded length');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/**
 * Read a delivery-response field at most once, on first use.
 *
 * Memoizing gives the exactly-once guarantee the checks depend on, and reading lazily
 * keeps the order of observation the same as the order of decision: a field no check
 * reaches is never observed, so it cannot turn a verdict that was already settled into
 * something else.
 */
function createResponseFieldReader(record: Record<string, unknown> | undefined): (field: string) => unknown {
  const observed = new Map<string, unknown>();
  return (field: string): unknown => {
    if (observed.has(field)) return observed.get(field);
    const value = record?.[field];
    observed.set(field, value);
    return value;
  };
}

function asStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Control-field comparison that keeps the loose coercion these checks have always used,
 * so a present-but-malformed signal reads as the partial evidence it is rather than being
 * narrowed into an absent one.
 */
function looseCount(value: unknown): number {
  return (value as number | undefined) ?? 0;
}

function lengthOfUnknown(value: unknown): unknown {
  return (value as { length?: unknown } | undefined)?.length;
}

/** Single `length` observation, or undefined when the collection does not declare one. */
function boundedCollectionLength(rows: readonly unknown[] | undefined): number | undefined {
  if (rows === undefined) return 0;
  const declared = (rows as { length?: unknown }).length;
  return typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined;
}

/**
 * Copy a row collection by index, bounded by its own declared length.
 *
 * Spreading a collection runs its iterator, and an adopter iterator is not obliged to
 * agree with `length`: a collection reporting length zero yielded 150,000 rows, all
 * materialized before the row cap could reject them. Indexed capture reads exactly the
 * `declaredLength` slots the caller already counted and admitted -- the length is never
 * re-read here, because a second answer would decouple what was admitted from what is
 * copied, staged and reported.
 */
function captureRowCollection(rows: readonly unknown[], declaredLength: number): unknown[] {
  const captured: unknown[] = new Array(declaredLength);
  for (let index = 0; index < declaredLength; index += 1) captured[index] = rows[index];
  return captured;
}

/** One bounded observation of an own data slot. */
type OwnDataSlotV1 =
  | { readonly kind: 'absent' }
  | { readonly kind: 'data'; readonly value: unknown }
  | { readonly kind: 'unreadable' };

/**
 * Resolve `field` from a single descriptor observation per prototype level.
 *
 * `data` carries the captured own value; callers must use that value rather than
 * re-reading the slot, so a stateful proxy cannot answer one way when the slot is
 * classified and another way when it is parsed. `unreadable` covers every slot that is
 * reachable but is not an own data property — an accessor anywhere on the chain, an
 * inherited value, a trap that throws, or a chain that cannot be bounded — so such a
 * slot fails closed instead of reading as omitted. Getters are never invoked, and the
 * walk is bounded by both prototype identity and depth so that a cyclic or endlessly
 * regenerated proxy chain terminates instead of spinning the event loop.
 */
function resolveOwnDataSlot(record: Record<string, unknown>, field: string): OwnDataSlotV1 {
  const visited = new Set<object>();
  let current: object | null = record;
  for (let depth = 0; current !== null; depth += 1) {
    if (depth >= INLINE_MAX_PROTOTYPE_CHAIN_DEPTH_V1 || visited.has(current)) return { kind: 'unreadable' };
    visited.add(current);
    let descriptor: PropertyDescriptor | undefined;
    let prototype: object | null = null;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, field);
      if (!descriptor) prototype = Object.getPrototypeOf(current) as object | null;
    } catch {
      return { kind: 'unreadable' };
    }
    if (descriptor) {
      if (!('value' in descriptor)) return { kind: 'unreadable' };
      if (descriptor.value === undefined) return { kind: 'absent' };
      return current === record ? { kind: 'data', value: descriptor.value } : { kind: 'unreadable' };
    }
    current = prototype;
  }
  return { kind: 'absent' };
}

/**
 * Build the staged record for one captured row. Every value comes from the snapshot, so
 * the row that was budgeted and validated is the row that is staged.
 */
function projectSnapshotRow(
  snapshot: RowSnapshotV1 | undefined,
  request: ReportingSourceSliceRequestV1,
  consumeBudget: (upperBound: number) => void,
  options: Readonly<{
    allowMissingMetrics: boolean;
    allowMissingDimensions: boolean;
    strictMetricClaims: boolean;
    includeDimensions: boolean;
  }>
): Record<string, unknown> {
  if (!snapshot) throw new TypeError('Invalid row');
  const projected: Record<string, unknown> = { media_buy_id: snapshot.mediaBuyId };
  if (options.includeDimensions) {
    for (const dimension of request.requestedDimensions) {
      if (dimension === 'media_buy_id') continue;
      const value = snapshotFieldValue(snapshot, dimension);
      if (value === undefined) {
        if (options.allowMissingDimensions) continue;
        throw new TypeError('Invalid dimension evidence');
      }
      consumeBudget(jsonEvidenceUpperBound(value));
      projected[dimension] = value;
    }
  }
  const projectedTotals: Record<string, unknown> = {};
  for (const metric of request.requestedMetrics) {
    const slot = fieldSlotOf(snapshot, metric);
    const flags = slotFlags(snapshot, slot);
    const directClaimed = (flags & CLAIM_DIRECT_CLAIMED_V1) !== 0;
    const directValid = (flags & CLAIM_DIRECT_VALID_V1) !== 0;
    // The resolved slot already is what projection retains: the direct claim whenever it
    // is claimed and valid, the `totals` claim otherwise.
    const value = slotValue(snapshot, slot);
    let directValue = false;
    if (options.strictMetricClaims) {
      if (directClaimed && !directValid) throw new TypeError('Invalid metric evidence');
      if ((flags & CLAIM_NESTED_CLAIMED_V1) !== 0 && (flags & CLAIM_NESTED_VALID_V1) === 0) {
        throw new TypeError('Invalid metric evidence');
      }
      // A row that claims the same metric twice must not let the direct value mask a
      // contradictory totals claim -- the sealed evidence would misrepresent the source.
      if ((flags & CLAIM_DISAGREE_V1) !== 0) throw new TypeError('Contradictory metric evidence');
      directValue = directClaimed;
    } else {
      directValue = directValid;
    }
    if (value === undefined) {
      if (options.allowMissingMetrics) continue;
      throw new TypeError('Invalid metric evidence');
    }
    consumeBudget(jsonEvidenceUpperBound(value));
    if (directValue) projected[metric] = value;
    else projectedTotals[metric] = value;
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

function deliveryPeriodBoundaryMatches(actual: unknown, wireDate: string, instant: string): boolean {
  if (typeof actual !== 'string') return false;
  return actual === wireDate || Date.parse(actual) === Date.parse(instant);
}

function normalizeDeliveryInstant(
  value: unknown,
  deliveryDates: { start: string; end: string },
  period: ReportingSourceSliceRequestV1['period']
): string {
  if (value === deliveryDates.start) return period.start;
  if (value === deliveryDates.end) return period.end;
  // A malformed watermark is passed through as observed so `Date.parse` rejects it as
  // invalid temporal evidence, instead of being narrowed into an absent one that seals.
  return typeof value === 'string' ? value : String(value);
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
