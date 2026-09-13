import { createHash } from 'node:crypto';
import { z } from 'zod';

import { toPublishedJsonSchema } from './json-schema';
import {
  canonicalJsonV1,
  deterministicSourcePublicationIdV1,
  parseVerifiedReportingSourceManifestV1,
  ReportingExternalIdV1Schema,
  ReportingFingerprintV1Schema,
  ReportingSourceManifestV1Schema,
  sourceBatchObjectSetFingerprintV1,
  type ReportingSourceManifestV1,
} from './manifest';
import {
  ReportingSourceCapabilitiesV1Schema,
  ReportingSourceErrorV1Schema,
  ReportingSourceExecutionResponseV1Schema,
  ReportingSourceSliceRequestV1Schema,
  reportingIsoDurationMillisecondsV1,
  type ReportingSourceCapabilitiesV1,
  type ReportingSourceErrorV1,
  type ReportingSourceExecutorResultV1,
  type ReportingSourceExecutorV1,
  type ReportingSourceSliceRequestV1,
  type ReportingSourceStagedObjectReaderV1,
} from './source';

export type ReportingSourceManifestLevelV1 = 'basic' | 'evidenced';
export const REPORTING_CROSS_FINALITY_BRIDGE_VERSION_V1 = 'reporting.cross_finality_bridge.v1' as const;
export const REPORTING_SOURCE_DEFAULT_MAX_OBJECT_BYTES_V1 = 512 * 1_024 * 1_024;
export const REPORTING_SOURCE_DEFAULT_MAX_TOTAL_OBJECT_BYTES_V1 = 2 * 1_024 * 1_024 * 1_024;

export interface ReportingSourceObjectReadLimitsV1 {
  maxObjectBytes?: number;
  maxTotalBytes?: number;
}

export const ReportingCrossFinalityBridgeV1Schema = z.strictObject({
  contractVersion: z.literal(REPORTING_CROSS_FINALITY_BRIDGE_VERSION_V1),
  bridgeId: ReportingExternalIdV1Schema,
  sequenceScopeFingerprint: ReportingFingerprintV1Schema,
  provisionalScopeFingerprint: ReportingFingerprintV1Schema,
  authoritativeScopeFingerprint: ReportingFingerprintV1Schema,
});
export type ReportingCrossFinalityBridgeV1 = z.output<typeof ReportingCrossFinalityBridgeV1Schema>;
export const ReportingCrossFinalityBridgeV1JsonSchema = toPublishedJsonSchema(ReportingCrossFinalityBridgeV1Schema);

export interface ReportingSourceConformanceIssueV1 {
  path: string;
  message: string;
}

export class ReportingSourceConformanceError extends Error {
  readonly issues: readonly ReportingSourceConformanceIssueV1[];

  constructor(
    readonly code:
      | 'CAPABILITY_MISMATCH'
      | 'EXECUTION_FAILED'
      | 'IDENTITY_MISMATCH'
      | 'MANIFEST_MISMATCH'
      | 'OBJECT_MISMATCH'
      | 'REPLAY_MISMATCH'
      | 'REVISION_SEQUENCE_INVALID',
    message: string,
    options?: ErrorOptions & { issues?: readonly ReportingSourceConformanceIssueV1[] }
  ) {
    super(message, options);
    this.name = 'ReportingSourceConformanceError';
    this.issues = options?.issues ?? [];
  }
}

