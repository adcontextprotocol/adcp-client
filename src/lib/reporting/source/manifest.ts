import { createHash } from 'node:crypto';
import { z } from 'zod';

import { toPublishedJsonSchema } from './json-schema';

export const REPORTING_SOURCE_CONTRACT_VERSION_V1 = '1.0' as const;
export const SOURCE_BATCH_MANIFEST_MAX_BYTES_V1 = 1_048_576;
export const SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1 = 1_000;
export const SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1 = 10_000;
export const REPORTING_SOURCE_SCOPE_MAX_DEPTH_V1 = 64;

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const METRIC_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const REASON = /^[A-Za-z0-9](?:[A-Za-z0-9 !#$%&'()*+,./:;<=>?@^_{}|~-]{0,510}[A-Za-z0-9])?$/;

export const ReportingSha256V1Schema = z.string().regex(SHA256);
export const ReportingFingerprintV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const EXTERNAL_ID_MAX_CHARS = 255;

/**
 * Whether `value` is padded or carries a control character, without allocating.
 *
 * A validator's checks all run even once one has failed, so splitting the value into a
 * code point array meant an over-long identifier was still walked in full: a validator
 * that rejects a 256 character id would allocate a 256 element array, and an
 * arbitrarily large one an arbitrarily large array. The length gate comes first and is
 * O(1), and the scan below reads code units in place. Control characters all sit below
 * the surrogate range, so scanning code units is equivalent to scanning code points.
 */
function isUnpaddedControlFreeIdentifier(value: string): boolean {
  if (value.length > EXTERNAL_ID_MAX_CHARS) return false;
  if (value.length === 0) return false;
  if (/^\s/.test(value) || /\s$/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 31 || unit === 127) return false;
  }
  return true;
}

export const ReportingExternalIdV1Schema = z
  .string()
  .min(1)
  .max(EXTERNAL_ID_MAX_CHARS)
  .refine(isUnpaddedControlFreeIdentifier, 'Identifier must not contain whitespace padding or control characters');
export const ReportingOpaqueReferenceV1Schema = z.string().regex(OPAQUE_REF);
export const ReportingEvidenceReasonV1Schema = z.string().min(1).max(512).regex(REASON);
export const ReportingInstantV1Schema = z.iso.datetime({ offset: true }).refine(value => {
  const precision = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return precision === undefined || precision.length <= 3;
}, 'Reporting instants support at most millisecond precision');

export const ReportingSourceScopeV1Schema = z
  .record(z.string().min(1).max(128), z.unknown())
  .superRefine((value, context) => {
    const validity = validateSourceScopeJson(value);
    if (!validity.valid) {
      context.addIssue({ code: 'custom', message: validity.message });
      return;
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(canonicalJsonV1(value), 'utf8');
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'sourceScope must contain canonical JSON values and safe integers only',
      });
      return;
    }
    if (bytes > 65_536) {
      context.addIssue({ code: 'custom', message: 'sourceScope exceeds 64 KiB' });
    }
  });

/** Structural HTTPS URI check only; callers must apply SSRF controls before dereferencing. */
export const ReportingContractHttpsUriV1Schema = z
  .string()
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: 'custom', message: 'Contract URI must be a valid URL' });
      return;
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      hostname === 'localhost' ||
      hostname.startsWith('[') ||
      /^\d+(?:\.\d+){3}$/.test(hostname) ||
      !hostname.includes('.')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Contract URI must use a public HTTPS hostname',
      });
    }
  });

export const ReportingAccountIdentityV1Schema = z.strictObject({
  account_id: ReportingExternalIdV1Schema,
});

export const ReportingContractIdentityV1Schema = z.strictObject({
  report_definition_id: ReportingExternalIdV1Schema,
  reportDefinitionUri: ReportingContractHttpsUriV1Schema,
  reportDefinitionSha256: ReportingSha256V1Schema,
  reportingProfile: ReportingExternalIdV1Schema,
  schemaVersion: z.string().trim().min(1).max(64),
  schemaUri: ReportingContractHttpsUriV1Schema,
  schemaSha256: ReportingSha256V1Schema,
  schemaDialect: z.literal('https://json-schema.org/draft/2020-12/schema'),
  schemaRefPolicy: z.literal('local_fragment_only'),
  mappingId: ReportingExternalIdV1Schema,
  mappingVersion: z.string().trim().min(1).max(64),
  mappingSha256: ReportingSha256V1Schema,
});

export const ReportingAdapterBuildIdentityV1Schema = z.strictObject({
  executorId: ReportingExternalIdV1Schema,
  adapterId: ReportingExternalIdV1Schema,
  adapterVersion: z.string().trim().min(1).max(128),
  adapterBuildSha256: ReportingSha256V1Schema,
});

const ProductBindingBase = {
  owner: z.literal('caller'),
  bindingId: ReportingOpaqueReferenceV1Schema,
  bindingVersion: z.number().int().positive().safe(),
  bindingSha256: ReportingSha256V1Schema,
  productId: ReportingExternalIdV1Schema,
};

export const ReportingPackageItemProductBindingV1Schema = z.strictObject({
  ...ProductBindingBase,
  bindingKind: z.literal('package_item_product'),
  packageId: ReportingExternalIdV1Schema,
});

export const ReportingMediaBuyProductBindingV1Schema = z.strictObject({
  ...ProductBindingBase,
  bindingKind: z.literal('media_buy_product'),
  mediaBuyId: ReportingExternalIdV1Schema,
});

const ConstituentIdentityVariants = [
  z.strictObject({
    constituentId: ReportingExternalIdV1Schema,
    constituentKind: z.literal('product'),
    productId: ReportingExternalIdV1Schema,
    packageId: z.never().optional(),
    mediaBuyId: z.never().optional(),
    productBinding: z.never().optional(),
  }),
  z.strictObject({
    constituentId: ReportingExternalIdV1Schema,
    constituentKind: z.literal('package_item'),
    productId: ReportingExternalIdV1Schema,
    packageId: ReportingExternalIdV1Schema,
    mediaBuyId: z.never().optional(),
    productBinding: ReportingPackageItemProductBindingV1Schema,
  }),
  z.strictObject({
    constituentId: ReportingExternalIdV1Schema,
    constituentKind: z.literal('media_buy'),
    productId: ReportingExternalIdV1Schema,
    packageId: z.never().optional(),
    mediaBuyId: ReportingExternalIdV1Schema,
    productBinding: ReportingMediaBuyProductBindingV1Schema,
  }),
] as const;

