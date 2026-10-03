import { createHash } from 'node:crypto';
import { z } from 'zod';

import { toPublishedJsonSchema } from './json-schema';
import {
  canonicalJsonV1,
  REPORTING_SOURCE_CONTRACT_VERSION_V1,
  ReportingAccountIdentityV1Schema,
  ReportingAdapterBuildIdentityV1Schema,
  ReportingContractIdentityV1Schema,
  ReportingCoverageConstituentIdentityV1Schema,
  ReportingExternalIdV1Schema,
  ReportingFingerprintV1Schema,
  ReportingInstantV1Schema,
  ReportingOpaqueReferenceV1Schema,
  ReportingSha256V1Schema,
  ReportingSourceScopeV1Schema,
  reportingCoverageDenominatorFingerprintV1,
  SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1,
  SourceBatchManifestReferenceV1Schema,
  type ReportingAccountIdentityV1,
  type ReportingSourceScopeV1,
  type SourceBatchManifestReferenceV1,
} from './manifest';

const ISO_DURATION =
  /^P(?=\d|T\d)(?:(\d{1,8})D)?(?:T(?=\d)(?:(\d{1,7})H)?(?:(\d{1,7})M)?(?:(\d{1,7})(?:\.(\d{1,3}))?S)?)?$/;
/** Arithmetic overflow guard; each offering declares its smaller operational limit. */
export const REPORTING_MAX_SOURCE_WINDOW_DAYS_V1 = Math.floor(
  (Number.MAX_SAFE_INTEGER - 2 * 60 * 60 * 1_000) / (24 * 60 * 60 * 1_000)
);

export const ReportingIsoDurationV1Schema = z.string().max(64).regex(ISO_DURATION);
function parseReportingIsoDurationMillisecondsV1(value: string): number | undefined {
  const match = ISO_DURATION.exec(value);
  if (!match) return undefined;
  const [, days = '0', hours = '0', minutes = '0', seconds = '0', fraction = ''] = match;
  const result =
    (BigInt(days) * 86_400n + BigInt(hours) * 3_600n + BigInt(minutes) * 60n + BigInt(seconds)) * 1_000n +
    BigInt(fraction.padEnd(3, '0') || '0');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(result);
}

export function reportingIsoDurationMillisecondsV1(value: string): number {
  const result = parseReportingIsoDurationMillisecondsV1(value);
  if (result === undefined) throw new TypeError('Invalid reporting duration');
  return result;
}

export const ReportingMetricOrDimensionNameV1Schema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const metricCoverage = z.strictObject({
  name: ReportingMetricOrDimensionNameV1Schema,
  support: z.enum(['exact', 'partial', 'unavailable']),
  reason: z.string().trim().min(1).max(512).optional(),
  semanticContractId: ReportingExternalIdV1Schema,
  semanticContractVersion: z.string().trim().min(1).max(128),
  semanticContractSha256: ReportingSha256V1Schema,
});
const dimensionCoverage = z.strictObject({
  name: ReportingMetricOrDimensionNameV1Schema,
  support: z.enum(['exact', 'partial', 'unavailable']),
  reason: z.string().trim().min(1).max(512).optional(),
});

export const ReportingSourceWindowingV1Schema = z
  .strictObject({
    kind: z.enum(['cumulative_current_window', 'fixed_closed_window', 'provider_defined']),
    minimumWindow: ReportingIsoDurationV1Schema,
    maximumWindow: ReportingIsoDurationV1Schema,
    overlappingWindowsSupported: z.boolean(),
  })
  .superRefine((value, context) => {
    const minimum = parseReportingIsoDurationMillisecondsV1(value.minimumWindow);
    const maximum = parseReportingIsoDurationMillisecondsV1(value.maximumWindow);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      context.addIssue({
        code: 'custom',
        path: ['maximumWindow'],
        message: 'Maximum window cannot be shorter than minimum window',
      });
  });

const triggerSupport = z.strictObject({
  scheduledPoll: z.literal(true),
  upstreamReadinessOrChangeWebhook: z.boolean(),
  hybrid: z.boolean(),
  pollingFallbackRequired: z.literal(true),
  webhookSemantics: z.literal('acceleration_hint_only'),
});