export async function validateReportingSourceExecutionV1(input: {
  level: ReportingSourceManifestLevelV1;
  capabilities: ReportingSourceCapabilitiesV1;
  request: ReportingSourceSliceRequestV1;
  result: ReportingSourceExecutorResultV1;
  objectReader: ReportingSourceStagedObjectReaderV1;
  objectReadLimits?: ReportingSourceObjectReadLimitsV1;
  signal?: AbortSignal;
}): Promise<ReportingSourceManifestV1> {
  const capabilities = ReportingSourceCapabilitiesV1Schema.parse(input.capabilities);
  const request = ReportingSourceSliceRequestV1Schema.parse(structuredClone(input.request));
  validateReportingSourceRequestAgainstCapabilitiesV1(capabilities, request, input.level);
  if (!input.result.ok) {
    const error = ReportingSourceErrorV1Schema.parse(input.result.error);
    throw new ReportingSourceConformanceError(
      'EXECUTION_FAILED',
      `${error.code}: reporting source execution returned a typed failure`
    );
  }
  const response = ReportingSourceExecutionResponseV1Schema.parse(input.result.response);
  if (!sameJson(response.identity, request.identity))
    throw new ReportingSourceConformanceError('IDENTITY_MISMATCH', 'Response must echo the frozen execution identity');
  const manifest = parseVerifiedReportingSourceManifestV1(response.manifest, input.result.manifestBytes, input.level);
  validateManifestAgainstRequest(capabilities, request, manifest, input.level);
  const limits = resolveObjectReadLimits(input.objectReadLimits);
  if (
    manifest.byteCount > limits.maxTotalBytes ||
    manifest.objects.some(object => object.byteCount > limits.maxObjectBytes)
  )
    throw new ReportingSourceConformanceError(
      'OBJECT_MISMATCH',
      'Staged object evidence exceeds the configured conformance read budget'
    );
  const deadline = deadlineBoundSignal(request.deadline.deadlineAt, input.signal);
  try {
    for (const object of manifest.objects) {
      let bytes: Uint8Array;
      try {
        bytes = await awaitConformanceOperation(
          () =>
            input.objectReader.read({
              objectRef: object.objectRef,
              objectGeneration: object.objectGeneration,
              sourceScope: structuredClone(request.sourceScope),
              account: structuredClone(request.account),
              delivery_config_id: request.delivery_config_id,
              delivery_config_version: request.delivery_config_version,
              report_definition_id: request.report_definition_id,
              reporting_obligation_id: request.reporting_obligation_id,
              maxBytes: object.byteCount,
              signal: deadline.signal,
            }),
          deadline.signal
        );
      } catch (error) {
        if (error instanceof ReportingSourceConformanceError) throw error;
        throw new ReportingSourceConformanceError(
          'OBJECT_MISMATCH',
          `Generation-pinned object ${object.ordinal} is not readable`,
          { cause: error }
        );
      }
      if (bytes.byteLength !== object.byteCount || createHash('sha256').update(bytes).digest('hex') !== object.sha256)
        throw new ReportingSourceConformanceError(
          'OBJECT_MISMATCH',
          `Generation-pinned object ${object.ordinal} does not match its digest`
        );
    }
    return manifest;
  } finally {
    deadline.dispose();
  }
}

export async function runReportingSourceReplayConformanceV1(input: {
  level: ReportingSourceManifestLevelV1;
  executor: ReportingSourceExecutorV1;
  request: ReportingSourceSliceRequestV1;
  objectReader: ReportingSourceStagedObjectReaderV1;
  objectReadLimits?: ReportingSourceObjectReadLimitsV1;
  signal?: AbortSignal;
}): Promise<ReportingSourceManifestV1> {
  const request = ReportingSourceSliceRequestV1Schema.parse(structuredClone(input.request));
  const capabilities = ReportingSourceCapabilitiesV1Schema.parse(input.executor.capabilities);
  validateReportingSourceRequestAgainstCapabilitiesV1(capabilities, request, input.level);
  const deadline = deadlineBoundSignal(request.deadline.deadlineAt, input.signal);
  try {
    const [first, second] = await Promise.all([
      executeSuccessfulReplay(input.executor, request, deadline.signal),
      executeSuccessfulReplay(input.executor, request, deadline.signal),
    ]);
    const firstManifest = await awaitConformanceOperation(
      () =>
        validateReportingSourceExecutionV1({
          ...input,
          signal: deadline.signal,
          capabilities,
          request,
          result: first,
        }),
      deadline.signal
    );
    const secondManifest = await awaitConformanceOperation(
      () =>
        validateReportingSourceExecutionV1({
          ...input,
          signal: deadline.signal,
          capabilities,
          request,
          result: second,
        }),
      deadline.signal
    );
    const third = await executeSuccessfulReplay(input.executor, request, deadline.signal);
    const thirdManifest = await awaitConformanceOperation(
      () =>
        validateReportingSourceExecutionV1({
          ...input,
          signal: deadline.signal,
          capabilities,
          request,
          result: third,
        }),
      deadline.signal
    );
    if (
      first.response.manifest.stagedCommitRef !== second.response.manifest.stagedCommitRef ||
      first.response.manifest.stagedCommitRef !== third.response.manifest.stagedCommitRef ||
      first.response.manifest.manifestSha256 !== second.response.manifest.manifestSha256 ||
      first.response.manifest.manifestSha256 !== third.response.manifest.manifestSha256 ||
      !Buffer.from(first.manifestBytes).equals(Buffer.from(second.manifestBytes)) ||
      !Buffer.from(first.manifestBytes).equals(Buffer.from(third.manifestBytes)) ||
      !sameJson(firstManifest, secondManifest) ||
      !sameJson(firstManifest, thirdManifest)
    )
      throw new ReportingSourceConformanceError(
        'REPLAY_MISMATCH',
        'Repeating sourceExecutionKey must return identical bytes and objects'
      );
    return firstManifest;
  } catch (error) {
    deadline.abort(new Error('Reporting replay conformance cancelled outstanding duplicate execution'));
    throw error;
  } finally {
    deadline.dispose();
  }
}