export const ReportingCoverageConstituentIdentityV1Schema = z.discriminatedUnion(
  'constituentKind',
  ConstituentIdentityVariants
);

const availability = z.enum(['present', 'explicit_zero', 'unsupported', 'delayed', 'partial', 'stale', 'missing']);

export const ReportingCoverageConstituentV1Schema = z.discriminatedUnion('constituentKind', [
  ConstituentIdentityVariants[0].extend({
    status: availability,
    dataThrough: ReportingInstantV1Schema.optional(),
    reason: ReportingEvidenceReasonV1Schema.optional(),
  }),
  ConstituentIdentityVariants[1].extend({
    status: availability,
    dataThrough: ReportingInstantV1Schema.optional(),
    reason: ReportingEvidenceReasonV1Schema.optional(),
  }),
  ConstituentIdentityVariants[2].extend({
    status: availability,
    dataThrough: ReportingInstantV1Schema.optional(),
    reason: ReportingEvidenceReasonV1Schema.optional(),
  }),
]);

export const SourceBatchObjectV1Schema = z.strictObject({
  ordinal: z.number().int().nonnegative().safe(),
  objectRef: ReportingOpaqueReferenceV1Schema,
  objectGeneration: ReportingOpaqueReferenceV1Schema,
  mediaType: z.enum(['application/json', 'application/x-ndjson', 'text/csv', 'application/vnd.apache.parquet']),
  compression: z.enum(['none', 'gzip', 'zstd']),
  sha256: ReportingSha256V1Schema,
  byteCount: z.number().int().nonnegative().safe(),
  rowCount: z.number().int().nonnegative().safe(),
});

export const SourceBatchManifestReferenceV1Schema = z.strictObject({
  stagedCommitRef: ReportingOpaqueReferenceV1Schema,
  manifestSha256: ReportingSha256V1Schema,
  byteCount: z.number().int().positive().max(SOURCE_BATCH_MANIFEST_MAX_BYTES_V1),
  encoding: z.literal('canonical_json_utf8_v1'),
  level: z.enum(['basic', 'evidenced']),
});

const windowing = z.strictObject({
  kind: z.enum(['cumulative_current_window', 'fixed_closed_window', 'provider_defined']),
  minimumWindow: z.string().min(2).max(64),
  maximumWindow: z.string().min(2).max(64),
  overlappingWindowsSupported: z.boolean(),
});

const period = z.strictObject({
  periodKey: ReportingExternalIdV1Schema,
  sourceLocalDate: z.iso.date(),
  start: ReportingInstantV1Schema,
  end: ReportingInstantV1Schema,
  sourceTimezone: z.string().trim().min(1).max(255),
  sourceReadCutoffAt: ReportingInstantV1Schema,
  observedAt: ReportingInstantV1Schema,
  dataThrough: ReportingInstantV1Schema,
  grain: ReportingExternalIdV1Schema,
  windowing,
});

const finalityEvidence = z.strictObject({
  owner: z.literal('adapter'),
  basis: z.enum(['provisional_observation', 'source_declared', 'source_job_terminal', 'elapsed_settlement_window']),
  observedAt: ReportingInstantV1Schema,
  evidenceRef: ReportingExternalIdV1Schema.optional(),
});

const finality = z.discriminatedUnion('revisionKind', [
  z.strictObject({
    revisionKind: z.literal('snapshot'),
    supersedesPublicationId: z.never().optional(),
    evidence: finalityEvidence,
  }),
  z.strictObject({
    revisionKind: z.literal('authoritative'),
    supersedesPublicationId: z.never().optional(),
    evidence: finalityEvidence,
  }),
  z.strictObject({
    revisionKind: z.literal('correction'),
    supersedesPublicationId: ReportingOpaqueReferenceV1Schema,
    evidence: finalityEvidence,
  }),
]);

const metricAvailability = z.strictObject({
  constituentId: ReportingExternalIdV1Schema,
  metric: z.string().regex(METRIC_NAME),
  semanticContractId: ReportingExternalIdV1Schema,
  semanticContractVersion: z.string().trim().min(1).max(128),
  semanticContractSha256: ReportingSha256V1Schema,
  status: availability,
  dataThrough: ReportingInstantV1Schema.optional(),
  reason: ReportingEvidenceReasonV1Schema.optional(),
});

const controlTotal = z.discriminatedUnion('valueType', [
  z.strictObject({
    name: z.string().regex(METRIC_NAME),
    value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/),
    valueType: z.literal('integer'),
    unit: z.string().min(1).max(32).optional(),
  }),
  z.strictObject({
    name: z.string().regex(METRIC_NAME),
    value: z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/),
    valueType: z.literal('decimal'),
    unit: z.string().min(1).max(32).optional(),
  }),
]);

const ManifestCommonFields = {
  manifestVersion: z.literal(REPORTING_SOURCE_CONTRACT_VERSION_V1),
  complete: z.literal(true),
  replacementMode: z.literal('replace'),
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
  publication: z.strictObject({
    namespace: z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/),
    publicationId: ReportingOpaqueReferenceV1Schema,
    publicationClass: z.enum(['PROVISIONAL_SNAPSHOT', 'AUTHORITATIVE']),
    contentFingerprint: ReportingFingerprintV1Schema,
  }),
  adapterBuild: ReportingAdapterBuildIdentityV1Schema,
  offeringId: ReportingExternalIdV1Schema,
  requestedDimensions: z.array(z.string().regex(METRIC_NAME)).max(1_000),
  period,
  finality,
  contract: ReportingContractIdentityV1Schema,
  sourceSettings: z.strictObject({
    currency: z.string().regex(/^[A-Z]{3}$/),
    attributionModel: z.string().trim().min(1).max(255),
    attributionWindow: z.string().trim().min(1).max(255),
    sourceSettingsVersion: z.string().trim().min(1).max(128),
    sourceSettingsSha256: ReportingSha256V1Schema,
    settingsSnapshotRef: ReportingOpaqueReferenceV1Schema,
  }),
  objects: z.array(SourceBatchObjectV1Schema).min(1).max(100_000),
  objectCount: z.number().int().positive().max(100_000),
  byteCount: z.number().int().nonnegative().safe(),
  rowCount: z.number().int().nonnegative().safe(),
  objectSetSha256: ReportingSha256V1Schema,
  controlTotals: z.array(controlTotal).max(1_000),
  metricAvailability: z.array(metricAvailability).min(1).max(SOURCE_BATCH_MANIFEST_MAX_METRIC_AVAILABILITY_V1),
  coverage: z.strictObject({
    denominatorFingerprint: ReportingFingerprintV1Schema,
    coverageFingerprint: ReportingFingerprintV1Schema,
    status: z.enum(['full', 'partial', 'none']),
    constituents: z.array(ReportingCoverageConstituentV1Schema).min(1).max(1_000),
  }),
  explicitZero: z.boolean(),
  acquiredAt: ReportingInstantV1Schema,
  eventTimeRange: z.strictObject({ start: ReportingInstantV1Schema, end: ReportingInstantV1Schema }).optional(),
  warnings: z.array(z.string().trim().min(1).max(1_024)).max(1_000),
};

