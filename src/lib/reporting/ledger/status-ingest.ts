import { z } from 'zod';

import { ReportingConsumerStatusSchema, SyncReportingStatusRequestSchema } from '../../schemas';
import type { ReportingConsumerStatus, SyncReportingStatusRequest, SyncReportingStatusResponse } from '../../types';
import { canonicalJsonSha256PreservingLoneSurrogates } from '../../utils/jcs';
import { DEFAULT_UNKNOWN_ERROR_RECOVERY, getErrorRecovery, type ErrorRecovery } from '../../types/error-codes';
import { validateSyncReportingStatusEnvelope } from '../../validation/sync-reporting-status-envelope';
import { ADCP_MAJOR_VERSION, ADCP_VERSION } from '../../version';
import { isWellFormedUnicodeString } from '../../utils/well-formed-unicode';
import {
  reportingLedgerConfigurationMatchesScope,
  reportingLedgerEffectivePeriod,
  reportingLedgerSuccessor,
} from './coverage';
import { acquireAccountReadSlot, ReportingReadCapacityError } from './handler';
import {
  canonicalReportingInstant,
  compareReportingInstantToOffset,
  compareReportingInstants,
  reportingDurationCeilOrdinal,
  reportingInstantHasDuration,
  reportingPeriodOrdinal,
} from './instant';
import {
  REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES,
  REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES,
  ReportingConsumerStatusConflictError,
  ReportingLedgerSnapshotUnavailableError,
  type ReportingConsumerStatusLedgerStore,
  type ReportingConsumerStatusBatchEntryV1,
  type ReportingConsumerStatusBatchResultV1,
  type ReportingLedgerConfigurationV1,
  type ReportingLedgerConsumerStatementV1,
} from './types';

const statusId = z
  .string()
  .min(16)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const INVALID_REPORTING_STATUS_ID = 'invalid-reporting-status-id';

/** Published AdCP 3.2.0-rc.2 consumer status schema with request-only instant bounds. */
export const ReportingConsumerStatusV1Schema = ReportingConsumerStatusSchema.superRefine((value, context) => {
  if (value.recorded_at !== undefined) {
    context.addIssue({ code: 'custom', path: ['recorded_at'], message: 'recorded_at is response-only' });
  }
  let periodInstantsValid = true;
  for (const [path, instant] of [
    [['status_as_of'], value.status_as_of],
    [['period', 'start'], value.period.start],
    [['period', 'end'], value.period.end],
    [['seller_ledger_as_of'], value.seller_ledger_as_of],
  ] as const) {
    if (instant === undefined) continue;
    if (instant.length > 64) {
      if (path[0] === 'period') periodInstantsValid = false;
      context.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Reporting instants must not exceed 64 characters',
      });
      continue;
    }
    try {
      canonicalReportingInstant(instant);
    } catch {
      if (path[0] === 'period') periodInstantsValid = false;
      context.addIssue({
        code: 'custom',
        path: [...path],
        message: 'value must be a canonical RFC 3339 instant',
      });
    }
  }
  if (periodInstantsValid && compareReportingInstants(value.period.start, value.period.end) >= 0) {
    context.addIssue({
      code: 'custom',
      path: ['period', 'end'],
      message: 'period must be a non-empty half-open interval',
    });
  }
  for (const key of Object.keys(value.period)) {
    if (!['start', 'end', 'source_timezone'].includes(key)) {
      context.addIssue({
        code: 'custom',
        path: ['period', key],
        message: 'period contains an unsupported field',
      });
    }
  }
  if (value.period.source_timezone.length > 255) {
    context.addIssue({
      code: 'custom',
      path: ['period', 'source_timezone'],
      message: 'source_timezone must not exceed 255 characters',
    });
  }
});

/** Published AdCP 3.2.0-rc.2 request schema with the SDK's consumer-only item refinements. */
export const SyncReportingStatusRequestV1Schema = SyncReportingStatusRequestSchema.safeExtend({
  statuses: z.array(ReportingConsumerStatusV1Schema).min(1).max(100),
}).strict();

