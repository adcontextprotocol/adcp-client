import { z } from 'zod';

import { canonicalJsonSha256 } from '../../utils/jcs';
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

const id = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const statusId = id.min(16);
const instant = z
  .string()
  .max(64)
  .refine(value => {
    try {
      canonicalReportingInstant(value);
      return true;
    } catch {
      return false;
    }
  }, 'value must be an RFC 3339 instant');
const accountReference = z
  .record(z.string(), z.unknown())
  .refine(
    value =>
      (typeof value.account_id === 'string' && value.account_id.length > 0) ||
      (isRecord(value.brand) && typeof value.operator === 'string' && value.operator.length > 0),
    'account must be an ID reference or buyer-declared natural key'
  );
const periodSchema = z
  .object({ start: instant, end: instant, source_timezone: z.string().min(1).max(255) })
  .strict()
  .refine(value => Date.parse(value.start) < Date.parse(value.end), 'period must be half-open');

export const ReportingConsumerStatusPreviewV1Schema = z
  .object({
    reporting_status_id: statusId,
    supersedes_reporting_status_id: statusId.optional(),
    delivery_config_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    delivery_config_version: z.number().int().min(1),
    report_definition_id: id,
    period: periodSchema,
    reporting_obligation_id: id.optional(),
    reporting_revision_id: id.optional(),
    observed_revision_content_sha256: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/)
      .optional(),
    consumer_status: z.enum(['received', 'obligation_missing', 'revision_missing', 'unreadable']),
    status_as_of: instant,
    failure_code: z
      .enum(['access_denied', 'resource_not_found', 'integrity_mismatch', 'reader_incompatible', 'transport_failed'])
      .optional(),
    consumer_commit_ref: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_.:-]+$/)
      .optional(),
    seller_ledger_snapshot_id: z.string().min(1).max(255).optional(),
    seller_ledger_as_of: instant.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const require = (field: keyof typeof value) => {
      if (value[field] === undefined)
        context.addIssue({ code: 'custom', path: [field], message: `${field} is required` });
    };
    const forbid = (field: keyof typeof value) => {
      if (value[field] !== undefined)
        context.addIssue({ code: 'custom', path: [field], message: `${field} is forbidden` });
    };
    if (value.consumer_status === 'received') {
      require('reporting_obligation_id');
      require('reporting_revision_id');
      require('observed_revision_content_sha256');
      forbid('failure_code');
    } else if (value.consumer_status === 'obligation_missing') {
      for (const field of [
        'reporting_obligation_id',
        'reporting_revision_id',
        'observed_revision_content_sha256',
        'failure_code',
      ] as const)
        forbid(field);
    } else if (value.consumer_status === 'revision_missing') {
      require('reporting_obligation_id');
      forbid('reporting_revision_id');
      forbid('observed_revision_content_sha256');
      forbid('failure_code');
    } else {
      require('reporting_obligation_id');
      require('reporting_revision_id');
      require('failure_code');
      forbid('observed_revision_content_sha256');
    }
    if ((value.seller_ledger_snapshot_id === undefined) !== (value.seller_ledger_as_of === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['seller_ledger_snapshot_id'],
        message: 'snapshot identity and time pair',
      });
    }
  });

export const SyncReportingStatusPreviewRequestV1Schema = z
  .object({
    account: accountReference,
    idempotency_key: z
      .string()
      .min(16)
      .max(255)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    statuses: z.array(ReportingConsumerStatusPreviewV1Schema).min(1).max(100),
    adcp_version: z.string().optional(),
    adcp_major_version: z.number().int().optional(),
    context: z.unknown().optional(),
    ext: z.unknown().optional(),
  })
  .strict();

const SyncReportingStatusPreviewEnvelopeV1Schema = SyncReportingStatusPreviewRequestV1Schema.extend({
  statuses: z.array(z.unknown()).min(1).max(100),
});

export type ReportingConsumerStatusPreviewV1 = z.infer<typeof ReportingConsumerStatusPreviewV1Schema>;
export type SyncReportingStatusPreviewRequestV1 = z.infer<typeof SyncReportingStatusPreviewRequestV1Schema>;

