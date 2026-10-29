// Deterministic Reliable Reporting transcript for a service without reporting subscriptions:
// install, one cycle (plan, execute, commit), get_reporting_status summary and periods,
// sync_reporting_status, get_media_buy_delivery, and the ledger records behind them. The golden
// output was captured from the service before subscription obligations were written into the
// ledger (test/fixtures/reporting-subscriptions/ledger-option-off-golden.json). Wall-clock values
// the ledger stamps with the real time (install and creation instants) are replaced by a marker.
const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { MemoryLedgerStore } = require('./memory-reporting-ledger-store.js');

const DAY = 86_400_000;
const ANCHOR = '2026-09-01T00:00:00.000Z';
const WALL_CLOCK_KEYS = new Set(['installedAt', 'createdAt', 'created_at', 'recorded_at']);

function deliveryOffering() {
  const source = redactedReportingSourceOfferingV1;
  return {
    offering_id: source.offeringId,
    feed_purpose: 'analytics',
    report_definition_id: source.contract.report_definition_id,
    report_definition_uri: source.contract.reportDefinitionUri,
    report_definition_sha256: source.contract.reportDefinitionSha256,
    reporting_profile: {
      id: source.contract.reportingProfile,
      version: source.contract.schemaVersion,
      schema_uri: source.contract.schemaUri,
      schema_sha256: source.contract.schemaSha256,
      schema_dialect: source.contract.schemaDialect,
      schema_ref_policy: source.contract.schemaRefPolicy,
      grain: source.grain,
      primary_keys: ['media_buy_id'],
    },
    schedule: {
      period_duration: 'P1D',
      alignment: 'source_timezone',
      period_timezone_policy: 'fixed',
      period_timezone: 'UTC',
      delivery_sla: 'PT0S',
    },
    supported_finality: ['snapshot'],
    reconciliation_mode: 'delivery_only',
  };
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, WALL_CLOCK_KEYS.has(key) ? '<wall-clock>' : normalize(item)])
    );
  }
  return value;
}

async function reportingLedgerOptionOffTranscript() {
  const store = new MemoryLedgerStore();
  const request = redactedReportingSourceRequestV1();
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  const [template] = request.coverage.constituents;
  const service = createReliableReportingService({
    store,
    adapters: {
      fixture: {
        sourceOffering,
        deliveryOffering: deliveryOffering(),
        fetchSlice: slice => ({
          reporting_period: { start: slice.start_date, end: slice.end_date },
          currency: 'USD',
          reporting_rows: slice.media_buy_ids.map(mediaBuyId => ({
            media_buy_id: mediaBuyId,
            impressions: 7,
            spend: '2.50',
          })),
        }),
      },
    },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: sourceOffering.retentionDays,
    resolveSource: account => ({
      adapterId: 'fixture',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    resolveCoverage: account => ({
      constituents: [
        {
          ...structuredClone(template),
          constituentId: `constituent-${account.id}`,
          mediaBuyId: `media-buy-${account.id}`,
          productBinding: { ...structuredClone(template.productBinding), mediaBuyId: `media-buy-${account.id}` },
        },
      ],
    }),
    resolveConsumerId: context => context.authInfo?.clientId ?? 'buyer-a',
  });
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  const installed = await service.installConfiguration(
    {
      delivery_config_id: 'delivery-config',
      delivery_config_version: 1,
      offeringId: sourceOffering.offeringId,
      report_definition_id: sourceOffering.contract.report_definition_id,
      feedPurpose: 'analytics',
      requiredFinality: 'snapshot',
      requestedMetrics: request.requestedMetrics,
      requestedDimensions: request.requestedDimensions,
      schedule: {
        anchor: ANCHOR,
        periodMilliseconds: DAY,
        deliverySlaMilliseconds: 0,
        recoveryWindowMilliseconds: DAY,
      },
      sourceSettings,
    },
    { account: { id: 'account-a', ctx_metadata: {} } }
  );
  // A controlled install instant, so the planned periods do not depend on today.
  store.configurations.get(installed.configurationId).installedAt = ANCHOR;
  const now = new Date(Date.parse(ANCHOR) + 3 * DAY + 60_000);
  const cycle = await service.runCycle({ accountId: 'account-a', now });
  store.ledgerAsOf = now.toISOString();
  const context = { account: { id: 'account-a', ctx_metadata: {} }, authInfo: { clientId: 'buyer-a' } };
  const period = { start: ANCHOR, end: new Date(Date.parse(ANCHOR) + 3 * DAY).toISOString() };
  const summary = await service.platform.getReportingStatus(
    { account: { account_id: 'account-a' }, view: 'summary', period },
    context
  );
  const periods = await service.platform.getReportingStatus(
    { account: { account_id: 'account-a' }, view: 'periods', period, pagination: { max_results: 100 } },
    context
  );
  const firstRevision = periods.revisions?.[0];
  const delivery = firstRevision
    ? await service.platform.getMediaBuyDelivery(
        { account: { account_id: 'account-a' }, reporting_revision_id: firstRevision.reporting_revision_id },
        context
      )
    : undefined;
  const firstPeriod = periods.periods[0];
  const consumerStatus = await service.platform.syncReportingStatus(
    {
      account: { account_id: 'account-a' },
      idempotency_key: 'option-off-transcript-0001',
      statuses: [
        {
          reporting_status_id: 'option-off-status-0001',
          delivery_config_id: firstPeriod.delivery_config_id,
          delivery_config_version: firstPeriod.delivery_config_version,
          report_definition_id: firstPeriod.report_definition_id,
          reporting_obligation_id: firstPeriod.reporting_obligation_id,
          reporting_revision_id: firstRevision.reporting_revision_id,
          observed_revision_content_sha256: firstRevision.revision_content_sha256,
          period: firstPeriod.period,
          consumer_status: 'received',
          status_as_of: now.toISOString(),
        },
      ],
    },
    context
  );
  return normalize({
    capabilities: service.capabilities,
    installed,
    cycle,
    configurations: await store.listConfigurations(),
    obligations: await store.listObligations(),
    summary,
    periods,
    delivery,
    consumerStatus,
  });
}

module.exports = { reportingLedgerOptionOffTranscript };