const CommonOfferingFields = {
  offeringId: ReportingExternalIdV1Schema,
  publicationNamespace: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/),
  adapterBuild: ReportingAdapterBuildIdentityV1Schema,
  applicability: z.strictObject({
    productIds: z.array(ReportingExternalIdV1Schema).min(1).max(10_000),
    constituentKinds: z
      .array(z.enum(['product', 'package_item', 'media_buy']))
      .min(1)
      .max(3),
  }),
  contract: ReportingContractIdentityV1Schema,
  sourceTimezone: z.strictObject({
    ownership: z.literal('source_scope'),
    calendar: z.literal('gregory'),
    ianaTimezone: z.string().trim().min(1).max(255).optional(),
  }),
  grain: ReportingExternalIdV1Schema,
  windowing: ReportingSourceWindowingV1Schema,
  metrics: z.array(metricCoverage).min(1).max(1_000),
  dimensions: z.array(dimensionCoverage).max(1_000),
  sourceSettings: z.strictObject({
    currencies: z.enum(['source_scope', 'request_selected']),
    attributionModels: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
    attributionWindows: z.array(z.string().trim().min(1).max(255)).min(1).max(100),
  }),
  formats: z
    .array(
      z.strictObject({
        mediaType: z.enum(['application/json', 'application/x-ndjson', 'text/csv', 'application/vnd.apache.parquet']),
        compression: z.enum(['none', 'gzip', 'zstd']),
      })
    )
    .min(1)
    .max(16),
  sourceExecution: z.strictObject({
    pagination: z.enum(['none', 'cursor', 'page', 'offset']),
    asyncJobs: z.enum(['unsupported', 'optional', 'required']),
    maximumWindowDaysPerRequest: z.number().int().positive().max(REPORTING_MAX_SOURCE_WINDOW_DAYS_V1),
    supportsCancellation: z.boolean(),
    manifestLevels: z
      .array(z.enum(['basic', 'evidenced']))
      .min(1)
      .max(2),
    rateLimitConstraints: z.array(z.string().trim().min(1).max(512)).max(100),
  }),
  retentionDays: z.number().int().positive().safe(),
};

const provisionalOffering = z.strictObject({
  ...CommonOfferingFields,
  publicationClass: z.literal('PROVISIONAL_SNAPSHOT'),
  cadence: z.strictObject({
    fastestSafeCadence: ReportingIsoDurationV1Schema,
    alignment: z.enum(['source_timezone', 'source_defined', 'unaligned']),
    expectedAvailabilityLag: ReportingIsoDurationV1Schema,
    worstCaseAvailabilityLag: ReportingIsoDurationV1Schema,
    triggerSupport,
  }),
  revisionSemantics: z.literal('provisional_replaceable'),
});

const authoritativeOffering = z.strictObject({
  ...CommonOfferingFields,
  publicationClass: z.literal('AUTHORITATIVE'),
  finalization: z.strictObject({
    schedule: z.strictObject({
      sourceLocalReadyTime: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
      daysAfterPeriodEnd: z.number().int().nonnegative().safe(),
    }),
    expectedAvailabilityLag: ReportingIsoDurationV1Schema,
    worstCaseAvailabilityLag: ReportingIsoDurationV1Schema,
    triggerSupport,
    correctionWindow: ReportingIsoDurationV1Schema,
    correctionPolicy: z.enum(['none', 'immutable_correction']),
  }),
  revisionSemantics: z.literal('official_with_declared_correction_policy'),
});

export const ReportingSourceOfferingV1Schema = z.discriminatedUnion('publicationClass', [
  provisionalOffering,
  authoritativeOffering,
]);