export interface SyncReportingStatusPreviewResponseV1 {
  adcp_version: string;
  adcp_major_version: number;
  status: 'completed';
  results: Array<
    | { result: 'recorded' | 'unchanged'; consumer_status: ReportingConsumerStatusPreviewV1 & { recorded_at: string } }
    | { result: 'failed'; reporting_status_id: string; errors: Array<{ code: string; message: string }> }
  >;
}

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
): (request: SyncReportingStatusPreviewRequestV1, context: TContext) => Promise<SyncReportingStatusPreviewResponseV1> {
  const activeReadsByAccount = new Map<string, number>();
  return async (requestInput, context) => {
    const parsed = SyncReportingStatusPreviewEnvelopeV1Schema.safeParse(requestInput);
    if (!parsed.success) {
      const rawStatuses = isRecord(requestInput) && Array.isArray(requestInput.statuses) ? requestInput.statuses : [];
      const ids =
        rawStatuses.length > 0 && rawStatuses.length <= 100
          ? rawStatuses.map(value => {
              const candidate = isRecord(value) ? value.reporting_status_id : undefined;
              return statusId.safeParse(candidate).success ? (candidate as string) : 'invalid-reporting-status-id';
            })
          : ['invalid-reporting-status-id'];
      return failed(ids, 'VALIDATION_ERROR', 'Reporting consumer status request is invalid');
    }
    const request = parsed.data;
    const parsedStatuses = request.statuses.map(value => ReportingConsumerStatusPreviewV1Schema.safeParse(value));
    const statusIds = parsedStatuses.map((value, index) =>
      value.success ? value.data.reporting_status_id : reportingStatusId(request.statuses[index])
    );
    const accountId = resolvedAccountId(context);
    if (typeof request.account.account_id === 'string' && accountId !== request.account.account_id) {
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
      const configurations = await store.listConfigurations(accountId);
      try {
        const entries: ReportingConsumerStatusBatchEntryV1[] = [];
        for (const [index, parsedStatus] of parsedStatuses.entries()) {
          if (!parsedStatus.success) {
            entries.push({
              reporting_status_id: reportingStatusId(request.statuses[index]),
              validationError: 'Reporting consumer status request is invalid',
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

async function validateStatus(
  store: ReportingConsumerStatusLedgerStore,
  configurations: ReportingLedgerConfigurationV1[],
  accountId: string,
  consumerId: string,
  status: ReportingConsumerStatusPreviewV1,
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
  if (!configuration || !isExactPeriod(configuration, configurations, status.period)) {
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
  period: ReportingConsumerStatusPreviewV1['period']
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
): ReportingConsumerStatusPreviewV1 & { recorded_at: string } {
  const { consumerId: _consumerId, account_id: _accountId, ...wire } = status;
  return wire;
}

function failed(ids: string[], code: string, message: string): SyncReportingStatusPreviewResponseV1 {
  return {
    adcp_version: wireAdcpVersion(),
    adcp_major_version: ADCP_MAJOR_VERSION,
    status: 'completed',
    results: ids.map(reporting_status_id => ({
      result: 'failed',
      reporting_status_id,
      errors: [{ code, message }],
    })),
  };
}

function completed(
  results: Awaited<ReturnType<ReportingConsumerStatusLedgerStore['syncConsumerStatusBatch']>>
): SyncReportingStatusPreviewResponseV1 {
  return {
    adcp_version: wireAdcpVersion(),
    adcp_major_version: ADCP_MAJOR_VERSION,
    status: 'completed',
    results: results.map(result =>
      'value' in result
        ? {
            result: result.inserted ? ('recorded' as const) : ('unchanged' as const),
            consumer_status: wireConsumerStatus(result.value),
          }
        : {
            result: 'failed' as const,
            reporting_status_id: result.reporting_status_id,
            errors: [{ code: result.errorCode, message: result.safeMessage }],
          }
    ),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function wireAdcpVersion(): string {
  return ADCP_VERSION.replace(/^(\d+\.\d+)\.0-/, '$1-');
}