const basicCompleteness = z.strictObject({
  terminal: z.literal(true),
  rowsComplete: z.literal(true),
  requestedGroupsComplete: z.literal(true),
});

const page = z.strictObject({
  ordinal: z.number().int().nonnegative().safe(),
  requestId: ReportingExternalIdV1Schema,
  requestParametersSha256: ReportingSha256V1Schema,
  requestCursor: z.string().min(1).max(2_048).optional(),
  nextCursor: z.string().min(1).max(2_048).optional(),
  pageNumber: z.number().int().positive().safe().optional(),
  offset: z.number().int().nonnegative().safe().optional(),
  responseSha256: ReportingSha256V1Schema,
  itemCount: z.number().int().nonnegative().safe(),
  outputObjectOrdinals: z.array(z.number().int().nonnegative().safe()).min(1).max(100_000),
});

const evidencedCompleteness = z.strictObject({
  terminal: z.literal(true),
  rowsComplete: z.literal(true),
  requestedGroupsComplete: z.literal(true),
  sourceRequestIds: z.array(ReportingExternalIdV1Schema).min(1).max(10_000),
  providerPagination: z.strictObject({
    kind: z.enum(['none', 'cursor', 'page', 'offset']),
    complete: z.literal(true),
    termination: z.enum(['single_page', 'no_next_cursor', 'known_page_count_reached', 'empty_terminal_page']),
    knownPageCount: z.number().int().positive().safe().optional(),
    pages: z.array(page).min(1).max(10_000),
  }),
  sourceJob: z.discriminatedUnion('mode', [
    z.strictObject({
      mode: z.literal('not_used'),
      terminal: z.literal(true),
      jobs: z.array(z.never()).max(0),
      polls: z.array(z.never()).max(0),
    }),
    z.strictObject({
      mode: z.literal('terminal_success'),
      terminal: z.literal(true),
      jobs: z
        .array(
          z.strictObject({
            jobId: ReportingExternalIdV1Schema,
            submissionRequestId: ReportingExternalIdV1Schema,
            submissionResponseSha256: ReportingSha256V1Schema,
          })
        )
        .min(1)
        .max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
      polls: z
        .array(
          z.strictObject({
            jobId: ReportingExternalIdV1Schema,
            ordinal: z.number().int().nonnegative().safe(),
            requestId: ReportingExternalIdV1Schema,
            observedAt: ReportingInstantV1Schema,
            state: z.enum(['queued', 'running', 'succeeded']),
            responseSha256: ReportingSha256V1Schema,
          })
        )
        .min(1)
        .max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
    }),
  ]),
  requestedGroups: z.array(ReportingExternalIdV1Schema).max(100_000),
});

const providerUsage = z.strictObject({
  requestCount: z.number().int().nonnegative().max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
  pageCount: z.number().int().nonnegative().max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
  asyncJobCount: z.number().int().nonnegative().max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
  retryCount: z.number().int().nonnegative().max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
  retryAttempts: z
    .array(
      z.strictObject({
        attemptId: ReportingOpaqueReferenceV1Schema,
        requestId: ReportingExternalIdV1Schema.optional(),
        attemptedAt: ReportingInstantV1Schema,
        classification: z.enum(['RATE_LIMITED', 'QUOTA_EXHAUSTED', 'SOURCE_TRANSIENT', 'SOURCE_JOB_FAILED']),
      })
    )
    .max(SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1),
  sourceQuotaUnits: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
    .optional(),
});