export function validateReportingSourceFailureV1(
  result: ReportingSourceExecutorResultV1,
  expectedCode: ReportingSourceErrorV1['code']
) {
  if (result.ok)
    throw new ReportingSourceConformanceError('EXECUTION_FAILED', 'Failure must not publish a completed manifest');
  const error = ReportingSourceErrorV1Schema.parse(result.error);
  if (error.code !== expectedCode)
    throw new ReportingSourceConformanceError('EXECUTION_FAILED', `Expected ${expectedCode}, received ${error.code}`);
  return error;
}

export function validateReportingRevisionSequenceV1(
  manifests: readonly ReportingSourceManifestV1[],
  options: Readonly<{ crossFinalityBridge?: ReportingCrossFinalityBridgeV1 }> = {}
) {
  if (!manifests.length) return [];
  const parsed = manifests.map(item => ReportingSourceManifestV1Schema.parse(item));
  if (
    new Set(parsed.map(item => item.publication.publicationId)).size !== parsed.length ||
    new Set(parsed.map(item => item.identity.sourceExecutionKey)).size !== parsed.length
  )
    throw new ReportingSourceConformanceError(
      'REVISION_SEQUENCE_INVALID',
      'Every retained observation revision requires distinct execution and publication identities'
    );
  const first = parsed[0]!;
  const firstSequence = sequenceScope(first);
  for (const manifest of parsed)
    if (!sameJson(sequenceScope(manifest), firstSequence))
      throw new ReportingSourceConformanceError(
        'REVISION_SEQUENCE_INVALID',
        'Revisions must retain sourceScope, AdCP identities, and source calendar window'
      );
  const firstSnapshot = parsed.find(item => item.finality.revisionKind === 'snapshot');
  const firstOfficial = parsed.find(item => item.finality.revisionKind !== 'snapshot');
  if (firstSnapshot && firstOfficial) {
    const bridge = options.crossFinalityBridge
      ? ReportingCrossFinalityBridgeV1Schema.parse(options.crossFinalityBridge)
      : undefined;
    if (
      !bridge ||
      bridge.sequenceScopeFingerprint !== reportingRevisionSequenceScopeFingerprintV1(firstSnapshot) ||
      bridge.provisionalScopeFingerprint !== reportingRevisionSemanticScopeFingerprintV1(firstSnapshot) ||
      bridge.authoritativeScopeFingerprint !== reportingRevisionSemanticScopeFingerprintV1(firstOfficial)
    )
      throw new ReportingSourceConformanceError(
        'REVISION_SEQUENCE_INVALID',
        'Snapshot to official transition requires an exact cross-finality bridge'
      );
  }
  let snapshot: ReportingSourceManifestV1 | undefined;
  let official: ReportingSourceManifestV1 | undefined;
  for (const manifest of parsed) {
    if (manifest.finality.revisionKind === 'snapshot') {
      if (official)
        throw new ReportingSourceConformanceError(
          'REVISION_SEQUENCE_INVALID',
          'Snapshot cannot follow official publication'
        );
      if (snapshot) {
        assertSameSemanticScope(snapshot, manifest);
        assertFreshness(snapshot, manifest);
        assertGranularFreshness(snapshot, manifest);
      }
      snapshot = manifest;
      continue;
    }
    if (manifest.finality.revisionKind === 'authoritative') {
      if (official)
        throw new ReportingSourceConformanceError(
          'REVISION_SEQUENCE_INVALID',
          'Only one initial authoritative publication is allowed'
        );
      if (snapshot) {
        assertFreshness(snapshot, manifest);
        assertGranularFreshness(snapshot, manifest, true);
      }
      official = manifest;
      continue;
    }
    if (!official)
      throw new ReportingSourceConformanceError(
        'REVISION_SEQUENCE_INVALID',
        'Correction requires an authoritative predecessor'
      );
    assertFreshness(official, manifest);
    assertGranularFreshness(official, manifest);
    if (
      manifest.finality.supersedesPublicationId !== official.publication.publicationId ||
      manifest.publication.namespace !== official.publication.namespace ||
      !sameJson(semanticScope(manifest), semanticScope(official))
    )
      throw new ReportingSourceConformanceError(
        'REVISION_SEQUENCE_INVALID',
        'Correction must retain and supersede its exact authoritative scope'
      );
    official = manifest;
  }
  return parsed;
}