export const ReportingSourceCapabilitiesV1Schema = z
  .strictObject({
    contractVersion: z.literal(REPORTING_SOURCE_CONTRACT_VERSION_V1),
    capabilityVersion: z.string().trim().min(1).max(128),
    capabilitySha256: ReportingSha256V1Schema,
    offerings: z.array(ReportingSourceOfferingV1Schema).min(1).max(100),
  })
  .superRefine((value, context) => {
    if (reportingSourceCapabilitiesSha256V1(value) !== value.capabilitySha256)
      context.addIssue({
        code: 'custom',
        path: ['capabilitySha256'],
        message: 'Capability checksum must bind the complete declaration',
      });
    unique(
      value.offerings.map(item => item.offeringId),
      context,
      ['offerings']
    );
    for (const [index, offering] of value.offerings.entries()) {
      unique(
        offering.metrics.map(item => item.name),
        context,
        ['offerings', index, 'metrics']
      );
      unique(
        offering.dimensions.map(item => item.name),
        context,
        ['offerings', index, 'dimensions']
      );
      unique(offering.applicability.productIds, context, ['offerings', index, 'applicability', 'productIds']);
      unique(offering.applicability.constituentKinds, context, [
        'offerings',
        index,
        'applicability',
        'constituentKinds',
      ]);
      unique(
        offering.formats.map(item => `${item.mediaType}\0${item.compression}`),
        context,
        ['offerings', index, 'formats']
      );
      unique(offering.sourceSettings.attributionModels, context, [
        'offerings',
        index,
        'sourceSettings',
        'attributionModels',
      ]);
      unique(offering.sourceSettings.attributionWindows, context, [
        'offerings',
        index,
        'sourceSettings',
        'attributionWindows',
      ]);
      unique(offering.sourceExecution.manifestLevels, context, [
        'offerings',
        index,
        'sourceExecution',
        'manifestLevels',
      ]);
      for (const item of [...offering.metrics, ...offering.dimensions])
        if (item.support !== 'exact' && !item.reason)
          context.addIssue({
            code: 'custom',
            path: ['offerings', index],
            message: 'Partial and unavailable declarations require a reason',
          });
      const timing = offering.publicationClass === 'PROVISIONAL_SNAPSHOT' ? offering.cadence : offering.finalization;
      const expectedAvailabilityLag = parseReportingIsoDurationMillisecondsV1(timing.expectedAvailabilityLag);
      const worstCaseAvailabilityLag = parseReportingIsoDurationMillisecondsV1(timing.worstCaseAvailabilityLag);
      if (
        expectedAvailabilityLag !== undefined &&
        worstCaseAvailabilityLag !== undefined &&
        expectedAvailabilityLag > worstCaseAvailabilityLag
      )
        context.addIssue({
          code: 'custom',
          path: ['offerings', index],
          message: 'Worst-case availability lag must not precede expected lag',
        });
      if (offering.sourceTimezone.ianaTimezone && !isIanaTimezone(offering.sourceTimezone.ianaTimezone))
        context.addIssue({
          code: 'custom',
          path: ['offerings', index, 'sourceTimezone', 'ianaTimezone'],
          message: 'Offering timezone must be a valid IANA timezone',
        });
    }
  });

