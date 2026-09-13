import { createHash } from 'node:crypto';

import {
  BasicSourceBatchManifestV1Schema,
  canonicalJsonV1,
  deterministicSourcePublicationIdV1,
  encodeReportingSourceManifestV1,
  REPORTING_SOURCE_CONTRACT_VERSION_V1,
  ReportingSourceManifestV1Schema,
  reportingCoverageDenominatorFingerprintV1,
  sourceBatchCoverageFingerprintV1,
  sourceBatchManifestReferenceV1,
  sourceBatchObjectSetFingerprintV1,
  sourceBatchPublicationContentFingerprintV1,
  SourceBatchManifestV1Schema,
  type ReportingSourceManifestV1,
} from './manifest';
import {
  completedReportingSourceResponseV1,
  reportingSourceCapabilitiesV1,
  ReportingSourceSliceRequestV1Schema,
  type ReportingSourceExecutorResultV1,
  type ReportingSourceOfferingV1,
  type ReportingSourceSliceRequestV1,
  type ReportingSourceStagedObjectReaderV1,
} from './source';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

export const canonicalJsonUtf8V1GoldenVectors = [
  {
    name: 'utf16-key-order-escaping-and-utf8',
    value: { z: 'line\n', é: 'é', '😀': '😀', a: 1 },
    canonicalUtf8Hex: '7b2261223a312c227a223a226c696e655c6e222c22c3a9223a22c3a9222c22f09f9880223a22f09f9880227d',
    sha256: '57d672581e912835bbb3b06dca5d2529559d186fa1981b7c36288f497b8806d5',
  },
  {
    name: 'arrays-booleans-and-safe-integers',
    value: { array: [true, false, null, 9007199254740991], exact: '1.2500' },
    canonicalUtf8Hex:
      '7b226172726179223a5b747275652c66616c73652c6e756c6c2c393030373139393235343734303939315d2c226578616374223a22312e32353030227d',
    sha256: '226e7194619d305726379b253c222d63b63fbe0bacc92138dbb958fc62a62647',
  },
] as const;

export const redactedReportingAdapterBuildV1 = {
  executorId: 'fixture-reporting-source',
  adapterId: 'fixture-adapter',
  adapterVersion: '1.0.0',
  adapterBuildSha256: A,
};

export const redactedReportingContractIdentityV1 = {
  report_definition_id: 'delivery-daily-v1',
  reportDefinitionUri: 'https://contracts.example/reporting/delivery-daily-v1',
  reportDefinitionSha256: A,
  reportingProfile: 'delivery',
  schemaVersion: '1.0.0',
  schemaUri: 'https://contracts.example/reporting/delivery-daily-v1/schema',
  schemaSha256: B,
  schemaDialect: 'https://json-schema.org/draft/2020-12/schema' as const,
  schemaRefPolicy: 'local_fragment_only' as const,
  mappingId: 'fixture-delivery-v1',
  mappingVersion: '1',
  mappingSha256: C,
};

export const redactedReportingSourceOfferingV1: ReportingSourceOfferingV1 = {
  offeringId: 'fixture-daily-snapshot',
  publicationNamespace: 'reporting-source:fixture',
  publicationClass: 'PROVISIONAL_SNAPSHOT',
  adapterBuild: redactedReportingAdapterBuildV1,
  applicability: {
    productIds: ['fixture-product'],
    constituentKinds: ['media_buy'],
  },
  contract: redactedReportingContractIdentityV1,
  sourceTimezone: {
    ownership: 'source_scope',
    calendar: 'gregory',
    ianaTimezone: 'UTC',
  },
  grain: 'source_day',
  windowing: {
    kind: 'fixed_closed_window',
    minimumWindow: 'P1D',
    maximumWindow: 'P1D',
    overlappingWindowsSupported: false,
  },
  metrics: [
    {
      name: 'impressions',
      support: 'exact',
      semanticContractId: 'delivery.impressions',
      semanticContractVersion: '1',
      semanticContractSha256: B,
    },
    {
      name: 'spend',
      support: 'exact',
      semanticContractId: 'delivery.spend',
      semanticContractVersion: '1',
      semanticContractSha256: C,
    },
  ],
  dimensions: [{ name: 'media_buy_id', support: 'exact' }],
  sourceSettings: {
    currencies: 'source_scope',
    attributionModels: ['source_default'],
    attributionWindows: ['source_default'],
  },
  formats: [{ mediaType: 'application/x-ndjson', compression: 'none' }],
  sourceExecution: {
    pagination: 'none',
    asyncJobs: 'optional',
    maximumWindowDaysPerRequest: 1,
    supportsCancellation: true,
    manifestLevels: ['basic', 'evidenced'],
    rateLimitConstraints: [],
  },
  retentionDays: 30,
  cadence: {
    fastestSafeCadence: 'PT1H',
    alignment: 'source_timezone',
    expectedAvailabilityLag: 'PT15M',
    worstCaseAvailabilityLag: 'PT6H',
    triggerSupport: {
      scheduledPoll: true,
      upstreamReadinessOrChangeWebhook: false,
      hybrid: false,
      pollingFallbackRequired: true,
      webhookSemantics: 'acceleration_hint_only',
    },
  },
  revisionSemantics: 'provisional_replaceable',
};

