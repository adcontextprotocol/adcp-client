/**
 * Minimal ledger fixture for row-storage tests: one configuration, one
 * leased obligation, and a revision builder that binds rows correctly.
 */
const { createHash } = require('node:crypto');

async function createRowStorageFixture({ store, now = Date.now(), suffix = 'rows', leaseMilliseconds = 600_000 }) {
  const source = require('../../dist/lib/reporting/source/index.js');
  const { canonicalize } = require('../../dist/lib/utils/jcs.js');
  const request = source.redactedReportingSourceRequestV1();
  const configuration = {
    configurationId: `rcfg_${suffix}`,
    account: request.account,
    sourceScope: request.sourceScope,
    delivery_config_id: `${request.delivery_config_id}_${suffix}`,
    delivery_config_version: request.delivery_config_version,
    offeringId: request.offeringId,
    report_definition_id: request.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    constituents: request.coverage.constituents,
    mediaBuyIds: request.coverage.mediaBuyIds,
    sourceTimezone: 'UTC',
    schedule: {
      anchor: new Date(now - 3_600_000).toISOString(),
      periodMilliseconds: 3_600_000,
      deliverySlaMilliseconds: 0,
      recoveryWindowMilliseconds: 3_600_000,
    },
    sourceSettings: request.sourceSettings,
    contract: request.contract,
    installedAt: new Date(now - 3_600_000).toISOString(),
    semanticFingerprint: `sha256:configuration-${suffix}`,
  };
  await store.putConfiguration(configuration);
  const obligation = {
    reporting_obligation_id: `robl_${suffix}`,
    configurationId: configuration.configurationId,
    account: request.account,
    sourceScope: request.sourceScope,
    delivery_config_id: configuration.delivery_config_id,
    delivery_config_version: request.delivery_config_version,
    offeringId: request.offeringId,
    report_definition_id: request.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    periodOrdinal: 0,
    period: {
      start: new Date(now - 3_600_000).toISOString(),
      end: new Date(now - 1_000).toISOString(),
      sourceTimezone: 'UTC',
    },
    schedule: configuration.schedule,
    scopeResolvedAt: new Date(now - 1_000).toISOString(),
    coverage: {
      status: 'full',
      evaluatedAt: new Date(now - 1_000).toISOString(),
      mediaBuyIds: request.coverage.mediaBuyIds,
      fullyCoveredMediaBuyIds: request.coverage.mediaBuyIds,
      partiallyCoveredMediaBuyIds: [],
      unsupportedMediaBuyIds: [],
      unknownMediaBuyIds: [],
    },
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    constituents: request.coverage.constituents,
    mediaBuyIds: request.coverage.mediaBuyIds,
    sourceSettings: request.sourceSettings,
    contract: request.contract,
    expectedAt: new Date(now - 1_000).toISOString(),
    recoveryDeadlineAt: new Date(now + 3_600_000).toISOString(),
    publicationOffsets: [],
    nextAttemptAt: new Date(now - 1_000).toISOString(),
    attemptCount: 0,
    state: 'pending',
    semanticFingerprint: `sha256:obligation-${suffix}`,
    createdAt: new Date(now).toISOString(),
  };
  await store.putObligation(obligation);
  const lease = await store.claimObligation({
    owner: `worker-${suffix}`,
    now: new Date(now).toISOString(),
    leaseMilliseconds,
  });
  if (!lease || lease.obligation.reporting_obligation_id !== obligation.reporting_obligation_id) {
    throw new Error('fixture obligation was not leased');
  }

  function revision(id, revisionNumber, rows, extra = {}) {
    const bytes = Buffer.from(
      canonicalize({ reporting_revision_id: id, row_count: rows.length, control_totals: [], reporting_rows: rows })
    );
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      reporting_revision_id: id,
      reporting_obligation_id: obligation.reporting_obligation_id,
      revisionNumber,
      finality: 'snapshot',
      kind: 'snapshot',
      manifest: { level: 'basic', objectRef: 'manifest', sha256: 'a'.repeat(64), byteCount: 1 },
      sourcePublicationId: `publication-${id}`,
      binding: { algorithm: 'rfc8785_jcs_v1', sha256, byteCount: bytes.byteLength, rowCount: rows.length },
      rows,
      observedAt: new Date(now + revisionNumber).toISOString(),
      dataThrough: new Date(now - 1_000).toISOString(),
      sourceReadCutoffAt: new Date(now + revisionNumber).toISOString(),
      createdAt: new Date(now).toISOString(),
      wireRevision: {
        reporting_revision_id: id,
        revision_content_sha256: sha256,
        control_totals: [],
        period: { start: obligation.period.start, end: obligation.period.end, source_timezone: 'UTC' },
      },
      ...extra,
    };
  }

  return { request, configuration, obligation, lease, revision };
}

module.exports = { createRowStorageFixture };