export const ReportingSourceSliceRequestV1Schema = z
  .strictObject({
    contractVersion: z.literal(REPORTING_SOURCE_CONTRACT_VERSION_V1),
    identity: z.strictObject({
      sourceExecutionKey: z.string().regex(/^[A-Za-z0-9_.:-]{8,255}$/),
      logicalSliceFingerprint: ReportingFingerprintV1Schema,
    }),
    sourceScope: ReportingSourceScopeV1Schema,
    account: ReportingAccountIdentityV1Schema,
    delivery_config_id: ReportingExternalIdV1Schema,
    delivery_config_version: z.number().int().positive().safe(),
    report_definition_id: ReportingExternalIdV1Schema,
    reporting_obligation_id: ReportingExternalIdV1Schema,
    adapterBuild: ReportingAdapterBuildIdentityV1Schema,
    offeringId: ReportingExternalIdV1Schema,
    publicationNamespace: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/),
    publicationClass: z.enum(['PROVISIONAL_SNAPSHOT', 'AUTHORITATIVE']),
    contract: ReportingContractIdentityV1Schema,
    period: z.strictObject({
      periodKey: ReportingExternalIdV1Schema,
      sourceLocalDate: z.iso.date(),
      start: ReportingInstantV1Schema,
      end: ReportingInstantV1Schema,
      sourceTimezone: z.string().trim().min(1).max(255),
      sourceReadCutoffAt: ReportingInstantV1Schema,
      grain: ReportingExternalIdV1Schema,
      windowing: ReportingSourceWindowingV1Schema,
    }),
    finality: z.discriminatedUnion('revisionKind', [
      z.strictObject({ revisionKind: z.literal('snapshot'), supersedesPublicationId: z.never().optional() }),
      z.strictObject({ revisionKind: z.literal('authoritative'), supersedesPublicationId: z.never().optional() }),
      z.strictObject({
        revisionKind: z.literal('correction'),
        supersedesPublicationId: ReportingOpaqueReferenceV1Schema,
      }),
    ]),
    trigger: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('scheduled_poll'),
        id: ReportingExternalIdV1Schema,
        webhookHintId: z.never().optional(),
      }),
      z.strictObject({
        kind: z.literal('webhook_hint'),
        id: ReportingExternalIdV1Schema,
        webhookHintId: ReportingOpaqueReferenceV1Schema,
      }),
      z.strictObject({
        kind: z.enum(['retry', 'backfill', 'gap_recovery', 'manual_replay']),
        id: ReportingExternalIdV1Schema,
        webhookHintId: z.never().optional(),
      }),
    ]),
    sourceRequest: z.strictObject({ groupIds: z.array(ReportingExternalIdV1Schema).max(100_000) }),
    coverage: z.strictObject({
      expected: z.enum(['full', 'partial']),
      constituents: z
        .array(ReportingCoverageConstituentIdentityV1Schema)
        .min(1)
        .max(SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1),
      productIds: z.array(ReportingExternalIdV1Schema).min(1).max(10_000),
      mediaBuyIds: z.array(ReportingExternalIdV1Schema).max(10_000),
      packageIds: z.array(ReportingExternalIdV1Schema).max(100_000),
      denominatorFingerprint: ReportingFingerprintV1Schema,
    }),
    requestedMetrics: z.array(ReportingMetricOrDimensionNameV1Schema).min(1).max(1_000),
    requestedDimensions: z.array(ReportingMetricOrDimensionNameV1Schema).max(1_000),
    sourceSettings: z.strictObject({
      currency: z.string().regex(/^[A-Z]{3}$/),
      attributionModel: z.string().trim().min(1).max(255),
      attributionWindow: z.string().trim().min(1).max(255),
      sourceSettingsVersion: z.string().trim().min(1).max(128),
      sourceSettingsSha256: ReportingSha256V1Schema,
      settingsSnapshotRef: ReportingOpaqueReferenceV1Schema,
    }),
    priorCheckpoint: z
      .strictObject({
        checkpointId: ReportingOpaqueReferenceV1Schema,
        cursor: z.string().min(1).max(2_048).optional(),
        watermark: z.string().min(1).max(2_048).optional(),
        checkpointSha256: ReportingSha256V1Schema,
      })
      .optional(),
    deadline: z.strictObject({
      deadlineAt: ReportingInstantV1Schema,
      cancellationIdentity: ReportingOpaqueReferenceV1Schema,
    }),
  })
  .superRefine((value, context) => {
    const start = Date.parse(value.period.start);
    const end = Date.parse(value.period.end);
    const cutoff = Date.parse(value.period.sourceReadCutoffAt);
    if (![start, end, cutoff].every(Number.isFinite)) return;
    if (end <= start)
      context.addIssue({
        code: 'custom',
        path: ['period', 'end'],
        message: 'Period must be a nonempty half-open window',
      });
    if (cutoff < start)
      context.addIssue({
        code: 'custom',
        path: ['period', 'sourceReadCutoffAt'],
        message: 'Source cutoff cannot precede period start',
      });
    if (!isIanaTimezone(value.period.sourceTimezone))
      context.addIssue({
        code: 'custom',
        path: ['period', 'sourceTimezone'],
        message: 'sourceTimezone must be a valid IANA timezone',
      });
    else if (sourceLocalDate(value.period.start, value.period.sourceTimezone) !== value.period.sourceLocalDate)
      context.addIssue({
        code: 'custom',
        path: ['period', 'sourceLocalDate'],
        message: 'sourceLocalDate must be the source-local date at period start',
      });
    if ((value.publicationClass === 'PROVISIONAL_SNAPSHOT') !== (value.finality.revisionKind === 'snapshot'))
      context.addIssue({
        code: 'custom',
        path: ['finality'],
        message: 'Publication class and revision kind must match',
      });
    if (value.report_definition_id !== value.contract.report_definition_id)
      context.addIssue({
        code: 'custom',
        path: ['report_definition_id'],
        message: 'Report definition must match the contract',
      });
    unique(
      value.coverage.constituents.map(item => item.constituentId),
      context,
      ['coverage', 'constituents']
    );
    unique(value.requestedMetrics, context, ['requestedMetrics']);
    unique(value.requestedDimensions, context, ['requestedDimensions']);
    unique(value.sourceRequest.groupIds, context, ['sourceRequest', 'groupIds']);
    if (
      reportingCoverageDenominatorFingerprintV1(value.coverage.constituents) !== value.coverage.denominatorFingerprint
    )
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'denominatorFingerprint'],
        message: 'Denominator fingerprint mismatch',
      });
    const products = [...new Set(value.coverage.constituents.map(item => item.productId))];
    const packages = [
      ...new Set(value.coverage.constituents.flatMap(item => (item.packageId ? [item.packageId] : []))),
    ];
    const buys = [...new Set(value.coverage.constituents.flatMap(item => (item.mediaBuyId ? [item.mediaBuyId] : [])))];
    if (
      !sameSet(products, value.coverage.productIds) ||
      !sameSet(packages, value.coverage.packageIds) ||
      !sameSet(buys, value.coverage.mediaBuyIds)
    )
      context.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'Coverage summary IDs must exactly project the constituent denominator',
      });
    for (const [index, constituent] of value.coverage.constituents.entries()) {
      if (
        constituent.constituentKind === 'package_item' &&
        (constituent.productBinding.productId !== constituent.productId ||
          constituent.productBinding.packageId !== constituent.packageId)
      )
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'constituents', index, 'productBinding'],
          message: 'Package binding must identify the exact package and product',
        });
      if (
        constituent.constituentKind === 'media_buy' &&
        (constituent.productBinding.productId !== constituent.productId ||
          constituent.productBinding.mediaBuyId !== constituent.mediaBuyId)
      )
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'constituents', index, 'productBinding'],
          message: 'Media-buy binding must identify the exact media buy and product',
        });
    }
    if (
      value.coverage.constituents.length * value.requestedMetrics.length >
      SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1
    )
      context.addIssue({
        code: 'custom',
        path: ['requestedMetrics'],
        message: 'Constituent-metric matrix exceeds 1,000 cells',
      });
  });