// Validate the envelope independently so one malformed status does not reject
// valid siblings. Each status is checked against the published schema below.
export type ReportingConsumerStatusV1 = Omit<ReportingConsumerStatus, 'recorded_at'>;
export type SyncReportingStatusRequestV1 = Omit<SyncReportingStatusRequest, 'statuses'> & {
  statuses: ReportingConsumerStatusV1[];
};
/** Raw partial-success handler input. Status items are parsed independently. */
export type SyncReportingStatusHandlerRequestV1 = Omit<SyncReportingStatusRequest, 'statuses'> & {
  statuses: unknown[];
};
export type RecordedReportingConsumerStatusV1 = {
  result: 'recorded' | 'unchanged';
  consumer_status: ReportingConsumerStatusV1 & { recorded_at: string };
};
export type FailedReportingConsumerStatusV1 = {
  result: 'failed';
  reporting_status_id: string;
  errors: [
    {
      code: string;
      recovery?: ErrorRecovery;
      retry_after?: number;
      message: string;
      field?: string;
      issues?: Array<{ pointer: string; message: string; keyword: string }>;
      details?: Record<string, unknown>;
    },
    ...Array<{
      code: string;
      recovery?: ErrorRecovery;
      retry_after?: number;
      message: string;
      field?: string;
      issues?: Array<{ pointer: string; message: string; keyword: string }>;
      details?: Record<string, unknown>;
    }>,
  ];
};
export type ReportingConsumerStatusResultV1 = RecordedReportingConsumerStatusV1 | FailedReportingConsumerStatusV1;
export type SyncReportingStatusResponseV1 = Omit<SyncReportingStatusResponse, 'status' | 'results'> & {
  status: 'completed';
  results: [ReportingConsumerStatusResultV1, ...ReportingConsumerStatusResultV1[]];
};
export type SyncReportingStatusHandlerV1<TContext = unknown> = (
  request: SyncReportingStatusHandlerRequestV1,
  context: TContext
) => Promise<SyncReportingStatusResponseV1>;

export interface SyncReportingStatusHandlerOptionsV1<TContext = unknown> {
  /** Resolve the durable authenticated consumer principal. Payloads cannot assert it. */
  resolveConsumerId(context: TContext): string | Promise<string>;
  now?: () => Date;
  clockSkewMilliseconds?: number;
}

type ReportingStatusValidationReason =
  | 'future status'
  | 'ineligible period'
  | 'missing status precedes expected_at'
  | 'obligation mismatch'
  | 'revision mismatch'
  | 'revision binding mismatch'
  | 'snapshot provenance unavailable'
  | 'snapshot provenance mismatch';

class ReportingStatusValidationError extends Error {
  constructor(readonly reason: ReportingStatusValidationReason) {
    super(reason);
  }
}