export function reportingRevisionSequenceScopeFingerprintV1(manifest: ReportingSourceManifestV1): string {
  return fingerprint(sequenceScope(ReportingSourceManifestV1Schema.parse(manifest)));
}
export function reportingRevisionSemanticScopeFingerprintV1(manifest: ReportingSourceManifestV1): string {
  return fingerprint(semanticScope(ReportingSourceManifestV1Schema.parse(manifest)));
}
export function createReportingCrossFinalityBridgeV1(input: {
  bridgeId: string;
  provisional: ReportingSourceManifestV1;
  authoritative: ReportingSourceManifestV1;
}): ReportingCrossFinalityBridgeV1 {
  const provisional = ReportingSourceManifestV1Schema.parse(input.provisional);
  const authoritative = ReportingSourceManifestV1Schema.parse(input.authoritative);
  if (
    provisional.finality.revisionKind !== 'snapshot' ||
    authoritative.finality.revisionKind !== 'authoritative' ||
    reportingRevisionSequenceScopeFingerprintV1(provisional) !==
      reportingRevisionSequenceScopeFingerprintV1(authoritative)
  )
    throw new ReportingSourceConformanceError(
      'REVISION_SEQUENCE_INVALID',
      'Bridge roles and sequence scope must match'
    );
  return ReportingCrossFinalityBridgeV1Schema.parse({
    contractVersion: REPORTING_CROSS_FINALITY_BRIDGE_VERSION_V1,
    bridgeId: input.bridgeId,
    sequenceScopeFingerprint: reportingRevisionSequenceScopeFingerprintV1(provisional),
    provisionalScopeFingerprint: reportingRevisionSemanticScopeFingerprintV1(provisional),
    authoritativeScopeFingerprint: reportingRevisionSemanticScopeFingerprintV1(authoritative),
  });
}

export function isUnchangedProvisionalSnapshotV1(
  previous: ReportingSourceManifestV1,
  candidate: ReportingSourceManifestV1
) {
  return (
    previous.finality.revisionKind === 'snapshot' &&
    candidate.finality.revisionKind === 'snapshot' &&
    reportingRevisionSequenceScopeFingerprintV1(previous) === reportingRevisionSequenceScopeFingerprintV1(candidate) &&
    reportingRevisionSemanticScopeFingerprintV1(previous) === reportingRevisionSemanticScopeFingerprintV1(candidate) &&
    previous.publication.contentFingerprint === candidate.publication.contentFingerprint
  );
}