function validateManifest(manifest: any, context: z.RefinementCtx) {
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: 'custom', path, message });
  const start = Date.parse(manifest.period.start);
  const end = Date.parse(manifest.period.end);
  const cutoff = Date.parse(manifest.period.sourceReadCutoffAt);
  const observed = Date.parse(manifest.period.observedAt);
  const dataThrough = Date.parse(manifest.period.dataThrough);
  const acquired = Date.parse(manifest.acquiredAt);
  const finalityObserved = Date.parse(manifest.finality.evidence.observedAt);
  if (![start, end, cutoff, observed, dataThrough, acquired, finalityObserved].every(Number.isFinite)) return;
  if (!isIanaTimezone(manifest.period.sourceTimezone)) {
    issue(['period', 'sourceTimezone'], 'Source timezone must be a valid IANA timezone');
  } else if (
    sourceLocalDate(manifest.period.start, manifest.period.sourceTimezone) !== manifest.period.sourceLocalDate
  ) {
    issue(['period', 'sourceLocalDate'], 'sourceLocalDate must be the source-local date at period start');
  }
  if (end <= start) issue(['period', 'end'], 'Period must be a nonempty half-open window');
  if (dataThrough < start || dataThrough > end || dataThrough > cutoff || dataThrough > observed) {
    issue(['period', 'dataThrough'], 'dataThrough must be bounded by the period, observation, and source read cutoff');
  }
  if (acquired < observed) issue(['acquiredAt'], 'Acquisition cannot precede observation');
  if (finalityObserved < dataThrough || finalityObserved > acquired) {
    issue(['finality', 'evidence', 'observedAt'], 'Finality evidence must fall between dataThrough and acquisition');
  }
  const snapshot = manifest.publication.publicationClass === 'PROVISIONAL_SNAPSHOT';
  if (snapshot !== (manifest.finality.revisionKind === 'snapshot')) {
    issue(['finality', 'revisionKind'], 'Snapshot and authoritative revision kinds are distinct');
  }
  if (snapshot !== (manifest.finality.evidence.basis === 'provisional_observation')) {
    issue(['finality', 'evidence', 'basis'], 'Finality evidence must match the publication class');
  }
  if (!snapshot && finalityObserved < end) {
    issue(['finality', 'evidence', 'observedAt'], 'Authoritative evidence cannot predate period end');
  }
  if (manifest.report_definition_id !== manifest.contract.report_definition_id) {
    issue(['report_definition_id'], 'Report definition identity must match the contract');
  }
  if (manifest.objectCount !== manifest.objects.length) issue(['objectCount'], 'Object count must match objects');
  const byteCount = manifest.objects.reduce((sum: number, object: any) => sum + object.byteCount, 0);
  const rowCount = manifest.objects.reduce((sum: number, object: any) => sum + object.rowCount, 0);
  if (!Number.isSafeInteger(byteCount) || byteCount !== manifest.byteCount)
    issue(['byteCount'], 'Byte count must equal object bytes');
  if (!Number.isSafeInteger(rowCount) || rowCount !== manifest.rowCount)
    issue(['rowCount'], 'Row count must equal object rows');
  manifest.objects.forEach((object: any, index: number) => {
    if (object.ordinal !== index) issue(['objects', index, 'ordinal'], 'Object ordinals must be contiguous');
  });
  if (new Set(manifest.objects.map((object: any) => object.objectRef)).size !== manifest.objects.length) {
    issue(['objects'], 'Object references must be unique');
  }
  if (
    new Set(manifest.objects.map((object: any) => `${object.objectRef}\0${object.objectGeneration}`)).size !==
    manifest.objects.length
  ) {
    issue(['objects'], 'Generation-pinned objects must be unique');
  }
  try {
    if (sourceBatchObjectSetFingerprintV1(manifest.objects) !== manifest.objectSetSha256)
      issue(['objectSetSha256'], 'Object-set digest mismatch');
  } catch {
    issue(['objectSetSha256'], 'Object-set digest cannot be verified');
  }
  try {
    if (
      reportingCoverageDenominatorFingerprintV1(manifest.coverage.constituents) !==
      manifest.coverage.denominatorFingerprint
    )
      issue(['coverage', 'denominatorFingerprint'], 'Coverage denominator mismatch');
  } catch {
    issue(['coverage', 'denominatorFingerprint'], 'Coverage denominator cannot be verified');
  }
  try {
    if (sourceBatchCoverageFingerprintV1(manifest.coverage.constituents) !== manifest.coverage.coverageFingerprint)
      issue(['coverage', 'coverageFingerprint'], 'Coverage evidence mismatch');
  } catch {
    issue(['coverage', 'coverageFingerprint'], 'Coverage evidence cannot be verified');
  }
  try {
    if (sourceBatchPublicationContentFingerprintV1(manifest) !== manifest.publication.contentFingerprint)
      issue(['publication', 'contentFingerprint'], 'Publication content digest mismatch');
  } catch {
    issue(['publication', 'contentFingerprint'], 'Publication content digest cannot be verified');
  }

  if (new Set(manifest.controlTotals.map((item: any) => item.name)).size !== manifest.controlTotals.length) {
    issue(['controlTotals'], 'Control-total names must be unique');
  }
  if (
    new Set(manifest.coverage.constituents.map((item: any) => item.constituentId)).size !==
    manifest.coverage.constituents.length
  ) {
    issue(['coverage', 'constituents'], 'Coverage constituents must be unique');
  }
  const cells = new Map(
    manifest.metricAvailability.map((item: any) => [`${item.constituentId}\0${item.metric}`, item])
  );
  if (cells.size !== manifest.metricAvailability.length) issue(['metricAvailability'], 'Metric cells must be unique');
  const metrics = new Set(manifest.metricAvailability.map((item: any) => item.metric));
  let missingMetricCell = false;
  for (const constituent of manifest.coverage.constituents) {
    for (const metric of metrics) {
      if (!cells.has(`${constituent.constituentId}\0${metric}`)) {
        missingMetricCell = true;
        break;
      }
    }
    if (missingMetricCell) break;
  }
  if (missingMetricCell) issue(['metricAvailability'], 'Every constituent requires every metric cell');
  const fullyCovered = manifest.coverage.constituents.filter((item: any) =>
    ['present', 'explicit_zero'].includes(item.status)
  ).length;
  const someCoverage =
    fullyCovered > 0 || manifest.coverage.constituents.some((item: any) => item.status === 'partial');
  if (manifest.coverage.status === 'full' && fullyCovered !== manifest.coverage.constituents.length)
    issue(['coverage', 'status'], 'Full coverage requires every constituent');
  if (manifest.coverage.status === 'none' && someCoverage)
    issue(['coverage', 'status'], 'No coverage cannot contain covered constituents');
  if (
    manifest.coverage.status === 'partial' &&
    (!someCoverage || fullyCovered === manifest.coverage.constituents.length)
  )
    issue(['coverage', 'status'], 'Partial coverage must be truthful');
  for (const [index, item] of manifest.coverage.constituents.entries()) {
    const available = ['present', 'explicit_zero'].includes(item.status);
    if (!available && !item.reason)
      issue(['coverage', 'constituents', index, 'reason'], 'Unavailable constituents require a reason');
    if (available && !item.dataThrough)
      issue(['coverage', 'constituents', index, 'dataThrough'], 'Available constituents require dataThrough');
    if (item.dataThrough && (Date.parse(item.dataThrough) < start || Date.parse(item.dataThrough) > dataThrough))
      issue(
        ['coverage', 'constituents', index, 'dataThrough'],
        'Constituent dataThrough must remain within the admitted manifest window'
      );
  }
  for (const [index, item] of manifest.metricAvailability.entries()) {
    const available = ['present', 'explicit_zero'].includes(item.status);
    if (!available && !item.reason)
      issue(['metricAvailability', index, 'reason'], 'Unavailable metrics require a reason');
    if (available && !item.dataThrough)
      issue(['metricAvailability', index, 'dataThrough'], 'Available metrics require dataThrough');
    if (item.dataThrough && (Date.parse(item.dataThrough) < start || Date.parse(item.dataThrough) > dataThrough))
      issue(
        ['metricAvailability', index, 'dataThrough'],
        'Metric dataThrough must remain within the admitted manifest window'
      );
    const constituent = manifest.coverage.constituents.find(
      (candidate: any) => candidate.constituentId === item.constituentId
    );
    if (!constituent || !constituentAllowsMetricStatus(constituent.status, item.status))
      issue(['metricAvailability', index, 'status'], 'Metric status must be consistent with its constituent roll-up');
  }
  if (!snapshot && manifest.coverage.status === 'full') {
    if (Date.parse(manifest.period.dataThrough) !== end)
      issue(['period', 'dataThrough'], 'Full authoritative coverage must reach period end');
    for (const [index, item] of manifest.coverage.constituents.entries())
      if (['present', 'explicit_zero'].includes(item.status) && Date.parse(item.dataThrough) !== end)
        issue(
          ['coverage', 'constituents', index, 'dataThrough'],
          'Full authoritative constituent must reach period end'
        );
    for (const [index, item] of manifest.metricAvailability.entries())
      if (['present', 'explicit_zero'].includes(item.status) && Date.parse(item.dataThrough) !== end)
        issue(['metricAvailability', index, 'dataThrough'], 'Full authoritative metric must reach period end');
  }
  if (manifest.explicitZero) {
    if (manifest.rowCount !== 0 || manifest.eventTimeRange)
      issue(['explicitZero'], 'Explicit zero has no rows or event range');
    if (manifest.controlTotals.some((item: any) => !/^-?0(?:\.0+)?$/.test(item.value)))
      issue(['controlTotals'], 'Explicit-zero control totals must be zero');
    if (
      manifest.coverage.constituents.some((item: any) => item.status !== 'explicit_zero') ||
      manifest.metricAvailability.some((item: any) => item.status !== 'explicit_zero')
    )
      issue(['explicitZero'], 'Explicit zero must cover every cell');
  } else if (manifest.rowCount === 0) {
    const unavailable =
      manifest.coverage.status !== 'full' &&
      manifest.coverage.constituents.every(
        (item: any) => item.status !== 'present' && item.status !== 'explicit_zero'
      ) &&
      manifest.metricAvailability.every((item: any) => item.status !== 'present' && item.status !== 'explicit_zero');
    if (!unavailable) issue(['explicitZero'], 'A completed zero-row available batch must be explicit zero');
    if (manifest.eventTimeRange) issue(['eventTimeRange'], 'A zero-row unavailable batch has no event-time range');
    if (manifest.controlTotals.some((item: any) => !/^-?0(?:\.0+)?$/.test(item.value)))
      issue(['controlTotals'], 'A zero-row unavailable batch cannot declare nonzero control totals');
  } else if (manifest.rowCount > 0 && !manifest.eventTimeRange) {
    issue(['eventTimeRange'], 'Nonzero rows require an event range');
  }
  if (manifest.eventTimeRange) {
    const eventStart = Date.parse(manifest.eventTimeRange.start);
    const eventEnd = Date.parse(manifest.eventTimeRange.end);
    if (
      !Number.isFinite(eventStart) ||
      !Number.isFinite(eventEnd) ||
      eventEnd <= eventStart ||
      eventStart < start ||
      eventEnd > end ||
      eventEnd > dataThrough ||
      eventEnd > cutoff
    )
      issue(['eventTimeRange'], 'Event range exceeds the admitted window');
  }
}