export function createSyncReportingStatusHandler<TContext = unknown>(
  store: ReportingConsumerStatusLedgerStore,
  options: SyncReportingStatusHandlerOptionsV1<TContext>
): SyncReportingStatusHandlerV1<TContext> {
  const activeReadsByAccount = new Map<string, number>();
  return async (requestInput, context) => {
    const envelope = validateSyncReportingStatusEnvelope(requestInput);
    if (!envelope.valid) {
      const ids = requestStatusIds(requestInput);
      const issue = envelope.issues[0];
      return failed(
        ids,
        'VALIDATION_ERROR',
        issue?.message ?? 'Reporting consumer status request is invalid',
        issue?.pointer,
        issue?.keyword
      );
    }
    const request = requestInput;
    const statusIds = request.statuses.map(reportingStatusId);
    const accountId = resolvedAccountId(context);
    if ('account_id' in request.account && accountId !== request.account.account_id) {
      return failed(statusIds, 'PERMISSION_DENIED', 'Reporting consumer status account is unavailable');
    }
    const consumerId = await options.resolveConsumerId(context);
    if (!consumerId || consumerId.length > 255) {
      throw new TypeError('resolveConsumerId must return a durable authenticated principal of at most 255 characters');
    }
    let releaseReadSlot: () => void;
    try {
      releaseReadSlot = acquireAccountReadSlot(activeReadsByAccount, accountId, 16, 256);
    } catch (error) {
      if (!(error instanceof ReportingReadCapacityError)) throw error;
      return failed(
        statusIds,
        'RATE_LIMITED',
        'Reporting consumer status read capacity is temporarily exhausted',
        undefined,
        undefined,
        'transient',
        1
      );
    }
    try {
      // Item parsing and canonical hashing are deliberately inside the
      // account/global read slot so authenticated callers cannot multiply
      // their CPU and allocation cost without bound.
      const parsedStatuses = request.statuses.map(value => ReportingConsumerStatusV1Schema.safeParse(value));
      const requestFingerprint = statusBatchFingerprint(request);
      try {
        const replay = await store.getConsumerStatusBatchReplay({
          account_id: accountId,
          consumerId,
          idempotencyKey: request.idempotency_key,
          requestFingerprint,
        });
        if (replay) return completed(replay);
      } catch (error) {
        if (!(error instanceof ReportingConsumerStatusConflictError)) throw error;
        return failed(statusIds, 'IDEMPOTENCY_CONFLICT', 'Reporting status idempotency conflict');
      }
      const now = (options.now ?? (() => new Date()))();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new RangeError('now must return a valid Date');
      }
      const clockSkewMilliseconds = options.clockSkewMilliseconds ?? 5 * 60_000;
      if (
        !Number.isSafeInteger(clockSkewMilliseconds) ||
        clockSkewMilliseconds < 0 ||
        clockSkewMilliseconds > 3_600_000
      ) {
        throw new RangeError('clockSkewMilliseconds must be a safe integer between 0 and 3600000');
      }
      const configurations = (await store.listConfigurations(accountId)).filter(
        value => value?.account?.account_id === accountId
      );
      try {
        const entries: ReportingConsumerStatusBatchEntryV1[] = [];
        for (const [index, parsedStatus] of parsedStatuses.entries()) {
          const rawStatus = request.statuses[index];
          const hasPrototypeKey = isRecord(rawStatus) && Object.hasOwn(rawStatus, '__proto__');
          if (!parsedStatus.success || hasPrototypeKey) {
            const issue = !parsedStatus.success ? parsedStatus.error.issues[0] : undefined;
            const path = hasPrototypeKey ? ['__proto__'] : issue?.path;
            const validationField =
              issue || hasPrototypeKey ? zodPathToPointer(['statuses', index, ...(path ?? [])]) : undefined;
            const identity = reportingStatusIdentity(rawStatus);
            entries.push({
              reporting_status_id: identity.value,
              ...(identity.synthetic ? { syntheticReportingStatusId: true } : {}),
              validationError: 'Reporting consumer status request is invalid',
              ...(validationField ? { validationField } : {}),
              ...(validationField
                ? { validationKeyword: hasPrototypeKey ? 'additionalProperties' : zodIssueKeyword(issue) }
                : {}),
              ...rawStatusChainIdentity(rawStatus),
            });
            continue;
          }
          const status = parsedStatus.data;
          let validationError: string | undefined;
          let validationField: string | undefined;
          try {
            await validateStatus(store, configurations, accountId, consumerId, status, now, clockSkewMilliseconds);
          } catch (error) {
            if (!(error instanceof ReportingStatusValidationError)) throw error;
            const diagnostic = reportingStatusValidationDiagnostic(error.reason, index);
            validationError = diagnostic.message;
            validationField = diagnostic.field;
          }
          entries.push({
            status: { ...status, account_id: accountId, consumerId },
            ...(validationError ? { validationError } : {}),
            ...(validationField ? { validationField } : {}),
          });
        }
        const results = await store.syncConsumerStatusBatch({
          account_id: accountId,
          consumerId,
          idempotencyKey: request.idempotency_key,
          requestFingerprint,
          entries,
        });
        return completed(results);
      } catch (error) {
        const conflict = error instanceof ReportingConsumerStatusConflictError;
        if (!conflict && !(error instanceof ReportingStatusValidationError)) throw error;
        return failed(
          statusIds,
          conflict ? 'IDEMPOTENCY_CONFLICT' : 'VALIDATION_ERROR',
          conflict
            ? 'Reporting status idempotency conflict'
            : 'Reporting consumer status does not match the seller ledger'
        );
      }
    } finally {
      releaseReadSlot();
    }
  };
}