export function validateReportingSourceRequestAgainstCapabilitiesV1(
  capabilities: ReportingSourceCapabilitiesV1,
  request: ReportingSourceSliceRequestV1,
  level: ReportingSourceManifestLevelV1
) {
  const offering = capabilities.offerings.find(item => item.offeringId === request.offeringId);
  const issues: ReportingSourceConformanceIssueV1[] = [];
  if (!offering) issues.push({ path: 'offeringId', message: 'Offering is absent from capabilities' });
  if (offering) {
    addMismatch(issues, !offering.sourceExecution.manifestLevels.includes(level), 'manifestLevel');
    addMismatch(issues, !offering.sourceExecution.supportsCancellation, 'sourceExecution.supportsCancellation');
    addMismatch(issues, offering.publicationNamespace !== request.publicationNamespace, 'publicationNamespace');
    addMismatch(issues, offering.publicationClass !== request.publicationClass, 'publicationClass');
    addMismatch(issues, !sameJson(offering.adapterBuild, request.adapterBuild), 'adapterBuild');
    addMismatch(issues, !sameJson(offering.contract, request.contract), 'contract');
    addMismatch(issues, offering.grain !== request.period.grain, 'period.grain');
    addMismatch(issues, !sameJson(offering.windowing, request.period.windowing), 'period.windowing');
    addMismatch(
      issues,
      offering.sourceTimezone.ianaTimezone !== undefined &&
        offering.sourceTimezone.ianaTimezone !== request.period.sourceTimezone,
      'period.sourceTimezone'
    );
  }
  if (!offering || issues.length)
    throw new ReportingSourceConformanceError(
      'CAPABILITY_MISMATCH',
      `Request is not an exact atomic offering: ${issues.map(issue => issue.path).join(', ')}`,
      { issues }
    );
  const elapsed = Date.parse(request.period.end) - Date.parse(request.period.start);
  if (
    elapsedMillisecondsForDurationComparison(
      request.period.start,
      request.period.end,
      request.period.sourceTimezone,
      offering.windowing.minimumWindow
    ) < reportingIsoDurationMillisecondsV1(offering.windowing.minimumWindow) ||
    elapsedMillisecondsForDurationComparison(
      request.period.start,
      request.period.end,
      request.period.sourceTimezone,
      offering.windowing.maximumWindow
    ) > reportingIsoDurationMillisecondsV1(offering.windowing.maximumWindow) ||
    sourceCalendarWallClockElapsedMs(request.period.start, request.period.end, request.period.sourceTimezone) >
      offering.sourceExecution.maximumWindowDaysPerRequest * 24 * 3_600_000 ||
    elapsed <= 0
  )
    throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', 'Requested window exceeds offering bounds');
  for (const constituent of request.coverage.constituents)
    if (
      !offering.applicability.productIds.includes(constituent.productId) ||
      !offering.applicability.constituentKinds.includes(constituent.constituentKind)
    )
      throw new ReportingSourceConformanceError(
        'CAPABILITY_MISMATCH',
        'Coverage constituent is outside offering applicability'
      );
  for (const metric of request.requestedMetrics)
    if (!offering.metrics.some(item => item.name === metric && item.support === 'exact'))
      throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', `Metric ${metric} is not exact`);
  for (const dimension of request.requestedDimensions)
    if (!offering.dimensions.some(item => item.name === dimension && item.support === 'exact'))
      throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', `Dimension ${dimension} is not exact`);
  if (
    !offering.sourceSettings.attributionModels.includes(request.sourceSettings.attributionModel) ||
    !offering.sourceSettings.attributionWindows.includes(request.sourceSettings.attributionWindow)
  )
    throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', 'Attribution settings are outside offering');
  if (
    request.finality.revisionKind === 'correction' &&
    (offering.publicationClass !== 'AUTHORITATIVE' || offering.finalization.correctionPolicy !== 'immutable_correction')
  )
    throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', 'Offering does not support corrections');
  const triggerSupport =
    offering.publicationClass === 'PROVISIONAL_SNAPSHOT'
      ? offering.cadence.triggerSupport
      : offering.finalization.triggerSupport;
  if (request.trigger.kind === 'webhook_hint' && !triggerSupport.upstreamReadinessOrChangeWebhook)
    throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', 'Offering does not support source webhook hints');
}

