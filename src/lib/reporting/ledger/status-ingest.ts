import { z } from 'zod';

import { ReportingConsumerStatusSchema, SyncReportingStatusRequestSchema } from '../../schemas';
import type { ReportingConsumerStatus, SyncReportingStatusRequest, SyncReportingStatusResponse } from '../../types';
import { MAX_JSON_DEPTH } from '../../utils/json-depth';
import { canonicalJsonSha256 } from '../../utils/jcs';
import { validateSyncReportingStatusEnvelope } from '../../validation/sync-reporting-status-envelope';
import { ADCP_MAJOR_VERSION, ADCP_VERSION } from '../../version';
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
  ReportingConsumerStatusConflictError,
  ReportingLedgerSnapshotUnavailableError,
  type ReportingConsumerStatusLedgerStore,
  type ReportingConsumerStatusBatchEntryV1,
  type ReportingLedgerConfigurationV1,
  type ReportingLedgerConsumerStatementV1,
} from './types';

const statusId = z
  .string()
  .min(16)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const MAX_VALIDATION_FIELD_BYTES = 1024;

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
      context.addIssue({
        code: 'custom',
        path: [...path],
        message: 'Reporting instants must not exceed 64 characters',
      });
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
export type RecordedReportingConsumerStatusV1 = {
  result: 'recorded' | 'unchanged';
  consumer_status: ReportingConsumerStatusV1 & { recorded_at: string };
};
export type FailedReportingConsumerStatusV1 = {
  result: 'failed';
  reporting_status_id: string;
  errors: [
    { code: string; message: string; field?: string; details?: Record<string, unknown> },
    ...Array<{ code: string; message: string; field?: string; details?: Record<string, unknown> }>,
  ];
};
export type ReportingConsumerStatusResultV1 = RecordedReportingConsumerStatusV1 | FailedReportingConsumerStatusV1;
export type SyncReportingStatusResponseV1 = Omit<SyncReportingStatusResponse, 'status' | 'results'> & {
  status: 'completed';
  results: [ReportingConsumerStatusResultV1, ...ReportingConsumerStatusResultV1[]];
};

export interface SyncReportingStatusHandlerOptionsV1<TContext = unknown> {
  /** Resolve the durable authenticated consumer principal. Payloads cannot assert it. */
  resolveConsumerId(context: TContext): string | Promise<string>;
  now?: () => Date;
  clockSkewMilliseconds?: number;
}

class ReportingStatusValidationError extends Error {}

export function createSyncReportingStatusHandler<TContext = unknown>(
  store: ReportingConsumerStatusLedgerStore,
  options: SyncReportingStatusHandlerOptionsV1<TContext>
): (request: SyncReportingStatusRequestV1, context: TContext) => Promise<SyncReportingStatusResponseV1> {
  const activeReadsByAccount = new Map<string, number>();
  return async (requestInput, context) => {
    if (!hasBoundedJsonDepth(requestInput)) {
      return failed(requestStatusIds(requestInput), 'VALIDATION_ERROR', 'Reporting consumer status request is invalid');
    }
    const envelope = validateSyncReportingStatusEnvelope(requestInput);
    if (!envelope.valid) {
      const ids = requestStatusIds(requestInput);
      return failed(
        ids,
        'VALIDATION_ERROR',
        'Reporting consumer status request is invalid',
        envelope.issues[0]?.pointer
      );
    }
    const request = requestInput;
    const parsedStatuses = request.statuses.map(value => ReportingConsumerStatusV1Schema.safeParse(value));
    const statusIds = parsedStatuses.map((value, index) =>
      value.success ? value.data.reporting_status_id : reportingStatusId(request.statuses[index])
    );
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
        'RESOURCE_EXHAUSTED',
        'Reporting consumer status read capacity is temporarily exhausted'
      );
    }
    try {
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
        return failed(statusIds, 'IDEMPOTENCY_CONFLICT', error.message);
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
          if (!parsedStatus.success) {
            const path = parsedStatus.error.issues[0]?.path;
            const validationField = path?.length ? zodPathToPointer(['statuses', index, ...path]) : undefined;
            entries.push({
              reporting_status_id: reportingStatusId(request.statuses[index]),
              validationError: 'Reporting consumer status request is invalid',
              ...(validationField ? { validationField } : {}),
              ...rawStatusChainIdentity(request.statuses[index]),
            });
            continue;
          }
          const status = parsedStatus.data;
          let validationError: string | undefined;
          try {
            await validateStatus(store, configurations, accountId, consumerId, status, now, clockSkewMilliseconds);
          } catch (error) {
            if (!(error instanceof ReportingStatusValidationError)) throw error;
            validationError = 'Reporting consumer status does not match the seller ledger';
          }
          entries.push({
            status: { ...status, account_id: accountId, consumerId },
            ...(validationError ? { validationError } : {}),
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
          conflict ? error.message : 'Reporting consumer status does not match the seller ledger'
        );
      }
    } finally {
      releaseReadSlot();
    }
  };
}