export const redactedReportingSourceCapabilitiesV1 = reportingSourceCapabilitiesV1(
  [redactedReportingSourceOfferingV1],
  'fixture-1'
);

export function redactedReportingSourceRequestV1(
  overrides: Partial<Pick<ReportingSourceSliceRequestV1['identity'], 'sourceExecutionKey'>> = {}
): ReportingSourceSliceRequestV1 {
  const constituent = {
    constituentId: 'fixture-constituent',
    constituentKind: 'media_buy' as const,
    productId: 'fixture-product',
    mediaBuyId: 'fixture-media-buy',
    productBinding: {
      owner: 'caller' as const,
      bindingKind: 'media_buy_product' as const,
      bindingId: 'fixture-product-binding',
      bindingVersion: 1,
      bindingSha256: C,
      productId: 'fixture-product',
      mediaBuyId: 'fixture-media-buy',
    },
  };
  return ReportingSourceSliceRequestV1Schema.parse({
    contractVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
    identity: {
      sourceExecutionKey: overrides.sourceExecutionKey ?? 'fixture-execution-1',
      logicalSliceFingerprint: `sha256:${A}`,
    },
    sourceScope: { connection: 'fixture-redacted', region: 'test' },
    account: { account_id: 'fixture-account' },
    delivery_config_id: 'fixture-delivery-config',
    delivery_config_version: 1,
    report_definition_id: 'delivery-daily-v1',
    reporting_obligation_id: 'fixture-obligation',
    adapterBuild: redactedReportingAdapterBuildV1,
    offeringId: redactedReportingSourceOfferingV1.offeringId,
    publicationNamespace: redactedReportingSourceOfferingV1.publicationNamespace,
    publicationClass: 'PROVISIONAL_SNAPSHOT',
    contract: redactedReportingContractIdentityV1,
    period: {
      periodKey: '2026-09-01',
      sourceLocalDate: '2026-09-01',
      start: '2026-09-01T00:00:00.000Z',
      end: '2026-09-02T00:00:00.000Z',
      sourceTimezone: 'UTC',
      sourceReadCutoffAt: '2026-09-02T00:00:00.000Z',
      grain: 'source_day',
      windowing: redactedReportingSourceOfferingV1.windowing,
    },
    finality: { revisionKind: 'snapshot' },
    trigger: { kind: 'scheduled_poll', id: 'fixture-trigger' },
    sourceRequest: { groupIds: [] },
    coverage: {
      expected: 'full',
      constituents: [constituent],
      productIds: ['fixture-product'],
      mediaBuyIds: ['fixture-media-buy'],
      packageIds: [],
      denominatorFingerprint: reportingCoverageDenominatorFingerprintV1([constituent]),
    },
    requestedMetrics: ['impressions', 'spend'],
    requestedDimensions: ['media_buy_id'],
    sourceSettings: {
      currency: 'USD',
      attributionModel: 'source_default',
      attributionWindow: 'source_default',
      sourceSettingsVersion: '1',
      sourceSettingsSha256: A,
      settingsSnapshotRef: 'fixture-settings',
    },
    deadline: {
      deadlineAt: '2099-09-02T01:00:00.000Z',
      cancellationIdentity: 'fixture-cancellation',
    },
  });
}