function validateManifestAgainstRequest(
  capabilities: ReportingSourceCapabilitiesV1,
  request: ReportingSourceSliceRequestV1,
  manifest: ReportingSourceManifestV1,
  level: ReportingSourceManifestLevelV1
) {
  const offering = capabilities.offerings.find(item => item.offeringId === request.offeringId)!;
  const expectedPublicationId = deterministicSourcePublicationIdV1({
    sourceExecutionKey: request.identity.sourceExecutionKey,
    logicalSliceFingerprint: request.identity.logicalSliceFingerprint,
    publicationClass: request.publicationClass,
    revisionKind: request.finality.revisionKind,
    supersedesPublicationId: request.finality.supersedesPublicationId,
  });
  const manifestConstituents = manifest.coverage.constituents.map(stripAvailability).sort(byConstituent);
  const requestConstituents = request.coverage.constituents.map(item => ({ ...item })).sort(byConstituent);
  const metricByName = new Map(offering.metrics.map(item => [item.name, item]));
  const metricCells = new Map(manifest.metricAvailability.map(item => [`${item.constituentId}\0${item.metric}`, item]));
  const metricMismatch =
    metricCells.size !== request.coverage.constituents.length * request.requestedMetrics.length ||
    request.coverage.constituents.some(constituent =>
      request.requestedMetrics.some(metric => {
        const item = metricCells.get(`${constituent.constituentId}\0${metric}`);
        const declared = metricByName.get(metric);
        return (
          !item ||
          !declared ||
          declared.semanticContractId !== item.semanticContractId ||
          declared.semanticContractVersion !== item.semanticContractVersion ||
          declared.semanticContractSha256 !== item.semanticContractSha256
        );
      })
    );
  const issues: ReportingSourceConformanceIssueV1[] = [];
  addMismatch(issues, manifest.level !== level, 'level');
  addMismatch(issues, !sameJson(manifest.identity, request.identity), 'identity');
  addMismatch(issues, !sameJson(manifest.sourceScope, request.sourceScope), 'sourceScope');
  addMismatch(issues, !sameJson(manifest.account, request.account), 'account');
  addMismatch(issues, manifest.delivery_config_id !== request.delivery_config_id, 'delivery_config_id');
  addMismatch(issues, manifest.delivery_config_version !== request.delivery_config_version, 'delivery_config_version');
  addMismatch(issues, manifest.report_definition_id !== request.report_definition_id, 'report_definition_id');
  addMismatch(issues, manifest.reporting_obligation_id !== request.reporting_obligation_id, 'reporting_obligation_id');
  addMismatch(issues, manifest.publication.publicationId !== expectedPublicationId, 'publication.publicationId');
  addMismatch(issues, manifest.publication.namespace !== request.publicationNamespace, 'publication.namespace');
  addMismatch(
    issues,
    manifest.publication.publicationClass !== request.publicationClass,
    'publication.publicationClass'
  );
  addMismatch(issues, !sameJson(manifest.adapterBuild, request.adapterBuild), 'adapterBuild');
  addMismatch(issues, manifest.offeringId !== request.offeringId, 'offeringId');
  addMismatch(issues, !sameJson(manifest.requestedDimensions, request.requestedDimensions), 'requestedDimensions');
  addMismatch(issues, !sameJson(manifest.contract, request.contract), 'contract');
  addMismatch(issues, !samePeriod(manifest.period, request.period), 'period');
  addMismatch(issues, manifest.finality.revisionKind !== request.finality.revisionKind, 'finality.revisionKind');
  addMismatch(
    issues,
    manifest.finality.supersedesPublicationId !== request.finality.supersedesPublicationId,
    'finality.supersedesPublicationId'
  );
  addMismatch(issues, !sameJson(manifest.sourceSettings, request.sourceSettings), 'sourceSettings');
  addMismatch(
    issues,
    manifest.coverage.denominatorFingerprint !== request.coverage.denominatorFingerprint,
    'coverage.denominatorFingerprint'
  );
  addMismatch(issues, !sameJson(manifestConstituents, requestConstituents), 'coverage.constituents');
  addMismatch(
    issues,
    metricMismatch,
    'metricAvailability',
    'Every requested constituent-metric cell must match the offering semantics'
  );
  addMismatch(
    issues,
    sourceBatchObjectSetFingerprintV1(manifest.objects) !== manifest.objectSetSha256,
    'objectSetSha256'
  );
  if (issues.length)
    throw new ReportingSourceConformanceError(
      'MANIFEST_MISMATCH',
      `Manifest does not bind the frozen request: ${issues.map(issue => issue.path).join(', ')}`,
      { issues }
    );
  if (request.coverage.expected === 'full' && manifest.coverage.status !== 'full')
    throw new ReportingSourceConformanceError(
      'MANIFEST_MISMATCH',
      'Full coverage must fail closed with PARTIAL_RESULT'
    );
  const declaredFormats = new Set(offering.formats.map(format => `${format.mediaType}\0${format.compression}`));
  if (manifest.objects.some(object => !declaredFormats.has(`${object.mediaType}\0${object.compression}`)))
    throw new ReportingSourceConformanceError(
      'CAPABILITY_MISMATCH',
      'Every staged object format must be declared by the offering'
    );
  if (level === 'evidenced' && manifest.level === 'evidenced') {
    if (!sameJson([...manifest.completeness.requestedGroups].sort(), [...request.sourceRequest.groupIds].sort()))
      throw new ReportingSourceConformanceError('MANIFEST_MISMATCH', 'Requested source groups do not match');
    if (manifest.completeness.providerPagination.kind !== offering.sourceExecution.pagination)
      throw new ReportingSourceConformanceError('MANIFEST_MISMATCH', 'Pagination evidence does not match offering');
    if (
      (offering.sourceExecution.asyncJobs === 'required' && manifest.completeness.sourceJob.mode === 'not_used') ||
      (offering.sourceExecution.asyncJobs === 'unsupported' && manifest.completeness.sourceJob.mode !== 'not_used')
    )
      throw new ReportingSourceConformanceError('CAPABILITY_MISMATCH', 'Job evidence does not match offering');
    if (
      manifest.completeness.providerPagination.kind === 'cursor' &&
      manifest.completeness.providerPagination.pages[0]?.requestCursor !== request.priorCheckpoint?.cursor
    )
      throw new ReportingSourceConformanceError(
        'MANIFEST_MISMATCH',
        'Cursor pagination must begin at the frozen checkpoint'
      );
    if (!sameJson(manifest.priorCheckpoint, request.priorCheckpoint))
      throw new ReportingSourceConformanceError(
        'MANIFEST_MISMATCH',
        'Prior checkpoint evidence must echo the frozen request'
      );
  }
}