function validateEvidencedManifest(manifest: any, context: z.RefinementCtx) {
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: 'custom', path, message });
  const pagination = manifest.completeness.providerPagination;
  const pages: any[] = pagination.pages;
  const sourceRequestIds: string[] = manifest.completeness.sourceRequestIds;
  const pageRequestIds = pages.map(page => page.requestId);
  if (!uniqueValues(sourceRequestIds) || !uniqueValues(pageRequestIds) || !sameSet(pageRequestIds, sourceRequestIds)) {
    issue(
      ['completeness', 'sourceRequestIds'],
      'Pagination evidence must cover the exact unique source request denominator'
    );
  }

  const objectsByOrdinal = new Map(manifest.objects.map((object: any) => [object.ordinal, object]));
  for (const [index, page] of pages.entries()) {
    if (page.ordinal !== index)
      issue(
        ['completeness', 'providerPagination', 'pages', index, 'ordinal'],
        'Page ordinals must be contiguous and source ordered'
      );
    if (!uniqueValues(page.outputObjectOrdinals.map(String)))
      issue(
        ['completeness', 'providerPagination', 'pages', index, 'outputObjectOrdinals'],
        'Page object ordinals must be unique'
      );
    const evidencedRows = page.outputObjectOrdinals.reduce(
      (total: number, ordinal: number) => total + ((objectsByOrdinal.get(ordinal) as any)?.rowCount ?? 0),
      0
    );
    if (evidencedRows !== page.itemCount)
      issue(
        ['completeness', 'providerPagination', 'pages', index, 'itemCount'],
        'Page item count must equal normalized output rows'
      );
  }

  if (pagination.kind === 'none') {
    if (
      pages.length !== 1 ||
      pagination.termination !== 'single_page' ||
      pagination.knownPageCount !== undefined ||
      pages.some(
        (page: any) =>
          page.requestCursor !== undefined ||
          page.nextCursor !== undefined ||
          page.pageNumber !== undefined ||
          page.offset !== undefined
      )
    ) {
      issue(['completeness', 'providerPagination'], 'Non-paginated evidence requires exactly one terminal page');
    }
  } else if (pagination.kind === 'cursor') {
    const seen = new Set<string>();
    for (const [index, page] of pages.entries()) {
      if (index < pages.length - 1 && page.nextCursor === undefined)
        issue(
          ['completeness', 'providerPagination', 'pages', index, 'nextCursor'],
          'Every nonterminal cursor page must declare its next cursor'
        );
      if (index > 0 && page.requestCursor === undefined)
        issue(
          ['completeness', 'providerPagination', 'pages', index, 'requestCursor'],
          'Every cursor page after the first must consume the preceding cursor'
        );
      if (
        (page.requestCursor && seen.has(page.requestCursor)) ||
        (page.nextCursor && (seen.has(page.nextCursor) || page.nextCursor === page.requestCursor))
      )
        issue(['completeness', 'providerPagination', 'pages', index], 'Cursor pagination must not repeat or cycle');
      if (page.requestCursor) seen.add(page.requestCursor);
      if (index > 0 && page.requestCursor !== pages[index - 1]?.nextCursor)
        issue(
          ['completeness', 'providerPagination', 'pages', index, 'requestCursor'],
          'Cursor pagination must form an unbroken chain'
        );
    }
    if (
      pages.at(-1)?.nextCursor !== undefined ||
      pagination.termination !== 'no_next_cursor' ||
      pagination.knownPageCount !== undefined ||
      pages.some((page: any) => page.pageNumber !== undefined || page.offset !== undefined)
    )
      issue(
        ['completeness', 'providerPagination', 'termination'],
        'Cursor pagination completes only with no next cursor'
      );
  } else if (pagination.kind === 'page') {
    if (
      pages.some(
        (page: any, index: number) =>
          page.pageNumber !== index + 1 ||
          page.requestCursor !== undefined ||
          page.nextCursor !== undefined ||
          page.offset !== undefined
      )
    )
      issue(['completeness', 'providerPagination', 'pages'], 'Page-number evidence must be contiguous from page one');
    const knownComplete =
      pagination.termination === 'known_page_count_reached' && pagination.knownPageCount === pages.length;
    const emptyComplete =
      pagination.termination === 'empty_terminal_page' &&
      pagination.knownPageCount === undefined &&
      pages.at(-1)?.itemCount === 0;
    if (!knownComplete && !emptyComplete)
      issue(
        ['completeness', 'providerPagination', 'termination'],
        'Page-number pagination requires an exact known count or retained empty terminal page'
      );
  } else if (pagination.kind === 'offset') {
    let expectedOffset = 0;
    for (const [index, page] of pages.entries()) {
      if (
        page.offset !== expectedOffset ||
        page.requestCursor !== undefined ||
        page.nextCursor !== undefined ||
        page.pageNumber !== undefined
      )
        issue(
          ['completeness', 'providerPagination', 'pages', index, 'offset'],
          'Offset evidence must be contiguous from zero'
        );
      expectedOffset += page.itemCount;
    }
    if (
      pagination.termination !== 'empty_terminal_page' ||
      pagination.knownPageCount !== undefined ||
      pages.at(-1)?.itemCount !== 0
    )
      issue(
        ['completeness', 'providerPagination', 'termination'],
        'Offset pagination requires a retained empty terminal page'
      );
  }

  const composedOrdinals = pages.flatMap(page => page.outputObjectOrdinals);
  if (
    !sameIntegerSet(
      composedOrdinals,
      manifest.objects.map((object: any) => object.ordinal)
    )
  )
    issue(['completeness', 'providerPagination', 'pages'], 'Page evidence must exactly partition the object set');
  if (manifest.providerUsage.pageCount !== pages.length)
    issue(['providerUsage', 'pageCount'], 'Page count must match evidence');

  const jobs: any[] = manifest.completeness.sourceJob.jobs;
  const polls: any[] = manifest.completeness.sourceJob.polls;
  if (!uniqueValues(jobs.map(job => job.jobId))) issue(['completeness', 'sourceJob', 'jobs'], 'Job IDs must be unique');
  if (manifest.providerUsage.asyncJobCount !== jobs.length)
    issue(['providerUsage', 'asyncJobCount'], 'Job count must match evidence');
  const jobIndex = new Map(jobs.map((job, index) => [job.jobId, index]));
  const state = new Map(
    jobs.map(job => [job.jobId, { count: 0, observedAt: Number.NEGATIVE_INFINITY, terminal: false }])
  );
  let priorJobIndex = -1;
  for (const [index, poll] of polls.entries()) {
    const declaredIndex = jobIndex.get(poll.jobId);
    const prior = state.get(poll.jobId);
    if (declaredIndex === undefined || !prior) {
      issue(['completeness', 'sourceJob', 'polls', index, 'jobId'], 'Poll must reference a declared job');
      continue;
    }
    if (declaredIndex < priorJobIndex)
      issue(['completeness', 'sourceJob', 'polls', index, 'jobId'], 'Polls must be grouped in declared job order');
    priorJobIndex = Math.max(priorJobIndex, declaredIndex);
    const observedAt = Date.parse(poll.observedAt);
    if (poll.ordinal !== prior.count)
      issue(['completeness', 'sourceJob', 'polls', index, 'ordinal'], 'Poll ordinals must be contiguous per job');
    if (observedAt < prior.observedAt || observedAt > Date.parse(manifest.acquiredAt))
      issue(
        ['completeness', 'sourceJob', 'polls', index, 'observedAt'],
        'Poll observations must be chronological and not postdate acquisition'
      );
    if (prior.terminal)
      issue(['completeness', 'sourceJob', 'polls', index, 'state'], 'No poll may follow terminal success');
    prior.count += 1;
    prior.observedAt = observedAt;
    prior.terminal = poll.state === 'succeeded';
  }
  for (const [index, job] of jobs.entries())
    if (!state.get(job.jobId)?.terminal)
      issue(['completeness', 'sourceJob', 'jobs', index], 'Every job requires a final terminal-success poll');

  const retries: any[] = manifest.providerUsage.retryAttempts;
  if (manifest.providerUsage.retryCount !== retries.length)
    issue(['providerUsage', 'retryCount'], 'Retry count must match evidence');
  if (!uniqueValues(retries.map(retry => retry.attemptId)))
    issue(['providerUsage', 'retryAttempts'], 'Retry attempt IDs must be unique');
  for (const [index, retry] of retries.entries())
    if (Date.parse(retry.attemptedAt) > Date.parse(manifest.acquiredAt))
      issue(['providerUsage', 'retryAttempts', index, 'attemptedAt'], 'Retry attempts must not postdate acquisition');
  const requestIds = [
    ...sourceRequestIds,
    ...jobs.map(job => job.submissionRequestId),
    ...polls.map(poll => poll.requestId),
    ...retries.flatMap(retry => (retry.requestId ? [retry.requestId] : [])),
  ];
  if (!uniqueValues(requestIds))
    issue(['providerUsage', 'requestCount'], 'All evidenced source request IDs must be unique');
  const evidencedCalls = sourceRequestIds.length + jobs.length + polls.length + retries.length;
  if (
    evidencedCalls > SOURCE_BATCH_MANIFEST_MAX_PROVIDER_CALLS_V1 ||
    manifest.providerUsage.requestCount !== evidencedCalls
  )
    issue(['providerUsage', 'requestCount'], 'Every bounded source call must be evidenced exactly once');
}