async function validateStatus(
  store: ReportingConsumerStatusLedgerStore,
  configurations: ReportingLedgerConfigurationV1[],
  accountId: string,
  consumerId: string,
  status: ReportingConsumerStatusV1,
  now: Date,
  clockSkewMilliseconds = 5 * 60_000
): Promise<void> {
  if (compareReportingInstantToOffset(status.status_as_of, now.toISOString(), clockSkewMilliseconds) > 0) {
    throw new ReportingStatusValidationError('future status');
  }
  const configuration = configurations.find(
    value =>
      value.delivery_config_id === status.delivery_config_id &&
      value.delivery_config_version === status.delivery_config_version &&
      value.report_definition_id === status.report_definition_id
  );
  if (
    !configuration ||
    configuration.account.account_id !== accountId ||
    !isExactPeriod(configuration, configurations, status.period)
  ) {
    throw new ReportingStatusValidationError('ineligible period');
  }
  const expectedOffset =
    configuration.requiredFinality === 'official'
      ? (configuration.schedule.officialAfterMilliseconds ?? configuration.schedule.deliverySlaMilliseconds)
      : configuration.schedule.deliverySlaMilliseconds;
  if (
    (status.consumer_status === 'obligation_missing' || status.consumer_status === 'revision_missing') &&
    compareReportingInstantToOffset(status.status_as_of, status.period.end, expectedOffset) < 0
  ) {
    throw new ReportingStatusValidationError('missing status precedes expected_at');
  }
  if (status.reporting_obligation_id) {
    const obligation = await store.getObligation(status.reporting_obligation_id, accountId);
    if (
      !obligation ||
      obligation.account.account_id !== accountId ||
      obligation.delivery_config_id !== status.delivery_config_id ||
      obligation.delivery_config_version !== status.delivery_config_version ||
      obligation.report_definition_id !== status.report_definition_id ||
      compareReportingInstants(obligation.period.start, status.period.start) !== 0 ||
      compareReportingInstants(obligation.period.end, status.period.end) !== 0 ||
      obligation.period.sourceTimezone !== status.period.source_timezone
    )
      throw new ReportingStatusValidationError('obligation mismatch');
  }
  if (status.reporting_revision_id) {
    const revision = await store.getRevisionMetadata(status.reporting_revision_id, accountId);
    if (
      !revision ||
      revision.wireRevision.account_id !== accountId ||
      revision.reporting_obligation_id !== status.reporting_obligation_id
    )
      throw new ReportingStatusValidationError('revision mismatch');
    if (
      status.consumer_status === 'received' &&
      revision.wireRevision.revision_content_sha256.toLowerCase() !==
        status.observed_revision_content_sha256?.toLowerCase()
    )
      throw new ReportingStatusValidationError('revision binding mismatch');
  }
  if (status.seller_ledger_snapshot_id) {
    if (!store.readSnapshotPage) {
      throw new ReportingStatusValidationError('snapshot provenance unavailable');
    }
    let page;
    try {
      page = await store.readSnapshotPage(status.seller_ledger_snapshot_id, accountId, undefined, 1);
    } catch (error) {
      if (!(error instanceof ReportingLedgerSnapshotUnavailableError)) throw error;
      throw new ReportingStatusValidationError('snapshot provenance unavailable');
    }
    const scope = reportingLedgerEffectivePeriod(page.snapshot.query, page.snapshot.ledgerAsOf);
    const configurationInScope = page.snapshot.configurations.some(
      value =>
        value.configurationId === configuration.configurationId &&
        reportingLedgerConfigurationMatchesScope(page.snapshot.query, value)
    );
    const obligationInScope =
      !status.reporting_obligation_id ||
      page.snapshot.obligations.some(value => value.reporting_obligation_id === status.reporting_obligation_id);
    const revisionInScope =
      !status.reporting_revision_id ||
      page.snapshot.revisions.some(
        value =>
          value.reporting_revision_id === status.reporting_revision_id &&
          (page.snapshot.query.view !== 'periods' ||
            !page.snapshot.query.finality ||
            page.snapshot.query.finality.includes(value.finality))
      );
    const periodInScope =
      page.snapshot.query.view === 'revision'
        ? Boolean(
            status.reporting_revision_id &&
            page.snapshot.query.reporting_revision_id === status.reporting_revision_id &&
            revisionInScope
          )
        : compareReportingInstants(status.period.start, scope.end) < 0 &&
          compareReportingInstants(status.period.end, scope.start) > 0;
    if (
      page.snapshot.query.account_id !== accountId ||
      page.snapshot.query.consumer_id !== consumerId ||
      page.snapshot.ledgerAsOf !== status.seller_ledger_as_of ||
      !configurationInScope ||
      !periodInScope ||
      !obligationInScope ||
      !revisionInScope
    ) {
      throw new ReportingStatusValidationError('snapshot provenance mismatch');
    }
  }
}