export const ReportingSourceExecutionResponseV1Schema = z.strictObject({
  contractVersion: z.literal(REPORTING_SOURCE_CONTRACT_VERSION_V1),
  identity: ReportingSourceSliceRequestV1Schema.shape.identity,
  outcome: z.literal('completed'),
  manifest: SourceBatchManifestReferenceV1Schema,
});

export const ReportingSourceErrorV1Schema = z
  .strictObject({
    contractVersion: z.literal(REPORTING_SOURCE_CONTRACT_VERSION_V1),
    code: z.enum([
      'AUTHENTICATION_FAILED',
      'AUTHORIZATION_FAILED',
      'INVALID_REQUEST',
      'UNSUPPORTED_OFFERING',
      'RATE_LIMITED',
      'QUOTA_EXHAUSTED',
      'SOURCE_TRANSIENT',
      'SOURCE_PERMANENT',
      'SOURCE_JOB_FAILED',
      'PARTIAL_RESULT',
      'CANCELLED',
      'DEADLINE_EXCEEDED',
      'STAGING_FAILED',
      'INTEGRITY_FAILED',
      'NOT_READY',
    ]),
    retry: z.enum(['retryable', 'terminal', 'cancelled']),
    scope: z.enum(['slice', 'account', 'source']),
    safeMessage: z.string().trim().min(1).max(1_024),
    sourceCode: z.string().trim().min(1).max(128).optional(),
    retryAfterMs: z.number().int().nonnegative().safe().optional(),
  })
  .superRefine((value, context) => {
    const permitted: Record<string, readonly string[]> = {
      AUTHENTICATION_FAILED: ['terminal'],
      AUTHORIZATION_FAILED: ['terminal'],
      INVALID_REQUEST: ['terminal'],
      UNSUPPORTED_OFFERING: ['terminal'],
      RATE_LIMITED: ['retryable'],
      QUOTA_EXHAUSTED: ['retryable', 'terminal'],
      SOURCE_TRANSIENT: ['retryable'],
      SOURCE_PERMANENT: ['terminal'],
      SOURCE_JOB_FAILED: ['retryable', 'terminal'],
      PARTIAL_RESULT: ['retryable', 'terminal'],
      CANCELLED: ['cancelled'],
      DEADLINE_EXCEEDED: ['retryable', 'terminal'],
      STAGING_FAILED: ['retryable', 'terminal'],
      INTEGRITY_FAILED: ['terminal'],
      NOT_READY: ['retryable'],
    };
    if (!permitted[value.code]?.includes(value.retry))
      context.addIssue({ code: 'custom', path: ['retry'], message: `${value.code} cannot be ${value.retry}` });
  });