export const BasicSourceBatchManifestV1Schema = z
  .strictObject({ ...ManifestCommonFields, level: z.literal('basic'), completeness: basicCompleteness })
  .superRefine((manifest, context) => {
    try {
      validateManifest(manifest, context);
    } catch {
      context.addIssue({ code: 'custom', message: 'Manifest cross-field evidence cannot be verified' });
    }
  });

export const SourceBatchManifestV1Schema = z
  .strictObject({
    ...ManifestCommonFields,
    level: z.literal('evidenced'),
    completeness: evidencedCompleteness,
    priorCheckpoint: z
      .strictObject({
        checkpointId: ReportingOpaqueReferenceV1Schema,
        cursor: z.string().min(1).max(2_048).optional(),
        watermark: z.string().min(1).max(2_048).optional(),
        checkpointSha256: ReportingSha256V1Schema,
      })
      .optional(),
    providerUsage,
  })
  .superRefine((manifest, context) => {
    try {
      validateManifest(manifest, context);
      validateEvidencedManifest(manifest, context);
    } catch {
      context.addIssue({ code: 'custom', message: 'Manifest cross-field evidence cannot be verified' });
    }
  });

export const ReportingSourceManifestV1Schema = z.union([BasicSourceBatchManifestV1Schema, SourceBatchManifestV1Schema]);