function isExactPeriod(
  configuration: ReportingLedgerConfigurationV1,
  configurations: ReportingLedgerConfigurationV1[],
  period: ReportingConsumerStatusV1['period']
): boolean {
  if (period.source_timezone !== configuration.sourceTimezone) return false;
  const duration = configuration.schedule.periodMilliseconds;
  const scheduleAnchor = new Date(Date.parse(configuration.schedule.anchor)).toISOString();
  const ordinal = reportingPeriodOrdinal(period.start, scheduleAnchor, duration);
  if (ordinal === null || !reportingInstantHasDuration(period.start, period.end, duration)) return false;
  const effectiveFrom =
    compareReportingInstants(scheduleAnchor, configuration.installedAt) >= 0
      ? scheduleAnchor
      : configuration.installedAt;
  const firstOwnedOrdinal = reportingDurationCeilOrdinal(scheduleAnchor, effectiveFrom, duration);
  const successor = reportingLedgerSuccessor(configuration, configurations);
  const generationEnds = [successor?.installedAt, configuration.supersededAt].filter((value): value is string =>
    Boolean(value)
  );
  const generationEnd = generationEnds.sort(compareReportingInstants)[0];
  return ordinal >= firstOwnedOrdinal && (!generationEnd || compareReportingInstants(period.start, generationEnd) < 0);
}

function resolvedAccountId(context: unknown): string {
  if (!context || typeof context !== 'object') throw new TypeError('sync_reporting_status requires a resolved account');
  const account = (context as { account?: unknown }).account;
  if (!account || typeof account !== 'object') throw new TypeError('sync_reporting_status requires a resolved account');
  const value = account as { id?: unknown; account_id?: unknown };
  const accountId =
    typeof value.id === 'string' ? value.id : typeof value.account_id === 'string' ? value.account_id : '';
  if (!accountId) throw new TypeError('sync_reporting_status requires a resolved account');
  return accountId;
}