function sequenceScope(manifest: ReportingSourceManifestV1) {
  return {
    logicalSliceFingerprint: manifest.identity.logicalSliceFingerprint,
    sourceScope: manifest.sourceScope,
    account: manifest.account,
    delivery_config_id: manifest.delivery_config_id,
    delivery_config_version: manifest.delivery_config_version,
    report_definition_id: manifest.report_definition_id,
    reporting_obligation_id: manifest.reporting_obligation_id,
    period: {
      periodKey: manifest.period.periodKey,
      sourceLocalDate: manifest.period.sourceLocalDate,
      start: manifest.period.start,
      end: manifest.period.end,
      sourceTimezone: manifest.period.sourceTimezone,
    },
  };
}
function semanticScope(manifest: ReportingSourceManifestV1) {
  return {
    offeringId: manifest.offeringId,
    namespace: manifest.publication.namespace,
    denominatorFingerprint: manifest.coverage.denominatorFingerprint,
    constituents: manifest.coverage.constituents.map(stripAvailability).sort(byConstituent),
    metrics: manifest.metricAvailability
      .map(({ constituentId, metric, semanticContractId, semanticContractVersion, semanticContractSha256 }) => ({
        constituentId,
        metric,
        semanticContractId,
        semanticContractVersion,
        semanticContractSha256,
      }))
      .sort((a, b) => (`${a.constituentId}\0${a.metric}` < `${b.constituentId}\0${b.metric}` ? -1 : 1)),
    requestedDimensions: [...manifest.requestedDimensions].sort(),
    contract: manifest.contract,
    sourceSettings: manifest.sourceSettings,
    grain: manifest.period.grain,
    windowing: manifest.period.windowing,
  };
}
function assertSameSemanticScope(left: ReportingSourceManifestV1, right: ReportingSourceManifestV1) {
  if (!sameJson(semanticScope(left), semanticScope(right)))
    throw new ReportingSourceConformanceError('REVISION_SEQUENCE_INVALID', 'Replacement must retain semantic scope');
}
function assertFreshness(left: ReportingSourceManifestV1, right: ReportingSourceManifestV1) {
  if (
    Date.parse(right.period.observedAt) < Date.parse(left.period.observedAt) ||
    Date.parse(right.acquiredAt) < Date.parse(left.acquiredAt) ||
    Date.parse(right.period.sourceReadCutoffAt) < Date.parse(left.period.sourceReadCutoffAt) ||
    Date.parse(right.period.dataThrough) < Date.parse(left.period.dataThrough)
  )
    throw new ReportingSourceConformanceError('REVISION_SEQUENCE_INVALID', 'Revision freshness must not regress');
}
function assertGranularFreshness(
  left: ReportingSourceManifestV1,
  right: ReportingSourceManifestV1,
  sharedOnly = false
) {
  const constituents = new Map(right.coverage.constituents.map(item => [item.constituentId, item]));
  const shared = new Set<string>();
  for (const prior of left.coverage.constituents) {
    const next = constituents.get(prior.constituentId);
    if (sharedOnly && (!next || !sameJson(stripAvailability(prior), stripAvailability(next)))) continue;
    shared.add(prior.constituentId);
    if (
      !next ||
      (available(prior.status) && !available(next.status)) ||
      (prior.dataThrough && (!next.dataThrough || Date.parse(next.dataThrough) < Date.parse(prior.dataThrough)))
    )
      throw new ReportingSourceConformanceError(
        'REVISION_SEQUENCE_INVALID',
        'Constituent availability or freshness regressed'
      );
  }
  const metrics = new Map(right.metricAvailability.map(item => [`${item.constituentId}\0${item.metric}`, item]));
  for (const prior of left.metricAvailability) {
    if (sharedOnly && !shared.has(prior.constituentId)) continue;
    const next = metrics.get(`${prior.constituentId}\0${prior.metric}`);
    if (
      sharedOnly &&
      next &&
      (next.semanticContractId !== prior.semanticContractId ||
        next.semanticContractVersion !== prior.semanticContractVersion ||
        next.semanticContractSha256 !== prior.semanticContractSha256)
    )
      continue;
    if (
      !next ||
      (available(prior.status) && !available(next.status)) ||
      (prior.dataThrough && (!next.dataThrough || Date.parse(next.dataThrough) < Date.parse(prior.dataThrough)))
    )
      throw new ReportingSourceConformanceError(
        'REVISION_SEQUENCE_INVALID',
        'Metric availability or freshness regressed'
      );
  }
}
function stripAvailability({ status: _status, dataThrough: _dataThrough, reason: _reason, ...identity }: any) {
  return identity;
}
function byConstituent(left: any, right: any) {
  return left.constituentId < right.constituentId ? -1 : left.constituentId > right.constituentId ? 1 : 0;
}
function elapsedMillisecondsForDurationComparison(start: string, end: string, timezone: string, duration: string) {
  const calendarDays = Number(/^P(?:(\d+)D)?/.exec(duration)?.[1] ?? 0);
  return calendarDays > 0
    ? sourceCalendarWallClockElapsedMs(start, end, timezone)
    : Date.parse(end) - Date.parse(start);
}
function sourceCalendarWallClockElapsedMs(start: string, end: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  });
  const localEpoch = (instant: string) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      Number(parts.fractionalSecond)
    );
  };
  return localEpoch(end) - localEpoch(start);
}
function available(status: string) {
  return status === 'present' || status === 'explicit_zero';
}
function samePeriod(left: any, right: any) {
  const { observedAt: _observed, dataThrough: _through, ...identity } = left;
  return sameJson(identity, right);
}
function sameJson(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right;
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}
function fingerprint(value: unknown) {
  return `sha256:${createHash('sha256').update(canonicalJsonV1(value)).digest('hex')}`;
}
function interrupted() {
  return new ReportingSourceConformanceError('EXECUTION_FAILED', 'Reporting source conformance was cancelled');
}
function addMismatch(
  issues: ReportingSourceConformanceIssueV1[],
  mismatched: boolean,
  path: string,
  message = 'Value does not match the frozen request or offering'
) {
  if (mismatched) issues.push({ path, message });
}