export type ReportingSourceScopeV1 = z.output<typeof ReportingSourceScopeV1Schema>;
export type ReportingAccountIdentityV1 = z.output<typeof ReportingAccountIdentityV1Schema>;
export type ReportingContractIdentityV1 = z.output<typeof ReportingContractIdentityV1Schema>;
export type ReportingAdapterBuildIdentityV1 = z.output<typeof ReportingAdapterBuildIdentityV1Schema>;
export type ReportingCoverageConstituentIdentityV1 = z.output<typeof ReportingCoverageConstituentIdentityV1Schema>;
export type SourceBatchObjectV1 = z.output<typeof SourceBatchObjectV1Schema>;
export type SourceBatchManifestReferenceV1 = z.output<typeof SourceBatchManifestReferenceV1Schema>;
export type BasicSourceBatchManifestV1 = z.output<typeof BasicSourceBatchManifestV1Schema>;
export type SourceBatchManifestV1 = z.output<typeof SourceBatchManifestV1Schema>;
export type ReportingSourceManifestV1 = z.output<typeof ReportingSourceManifestV1Schema>;
export type ReportingSourcePublicationContentV1 = Pick<
  ReportingSourceManifestV1,
  | 'sourceScope'
  | 'account'
  | 'delivery_config_id'
  | 'delivery_config_version'
  | 'report_definition_id'
  | 'reporting_obligation_id'
  | 'publication'
  | 'period'
  | 'contract'
  | 'offeringId'
  | 'requestedDimensions'
  | 'sourceSettings'
  | 'objects'
  | 'rowCount'
  | 'controlTotals'
  | 'metricAvailability'
  | 'coverage'
  | 'explicitZero'
>;

export const ReportingEvidenceReasonV1JsonSchema = toPublishedJsonSchema(ReportingEvidenceReasonV1Schema);
export const SourceBatchManifestReferenceV1JsonSchema = toPublishedJsonSchema(SourceBatchManifestReferenceV1Schema);
export const BasicSourceBatchManifestV1JsonSchema = toPublishedJsonSchema(BasicSourceBatchManifestV1Schema);
export const SourceBatchManifestV1JsonSchema = toPublishedJsonSchema(SourceBatchManifestV1Schema);

export class SourceBatchContractError extends Error {
  constructor(
    readonly code:
      | 'SOURCE_MANIFEST_TOO_LARGE'
      | 'SOURCE_MANIFEST_CHECKSUM_MISMATCH'
      | 'SOURCE_MANIFEST_ENCODING_INVALID'
      | 'SOURCE_MANIFEST_CANONICAL_ENCODING_MISMATCH'
      | 'SOURCE_MANIFEST_JSON_INVALID'
      | 'SOURCE_MANIFEST_LEVEL_MISMATCH',
    message: string
  ) {
    super(message);
    this.name = 'SourceBatchContractError';
  }
}

export function canonicalJsonV1(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('canonical_json_utf8_v1 permits safe integers only');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJsonV1(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('canonical_json_utf8_v1 does not permit this value');
}

export function encodeReportingSourceManifestV1(input: ReportingSourceManifestV1): Uint8Array {
  const parsed = ReportingSourceManifestV1Schema.parse(input);
  const bytes = Buffer.from(canonicalJsonV1(parsed), 'utf8');
  if (bytes.byteLength > SOURCE_BATCH_MANIFEST_MAX_BYTES_V1)
    throw new SourceBatchContractError('SOURCE_MANIFEST_TOO_LARGE', 'Source manifest exceeds 1 MiB');
  return bytes;
}

export const encodeSourceBatchManifestV1 = encodeReportingSourceManifestV1;

export function sourceBatchManifestReferenceV1(
  stagedCommitRef: string,
  manifestBytes: Uint8Array,
  level: 'basic' | 'evidenced'
): SourceBatchManifestReferenceV1 {
  return SourceBatchManifestReferenceV1Schema.parse({
    stagedCommitRef,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    byteCount: manifestBytes.byteLength,
    encoding: 'canonical_json_utf8_v1',
    level,
  });
}

export function parseVerifiedReportingSourceManifestV1(
  reference: SourceBatchManifestReferenceV1,
  rawBytes: Uint8Array,
  level: 'basic' | 'evidenced' = reference.level
): ReportingSourceManifestV1 {
  const parsedReference = SourceBatchManifestReferenceV1Schema.parse(reference);
  if (parsedReference.level !== level)
    throw new SourceBatchContractError(
      'SOURCE_MANIFEST_LEVEL_MISMATCH',
      'Manifest level does not match conformance level'
    );
  if (rawBytes.byteLength !== parsedReference.byteCount || rawBytes.byteLength > SOURCE_BATCH_MANIFEST_MAX_BYTES_V1)
    throw new SourceBatchContractError('SOURCE_MANIFEST_TOO_LARGE', 'Manifest size does not match reference');
  if (createHash('sha256').update(rawBytes).digest('hex') !== parsedReference.manifestSha256)
    throw new SourceBatchContractError('SOURCE_MANIFEST_CHECKSUM_MISMATCH', 'Manifest checksum mismatch');
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    throw new SourceBatchContractError('SOURCE_MANIFEST_ENCODING_INVALID', 'Manifest is not UTF-8');
  }
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    throw new SourceBatchContractError('SOURCE_MANIFEST_JSON_INVALID', 'Manifest is not JSON');
  }
  const manifest = (level === 'evidenced' ? SourceBatchManifestV1Schema : BasicSourceBatchManifestV1Schema).parse(
    input
  ) as ReportingSourceManifestV1;
  if (!Buffer.from(encodeReportingSourceManifestV1(manifest)).equals(Buffer.from(rawBytes)))
    throw new SourceBatchContractError(
      'SOURCE_MANIFEST_CANONICAL_ENCODING_MISMATCH',
      'Manifest is not canonical_json_utf8_v1'
    );
  return manifest;
}

export function sourceBatchObjectSetFingerprintV1(objects: readonly SourceBatchObjectV1[]): string {
  const parsed = z.array(SourceBatchObjectV1Schema).min(1).max(100_000).parse(objects);
  const hash = createHash('sha256');
  appendLengthPrefixed(hash, 'ordered_generation_pinned_object_set_v1');
  for (const object of parsed) {
    appendLengthPrefixed(hash, String(object.ordinal));
    appendLengthPrefixed(hash, object.objectRef);
    appendLengthPrefixed(hash, object.objectGeneration);
    appendLengthPrefixed(hash, object.mediaType);
    appendLengthPrefixed(hash, object.compression);
    appendLengthPrefixed(hash, object.sha256);
    appendLengthPrefixed(hash, String(object.byteCount));
    appendLengthPrefixed(hash, String(object.rowCount));
  }
  return hash.digest('hex');
}