export type ReportingSourceOfferingV1 = z.output<typeof ReportingSourceOfferingV1Schema>;
export type ReportingSourceCapabilitiesV1 = z.output<typeof ReportingSourceCapabilitiesV1Schema>;
export type ReportingSourceSliceRequestV1 = z.output<typeof ReportingSourceSliceRequestV1Schema>;
export type ReportingSourceExecutionResponseV1 = z.output<typeof ReportingSourceExecutionResponseV1Schema>;
export type ReportingSourceErrorV1 = z.output<typeof ReportingSourceErrorV1Schema>;
export type ReportingSourceExecutorResultV1 =
  | { ok: true; response: ReportingSourceExecutionResponseV1; manifestBytes: Uint8Array }
  | { ok: false; error: ReportingSourceErrorV1 };

export interface ReportingSourceExecutorV1 {
  readonly capabilities: ReportingSourceCapabilitiesV1;
  /**
   * Executes one bounded slice. On abort, cancel source requests, job polls,
   * and staging I/O; settle only after all owned work has terminated.
   * A host-supplied heartbeat reports liveness while a leased worker owns the
   * slice; adapters may call it after source progress without awaiting it.
   */
  execute(
    request: ReportingSourceSliceRequestV1,
    context: Readonly<{ signal: AbortSignal; heartbeat?: () => void }>
  ): Promise<ReportingSourceExecutorResultV1>;
}

export interface ReportingSourceStagedObjectReaderV1 {
  /**
   * Enforce `maxBytes` while streaming from storage, before allocating a
   * larger in-memory buffer. On abort, cancel storage I/O and settle after
   * owned work terminates.
   */
  read(input: Readonly<ReportingSourceStagedObjectReadV1>): Promise<Uint8Array>;
}

export interface ReportingSourceStagedObjectReadV1 {
  objectRef: string;
  objectGeneration: string;
  sourceScope: ReportingSourceScopeV1;
  account: ReportingAccountIdentityV1;
  delivery_config_id: string;
  delivery_config_version: number;
  report_definition_id: string;
  reporting_obligation_id: string;
  maxBytes: number;
  signal: AbortSignal;
}

export const ReportingSourceOfferingV1JsonSchema = toPublishedJsonSchema(ReportingSourceOfferingV1Schema);
export const ReportingSourceCapabilitiesV1JsonSchema = toPublishedJsonSchema(ReportingSourceCapabilitiesV1Schema);
export const ReportingSourceSliceRequestV1JsonSchema = toPublishedJsonSchema(ReportingSourceSliceRequestV1Schema);
export const ReportingSourceExecutionResponseV1JsonSchema = toPublishedJsonSchema(
  ReportingSourceExecutionResponseV1Schema
);
export const ReportingSourceErrorV1JsonSchema = toPublishedJsonSchema(ReportingSourceErrorV1Schema);

export function reportingSourceCapabilitiesSha256V1(input: object): string {
  const { capabilitySha256: _ignored, ...declaration } = input as Record<string, unknown>;
  return createHash('sha256').update(canonicalJsonV1(declaration)).digest('hex');
}

export function reportingSourceCapabilitiesV1(
  offerings: readonly ReportingSourceOfferingV1[],
  capabilityVersion = '1'
): ReportingSourceCapabilitiesV1 {
  const candidate = {
    contractVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
    capabilityVersion,
    capabilitySha256: '0'.repeat(64),
    offerings: [...offerings],
  };
  candidate.capabilitySha256 = reportingSourceCapabilitiesSha256V1(candidate);
  return ReportingSourceCapabilitiesV1Schema.parse(candidate);
}