export function redactedReportingSourceResultV1(
  level: 'basic' | 'evidenced' = 'evidenced',
  request = redactedReportingSourceRequestV1()
): {
  manifest: ReportingSourceManifestV1;
  result: ReportingSourceExecutorResultV1;
  objectReader: ReportingSourceStagedObjectReaderV1;
} {
  const body = '{"impressions":10,"media_buy_id":"fixture-media-buy","spend":"1.25"}\n';
  const bytes = Buffer.from(body, 'utf8');
  const object = {
    ordinal: 0,
    objectRef: 'fixture-object',
    objectGeneration: 'fixture-generation',
    mediaType: 'application/x-ndjson' as const,
    compression: 'none' as const,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteCount: bytes.byteLength,
    rowCount: 1,
  };
  const dataThrough = request.period.end;
  const coverageConstituents = request.coverage.constituents.map(item => ({
    ...item,
    status: 'present' as const,
    dataThrough,
  }));
  const common = {
    manifestVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
    level,
    complete: true as const,
    replacementMode: 'replace' as const,
    identity: request.identity,
    sourceScope: request.sourceScope,
    account: request.account,
    delivery_config_id: request.delivery_config_id,
    delivery_config_version: request.delivery_config_version,
    report_definition_id: request.report_definition_id,
    reporting_obligation_id: request.reporting_obligation_id,
    publication: {
      namespace: request.publicationNamespace,
      publicationId: deterministicSourcePublicationIdV1({
        sourceExecutionKey: request.identity.sourceExecutionKey,
        logicalSliceFingerprint: request.identity.logicalSliceFingerprint,
        publicationClass: request.publicationClass,
        revisionKind: request.finality.revisionKind,
      }),
      publicationClass: request.publicationClass,
      contentFingerprint: `sha256:${A}`,
    },
    adapterBuild: request.adapterBuild,
    offeringId: request.offeringId,
    requestedDimensions: request.requestedDimensions,
    period: {
      ...request.period,
      observedAt: request.period.end,
      dataThrough,
    },
    finality: {
      revisionKind: 'snapshot' as const,
      evidence: {
        owner: 'adapter' as const,
        basis: 'provisional_observation' as const,
        observedAt: request.period.end,
      },
    },
    contract: request.contract,
    sourceSettings: request.sourceSettings,
    objects: [object],
    objectCount: 1,
    byteCount: bytes.byteLength,
    rowCount: 1,
    objectSetSha256: sourceBatchObjectSetFingerprintV1([object]),
    controlTotals: [],
    metricAvailability: request.requestedMetrics.map(metric => {
      const declaration = redactedReportingSourceOfferingV1.metrics.find(item => item.name === metric)!;
      return {
        constituentId: 'fixture-constituent',
        metric,
        semanticContractId: declaration.semanticContractId,
        semanticContractVersion: declaration.semanticContractVersion,
        semanticContractSha256: declaration.semanticContractSha256,
        status: 'present' as const,
        dataThrough,
      };
    }),
    coverage: {
      denominatorFingerprint: request.coverage.denominatorFingerprint,
      coverageFingerprint: sourceBatchCoverageFingerprintV1(coverageConstituents),
      status: 'full' as const,
      constituents: coverageConstituents,
    },
    explicitZero: false,
    acquiredAt: request.period.end,
    eventTimeRange: { start: request.period.start, end: request.period.end },
    warnings: [],
  };
  const candidate =
    level === 'basic'
      ? {
          ...common,
          level: 'basic' as const,
          completeness: {
            terminal: true as const,
            rowsComplete: true as const,
            requestedGroupsComplete: true as const,
          },
        }
      : {
          ...common,
          level: 'evidenced' as const,
          completeness: {
            terminal: true as const,
            rowsComplete: true as const,
            requestedGroupsComplete: true as const,
            sourceRequestIds: ['fixture-request'],
            providerPagination: {
              kind: 'none' as const,
              complete: true as const,
              termination: 'single_page' as const,
              pages: [
                {
                  ordinal: 0,
                  requestId: 'fixture-request',
                  requestParametersSha256: A,
                  responseSha256: object.sha256,
                  itemCount: 1,
                  outputObjectOrdinals: [0],
                },
              ],
            },
            sourceJob: {
              mode: 'not_used' as const,
              terminal: true as const,
              jobs: [],
              polls: [],
            },
            requestedGroups: [],
          },
          providerUsage: {
            requestCount: 1,
            pageCount: 1,
            asyncJobCount: 0,
            retryCount: 0,
            retryAttempts: [],
          },
        };
  candidate.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(candidate);
  const manifest = (level === 'basic' ? BasicSourceBatchManifestV1Schema : SourceBatchManifestV1Schema).parse(
    candidate
  ) as ReportingSourceManifestV1;
  const manifestBytes = encodeReportingSourceManifestV1(manifest);
  const reference = sourceBatchManifestReferenceV1(`fixture-manifest-${level}`, manifestBytes, level);
  return {
    manifest: ReportingSourceManifestV1Schema.parse(manifest),
    result: {
      ok: true,
      response: completedReportingSourceResponseV1({ request, manifest: reference }),
      manifestBytes,
    },
    objectReader: {
      async read(input) {
        if (
          input.objectRef !== object.objectRef ||
          input.objectGeneration !== object.objectGeneration ||
          canonicalJsonV1(input.sourceScope) !== canonicalJsonV1(request.sourceScope) ||
          input.account.account_id !== request.account.account_id ||
          input.delivery_config_id !== request.delivery_config_id ||
          input.delivery_config_version !== request.delivery_config_version ||
          input.report_definition_id !== request.report_definition_id ||
          input.reporting_obligation_id !== request.reporting_obligation_id ||
          input.maxBytes !== object.byteCount
        ) {
          throw new Error('Fixture object scope mismatch');
        }
        return bytes;
      },
    },
  };
}