export function reportingCoverageDenominatorFingerprintV1(
  constituents: readonly ReportingCoverageConstituentIdentityV1[]
): string {
  const identities = constituents
    .map(constituentIdentity)
    .sort((a, b) =>
      String(a.constituentId) < String(b.constituentId) ? -1 : String(a.constituentId) > String(b.constituentId) ? 1 : 0
    );
  return `sha256:${createHash('sha256')
    .update(canonicalJsonV1({ kind: 'reporting_coverage_denominator_v1', constituents: identities }))
    .digest('hex')}`;
}

export function sourceBatchCoverageFingerprintV1(
  constituents: readonly z.output<typeof ReportingCoverageConstituentV1Schema>[]
): string {
  return `sha256:${createHash('sha256')
    .update(
      canonicalJsonV1(
        [...constituents].sort((a, b) =>
          a.constituentId < b.constituentId ? -1 : a.constituentId > b.constituentId ? 1 : 0
        )
      )
    )
    .digest('hex')}`;
}

export function sourceBatchPublicationContentFingerprintV1(manifest: ReportingSourcePublicationContentV1): string {
  const content = {
    sourceScope: manifest.sourceScope,
    account: manifest.account,
    delivery_config_id: manifest.delivery_config_id,
    delivery_config_version: manifest.delivery_config_version,
    report_definition_id: manifest.report_definition_id,
    reporting_obligation_id: manifest.reporting_obligation_id,
    publicationClass: manifest.publication.publicationClass,
    period: {
      periodKey: manifest.period.periodKey,
      start: manifest.period.start,
      end: manifest.period.end,
      sourceTimezone: manifest.period.sourceTimezone,
      grain: manifest.period.grain,
      windowing: manifest.period.windowing,
    },
    contract: manifest.contract,
    offeringId: manifest.offeringId,
    requestedDimensions: manifest.requestedDimensions,
    sourceSettings: manifest.sourceSettings,
    objects: manifest.objects.map((object: SourceBatchObjectV1) => ({
      ordinal: object.ordinal,
      mediaType: object.mediaType,
      compression: object.compression,
      sha256: object.sha256,
      byteCount: object.byteCount,
      rowCount: object.rowCount,
    })),
    rowCount: manifest.rowCount,
    controlTotals: manifest.controlTotals,
    metricAvailability: manifest.metricAvailability.map((item: any) => ({
      constituentId: item.constituentId,
      metric: item.metric,
      semanticContractId: item.semanticContractId,
      semanticContractVersion: item.semanticContractVersion,
      semanticContractSha256: item.semanticContractSha256,
      status: item.status,
      ...(item.reason ? { reason: item.reason } : {}),
    })),
    coverage: {
      denominatorFingerprint: manifest.coverage.denominatorFingerprint,
      status: manifest.coverage.status,
      constituents: manifest.coverage.constituents.map((item: any) => ({
        ...constituentIdentity(item),
        status: item.status,
        ...(item.reason ? { reason: item.reason } : {}),
      })),
    },
    explicitZero: manifest.explicitZero,
  };
  return `sha256:${createHash('sha256').update(canonicalJsonV1(content)).digest('hex')}`;
}

export function deterministicSourcePublicationIdV1(input: {
  sourceExecutionKey: string;
  logicalSliceFingerprint: string;
  publicationClass: 'PROVISIONAL_SNAPSHOT' | 'AUTHORITATIVE';
  revisionKind: 'snapshot' | 'authoritative' | 'correction';
  supersedesPublicationId?: string;
}): string {
  const identity = {
    sourceExecutionKey: input.sourceExecutionKey,
    logicalSliceFingerprint: input.logicalSliceFingerprint,
    publicationClass: input.publicationClass,
    revisionKind: input.revisionKind,
    ...(input.supersedesPublicationId ? { supersedesPublicationId: input.supersedesPublicationId } : {}),
  };
  return `src-${createHash('sha256').update(canonicalJsonV1(identity)).digest('hex')}`;
}

function constituentIdentity(item: any) {
  return {
    constituentId: item.constituentId,
    constituentKind: item.constituentKind,
    productId: item.productId,
    ...(item.packageId !== undefined ? { packageId: item.packageId } : {}),
    ...(item.mediaBuyId !== undefined ? { mediaBuyId: item.mediaBuyId } : {}),
    ...(item.productBinding !== undefined ? { productBinding: item.productBinding } : {}),
  };
}

function appendLengthPrefixed(hash: ReturnType<typeof createHash>, value: string) {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function validateSourceScopeJson(root: unknown): { valid: true } | { valid: false; message: string } {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (Number.isSafeInteger(value)) continue;
      return { valid: false, message: 'sourceScope numbers must be safe integers' };
    }
    if (typeof value !== 'object') {
      return { valid: false, message: 'sourceScope must contain JSON values only' };
    }
    if (depth >= REPORTING_SOURCE_SCOPE_MAX_DEPTH_V1) {
      return {
        valid: false,
        message: `sourceScope exceeds maximum depth ${REPORTING_SOURCE_SCOPE_MAX_DEPTH_V1}`,
      };
    }
    if (seen.has(value)) return { valid: false, message: 'sourceScope must be an acyclic JSON tree' };
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, depth: depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { valid: false, message: 'sourceScope objects must be plain JSON objects' };
    }
    for (const item of Object.values(value)) pending.push({ value: item, depth: depth + 1 });
  }
  return { valid: true };
}

function sameSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return (
    new Set(left).size === left.length && rightSet.size === right.length && left.every(value => rightSet.has(value))
  );
}

function uniqueValues(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function sameIntegerSet(left: readonly number[], right: readonly number[]) {
  return (
    left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value))
  );
}

function constituentAllowsMetricStatus(constituent: string, metric: string) {
  switch (constituent) {
    case 'present':
      return metric === 'present' || metric === 'explicit_zero';
    case 'explicit_zero':
      return metric === 'explicit_zero';
    case 'unsupported':
      return metric === 'unsupported';
    case 'delayed':
      return ['unsupported', 'delayed', 'missing'].includes(metric);
    case 'stale':
      return ['unsupported', 'delayed', 'stale', 'missing'].includes(metric);
    case 'missing':
      return metric === 'missing';
    case 'partial':
      return true;
    default:
      return false;
  }
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