export function completedReportingSourceResponseV1(input: {
  request: ReportingSourceSliceRequestV1;
  manifest: SourceBatchManifestReferenceV1;
}): ReportingSourceExecutionResponseV1 {
  return ReportingSourceExecutionResponseV1Schema.parse({
    contractVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
    identity: input.request.identity,
    outcome: 'completed',
    manifest: input.manifest,
  });
}

function unique(values: readonly string[], context: z.RefinementCtx, path: PropertyKey[]) {
  if (new Set(values).size !== values.length)
    context.addIssue({ code: 'custom', path, message: 'Values must be unique' });
}
function sameSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return (
    new Set(left).size === left.length && rightSet.size === right.length && left.every(value => rightSet.has(value))
  );
}

function isIanaTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function sourceLocalDate(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Normative period-boundary origins from `core/reporting-schedule.json`.
 *
 * `utc` uses 1970-01-01T00:00:00Z as interval zero; `source_timezone` uses
 * local midnight on that date in the explicit period timezone. Every boundary
 * is the origin plus an interval ordinal, so an adopter that follows the spec
 * anchors its generation on that origin rather than on a recent date.
 */
export const REPORTING_SCHEDULE_ORIGIN_UTC_DATE_V1 = Date.UTC(1970, 0, 1);

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

/** Constructing a formatter per sample would dominate an offset scan. */
function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedParts(
  timeZone: string,
  instantMs: number
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value);
  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    hour: field('hour'),
    minute: field('minute'),
    second: field('second'),
  };
}

/** Minutes east of UTC that `timeZone` observes at `instantMs`. */
export function reportingUtcOffsetMinutesV1(timeZone: string, instantMs: number): number {
  const parts = zonedParts(timeZone, instantMs);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - (instantMs - (instantMs % 1_000))) / 60_000);
}

/** Shorter than any real IANA offset era, so no change hides between probes. */
const REPORTING_OFFSET_PROBE_STEP_MS_V1 = 10 * 86_400_000;

/**
 * True when `timeZone` does not hold one UTC offset across `[startMs, endMs]`.
 *
 * Fixed-millisecond period arithmetic only agrees with the spec's civil-time
 * boundary generation while the offset holds still, so any change in the span
 * means boundaries drift off source-local midnight.
 */
export function reportingUtcOffsetChangesV1(timeZone: string, startMs: number, endMs: number): boolean {
  const baseline = reportingUtcOffsetMinutesV1(timeZone, startMs);
  for (let instant = startMs; instant < endMs; instant += REPORTING_OFFSET_PROBE_STEP_MS_V1) {
    if (reportingUtcOffsetMinutesV1(timeZone, instant) !== baseline) return true;
  }
  return reportingUtcOffsetMinutesV1(timeZone, endMs) !== baseline;
}

/** True when `instantMs` is exactly 00:00:00.000 local time in `timeZone`. */
export function reportingIsSourceLocalMidnightV1(instantMs: number, timeZone: string): boolean {
  if (instantMs % 1_000 !== 0) return false;
  const parts = zonedParts(timeZone, instantMs);
  return parts.hour === 0 && parts.minute === 0 && parts.second === 0;
}

/**
 * Interval zero for an alignment, per `reporting-schedule.json` §period_generation.
 * `billing_cycle` has no derivable origin — it carries an explicit anchor.
 */
export function reportingScheduleOriginV1(alignment: 'utc' | 'source_timezone', timeZone: string): number {
  if (alignment === 'utc') return REPORTING_SCHEDULE_ORIGIN_UTC_DATE_V1;
  // Resolve local midnight on 1970-01-01 by converging on the zone's own
  // offset at that instant; two passes settle any offset/era difference.
  let instant = REPORTING_SCHEDULE_ORIGIN_UTC_DATE_V1;
  for (let pass = 0; pass < 3; pass += 1) {
    const candidate = REPORTING_SCHEDULE_ORIGIN_UTC_DATE_V1 - reportingUtcOffsetMinutesV1(timeZone, instant) * 60_000;
    if (candidate === instant) break;
    instant = candidate;
  }
  return instant;
}