function hasBoundedJsonDepth(root: unknown): boolean {
  const maxNodes = 10_000;
  let nodes = 0;
  let pendingValues = 1;
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value: root, depth: 0 }];
  const active = new WeakSet<object>();
  while (stack.length > 0) {
    const { value, depth, exit } = stack.pop()!;
    if (!exit) {
      pendingValues -= 1;
      if (++nodes > maxNodes) return false;
    }
    if (value === null || typeof value !== 'object') continue;
    if (exit) {
      active.delete(value);
      continue;
    }
    if (active.has(value)) return false;
    active.add(value);
    if (depth > MAX_JSON_DEPTH) return false;
    stack.push({ value, depth, exit: true });
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    if (nodes + pendingValues + children.length > maxNodes) return false;
    pendingValues += children.length;
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return true;
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
    const obligation = await store.getObligation(status.reporting_obligation_id);
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
    if (!revision || revision.reporting_obligation_id !== status.reporting_obligation_id)
      throw new ReportingStatusValidationError('revision mismatch');
    if (
      status.consumer_status === 'received' &&
      revision.wireRevision.revision_content_sha256.toLowerCase() !==
        status.observed_revision_content_sha256?.toLowerCase()
    )
      throw new ReportingStatusValidationError('revision binding mismatch');
  }
  if (status.seller_ledger_snapshot_id) {
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
    !Number.isInteger(fields.delivery_config_version) ||
    typeof fields.report_definition_id !== 'string' ||
    fields.report_definition_id.length === 0 ||
    fields.report_definition_id.length > 255 ||
    typeof fields.periodStart !== 'string' ||
    typeof fields.periodEnd !== 'string' ||
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

function failed(ids: string[], code: string, message: string, field?: string): SyncReportingStatusResponseV1 {
  const results = ids.map(reporting_status_id => ({
    result: 'failed' as const,
    reporting_status_id,
    errors: [{ code, message, ...wireValidationField(field) }] as FailedReportingConsumerStatusV1['errors'],
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
      : {
          result: 'failed' as const,
          reporting_status_id: result.reporting_status_id,
          errors: [
            {
              code: result.errorCode,
              message: result.safeMessage,
              ...wireValidationField(result.errorField),
            },
          ],
        }
  );
  if (wireResults.length === 0) throw new TypeError('sync_reporting_status store returned no item results');
  return {
    adcp_version: wireAdcpVersion(),
    adcp_major_version: ADCP_MAJOR_VERSION,
    status: 'completed',
    results: wireResults as [ReportingConsumerStatusResultV1, ...ReportingConsumerStatusResultV1[]],
  };
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
  return canonicalJsonSha256(wireValue);
}

function reportingStatusId(value: unknown): string {
  const candidate = isRecord(value) ? value.reporting_status_id : undefined;
  return statusId.safeParse(candidate).success ? (candidate as string) : 'invalid-reporting-status-id';
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
    if (Buffer.byteLength(raw, 'utf8') > MAX_VALIDATION_FIELD_BYTES) return undefined;
    const segment = raw.replace(/~/g, '~0').replace(/\//g, '~1');
    const next = `${pointer}/${segment}`;
    if (Buffer.byteLength(next, 'utf8') > MAX_VALIDATION_FIELD_BYTES) return undefined;
    pointer = next;
  }
  return pointer || undefined;
}

function wireValidationField(field?: string): { field?: string } {
  return field && Buffer.byteLength(field, 'utf8') <= MAX_VALIDATION_FIELD_BYTES ? { field } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wireAdcpVersion(): string {
  return ADCP_VERSION.replace(/^(\d+\.\d+)\.0-/, '$1-');
}