function resolveObjectReadLimits(input?: ReportingSourceObjectReadLimitsV1) {
  const maxObjectBytes = input?.maxObjectBytes ?? REPORTING_SOURCE_DEFAULT_MAX_OBJECT_BYTES_V1;
  const maxTotalBytes = input?.maxTotalBytes ?? REPORTING_SOURCE_DEFAULT_MAX_TOTAL_OBJECT_BYTES_V1;
  if (
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes < 1 ||
    !Number.isSafeInteger(maxTotalBytes) ||
    maxTotalBytes < maxObjectBytes
  )
    throw new TypeError('Reporting source object read limits must be positive safe integers');
  return { maxObjectBytes, maxTotalBytes };
}

function deadlineBoundSignal(deadlineAt: string, parent?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = () => controller.abort(parent?.reason);
  const arm = () => {
    const remaining = Date.parse(deadlineAt) - Date.now();
    if (remaining <= 0) {
      controller.abort(new Error('Reporting source request deadline elapsed'));
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  if (!controller.signal.aborted) arm();
  return {
    signal: controller.signal,
    abort(reason?: unknown) {
      controller.abort(reason);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function awaitConformanceOperation<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(interrupted());
  const operationPromise = Promise.resolve().then(() => {
    if (signal.aborted) throw interrupted();
    return operation();
  });
  return new Promise<T>((resolve, reject) => {
    let completed = false;
    const finish = (settle: () => void) => {
      if (completed) return;
      completed = true;
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(interrupted()));
    signal.addEventListener('abort', onAbort, { once: true });
    // Continue observing owned work after cancellation. This keeps a late
    // rejection handled while the harness reports detached work as failure.
    void operationPromise.then(
      value => finish(() => (signal.aborted ? reject(interrupted()) : resolve(value))),
      error => finish(() => (signal.aborted ? reject(interrupted()) : reject(error)))
    );
  });
}

async function executeForConformance(
  executor: ReportingSourceExecutorV1,
  request: ReportingSourceSliceRequestV1,
  signal: AbortSignal
) {
  try {
    const isolatedRequest = ReportingSourceSliceRequestV1Schema.parse(structuredClone(request));
    return await awaitConformanceOperation(
      () => executor.execute(isolatedRequest, { signal, heartbeat: () => undefined }),
      signal
    );
  } catch (error) {
    if (error instanceof ReportingSourceConformanceError) throw error;
    throw new ReportingSourceConformanceError(
      'EXECUTION_FAILED',
      'Reporting source executor failed without a typed source error',
      { cause: error }
    );
  }
}

async function executeSuccessfulReplay(
  executor: ReportingSourceExecutorV1,
  request: ReportingSourceSliceRequestV1,
  signal: AbortSignal
): Promise<Extract<ReportingSourceExecutorResultV1, { ok: true }>> {
  const result = await executeForConformance(executor, request, signal);
  if (!result.ok) {
    const error = ReportingSourceErrorV1Schema.parse(result.error);
    throw new ReportingSourceConformanceError(
      'EXECUTION_FAILED',
      `${error.code}: reporting source replay returned a typed failure`
    );
  }
  return result;
}