function rawStatusChainIdentity(
  value: unknown
): Pick<Extract<ReportingConsumerStatusBatchEntryV1, { reporting_status_id: string }>, 'chainIdentity'> {
  if (!isRecord(value) || !isRecord(value.period)) return {};
  const fields = {
    delivery_config_id: value.delivery_config_id,
    delivery_config_version: value.delivery_config_version,
    report_definition_id: value.report_definition_id,
    periodStart: value.period.start,
    periodEnd: value.period.end,
    sourceTimezone: value.period.source_timezone,
  };
  if (
    typeof fields.delivery_config_id !== 'string' ||
    fields.delivery_config_id.length === 0 ||
    fields.delivery_config_id.length > 255 ||
    !Number.isSafeInteger(fields.delivery_config_version) ||
    typeof fields.report_definition_id !== 'string' ||
    fields.report_definition_id.length === 0 ||
    fields.report_definition_id.length > 255 ||
    typeof fields.periodStart !== 'string' ||
    fields.periodStart.length > 64 ||
    typeof fields.periodEnd !== 'string' ||
    fields.periodEnd.length > 64 ||
    typeof fields.sourceTimezone !== 'string' ||
    fields.sourceTimezone.length === 0 ||
    fields.sourceTimezone.length > 255
  ) {
    return {};
  }
  try {
    canonicalReportingInstant(fields.periodStart);
    canonicalReportingInstant(fields.periodEnd);
  } catch {
    return {};
  }
  return { chainIdentity: fields as NonNullable<ReturnType<typeof rawStatusChainIdentity>['chainIdentity']> };
}

function wireConsumerStatus(
  status: ReportingLedgerConsumerStatementV1
): ReportingConsumerStatusV1 & { recorded_at: string } {
  const { consumerId: _consumerId, account_id: _accountId, ...wire } = status;
  return wire;
}

function failed(
  ids: string[],
  code: string,
  message: string,
  field?: string,
  keyword?: string,
  recovery: ErrorRecovery = getErrorRecovery(code) ?? DEFAULT_UNKNOWN_ERROR_RECOVERY,
  retryAfterSeconds?: number
): SyncReportingStatusResponseV1 {
  const results = ids.map(reporting_status_id => ({
    result: 'failed' as const,
    reporting_status_id,
    errors: [
      {
        code,
        recovery,
        ...(retryAfterSeconds !== undefined ? { retry_after: retryAfterSeconds } : {}),
        message,
        ...wireValidationDiagnostic(field, message, keyword),
      },
    ] as FailedReportingConsumerStatusV1['errors'],
  }));
  if (results.length === 0) throw new TypeError('sync_reporting_status requires at least one result');
  return {
    adcp_version: wireAdcpVersion(),
    adcp_major_version: ADCP_MAJOR_VERSION,
    status: 'completed',
    results: results as [FailedReportingConsumerStatusV1, ...FailedReportingConsumerStatusV1[]],
  };
}

function completed(
  results: Awaited<ReturnType<ReportingConsumerStatusLedgerStore['syncConsumerStatusBatch']>>
): SyncReportingStatusResponseV1 {
  const wireResults: ReportingConsumerStatusResultV1[] = results.map(result =>
    'value' in result
      ? {
          result: result.inserted ? ('recorded' as const) : ('unchanged' as const),
          consumer_status: wireConsumerStatus(result.value),
        }
      : completedFailure(result)
  );
  if (wireResults.length === 0) throw new TypeError('sync_reporting_status store returned no item results');
  return {
    adcp_version: wireAdcpVersion(),
    adcp_major_version: ADCP_MAJOR_VERSION,
    status: 'completed',
    results: wireResults as [ReportingConsumerStatusResultV1, ...ReportingConsumerStatusResultV1[]],
  };
}

