import {
  BasicSourceBatchManifestV1Schema,
  deterministicSourcePublicationIdV1,
  encodeReportingSourceManifestV1,
  REPORTING_SOURCE_CONTRACT_VERSION_V1,
  sourceBatchCoverageFingerprintV1,
  sourceBatchManifestReferenceV1,
  sourceBatchObjectSetFingerprintV1,
  sourceBatchPublicationContentFingerprintV1,
  SourceBatchManifestV1Schema,
  type BasicSourceBatchManifestV1,
  type ReportingSourceManifestV1,
  type SourceBatchManifestReferenceV1,
  type SourceBatchManifestV1,
  type SourceBatchObjectV1,
} from './manifest';
import type { ReportingSourceSliceRequestV1 } from './source';

type ManifestEvidenceFields = {
  request: ReportingSourceSliceRequestV1;
  stagedCommitRef: string;
  objects: readonly SourceBatchObjectV1[];
  controlTotals?: ReportingSourceManifestV1['controlTotals'];
  metricAvailability: ReportingSourceManifestV1['metricAvailability'];
  coverage: Pick<ReportingSourceManifestV1['coverage'], 'status' | 'constituents'>;
  observedAt: string;
  dataThrough: string;
  finalityEvidence: ReportingSourceManifestV1['finality']['evidence'];
  acquiredAt: string;
  explicitZero: boolean;
  eventTimeRange?: ReportingSourceManifestV1['eventTimeRange'];
  warnings?: readonly string[];
};

export type BuildReportingSourceManifestV1Input = ManifestEvidenceFields &
  (
    | {
        level: 'basic';
        completeness: BasicSourceBatchManifestV1['completeness'];
      }
    | {
        level: 'evidenced';
        completeness: SourceBatchManifestV1['completeness'];
        providerUsage: SourceBatchManifestV1['providerUsage'];
        priorCheckpoint?: SourceBatchManifestV1['priorCheckpoint'];
      }
  );

export type BuiltReportingSourceManifestV1 = {
  manifest: ReportingSourceManifestV1;
  manifestBytes: Uint8Array;
  reference: SourceBatchManifestReferenceV1;
};

/**
 * Builds and seals a manifest while deriving every order-sensitive digest.
 * The returned bytes and reference are ready for a completed executor result.
 */
export function buildReportingSourceManifestV1(
  input: BuildReportingSourceManifestV1Input
): BuiltReportingSourceManifestV1 {
  const objects = [...input.objects];
  const request = input.request;
  const candidate = {
    manifestVersion: REPORTING_SOURCE_CONTRACT_VERSION_V1,
    level: input.level,
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
        supersedesPublicationId: request.finality.supersedesPublicationId,
      }),
      publicationClass: request.publicationClass,
      contentFingerprint: `sha256:${'0'.repeat(64)}`,
    },
    adapterBuild: request.adapterBuild,
    offeringId: request.offeringId,
    requestedDimensions: request.requestedDimensions,
    period: {
      ...request.period,
      observedAt: input.observedAt,
      dataThrough: input.dataThrough,
    },
    finality: {
      ...request.finality,
      evidence: input.finalityEvidence,
    },
    contract: request.contract,
    sourceSettings: request.sourceSettings,
    objects,
    objectCount: objects.length,
    byteCount: objects.reduce((sum, object) => sum + object.byteCount, 0),
    rowCount: objects.reduce((sum, object) => sum + object.rowCount, 0),
    objectSetSha256: sourceBatchObjectSetFingerprintV1(objects),
    controlTotals: input.controlTotals ?? [],
    metricAvailability: input.metricAvailability,
    coverage: {
      status: input.coverage.status,
      constituents: input.coverage.constituents,
      denominatorFingerprint: request.coverage.denominatorFingerprint,
      coverageFingerprint: sourceBatchCoverageFingerprintV1(input.coverage.constituents),
    },
    explicitZero: input.explicitZero,
    acquiredAt: input.acquiredAt,
    ...(input.eventTimeRange ? { eventTimeRange: input.eventTimeRange } : {}),
    warnings: [...(input.warnings ?? [])],
    completeness: input.completeness,
    ...(input.level === 'evidenced'
      ? {
          providerUsage: input.providerUsage,
          ...(input.priorCheckpoint ? { priorCheckpoint: input.priorCheckpoint } : {}),
        }
      : {}),
  };
  candidate.publication.contentFingerprint = sourceBatchPublicationContentFingerprintV1(candidate);
  const manifest = (input.level === 'basic' ? BasicSourceBatchManifestV1Schema : SourceBatchManifestV1Schema).parse(
    candidate
  ) as ReportingSourceManifestV1;
  const manifestBytes = encodeReportingSourceManifestV1(manifest);
  return {
    manifest,
    manifestBytes,
    reference: sourceBatchManifestReferenceV1(input.stagedCommitRef, manifestBytes, input.level),
  };
}