function completedFailure(
  result: Extract<ReportingConsumerStatusBatchResultV1, { errorCode: string }>
): FailedReportingConsumerStatusV1 {
  const code = boundedErrorCode(result.errorCode);
  const message = boundedErrorMessage(result.safeMessage);
  const retryAfterSeconds = boundedRetryAfterSeconds(result.retryAfterSeconds);
  const recovery = boundedRecovery(result.recovery) ?? getErrorRecovery(code) ?? DEFAULT_UNKNOWN_ERROR_RECOVERY;
  const errorField = boundedErrorField(result.errorField);
  const errorKeyword = boundedErrorKeyword(result.errorKeyword);
  return {
    result: 'failed',
    reporting_status_id: statusId.safeParse(result.reporting_status_id).success
      ? result.reporting_status_id
      : INVALID_REPORTING_STATUS_ID,
    errors: [
      {
        code,
        recovery,
        ...(retryAfterSeconds !== undefined ? { retry_after: retryAfterSeconds } : {}),
        message,
        ...wireValidationDiagnostic(errorField, message, errorKeyword),
      },
    ],
  };
}

function boundedErrorCode(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && isWellFormedUnicodeString(value)
    ? value
    : 'VALIDATION_ERROR';
}

function boundedRetryAfterSeconds(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 3600 ? Number(value) : undefined;
}

function boundedRecovery(value: unknown): ErrorRecovery | undefined {
  return value === 'transient' || value === 'correctable' || value === 'terminal' ? value : undefined;
}

function boundedErrorField(value: unknown): string | undefined {
  return typeof value === 'string' &&
    !value.includes('\u0000') &&
    isWellFormedUnicodeString(value) &&
    Buffer.byteLength(value, 'utf8') <= REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES
    ? value
    : undefined;
}

function boundedErrorKeyword(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

function boundedErrorMessage(value: unknown): string {
  if (typeof value !== 'string') return 'Reporting consumer status was rejected';
  const wellFormed = Buffer.from(value, 'utf8')
    .toString('utf8')
    .replace(/\u0000/g, '\ufffd');
  if (Buffer.byteLength(wellFormed, 'utf8') <= REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES) {
    return wellFormed || 'Reporting consumer status was rejected';
  }
  let bounded = '';
  let bytes = 0;
  for (const character of wellFormed) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > REPORTING_CONSUMER_STATUS_ERROR_MESSAGE_MAX_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded || 'Reporting consumer status was rejected';
}

function statusBatchFingerprint(request: {
  account: Record<string, unknown>;
  idempotency_key: string;
  statuses: unknown[];
  adcp_version?: string;
  adcp_major_version?: number;
  context?: unknown;
  ext?: unknown;
}): string {
  const {
    idempotency_key: _idempotencyKey,
    adcp_version: _adcpVersion,
    adcp_major_version: _adcpMajorVersion,
    context: _context,
    ...semanticRequest
  } = request;
  const wireValue = JSON.parse(JSON.stringify(semanticRequest)) as Record<string, unknown>;
  return canonicalJsonSha256PreservingLoneSurrogates(wireValue);
}

function reportingStatusId(value: unknown): string {
  return reportingStatusIdentity(value).value;
}

function reportingStatusIdentity(value: unknown): { value: string; synthetic: boolean } {
  const candidate = isRecord(value) ? value.reporting_status_id : undefined;
  return statusId.safeParse(candidate).success
    ? { value: candidate as string, synthetic: false }
    : { value: INVALID_REPORTING_STATUS_ID, synthetic: true };
}

function requestStatusIds(value: unknown): string[] {
  const statuses = isRecord(value) && Array.isArray(value.statuses) ? value.statuses : [];
  return statuses.length > 0 && statuses.length <= 100
    ? statuses.map(reportingStatusId)
    : ['invalid-reporting-status-id'];
}

function zodPathToPointer(path: PropertyKey[]): string | undefined {
  let pointer = '';
  for (const value of path) {
    const raw = String(value);
    // PostgreSQL jsonb rejects NUL and lone UTF-16 surrogates even though
    // JSON.stringify can escape them. Omit the optional diagnostic rather
    // than turning one malformed item into a transaction-wide failure.
    if (raw.includes('\u0000') || !isWellFormedUnicodeString(raw)) return undefined;
    if (Buffer.byteLength(raw, 'utf8') > REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES) return undefined;
    const segment = raw.replace(/~/g, '~0').replace(/\//g, '~1');
    const next = `${pointer}/${segment}`;
    if (Buffer.byteLength(next, 'utf8') > REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES) return undefined;
    pointer = next;
  }
  return pointer || undefined;
}

function wireValidationDiagnostic(
  pointer: string | undefined,
  message: string,
  keyword?: string
): { field?: string; issues?: Array<{ pointer: string; message: string; keyword: string }> } {
  if (!pointer || Buffer.byteLength(pointer, 'utf8') > REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES) {
    return {};
  }
  if (!pointer.startsWith('/')) return { field: pointer };
  const field = jsonPointerToJsonPathLite(pointer);
  if (!field) return {};
  return {
    field,
    ...(keyword ? { issues: [{ pointer, message, keyword }] } : {}),
  };
}

function jsonPointerToJsonPathLite(pointer: string): string | undefined {
  if (!pointer.startsWith('/')) return undefined;
  if (pointer === '/') return '$';
  let field = '';
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (/^(0|[1-9][0-9]*)$/.test(segment)) {
      if (!field) return undefined;
      field += `[${segment}]`;
    } else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment)) {
      field += field ? `.${segment}` : segment;
    } else {
      field += `${field ? '' : '$'}[${JSON.stringify(segment)}]`;
    }
  }
  return Buffer.byteLength(field, 'utf8') <= REPORTING_CONSUMER_STATUS_ERROR_FIELD_MAX_BYTES ? field : undefined;
}

function zodIssueKeyword(
  issue: { code?: string; origin?: string; message?: string; format?: string } | undefined
): string {
  switch (issue?.code) {
    case 'invalid_type':
      return issue.message?.includes('received undefined') ? 'required' : 'type';
    case 'invalid_union':
      return 'oneOf';
    case 'invalid_value':
      return 'enum';
    case 'not_multiple_of':
      return 'multipleOf';
    case 'too_small':
      return issue.origin === 'array' ? 'minItems' : issue.origin === 'string' ? 'minLength' : 'minimum';
    case 'too_big':
      return issue.origin === 'array' ? 'maxItems' : issue.origin === 'string' ? 'maxLength' : 'maximum';
    case 'invalid_format':
      return issue.format === 'regex' ? 'pattern' : 'format';
    case 'unrecognized_keys':
      return 'additionalProperties';
    case 'custom':
      if (issue.message?.includes('unsupported field') || issue.message?.includes('Unrecognized key')) {
        return 'additionalProperties';
      }
      if (issue.message?.includes('RFC 3339') || issue.message?.includes('date-time')) return 'format';
      if (issue.message?.includes('response-only')) return 'not';
      return 'allOf';
    default:
      return 'allOf';
  }
}

function reportingStatusValidationDiagnostic(
  reason: ReportingStatusValidationReason,
  index: number
): { message: string; field?: string } {
  switch (reason) {
    case 'future status':
      return {
        message: 'status_as_of exceeds the allowed clock skew',
        field: `/statuses/${index}/status_as_of`,
      };
    case 'ineligible period':
      return {
        message: 'Reporting consumer status period is not eligible for the selected configuration',
        field: `/statuses/${index}/period`,
      };
    case 'missing status precedes expected_at':
      return {
        message: 'Missing reporting status cannot precede the expected reporting time',
        field: `/statuses/${index}/status_as_of`,
      };
    default:
      // Obligation, revision, and snapshot lookups remain deliberately
      // indistinguishable so this endpoint cannot become an existence oracle.
      return { message: 'Reporting consumer status does not match the seller ledger' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wireAdcpVersion(): string {
  return ADCP_VERSION.replace(/^(\d+\.\d+)\.0-/, '$1-');
}
