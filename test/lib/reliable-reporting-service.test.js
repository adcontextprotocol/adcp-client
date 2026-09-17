const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  createReliableReportingService,
  runReliableReportingServiceConformanceV1,
} = require('../../dist/lib/reporting/service/index.js');
const {
  createInlineReportingSourceExecutor,
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
  reportingScheduleOriginV1,
} = require('../../dist/lib/reporting/source/index.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');
const { canonicalize } = require('../../dist/lib/utils/jcs.js');
const { createHash } = require('node:crypto');

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

function adapter(calls = []) {
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  // The shared fixture declares a PT6H worst case while the delivery offering
  // below advertises PT0S. Make the fixture internally truthful so the SLA
  // feasibility gate has a consistent baseline to work from.
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  return {
    sourceOffering,
    deliveryOffering: deliveryOffering(),
    fetchSlice: (request, context) => {
      calls.push({ request: structuredClone(request), sourceScope: structuredClone(context.sourceScope) });
      return {
        reporting_period: { start: request.start_date, end: request.end_date },
        currency: context.sourceSettings.currency,
        reporting_rows: [],
      };
    },
  };
}

function configuration(overrides = {}) {
  const request = redactedReportingSourceRequestV1();
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  return {
    delivery_config_id: 'delivery-config',
    delivery_config_version: 1,
    offeringId: redactedReportingSourceOfferingV1.offeringId,
    report_definition_id: redactedReportingSourceOfferingV1.contract.report_definition_id,
    feedPurpose: 'analytics',
    requiredFinality: 'snapshot',
    requestedMetrics: request.requestedMetrics,
    requestedDimensions: request.requestedDimensions,
    schedule: {
      anchor: '2026-09-01T00:00:00.000Z',
      periodMilliseconds: 86_400_000,
      deliverySlaMilliseconds: 0,
      recoveryWindowMilliseconds: 86_400_000,
    },
    sourceSettings,
    expectedCurrency: 'USD',
    expectedSourceTimezone: 'UTC',
    ...overrides,
  };
}

/** Only this account's own media buy; naming another account's ID is not authorized. */
function authorizedConstituent(accountId) {
  const [template] = redactedReportingSourceRequestV1().coverage.constituents;
  const mediaBuyId = `media-buy-${accountId}`;
  return {
    ...structuredClone(template),
    constituentId: `constituent-${accountId}`,
    mediaBuyId,
    productBinding: { ...structuredClone(template.productBinding), mediaBuyId },
  };
}

/** A fixture whose offering and resolver agree on one non-UTC source timezone. */
function zonedFixture(
  timezone,
  { alignment = 'source_timezone', periodDuration = 'P1D', minimumWindow, periodTimezone, accountResolved } = {}
) {
  const zoned = adapter();
  // `account_resolved` leaves the zone unknown until the account is resolved,
  // so the construction-time gate cannot see it and install-time validation is
  // what runs. Pinning it instead makes construction the decisive gate.
  zoned.sourceOffering.sourceTimezone = accountResolved
    ? { ...zoned.sourceOffering.sourceTimezone, ianaTimezone: undefined }
    : { ...zoned.sourceOffering.sourceTimezone, ianaTimezone: timezone };
  if (accountResolved) delete zoned.sourceOffering.sourceTimezone.ianaTimezone;
  if (minimumWindow) {
    zoned.sourceOffering.windowing = { ...zoned.sourceOffering.windowing, minimumWindow };
  }
  const { period_timezone_policy, period_timezone, ...base } = zoned.deliveryOffering.schedule;
  zoned.deliveryOffering.schedule =
    alignment === 'utc'
      ? { ...base, alignment, period_duration: periodDuration }
      : accountResolved
        ? { ...base, alignment, period_duration: periodDuration, period_timezone_policy: 'account_resolved' }
        : {
            ...base,
            alignment,
            period_duration: periodDuration,
            period_timezone_policy: 'fixed',
            period_timezone: periodTimezone ?? timezone,
          };
  return serviceFixture({
    adapters: { fixture: zoned },
    resolveSource: account => ({
      adapterId: 'fixture',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: timezone,
    }),
  });
}

/** The first protocol period boundary at/after `isoInstant` for a zone. */
function protocolBoundaryAfter(timezone, isoInstant) {
  const origin = reportingScheduleOriginV1('source_timezone', timezone);
  const target = Date.parse(isoInstant);
  const ordinal = Math.ceil((target - origin) / 86_400_000);
  return new Date(origin + ordinal * 86_400_000).toISOString();
}

function serviceFixture(overrides = {}) {
  const store = new MemoryLedgerStore();
  const currencies = new Map([
    ['account-a', 'USD'],
    ['account-b', 'EUR'],
  ]);
  const reportingAdapter = adapter();
  const service = createReliableReportingService({
    store,
    adapters: { fixture: reportingAdapter },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    resolveSource: account => ({
      adapterId: 'fixture',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: account => currencies.get(account.id),
    resolveCoverage: account => ({ constituents: [authorizedConstituent(account.id)] }),
    ...overrides,
  });
  return { service, store, currencies, reportingAdapter };
}

describe('ReliableReportingService', () => {
  test('installs account-isolated configurations with trusted frozen currency', async () => {
    const { service, store, currencies } = serviceFixture();
    const account = { account: { id: 'account-a', ctx_metadata: { access_token: 'must-not-copy' } } };
    const installed = await service.installConfiguration(configuration(), account);
    assert.equal(installed.account.account_id, 'account-a');
    assert.equal(installed.sourceSettings.currency, 'USD');
    assert.deepEqual(installed.sourceScope, {
      network_id: 'network-account-a',
      _adcp_reporting_adapter: 'fixture',
    });
    assert.equal(JSON.stringify(installed).includes('must-not-copy'), false);

    currencies.set('account-a', 'EUR');
    await assert.rejects(
      service.installConfiguration(configuration({ expectedCurrency: 'EUR' }), account),
      /immutable/i,
      'a later resolver result cannot mutate a frozen generation'
    );
    assert.equal((await store.listConfigurations('account-a'))[0].sourceSettings.currency, 'USD');

    const isolated = await service.installConfiguration(configuration({ expectedCurrency: 'EUR' }), {
      account: { id: 'account-b', ctx_metadata: {} },
    });
    assert.notEqual(isolated.configurationId, installed.configurationId);
    assert.equal(isolated.sourceSettings.currency, 'EUR');
  });

  test('fails closed on missing/conflicting currency and credential-bearing source scopes', async () => {
    const base = serviceFixture({ resolveCurrency: () => undefined });
    await assert.rejects(
      base.service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } }),
      /resolveCurrency/
    );

    const conflict = serviceFixture({ resolveCurrency: () => 'EUR' });
    await assert.rejects(
      conflict.service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } }),
      /conflicts/
    );

    for (const sourceScope of [{ access_token: 'secret' }, { nested: { ctx_metadata: { tenant: 'x' } } }]) {
      const unsafe = serviceFixture({
        resolveSource: () => ({ adapterId: 'fixture', sourceScope, sourceTimezone: 'UTC' }),
      });
      await assert.rejects(
        unsafe.service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } }),
        /non-secret routing identifiers/
      );
    }

    const invalidTimezone = serviceFixture({
      resolveSource: () => ({ adapterId: 'fixture', sourceScope: {}, sourceTimezone: 'not/a-zone' }),
    });
    await assert.rejects(
      invalidTimezone.service.installConfiguration(configuration(), {
        account: { id: 'account-a', ctx_metadata: {} },
      }),
      /valid IANA sourceTimezone/
    );

    const injected = serviceFixture();
    await assert.rejects(
      injected.service.installConfiguration(
        { ...configuration(), account: { account_id: 'account-b' } },
        { account: { id: 'account-a', ctx_metadata: {} } }
      ),
      /trusted lineage field account/
    );
    await assert.rejects(
      injected.service.installConfiguration(
        {
          ...configuration(),
          sourceSettings: { ...configuration().sourceSettings, currency: 'EUR' },
        },
        { account: { id: 'account-a', ctx_metadata: {} } }
      ),
      /sourceSettings\.currency/
    );
  });

  test('plans, produces, and serves one exact revision through the installed service', async () => {
    const calls = [];
    const reportingAdapter = adapter(calls);
    const { service, store } = serviceFixture({ adapters: { fixture: reportingAdapter } });
    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration();
    input.schedule.anchor = anchor;
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    store.configurations.get(installed.configurationId).installedAt = anchor;

    const cycle = await service.runCycle({
      deploymentWide: true,
      maxObligations: 1,
      maxWorkerIterations: 1,
    });
    assert.equal(cycle.planned, 1);
    assert.equal(cycle.revisionsCommitted, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sourceScope.network_id, 'network-account-a');

    const obligation = (await store.listObligations('account-a'))[0];
    const revision = (await store.listRevisions(obligation.reporting_obligation_id))[0];
    const exact = await service.platform.getMediaBuyDelivery(
      { reporting_revision_id: revision.reporting_revision_id },
      { account: { id: 'account-a' } }
    );
    assert.equal(exact.reporting_revision.reporting_revision_id, revision.reporting_revision_id);
    assert.deepEqual(exact.reporting_rows, []);

    const platform = service.install({
      capabilities: { specialisms: [], config: {} },
      accounts: {
        resolution: 'explicit',
        resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
        upsert: async () => [],
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'reporting-revision-test',
      version: '1.0.0',
      adcpVersion: '3.2.0-rc.3',
      validation: { requests: 'strict', responses: 'strict' },
    });
    const wireExact = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            reporting_revision_id: revision.reporting_revision_id,
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.notEqual(wireExact.isError, true, JSON.stringify(wireExact.structuredContent));
    assert.equal(wireExact.structuredContent.reporting_revision.reporting_revision_id, revision.reporting_revision_id);
  });

  test('derives Core-only capabilities and installs native server handlers', async () => {
    const { service } = serviceFixture();
    assert.equal(service.capabilities.consumer_status_task, undefined);
    for (const claim of ['managed_delivery', 'reconciled_billing', 'status_notification', 'ledger_notification']) {
      assert.equal(service.capabilities[claim], undefined);
    }
    assert.deepEqual(service.setup.migrations.length, 1);

    const platform = service.install({
      capabilities: { specialisms: [], config: {} },
      accounts: {
        resolution: 'explicit',
        resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
        upsert: async () => [],
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'reporting-service-test',
      version: '1.0.0',
      adcpVersion: '3.2.0-rc.3',
      validation: { requests: 'strict', responses: 'strict' },
    });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'get_adcp_capabilities', arguments: {} },
    });
    assert.deepEqual(
      result.structuredContent.experimental_features,
      ['media_buy.reporting_delivery'],
      JSON.stringify(result.structuredContent)
    );
    assert.deepEqual(result.structuredContent.media_buy.reporting_delivery, service.capabilities);

    const status = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_reporting_status',
          arguments: { account: { account_id: 'account-a' }, view: 'summary' },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.equal(status.structuredContent.status, 'completed');

    const unauthenticated = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_reporting_status',
        arguments: { account: { account_id: 'account-a' }, view: 'summary' },
      },
    });
    assert.equal(unauthenticated.structuredContent.adcp_error.code, 'AUTH_MISSING');
  });

  test('refuses to advertise a configuration task without the native account handler', () => {
    const { service } = serviceFixture();
    assert.throws(
      () =>
        service.install({
          capabilities: { specialisms: [], config: {} },
          accounts: {
            resolution: 'explicit',
            resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
          },
        }),
      /sync_accounts configuration task/
    );
  });

  test('preserves an existing exact-revision delivery handler when the service is absent', async () => {
    const seen = [];
    const server = createAdcpServerFromPlatform(
      {
        capabilities: { specialisms: [], config: {} },
        accounts: {
          resolution: 'explicit',
          resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
        },
        sales: {
          getMediaBuyDelivery: async request => {
            seen.push(request);
            return {
              reporting_period: { start: '2026-09-01', end: '2026-09-02' },
              currency: 'USD',
              media_buy_deliveries: [],
            };
          },
        },
      },
      {
        name: 'legacy-exact-reporting-test',
        version: '1.0.0',
        validation: { requests: 'off', responses: 'off' },
      }
    );
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'get_media_buy_delivery',
        arguments: {
          account: { account_id: 'account-a' },
          reporting_revision_id: 'revision-existing-handler',
        },
      },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(seen[0].reporting_revision_id, 'revision-existing-handler');
  });

  test('advertises consumer status only with its authenticated handler and atomic store port', () => {
    const { service } = serviceFixture({ resolveConsumerId: context => context.agent.agent_url });
    assert.equal(service.capabilities.consumer_status_task, 'sync_reporting_status');
    assert.equal(typeof service.platform.syncReportingStatus, 'function');

    assert.throws(
      () =>
        serviceFixture({
          store: {},
          resolveConsumerId: context => context.agent.agent_url,
        }),
      /reporting ledger store|putConfiguration/
    );

    assert.throws(
      () =>
        serviceFixture({
          consumerMismatchEscalation: {
            escalationSeconds: 60,
            operationsContact: { email: 'reporting@example.com' },
          },
        }),
      /requires resolveConsumerId/
    );
  });

  test('rejects adapter declarations for uninstalled reporting tiers', () => {
    for (const mutate of [
      offering => {
        offering.method = {};
      },
      offering => {
        offering.reconciliation_mode = 'consumer_receipt';
      },
      offering => {
        offering.feed_purpose = 'billing';
      },
    ]) {
      const candidate = adapter();
      mutate(candidate.deliveryOffering);
      assert.throws(
        () =>
          createReliableReportingService({
            store: new MemoryLedgerStore(),
            adapters: { fixture: candidate },
            contact: { name: 'Reporting operations' },
            automatedRecoveryWindowSeconds: 86_400,
            statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
            resolveSource: () => ({ adapterId: 'fixture', sourceScope: {}, sourceTimezone: 'UTC' }),
            resolveCurrency: () => 'USD',
            resolveCoverage: account => ({ constituents: [authorizedConstituent(account.id)] }),
          }),
        /Core API delivery only/
      );
    }

    const malformed = adapter();
    malformed.deliveryOffering.schedule.alignment = 'invented';
    assert.throws(() => serviceFixture({ adapters: { fixture: malformed } }), /alignment/);
  });

  test('refuses to project Reliable Reporting onto a pre-3.2 server', () => {
    const { service } = serviceFixture();
    const platform = service.install({
      capabilities: { specialisms: [], config: {} },
      accounts: {
        resolution: 'explicit',
        resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
        upsert: async () => [],
      },
    });
    assert.throws(
      () =>
        createAdcpServerFromPlatform(platform, {
          name: 'old-reporting-pin',
          version: '1.0.0',
          adcpVersion: '3.1.18',
        }),
      /requires an AdCP 3\.2\.0-rc\.3/
    );
  });

  test('runs the reusable replay, isolation, currency, lifecycle, and capability conformance helper', async () => {
    const { service, reportingAdapter } = serviceFixture();
    const result = await runReliableReportingServiceConformanceV1({
      service,
      adapter: reportingAdapter,
      replayRequest: redactedReportingSourceRequestV1({ sourceExecutionKey: 'service-conformance' }),
      primary: {
        context: { account: { id: 'account-a', ctx_metadata: {} } },
        configuration: configuration(),
      },
      isolated: {
        context: { account: { id: 'account-b', ctx_metadata: {} } },
        configuration: configuration({ expectedCurrency: 'EUR' }),
      },
    });
    assert.equal(result.manifest.rowCount, 0);
    assert.deepEqual(result.checks, [
      'adapter_replay',
      'account_isolation',
      'frozen_currency',
      'lifecycle_start_stop',
      'capability_truthfulness',
    ]);
  });

  test('keeps media-buy lineage trusted so one buyer cannot report on another buyer', async () => {
    const calls = [];
    const reportingAdapter = adapter(calls);
    // A shared upstream network: sourceScope alone separates nothing, so the
    // constituent denominator is the whole authorization boundary.
    const { service, store } = serviceFixture({
      adapters: { fixture: reportingAdapter },
      resolveSource: () => ({
        adapterId: 'fixture',
        sourceScope: { network_id: 'shared-network' },
        sourceTimezone: 'UTC',
      }),
    });
    const attacker = { account: { id: 'account-a', ctx_metadata: {} } };
    const victimConstituent = authorizedConstituent('account-b');

    // A declaration can no longer carry its own denominator at all.
    for (const injected of [{ constituents: [victimConstituent] }, { mediaBuyIds: ['media-buy-account-b'] }]) {
      await assert.rejects(
        service.installConfiguration({ ...configuration(), ...injected }, attacker),
        /must not supply trusted lineage field (constituents|mediaBuyIds)/,
        `buyer-supplied ${Object.keys(injected)[0]} must be refused`
      );
    }

    // An assertion that disagrees with the authorized scope fails closed
    // instead of widening it.
    await assert.rejects(
      service.installConfiguration(
        configuration({ expectedMediaBuyIds: ['media-buy-account-a', 'media-buy-account-b'] }),
        attacker
      ),
      /conflicts with the configuration media-buy assertion/
    );

    const installed = await service.installConfiguration(
      configuration({ expectedMediaBuyIds: ['media-buy-account-a'] }),
      attacker
    );
    assert.deepEqual(installed.mediaBuyIds, ['media-buy-account-a']);
    assert.deepEqual(
      installed.constituents.map(value => value.constituentId),
      ['constituent-account-a']
    );

    // Drive a real cycle and prove the victim's ID never reaches the adapter.
    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    store.configurations.get(installed.configurationId).schedule.anchor = anchor;
    store.configurations.get(installed.configurationId).installedAt = anchor;
    await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request.media_buy_ids, ['media-buy-account-a']);
    assert.equal(JSON.stringify(calls[0]).includes('media-buy-account-b'), false);
    assert.equal(JSON.stringify(calls[0]).includes('constituent-account-b'), false);
  });

  test('refuses a coverage resolution that is missing, empty, or self-contradicting', async () => {
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    for (const [resolveCoverage, expected] of [
      [() => undefined, /authorized constituent denominator/],
      [() => ({ constituents: 'all' }), /authorized constituent denominator/],
      [() => ({ constituents: [] }), /at least 1|too_small|greater than or equal/i],
      [
        () => ({
          constituents: [authorizedConstituent('account-a'), authorizedConstituent('account-a')],
        }),
        /unique constituent identities/,
      ],
    ]) {
      const { service } = serviceFixture({ resolveCoverage });
      await assert.rejects(service.installConfiguration(configuration(), context), expected);
    }
  });

  test('serves populated hash-bound reporting rows without creative-format projection', async () => {
    // Columns a real ad-server reporting feed carries. `creative_id` +
    // `format_kind` is exactly the pair that trips response creative-format
    // projection, which would rewrite content out from under the revision's
    // content digest.
    const rows = [
      {
        media_buy_id: 'media-buy-account-a',
        creative_id: 'creative-1',
        format_kind: 'display_300x250',
        impressions: 1000,
        spend: 12.34,
      },
    ];
    const reportingAdapter = adapter();
    reportingAdapter.sourceOffering.dimensions = [
      { name: 'media_buy_id', support: 'exact' },
      { name: 'creative_id', support: 'exact' },
      { name: 'format_kind', support: 'exact' },
    ];
    reportingAdapter.fetchSlice = (request, context) => ({
      reporting_period: { start: request.start_date, end: request.end_date },
      currency: context.sourceSettings.currency,
      reporting_rows: structuredClone(rows),
    });
    const { service, store } = serviceFixture({ adapters: { fixture: reportingAdapter } });

    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration({ requestedDimensions: ['media_buy_id', 'creative_id', 'format_kind'] });
    input.schedule.anchor = anchor;
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    store.configurations.get(installed.configurationId).installedAt = anchor;
    const cycle = await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });
    assert.equal(cycle.revisionsCommitted, 1);

    const obligation = (await store.listObligations('account-a'))[0];
    const revision = (await store.listRevisions(obligation.reporting_obligation_id))[0];
    const platform = service.install({
      capabilities: { specialisms: [], config: {} },
      accounts: {
        resolution: 'explicit',
        resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
        upsert: async () => [],
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'reporting-rows-test',
      version: '1.0.0',
      adcpVersion: '3.2.0-rc.3',
      validation: { requests: 'strict', responses: 'strict' },
    });
    const wire = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            reporting_revision_id: revision.reporting_revision_id,
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.notEqual(wire.isError, true, JSON.stringify(wire.structuredContent));
    assert.deepEqual(wire.structuredContent.reporting_rows, rows, 'exact revision content must reach the wire intact');

    // The bytes on the wire still satisfy the revision's own content binding.
    const wireRevision = wire.structuredContent.reporting_revision;
    const rebound = createHash('sha256')
      .update(
        Buffer.from(
          canonicalize({
            reporting_revision_id: wireRevision.reporting_revision_id,
            row_count: wireRevision.row_count,
            control_totals: wireRevision.control_totals,
            reporting_rows: wire.structuredContent.reporting_rows,
          }),
          'utf8'
        )
      )
      .digest('hex');
    assert.equal(rebound, wireRevision.revision_content_sha256);
  });

  test('projects unbound delivery even when sales and reporting share one handler', async () => {
    // An adopter may legitimately wire a single function into both delivery
    // slots. Handler identity alone must not decide the raw-passthrough gate.
    const rows = [
      {
        media_buy_id: 'media-buy-account-a',
        creative_id: 'creative-1',
        format_kind: 'display_300x250',
        impressions: 1000,
        spend: 12.34,
      },
    ];
    const reportingAdapter = adapter();
    reportingAdapter.sourceOffering.dimensions = [
      { name: 'media_buy_id', support: 'exact' },
      { name: 'creative_id', support: 'exact' },
      { name: 'format_kind', support: 'exact' },
    ];
    reportingAdapter.fetchSlice = (request, context) => ({
      reporting_period: { start: request.start_date, end: request.end_date },
      currency: context.sourceSettings.currency,
      reporting_rows: structuredClone(rows),
    });
    const { service, store } = serviceFixture({ adapters: { fixture: reportingAdapter } });

    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration({ requestedDimensions: ['media_buy_id', 'creative_id', 'format_kind'] });
    input.schedule.anchor = anchor;
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    store.configurations.get(installed.configurationId).installedAt = anchor;
    await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });
    const obligation = (await store.listObligations('account-a'))[0];
    const revision = (await store.listRevisions(obligation.reporting_obligation_id))[0];

    // One function reference in both slots: exact reads delegate to the
    // ledger, cumulative reads return an ordinary creative-bearing delivery.
    const shared = async (request, context) =>
      request.reporting_revision_id
        ? service.platform.getMediaBuyDelivery(request, context)
        : {
            reporting_period: { start: '2026-09-01', end: '2026-09-02' },
            currency: 'USD',
            media_buy_deliveries: [
              { media_buy_id: 'media-buy-account-a', creative_id: 'creative-1', format_kind: 'display_300x250' },
            ],
          };
    const server = createAdcpServerFromPlatform(
      {
        capabilities: { specialisms: [], config: {} },
        accounts: {
          resolution: 'explicit',
          resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
          upsert: async () => [],
        },
        sales: { getMediaBuyDelivery: shared },
        reporting: {
          capabilities: service.capabilities,
          getReportingStatus: service.platform.getReportingStatus,
          getMediaBuyDelivery: shared,
        },
      },
      {
        name: 'shared-delivery-handler-test',
        version: '1.0.0',
        adcpVersion: '3.2.0-rc.3',
        // Projection, not schema validation, is the behavior under test.
        validation: { requests: 'off', responses: 'off' },
      }
    );

    const cumulative = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            media_buy_ids: ['media-buy-account-a'],
            start_date: '2026-09-01',
            end_date: '2026-09-02',
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.equal(cumulative.isError, true, 'an unbound delivery read must still be projected');
    assert.equal(cumulative.structuredContent.adcp_error.code, 'INVALID_REQUEST');

    const exact = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            reporting_revision_id: revision.reporting_revision_id,
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.notEqual(exact.isError, true, JSON.stringify(exact.structuredContent));
    assert.deepEqual(exact.structuredContent.reporting_rows, rows);
  });

  test('refuses schedule semantics the installed executor cannot satisfy', async () => {
    const context = { account: { id: 'account-a', ctx_metadata: {} } };

    // Alignment the service does not generate periods for. Refused at
    // construction so discovery never advertises an uninstallable schedule.
    for (const alignment of ['billing_cycle', 'account_timezone']) {
      assert.throws(
        () => zonedFixture('UTC', { alignment }),
        /cannot honor '.*' period alignment/,
        `${alignment} must be refused`
      );
    }

    // UTC-aligned offerings need a zero-offset source timezone, and the zone is
    // pinned, so this is decidable before the offering is ever published.
    assert.throws(() => zonedFixture('Asia/Kolkata', { alignment: 'utc' }), /UTC offset is zero/);

    // An anchor off the protocol period boundary: the executor refuses every
    // slice, so the generation must never install.
    const noonAnchored = serviceFixture();
    await assert.rejects(
      noonAnchored.service.installConfiguration(
        configuration({
          schedule: {
            anchor: '2026-09-01T12:00:00.000Z',
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /is not on a 'source_timezone' period boundary/
    );

    // A delivery offering that pins a period timezone its source offering does
    // not declare is now refused before it can be advertised.
    assert.throws(
      () => zonedFixture('Asia/Kolkata', { periodTimezone: 'UTC' }),
      /pins a period timezone its source offering does not declare/
    );

    assert.throws(
      () => zonedFixture('America/New_York'),
      /UTC offset|schedule-origin offset/,
      'a pinned DST zone cannot hold local midnight and must not be advertised'
    );

    // The same zone behind an account_resolved policy is unknown until install,
    // so install-time validation is what has to catch it.
    const lateDst = zonedFixture('America/New_York', { accountResolved: true });
    await assert.rejects(
      lateDst.service.installConfiguration(
        configuration({
          expectedSourceTimezone: 'America/New_York',
          schedule: {
            anchor: '2026-01-01T05:00:00.000Z',
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /UTC offset|schedule-origin offset/
    );

    // Sub-day windows have no source-local midnight boundary, so the offering
    // is refused at construction and never reaches capabilities. The inline
    // executor rejects the window first; an injected executor would instead
    // trip the delivery-offering whole-day gate.
    assert.throws(
      () => zonedFixture('UTC', { periodDuration: 'PT12H', minimumWindow: 'PT12H' }),
      /whole source-day fixed windows|not a whole number of source-local days/
    );

    // A historical anchor whose offset change lands between the anchor and the
    // periods being generated now. Asia/Almaty held UTC+6 through 2023 and
    // moved to UTC+5 on 2024-03-01, so a 2022 generation looks stable for its
    // first year and every currently generated boundary sits at 23:00 local.
    const almaty = zonedFixture('Asia/Almaty', { accountResolved: true });
    await assert.rejects(
      almaty.service.installConfiguration(
        configuration({
          expectedSourceTimezone: 'Asia/Almaty',
          schedule: {
            anchor: '2021-12-31T18:00:00.000Z', // 2022-01-01T00:00 +06:00
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /UTC offset|schedule-origin offset/,
      'validation must reach from the anchor through the periods being generated now'
    );

    // Positive controls: a fixed-offset non-UTC zone installs both at a recent
    // boundary and at the protocol's own 1970 local-midnight origin, which is
    // exactly what a spec-following adopter sends. The rule is "no offset
    // change", not "UTC only" or "recent anchors only".
    const kolkata = zonedFixture('Asia/Kolkata');
    for (const anchor of ['2026-09-01T18:30:00.000Z', '1969-12-31T18:30:00.000Z']) {
      const installed = await kolkata.service.installConfiguration(
        configuration({
          delivery_config_id: `delivery-config-${anchor}`,
          expectedSourceTimezone: 'Asia/Kolkata',
          schedule: {
            anchor,
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      );
      assert.equal(installed.sourceTimezone, 'Asia/Kolkata');
    }
  });

  test('keeps a legacy cumulative delivery handler reachable after installing reporting', async () => {
    // A reporting-only platform: no native sales/lifecycle delivery, so the
    // adopter's own handler is still the one that serves cumulative reads.
    const { service } = serviceFixture();
    const seen = [];
    const server = createAdcpServerFromPlatform(
      service.install({
        capabilities: { specialisms: [], config: {} },
        accounts: {
          resolution: 'explicit',
          resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
          upsert: async () => [],
        },
      }),
      {
        name: 'legacy-cumulative-delivery-test',
        version: '1.0.0',
        adcpVersion: '3.2.0-rc.3',
        validation: { requests: 'off', responses: 'off' },
        legacyHandlers: {
          mediaBuy: {
            getMediaBuyDelivery: async request => {
              seen.push(request.media_buy_ids);
              return {
                reporting_period: { start: '2026-09-01', end: '2026-09-02' },
                currency: 'USD',
                media_buy_deliveries: [],
              };
            },
          },
        },
      }
    );

    const cumulative = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            media_buy_ids: ['media-buy-account-a'],
            start_date: '2026-09-01',
            end_date: '2026-09-02',
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.notEqual(cumulative.isError, true, JSON.stringify(cumulative.structuredContent));
    assert.deepEqual(seen, [['media-buy-account-a']], 'installing reporting must not shadow the legacy handler');

    // The reporting ledger still owns exact revision reads.
    const exact = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: { account: { account_id: 'account-a' }, reporting_revision_id: 'revision-unknown' },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.equal(seen.length, 1, 'an exact revision read must not reach the legacy handler');
    assert.equal(exact.isError, true);
  });

  test('projects an installed source_timezone schedule as itself, not billing_cycle', async () => {
    const { service, store } = serviceFixture();
    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration();
    input.schedule.anchor = anchor;
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    store.configurations.get(installed.configurationId).installedAt = anchor;
    await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });

    const status = await service.platform.getReportingStatus(
      { account: { account_id: 'account-a' }, view: 'periods' },
      { account: { id: 'account-a' }, agent: { agent_url: 'https://buyer.example' } }
    );
    const [obligation] = status.periods;
    // installed_schedule_match: the status must echo exactly what was
    // installed. A source_timezone offering must not be reported as `utc`
    // merely because a UTC source clock also sits on the UTC origin, and P1D
    // must not be re-expressed as PT86400S.
    assert.equal(obligation.schedule.alignment, 'source_timezone');
    assert.equal(obligation.schedule.period_duration, 'P1D');
    assert.equal(obligation.schedule.period_timezone, 'UTC');
    assert.equal(obligation.schedule.period_anchor, undefined, 'period_anchor is forbidden outside billing_cycle');
    assert.equal(
      obligation.schedule.delivery_sla,
      service.capabilities.offerings[0].schedule.delivery_sla,
      'the echoed SLA must match the advertised offering'
    );
  });

  test('refuses an official delivery SLA the source cannot finalize within', async () => {
    const infeasible = adapter();
    const { cadence, ...sourceOffering } = infeasible.sourceOffering;
    infeasible.sourceOffering = {
      ...sourceOffering,
      publicationClass: 'AUTHORITATIVE',
      finalization: {
        // Finalizes 01:00 source-local the same day. The typical publish lag is
        // PT15M, but the worst case is PT6H — so the honest floor is 7h, and a
        // PT2H SLA is only ever met on a good day.
        schedule: { sourceLocalReadyTime: '01:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT15M',
        worstCaseAvailabilityLag: 'PT6H',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P7D',
        correctionPolicy: 'immutable_correction',
      },
      revisionSemantics: 'official_with_declared_correction_policy',
    };
    infeasible.deliveryOffering.supported_finality = ['official'];
    infeasible.deliveryOffering.schedule.delivery_sla = 'PT2H';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: infeasible } }),
      /shorter than the source can finalize and publish/,
      'the expected lag is not the promise; the worst case is'
    );

    // Widening the advertised SLA past the worst-case publish makes it honest.
    infeasible.deliveryOffering.schedule.delivery_sla = 'PT7H';
    const feasible = serviceFixture({ adapters: { fixture: infeasible } });
    assert.equal(feasible.service.capabilities.offerings[0].schedule.delivery_sla, 'PT7H');
  });

  test('applies per-account budgets and rotates tenants in deployment-wide mode', async () => {
    const { service } = serviceFixture({ resolveCurrency: () => 'USD' });
    for (const id of ['account-a', 'account-b', 'account-c']) {
      const installed = await service.installConfiguration(configuration(), {
        account: { id, ctx_metadata: {} },
      });
      assert.equal(installed.account.account_id, id);
    }

    const passes = [];
    let current = [];
    service.producer.planObligations = async (_now, options) => {
      current.push([options?.account_id, options?.maxObligations]);
      return [];
    };
    service.producer.runWorker = async options => {
      assert.equal(options?.maxIterations, 7, 'per-account worker budget must reach the worker');
      return { claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 };
    };

    service.start({
      intervalMilliseconds: 60,
      deploymentWide: true,
      maxObligationsPerAccount: 5,
      maxWorkerIterationsPerAccount: 7,
    });
    while (passes.length < 2) {
      await new Promise(resolve => setTimeout(resolve, 20));
      if (current.length >= 3) {
        passes.push(current.slice(0, 3));
        current = current.slice(3);
      }
    }
    await service.stop();

    // Every tenant gets its own bounded cycle, not one global sweep.
    for (const pass of passes) {
      assert.deepEqual(
        pass.map(entry => entry[1]),
        [5, 5, 5],
        'the per-account obligation budget must be applied per account'
      );
      assert.deepEqual(
        [...pass.map(entry => entry[0])].sort(),
        ['account-a', 'account-b', 'account-c'],
        'a deployment-wide pass must still cover every tenant'
      );
    }
    assert.notDeepEqual(
      passes[0].map(entry => entry[0]),
      passes[1].map(entry => entry[0]),
      'the starting tenant must rotate so a fixed order cannot starve'
    );
  });

  test('refuses a keyless generation replay once a second adapter is installed', async () => {
    const { service, store } = serviceFixture();
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;
    await service.producer.installConfiguration({
      ...ledgerInput,
      account: { account_id: 'account-a' },
      sourceScope: { network_id: 'network-account-a' },
      sourceTimezone: 'UTC',
      sourceSettings: { ...sourceSettings, currency: 'USD' },
      contract: structuredClone(redactedReportingSourceOfferingV1.contract),
      constituents: [authorizedConstituent('account-a')],
      mediaBuyIds: ['media-buy-account-a'],
    });

    // A second adapter means the sole-adapter fallback no longer resolves, so a
    // keyless generation could never route. Refuse rather than replay it into a
    // configuration whose every execute and read would fail.
    const second = adapter();
    second.sourceOffering.offeringId = 'fixture-daily-snapshot-two';
    second.deliveryOffering.offering_id = 'fixture-daily-snapshot-two';
    const multi = serviceFixture({ store, adapters: { fixture: adapter(), other: second } });
    await assert.rejects(
      multi.service.installConfiguration(configuration(), context),
      /cannot be routed with multiple adapters installed/
    );

    // The single-adapter deployment still replays it.
    const replayed = await service.installConfiguration(configuration(), context);
    assert.deepEqual(replayed.sourceScope, { network_id: 'network-account-a' });
  });

  test('refuses constituent lineage that contradicts its product binding', async () => {
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    const contradictions = [
      [
        constituent => {
          constituent.productBinding.mediaBuyId = 'media-buy-account-b';
        },
        /mediaBuyId contradicts its product binding/,
      ],
      [
        constituent => {
          constituent.productBinding.productId = 'other-product';
        },
        /productId contradicts its product binding/,
      ],
    ];
    for (const [mutate, expected] of contradictions) {
      const { service } = serviceFixture({
        resolveCoverage: account => {
          const constituent = authorizedConstituent(account.id);
          mutate(constituent);
          return { constituents: [constituent] };
        },
      });
      await assert.rejects(service.installConfiguration(configuration(), context), expected);
    }
  });

  test('refuses package_item coverage the inline executor can never produce', async () => {
    // The inline executor narrows applicability to media_buy, so the routed
    // offering must advertise that narrowing too: otherwise a package_item
    // denominator installs against the declared applicability and then fails
    // every execute forever.
    // The adapter *declares* both kinds; only the executor's narrowing removes
    // package_item, so this fixture is what makes the narrowing load-bearing.
    const broad = adapter();
    broad.sourceOffering.applicability = {
      ...broad.sourceOffering.applicability,
      constituentKinds: ['media_buy', 'package_item'],
    };
    assert.deepEqual(serviceFixture({ adapters: { fixture: broad } }).service.producer !== undefined, true);

    const [template] = redactedReportingSourceRequestV1().coverage.constituents;
    const packageConstituent = {
      constituentId: 'constituent-package',
      constituentKind: 'package_item',
      productId: template.productId,
      packageId: 'package-1',
      productBinding: {
        ...structuredClone(template.productBinding),
        bindingKind: 'package_item_product',
        packageId: 'package-1',
        mediaBuyId: undefined,
      },
    };
    delete packageConstituent.productBinding.mediaBuyId;

    const packaged = serviceFixture({
      adapters: { fixture: broad },
      resolveCoverage: () => ({ constituents: [packageConstituent] }),
    });
    await assert.rejects(
      packaged.service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } }),
      /constituent kind is outside its offering applicability/
    );
  });

  test('still checks offset behavior for an anchor beyond the forward horizon', async () => {
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    // A 2030 anchor sits past now + forward horizon. Ending the scan at
    // "now + horizon" would put the span end before its start, so the loop body
    // would never run and a DST zone would install.
    for (const timezone of ['America/Santiago', 'Australia/Sydney']) {
      const zone = zonedFixture(timezone, { accountResolved: true });
      await assert.rejects(
        zone.service.installConfiguration(
          configuration({
            expectedSourceTimezone: timezone,
            schedule: {
              anchor: protocolBoundaryAfter(timezone, '2030-01-01T00:00:00.000Z'),
              periodMilliseconds: 86_400_000,
              deliverySlaMilliseconds: 0,
              recoveryWindowMilliseconds: 86_400_000,
            },
          }),
          context
        ),
        /UTC offset|schedule-origin offset/,
        `${timezone} observes DST and must be refused even when anchored in the future`
      );
    }
  });

  test('refuses a period wider than the executor can fetch in one request', async () => {
    // P2D sits inside the offering's declared window bounds but above the
    // executor's per-request ceiling, so every execution would fail.
    const wide = adapter();
    wide.sourceOffering.windowing = {
      ...wide.sourceOffering.windowing,
      minimumWindow: 'P1D',
      maximumWindow: 'P2D',
    };
    wide.sourceOffering.sourceExecution = {
      ...wide.sourceOffering.sourceExecution,
      maximumWindowDaysPerRequest: 1,
    };
    wide.deliveryOffering.schedule.period_duration = 'P2D';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: wide } }),
      /maximumWindowDaysPerRequest/,
      'a period no single request can cover must fail at install, not at every execution'
    );

    // Raising the executor ceiling to match makes the same period installable.
    wide.sourceOffering.sourceExecution = {
      ...wide.sourceOffering.sourceExecution,
      maximumWindowDaysPerRequest: 2,
    };
    const ok = serviceFixture({ adapters: { fixture: wide } });
    assert.equal(ok.service.capabilities.offerings[0].schedule.period_duration, 'P2D');
  });

  test('rotates tenants under the producer default cap, not only explicit budgets', async () => {
    const { service } = serviceFixture({ resolveCurrency: () => 'USD' });
    for (const id of ['account-a', 'account-b']) {
      await service.installConfiguration(configuration(), { account: { id, ctx_metadata: {} } });
    }

    // account-a has far more due work than one pass can drain; account-b has
    // one obligation. Under a single deployment-wide sweep with the producer's
    // default cap, account-a consumes the pass every time and account-b never
    // produces.
    const planned = [];
    service.producer.planObligations = async (_now, options) => {
      planned.push(options?.account_id);
      return options?.account_id === 'account-a' ? new Array(1_000).fill({}) : [{}];
    };
    service.producer.runWorker = async () => ({ claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 });

    service.start({ intervalMilliseconds: 20, deploymentWide: true });
    for (let tick = 0; tick < 300 && planned.length < 6; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await service.stop();

    assert.ok(planned.length >= 4, `expected repeated passes, saw ${planned.length}`);
    assert.ok(planned.includes('account-b'), 'the smaller tenant must still be planned');
    const firstOfEachPass = [planned[0], planned[2]];
    assert.notDeepEqual(firstOfEachPass[0], firstOfEachPass[1], 'the starting tenant must rotate between passes');
  });

  test('composes the reporting/legacy delivery split under strict merge-seam mode', async () => {
    const { service } = serviceFixture();
    const seen = [];
    // strict mode rejects an un-migrated override. This split is deliberate —
    // the ledger owns exact revision reads, the adopter owns cumulative ones —
    // so it must compose rather than be reported as a collision.
    const server = createAdcpServerFromPlatform(
      service.install({
        capabilities: { specialisms: [], config: {} },
        accounts: {
          resolution: 'explicit',
          resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
          upsert: async () => [],
        },
      }),
      {
        name: 'strict-merge-seam-test',
        version: '1.0.0',
        adcpVersion: '3.2.0-rc.3',
        validation: { requests: 'off', responses: 'off' },
        mergeSeam: 'strict',
        legacyHandlers: {
          mediaBuy: {
            getMediaBuyDelivery: async request => {
              seen.push(request.media_buy_ids);
              return {
                reporting_period: { start: '2026-09-01', end: '2026-09-02' },
                currency: 'USD',
                media_buy_deliveries: [],
              };
            },
          },
        },
      }
    );

    const cumulative = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            media_buy_ids: ['media-buy-account-a'],
            start_date: '2026-09-01',
            end_date: '2026-09-02',
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.notEqual(cumulative.isError, true, JSON.stringify(cumulative.structuredContent));
    assert.deepEqual(seen, [['media-buy-account-a']]);

    const exact = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: { account: { account_id: 'account-a' }, reporting_revision_id: 'revision-unknown' },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.equal(seen.length, 1, 'exact revision reads stay with the ledger under strict mode');
    assert.equal(exact.isError, true);
  });

  test('never advertises a schedule offering it would refuse to install', async () => {
    // Discovery-to-install consistency: every alignment reachable in
    // capabilities must be installable, and the unsupported ones must be
    // unreachable because construction refused them.
    for (const alignment of ['billing_cycle', 'account_timezone']) {
      assert.throws(() => zonedFixture('UTC', { alignment }), /cannot honor/);
    }

    const { service } = serviceFixture();
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    for (const offering of service.capabilities.offerings) {
      assert.ok(
        ['utc', 'source_timezone'].includes(offering.schedule.alignment),
        `advertised alignment ${offering.schedule.alignment} must be installable`
      );
      const installed = await service.installConfiguration(
        configuration({ delivery_config_id: `dc-${offering.offering_id}` }),
        context
      );
      assert.equal(installed.schedule.alignment, offering.schedule.alignment);
      assert.equal(installed.schedule.periodDuration, offering.schedule.period_duration);
    }
  });

  test('round-trips the exact installed delivery SLA syntax, not an equivalent instant', async () => {
    // installed_schedule_match compares values, not instants: an offering that
    // advertised PT1H must not be echoed back as PT3600S.
    const lexical = adapter();
    lexical.deliveryOffering.schedule.delivery_sla = 'PT1H';
    const { service, store } = serviceFixture({ adapters: { fixture: lexical } });
    assert.equal(service.capabilities.offerings[0].schedule.delivery_sla, 'PT1H');

    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration({
      schedule: {
        anchor,
        periodMilliseconds: 86_400_000,
        deliverySlaMilliseconds: 3_600_000,
        recoveryWindowMilliseconds: 86_400_000,
      },
    });
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    assert.equal(installed.schedule.deliverySlaDuration, 'PT1H');
    store.configurations.get(installed.configurationId).installedAt = anchor;
    await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });

    const status = await service.platform.getReportingStatus(
      { account: { account_id: 'account-a' }, view: 'periods' },
      { account: { id: 'account-a' }, agent: { agent_url: 'https://buyer.example' } }
    );
    const [obligation] = status.periods;
    assert.equal(obligation.schedule.delivery_sla, 'PT1H', 'the status must echo the installed SLA verbatim');
    assert.equal(obligation.schedule.period_duration, 'P1D');
    assert.equal(
      obligation.schedule.delivery_sla,
      service.capabilities.offerings[0].schedule.delivery_sla,
      'discovery and status must agree lexically'
    );
  });

  test('never advertises a period duration installation would reject', async () => {
    // PT25H sits inside a P1D..P2D window but is not a whole source-local day,
    // so publishing it would advertise a period every install refuses.
    const odd = adapter();
    odd.sourceOffering.windowing = {
      ...odd.sourceOffering.windowing,
      minimumWindow: 'P1D',
      maximumWindow: 'P2D',
    };
    odd.sourceOffering.sourceExecution = {
      ...odd.sourceOffering.sourceExecution,
      maximumWindowDaysPerRequest: 2,
    };
    odd.deliveryOffering.schedule.period_duration = 'PT25H';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: odd } }),
      /not a whole number of source-local days/,
      'an install-impossible duration must never reach capabilities'
    );

    // The neighbouring whole-day duration inside the same window is installable.
    odd.deliveryOffering.schedule.period_duration = 'P2D';
    const whole = serviceFixture({ adapters: { fixture: odd } });
    assert.equal(whole.service.capabilities.offerings[0].schedule.period_duration, 'P2D');
    const installed = await whole.service.installConfiguration(
      configuration({
        schedule: {
          // On the 2-day grid from the 1970 origin.
          anchor: '2026-08-31T00:00:00.000Z',
          periodMilliseconds: 172_800_000,
          deliverySlaMilliseconds: 0,
          recoveryWindowMilliseconds: 86_400_000,
        },
      }),
      { account: { id: 'account-a', ctx_metadata: {} } }
    );
    assert.equal(installed.schedule.periodDuration, 'P2D');
  });

  test('never advertises snapshot finality for an authoritative source', async () => {
    // The ledger installs an authoritative source as official only, so
    // advertising snapshot publishes a finality every install rejects.
    const authoritative = adapter();
    const { cadence, ...sourceOffering } = authoritative.sourceOffering;
    authoritative.sourceOffering = {
      ...sourceOffering,
      publicationClass: 'AUTHORITATIVE',
      finalization: {
        schedule: { sourceLocalReadyTime: '01:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT15M',
        worstCaseAvailabilityLag: 'PT1H',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P7D',
        correctionPolicy: 'immutable_correction',
      },
      revisionSemantics: 'official_with_declared_correction_policy',
    };
    authoritative.deliveryOffering.schedule.delivery_sla = 'PT2H';

    for (const supported of [['snapshot'], ['snapshot', 'official']]) {
      authoritative.deliveryOffering.supported_finality = supported;
      assert.throws(
        () => serviceFixture({ adapters: { fixture: authoritative } }),
        /cannot advertise snapshot delivery finality/,
        `supported_finality ${JSON.stringify(supported)} must be refused`
      );
    }

    // Official-only is the installable shape, and every advertised finality
    // must be one the ledger will accept.
    authoritative.deliveryOffering.supported_finality = ['official'];
    const { service } = serviceFixture({ adapters: { fixture: authoritative } });
    assert.deepEqual(service.capabilities.offerings[0].supported_finality, ['official']);
  });

  test('gates conditional shape and duration parseability before publishing capabilities', async () => {
    // A source_timezone offering without period_timezone_policy is invalid per
    // reporting-schedule-offering.json, so publishing it would fail a strict
    // get_adcp_capabilities for every buyer.
    const shapeless = adapter();
    delete shapeless.deliveryOffering.schedule.period_timezone_policy;
    assert.throws(
      () => serviceFixture({ adapters: { fixture: shapeless } }),
      /must advertise a period_timezone_policy/
    );

    const anchored = adapter();
    anchored.deliveryOffering.schedule.period_anchor = '2026-09-01T00:00:00.000Z';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: anchored } }),
      /advertises period_anchor, which 'source_timezone' alignment forbids/
    );

    // A snapshot SLA the service cannot express as a fixed duration was
    // published happily and then threw on every install.
    const monthly = adapter();
    monthly.deliveryOffering.schedule.delivery_sla = 'P1M';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: monthly } }),
      /delivery_sla of 'P1M' that this service cannot express/
    );

    const monthlyPeriod = adapter();
    monthlyPeriod.deliveryOffering.schedule.period_duration = 'P1M';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: monthlyPeriod } }),
      /period_duration of 'P1M' that this service cannot express/
    );
  });

  test('projects only the schema-allowed schedule fields for account_timezone', async () => {
    // reporting-schedule.json forbids period_timezone for account_timezone, and
    // a strict get_reporting_status rejects the whole response if it appears.
    const { service, store } = serviceFixture();
    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration();
    input.schedule.anchor = anchor;
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    store.configurations.get(installed.configurationId).installedAt = anchor;
    await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });

    // Rewrite the stored identity to account_timezone the way a non-service
    // ledger adopter could, then read it back through the status handler.
    store.configurations.get(installed.configurationId).schedule.alignment = 'account_timezone';
    // The store clones on read, so mutate the entries it actually holds.
    for (const obligation of store.obligations.values()) {
      obligation.schedule.alignment = 'account_timezone';
    }

    const status = await service.platform.getReportingStatus(
      { account: { account_id: 'account-a' }, view: 'periods' },
      { account: { id: 'account-a' }, agent: { agent_url: 'https://buyer.example' } }
    );
    const [obligation] = status.periods;
    assert.equal(obligation.schedule.alignment, 'account_timezone');
    assert.equal(obligation.schedule.period_timezone, undefined, 'account_timezone forbids period_timezone');
    assert.equal(obligation.schedule.period_anchor, undefined, 'account_timezone forbids period_anchor');
  });

  test('sleeps safely across an interval beyond the platform timer ceiling', async () => {
    const { service } = serviceFixture({ resolveCurrency: () => 'USD' });
    await service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } });
    let cycles = 0;
    service.producer.planObligations = async () => {
      cycles += 1;
      return [];
    };
    service.producer.runWorker = async () => ({ claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 });

    // 30 days exceeds setTimeout's 2^31-1 ms ceiling. Clamping it to 1ms turns
    // the scheduler into a tight ledger-scan loop.
    service.start({ intervalMilliseconds: 30 * 24 * 60 * 60 * 1_000, deploymentWide: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    const afterSleep = cycles;
    await service.stop();

    assert.equal(afterSleep, 1, `expected one cycle while sleeping, saw ${afterSleep}`);
    assert.equal(service.running, false);
  });

  test('accepts an injectable durable executor in place of the inline one', async () => {
    const inlineAdapter = adapter();
    const durable = createInlineReportingSourceExecutor(
      inlineAdapter.fetchSlice,
      structuredClone(inlineAdapter.sourceOffering)
    );
    const injected = {
      sourceOffering: inlineAdapter.sourceOffering,
      deliveryOffering: inlineAdapter.deliveryOffering,
      executor: durable,
    };
    const { service } = serviceFixture({ adapters: { fixture: injected } });
    const installed = await service.installConfiguration(configuration(), {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    assert.equal(installed.account.account_id, 'account-a');

    // Exactly one of the two must be supplied.
    assert.throws(
      () => serviceFixture({ adapters: { fixture: { ...injected, fetchSlice: inlineAdapter.fetchSlice } } }),
      /exactly one of fetchSlice or executor/
    );
    assert.throws(
      () => serviceFixture({ adapters: { fixture: { ...injected, executor: undefined } } }),
      /exactly one of fetchSlice or executor/
    );
  });

  test('refuses a snapshot delivery SLA shorter than the source worst case', async () => {
    const optimistic = adapter();
    optimistic.sourceOffering.cadence = {
      ...optimistic.sourceOffering.cadence,
      expectedAvailabilityLag: 'PT15M',
      worstCaseAvailabilityLag: 'PT6H',
    };
    optimistic.deliveryOffering.schedule.delivery_sla = 'PT0S';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: optimistic } }),
      /Snapshot reporting delivery SLA is shorter than the source worst-case/,
      'PT0S promises close-time delivery the source cannot make on a bad day'
    );

    // The expected lag is not the promise either: PT15M still under-promises.
    optimistic.deliveryOffering.schedule.delivery_sla = 'PT15M';
    assert.throws(
      () => serviceFixture({ adapters: { fixture: optimistic } }),
      /Snapshot reporting delivery SLA is shorter than the source worst-case/
    );

    // Advertising the worst case is truthful.
    optimistic.deliveryOffering.schedule.delivery_sla = 'PT6H';
    const truthful = serviceFixture({ adapters: { fixture: optimistic } });
    assert.equal(truthful.service.capabilities.offerings[0].schedule.delivery_sla, 'PT6H');
  });

  test('validates delivery metadata against the executor offering that actually routes', async () => {
    // An injected executor answering the declared ID with a different contract
    // would advertise definition A while storing and requesting B.
    const declared = adapter();
    const impostorOffering = structuredClone(declared.sourceOffering);
    impostorOffering.contract = {
      ...impostorOffering.contract,
      report_definition_id: 'delivery-daily-v2-impostor',
    };
    const impostor = createInlineReportingSourceExecutor(declared.fetchSlice, impostorOffering);
    assert.throws(
      () =>
        serviceFixture({
          adapters: {
            fixture: {
              sourceOffering: declared.sourceOffering,
              deliveryOffering: declared.deliveryOffering,
              executor: impostor,
            },
          },
        }),
      /executor offering contract differs from its declared source offering/
    );

    // An executor exposing the declared ID more than once is equally ambiguous.
    const duplicate = {
      capabilities: {
        ...impostor.capabilities,
        offerings: [structuredClone(declared.sourceOffering), structuredClone(declared.sourceOffering)],
      },
      execute: impostor.execute,
      read: impostor.read,
    };
    assert.throws(
      () =>
        serviceFixture({
          adapters: {
            fixture: {
              sourceOffering: declared.sourceOffering,
              deliveryOffering: declared.deliveryOffering,
              executor: duplicate,
            },
          },
        }),
      /exactly one offering with its declared ID/
    );
  });

  test('keeps a 130-period feed producing under an explicit replay retention policy', async () => {
    const ctx = () => ({ signal: new AbortController().signal });
    const key = period => `feed-period-${String(period).padStart(4, '0')}`;
    const executor = options =>
      createInlineReportingSourceExecutor(() => [], structuredClone(redactedReportingSourceOfferingV1), options);

    // Default: every admitted execution is retained, so an admitted key stays
    // replayable and the scope terminalizes at 100 periods.
    const bounded = executor(undefined);
    let boundedFailures = 0;
    let firstFailure;
    for (let period = 0; period < 130; period += 1) {
      const result = await bounded.execute(
        redactedReportingSourceRequestV1({ sourceExecutionKey: key(period) }),
        ctx()
      );
      if (!result.ok) {
        boundedFailures += 1;
        firstFailure ??= { period, code: result.error.code };
      }
    }
    assert.deepEqual(firstFailure, { period: 100, code: 'QUOTA_EXHAUSTED' });
    assert.equal(boundedFailures, 30, 'periods 101-130 terminalize without an explicit policy');

    // Opting in keeps the same feed producing for all 130 periods.
    const retained = executor({ replayRetention: { evictSettled: true } });
    for (let period = 0; period < 130; period += 1) {
      const result = await retained.execute(
        redactedReportingSourceRequestV1({ sourceExecutionKey: key(period) }),
        ctx()
      );
      assert.equal(result.ok, true, `period ${period} must still produce`);
    }

    // The service surfaces the same policy on its adapter.
    const { service } = serviceFixture({
      adapters: { fixture: { ...adapter(), inlineReplayRetention: { evictSettled: true } } },
    });
    const installed = await service.installConfiguration(configuration(), {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    assert.equal(installed.account.account_id, 'account-a');
  });

  test('keeps a legacy generation projecting the identity it was installed with', async () => {
    const { service, store } = serviceFixture();
    const now = new Date();
    const boundary = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const anchor = new Date(boundary - 86_400_000).toISOString();
    const input = configuration();
    input.schedule.anchor = anchor;
    const installed = await service.installConfiguration(input, {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    store.configurations.get(installed.configurationId).installedAt = anchor;
    await service.runCycle({ accountId: 'account-a', maxObligations: 1, maxWorkerIterations: 1 });

    // Strip the stored identity the way a pre-existing generation has it. Such
    // a generation was installed as billing_cycle and has always been projected
    // that way; re-deriving from its boundaries would call it `utc` and drop
    // the period_anchor its immutable schedule match depends on.
    store.configurations.get(installed.configurationId).schedule.alignment = undefined;
    for (const obligation of store.obligations.values()) {
      delete obligation.schedule.alignment;
      delete obligation.schedule.periodDuration;
      delete obligation.schedule.periodTimezone;
      delete obligation.schedule.deliverySlaDuration;
    }

    const status = await service.platform.getReportingStatus(
      { account: { account_id: 'account-a' }, view: 'periods' },
      { account: { id: 'account-a' }, agent: { agent_url: 'https://buyer.example' } }
    );
    const [obligation] = status.periods;
    assert.equal(obligation.schedule.alignment, 'billing_cycle');
    assert.equal(obligation.schedule.period_anchor, anchor, 'billing_cycle requires its anchor');
    assert.equal(obligation.schedule.period_timezone, 'UTC', 'billing_cycle requires its timezone');
  });

  test('judges a change-and-return by the operational window, not by history', async () => {
    // Asia/Tehran ran +04:30 through the summers of 2021 and 2022 and has been
    // a constant +03:30 since. Obligations begin at max(anchor, installedAt),
    // so a generation installed today never produces a 2021 period and those
    // transitions cannot put a boundary off local midnight — refusing it would
    // reject a schedule the service executes correctly. What must still be
    // refused is a zone whose offset moves inside the window that is actually
    // generated.
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    const tehran = zonedFixture('Asia/Tehran', { accountResolved: true });
    const origin = reportingScheduleOriginV1('source_timezone', 'Asia/Tehran');
    const historic = origin + Math.ceil((Date.parse('2021-01-15T00:00:00.000Z') - origin) / 86_400_000) * 86_400_000;
    const installed = await tehran.service.installConfiguration(
      configuration({
        expectedSourceTimezone: 'Asia/Tehran',
        schedule: {
          anchor: new Date(historic).toISOString(),
          periodMilliseconds: 86_400_000,
          deliverySlaMilliseconds: 0,
          recoveryWindowMilliseconds: 86_400_000,
        },
      }),
      context
    );
    assert.equal(installed.sourceTimezone, 'Asia/Tehran', 'history the planner never reaches must not refuse');

    // A zone whose offset moves inside the operational window is still refused.
    const dst = zonedFixture('America/New_York', { accountResolved: true });
    const nyOrigin = reportingScheduleOriginV1('source_timezone', 'America/New_York');
    const recent = nyOrigin + Math.ceil((Date.now() - nyOrigin) / 86_400_000) * 86_400_000;
    await assert.rejects(
      dst.service.installConfiguration(
        configuration({
          expectedSourceTimezone: 'America/New_York',
          schedule: {
            anchor: new Date(recent).toISOString(),
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /UTC offset|schedule-origin offset/,
      'an offset change inside the generated window must still refuse'
    );
  });

  test('reclaims staged evidence and accounting with the execution it evicts', async () => {
    const retained = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = period => `feed-period-${String(period).padStart(4, '0')}`;
    const request = period => redactedReportingSourceRequestV1({ sourceExecutionKey: key(period) });

    const first = request(0);
    const sealed = await retained.execute(first, ctx());
    assert.equal(sealed.ok, true);
    const manifest = JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8'));
    const staged = (manifest.objects ?? manifest.publication?.objects ?? [])[0];
    const readInput = {
      objectRef: staged.objectRef,
      objectGeneration: staged.objectGeneration,
      sourceScope: first.sourceScope,
      account: first.account,
      delivery_config_id: first.delivery_config_id,
      delivery_config_version: first.delivery_config_version,
      report_definition_id: first.report_definition_id,
      reporting_obligation_id: first.reporting_obligation_id,
      maxBytes: 1024 * 1024,
      signal: new AbortController().signal,
    };
    const before = await retained.read(readInput);
    assert.ok(before.byteLength > 0, 'staged evidence is readable while its execution is retained');

    // Fill the scope so the first execution is the one reclaimed.
    for (let period = 1; period <= 100; period += 1) {
      assert.equal((await retained.execute(request(period), ctx())).ok, true, `period ${period}`);
    }

    // The staged object is reclaimed with its execution, rather than lingering
    // under its old generation for a later replay to re-stage over.
    await assert.rejects(
      retained.read(readInput),
      /Inline staged object was not found/,
      'evicting an execution must reclaim its staged evidence too'
    );

    // Its bytes returned to the budget, so the scope keeps admitting work.
    for (let period = 101; period <= 130; period += 1) {
      assert.equal((await retained.execute(request(period), ctx())).ok, true, `period ${period} must still stage`);
    }
  });

  test('never advertises a zone whose protocol grid has no installable anchor', async () => {
    // Stable today, but their offset moved after the 1970 origin, so every
    // boundary derived from that origin misses local midnight by 30 or 15
    // minutes and no P1D anchor can ever install.
    for (const timezone of ['Asia/Singapore', 'Asia/Kathmandu']) {
      assert.throws(
        () => zonedFixture(timezone),
        /no longer observes its schedule-origin offset/,
        `${timezone} has no installable protocol anchor and must not be advertised`
      );
    }

    // A zone that has held one offset since the origin is still advertisable.
    const kolkata = zonedFixture('Asia/Kolkata');
    assert.equal(kolkata.service.capabilities.offerings[0].schedule.period_timezone, 'Asia/Kolkata');

    // Asia/Shanghai and Asia/Seoul each ran DST in the 1980s and returned to
    // their 1970 offset. Their grid still lands on local midnight and they are
    // stable across the operational horizon, so a recent generation installs —
    // scanning back to the origin refused them for history no obligation is
    // ever generated in.
    for (const timezone of ['Asia/Shanghai', 'Asia/Seoul']) {
      const stable = zonedFixture(timezone);
      assert.equal(
        stable.service.capabilities.offerings[0].schedule.period_timezone,
        timezone,
        `${timezone} is stable today and must remain advertisable`
      );
      // The protocol's own origin is the canonical anchor. Scanning from it
      // walked straight into the 1980s DST era these zones have long left,
      // refusing the exact schedule the same offering accepts at a recent
      // anchor — obligations begin at max(anchor, installedAt), so none of
      // that history is ever generated.
      const origin = reportingScheduleOriginV1('source_timezone', timezone);
      for (const anchorMs of [origin, origin + Math.ceil((Date.now() - origin) / 86_400_000) * 86_400_000]) {
        const installed = await stable.service.installConfiguration(
          configuration({
            delivery_config_id: `dc-${timezone}-${anchorMs}`,
            expectedSourceTimezone: timezone,
            schedule: {
              anchor: new Date(anchorMs).toISOString(),
              periodMilliseconds: 86_400_000,
              deliverySlaMilliseconds: 0,
              recoveryWindowMilliseconds: 86_400_000,
            },
          }),
          { account: { id: 'account-a', ctx_metadata: {} } }
        );
        assert.equal(
          installed.sourceTimezone,
          timezone,
          `${timezone} must install at ${new Date(anchorMs).toISOString()}`
        );
      }
    }
  });

  test('binds each route to its own adapter executor, not a shared offering ID', async () => {
    // A second adapter whose executor also exposes the first adapter's offering
    // ID must not be selectable for it.
    const primary = adapter();
    const secondary = adapter();
    secondary.sourceOffering = structuredClone(primary.sourceOffering);
    secondary.sourceOffering.offeringId = 'fixture-secondary';
    secondary.deliveryOffering = structuredClone(primary.deliveryOffering);
    secondary.deliveryOffering.offering_id = 'fixture-secondary';

    const { service } = serviceFixture({
      adapters: { primary, secondary },
      resolveSource: () => ({
        adapterId: 'secondary',
        sourceScope: { network_id: 'shared' },
        sourceTimezone: 'UTC',
      }),
    });

    // The configuration names the primary offering while routing to secondary.
    await assert.rejects(
      service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } }),
      /does not provide the selected offering/
    );

    // Routing to the adapter that actually owns the offering installs.
    const consistent = serviceFixture({
      adapters: { primary, secondary },
      resolveSource: () => ({ adapterId: 'primary', sourceScope: { network_id: 'shared' }, sourceTimezone: 'UTC' }),
    });
    const installed = await consistent.service.installConfiguration(configuration(), {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    assert.equal(installed.sourceScope._adcp_reporting_adapter, 'primary');
  });

  test('binds the full delivery contract to its executor at construction', async () => {
    const grainMismatch = adapter();
    grainMismatch.deliveryOffering.reporting_profile.grain = 'source_hour';
    assert.throws(() => serviceFixture({ adapters: { fixture: grainMismatch } }), /grain does not match/);

    const emptyFinality = adapter();
    emptyFinality.deliveryOffering.supported_finality = [];
    assert.throws(() => serviceFixture({ adapters: { fixture: emptyFinality } }), /at least one supported finality/);

    const duplicateFinality = adapter();
    duplicateFinality.deliveryOffering.supported_finality = ['snapshot', 'snapshot'];
    assert.throws(
      () => serviceFixture({ adapters: { fixture: duplicateFinality } }),
      /supported finality values must be unique/
    );
  });

  test('refuses a schedule identity that does not describe its own boundaries', async () => {
    // The producer is a public surface, and the status projection emits this
    // identity verbatim as the installed schedule.
    const { service } = serviceFixture();
    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;
    const install = schedule =>
      service.producer.installConfiguration({
        ...ledgerInput,
        schedule: { ...ledgerInput.schedule, ...schedule },
        account: { account_id: 'account-a' },
        sourceScope: { network_id: 'n' },
        sourceTimezone: 'UTC',
        sourceSettings: { ...sourceSettings, currency: 'USD' },
        contract: structuredClone(redactedReportingSourceOfferingV1.contract),
        constituents: [authorizedConstituent('account-a')],
        mediaBuyIds: ['media-buy-account-a'],
      });

    await assert.rejects(install({ periodDuration: 'P1M' }), /periodDuration does not describe/);
    await assert.rejects(install({ deliverySlaDuration: 'PT1H' }), /deliverySlaDuration does not describe/);
    await assert.rejects(
      install({ alignment: 'utc', periodTimezone: 'UTC' }),
      /utc alignment must not declare a period timezone/
    );
    await assert.rejects(install({ periodTimezone: 'UTC' }), /requires an explicit schedule alignment/);
    await assert.rejects(
      install({ alignment: 'source_timezone', periodTimezone: 'Asia/Kolkata' }),
      /periodTimezone does not match the configured source timezone/
    );

    // The identity the service itself installs is consistent.
    const ok = await install({ periodDuration: 'P1D', alignment: 'source_timezone', periodTimezone: 'UTC' });
    assert.equal(ok.schedule.periodDuration, 'P1D');
  });

  test('reclaims exactly one execution when the global ceiling frees the same scope', async () => {
    // Fill the global ceiling with the target scope oldest, so the global
    // reclamation picks a victim from that very scope. Recomputing the scope
    // against a stale count then charges a second victim for the same
    // admission, destroying replay evidence that was still owed.
    const retained = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const scoped = (scope, index) => {
      const value = redactedReportingSourceRequestV1({
        sourceExecutionKey: `scope-${scope}-${String(index).padStart(4, '0')}`,
      });
      value.sourceScope = { connection: `fixture-scope-${scope}`, region: 'test' };
      return value;
    };
    const readInputFor = (request, staged) => ({
      objectRef: staged.objectRef,
      objectGeneration: staged.objectGeneration,
      sourceScope: request.sourceScope,
      account: request.account,
      delivery_config_id: request.delivery_config_id,
      delivery_config_version: request.delivery_config_version,
      report_definition_id: request.report_definition_id,
      reporting_obligation_id: request.reporting_obligation_id,
      maxBytes: 1024 * 1024,
      signal: new AbortController().signal,
    });
    const stagedOf = sealed =>
      (JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8')).objects ?? [])[0];

    // Target scope first (100 = its ceiling), so its entries are the oldest.
    const targetReads = [];
    for (let index = 0; index < 100; index += 1) {
      const request = scoped(0, index);
      const sealed = await retained.execute(request, ctx());
      assert.equal(sealed.ok, true, `target ${index}`);
      targetReads.push(readInputFor(request, stagedOf(sealed)));
    }
    // Other scopes bring the executor to its global ceiling of 1000.
    for (let scope = 1; scope <= 9; scope += 1) {
      for (let index = 0; index < 100; index += 1) {
        assert.equal((await retained.execute(scoped(scope, index), ctx())).ok, true, `scope ${scope}/${index}`);
      }
    }

    // One more request for the target scope: globally and scope exhausted.
    assert.equal((await retained.execute(scoped(0, 100), ctx())).ok, true);

    // Exactly one of the target scope's staged objects may be gone.
    let reclaimed = 0;
    for (const input of targetReads) {
      try {
        await retained.read(input);
      } catch {
        reclaimed += 1;
      }
    }
    assert.equal(reclaimed, 1, 'a single admission must reclaim a single execution');
  });

  test('refuses a raw anchor that is off its declared protocol grid', async () => {
    // Only billing_cycle carries its anchor on the wire, so a utc or
    // source_timezone generation anchored at 06:00 would run 06:00 boundaries
    // while every buyer derives 00:00 from the protocol origin.
    const { service } = serviceFixture();
    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;
    const install = schedule =>
      service.producer.installConfiguration({
        ...ledgerInput,
        schedule: { ...ledgerInput.schedule, ...schedule },
        account: { account_id: 'account-a' },
        sourceScope: { network_id: 'n' },
        sourceTimezone: 'UTC',
        sourceSettings: { ...sourceSettings, currency: 'USD' },
        contract: structuredClone(redactedReportingSourceOfferingV1.contract),
        constituents: [authorizedConstituent('account-a')],
        mediaBuyIds: ['media-buy-account-a'],
      });

    for (const alignment of ['utc', 'source_timezone']) {
      await assert.rejects(
        install({
          alignment,
          anchor: '2026-09-01T06:00:00.000Z',
          ...(alignment === 'source_timezone' ? { periodTimezone: 'UTC' } : {}),
        }),
        /anchor is not on a period boundary derived from its protocol origin/,
        `${alignment} must not accept an off-grid anchor`
      );
    }

    // account_timezone has no origin this ledger can resolve, so it is refused
    // rather than published as a schedule nobody can reproduce.
    await assert.rejects(
      install({ alignment: 'account_timezone', anchor: '2026-09-01T00:00:00.000Z' }),
      /account_timezone alignment is not schedulable/
    );

    // billing_cycle emits its anchor, so an off-grid anchor stays reproducible.
    const billing = await install({
      alignment: 'billing_cycle',
      periodTimezone: 'UTC',
      anchor: '2026-09-01T06:00:00.000Z',
    });
    assert.equal(billing.schedule.alignment, 'billing_cycle');
  });

  test('reclaims settled evidence under byte pressure, not only at the count ceiling', async () => {
    // A scope can exhaust its byte budget long before its 100th slice. Without
    // byte-pressure reclamation every later slice terminalizes STAGING_FAILED
    // while the execution count is still well under the ceiling.
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      media_buy_id: 'fixture-media-buy',
      impressions: index,
      spend: '0.10',
    }));
    const executor = options =>
      createInlineReportingSourceExecutor(() => rows, structuredClone(redactedReportingSourceOfferingV1), options);
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `bytes-slice-${String(index).padStart(4, '0')}`;

    const bounded = executor(undefined);
    let boundedOk = 0;
    let boundedFailure;
    for (let index = 0; index < 90; index += 1) {
      const result = await bounded.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) }), ctx());
      if (result.ok) boundedOk += 1;
      else boundedFailure ??= { index, code: result.error.code };
    }
    assert.ok(boundedOk < 90, 'the scope byte budget is reached well before the 100-execution ceiling');
    assert.equal(boundedFailure.code, 'STAGING_FAILED');
    assert.ok(boundedFailure.index < 100, 'byte pressure, not the count ceiling, is what refuses here');

    // With an explicit policy the same feed keeps staging past that pressure.
    const retained = executor({ replayRetention: { evictSettled: true } });
    for (let index = 0; index < 90; index += 1) {
      const result = await retained.execute(
        redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) }),
        ctx()
      );
      assert.equal(result.ok, true, `slice ${index} must stage under byte pressure`);
    }
  });

  test('stays correct and bounded across many unique reclaimed scopes', async () => {
    // Reclamation now drops a scope's accounting row instead of parking a zero,
    // so a stream of admissions across unique scopes cannot grow that map
    // without limit. The row itself is internal — capacity math reads a missing
    // row and a zero row identically — so what is asserted here is that the
    // executor keeps admitting and staging correctly well past the global
    // ceiling, which is the behavior that bounded accounting has to sustain.
    const retained = createInlineReportingSourceExecutor(
      () => [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const scoped = scope => {
      const value = redactedReportingSourceRequestV1({
        sourceExecutionKey: `unique-scope-${String(scope).padStart(5, '0')}`,
      });
      value.sourceScope = { connection: `fixture-unique-${scope}`, region: 'test' };
      return value;
    };

    for (let scope = 0; scope < 1_100; scope += 1) {
      assert.equal((await retained.execute(scoped(scope), ctx())).ok, true, `scope ${scope}`);
    }
  });

  test('routes a null reporting_revision_id as the cumulative read it is', async () => {
    // A native cumulative handler alongside the installed ledger. Routing on
    // mere presence sent `reporting_revision_id: null` to the ledger as if it
    // were an exact read, so the cumulative request answered
    // SERVICE_UNAVAILABLE wherever request validation is off.
    const { service } = serviceFixture();
    const seen = [];
    const platform = service.install({
      capabilities: { specialisms: [], config: {} },
      accounts: {
        resolution: 'explicit',
        resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
        upsert: async () => [],
      },
      sales: {
        getMediaBuyDelivery: async request => {
          seen.push(request.media_buy_ids);
          return {
            reporting_period: { start: '2026-09-01', end: '2026-09-02' },
            currency: 'USD',
            media_buy_deliveries: [],
          };
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'null-revision-test',
      version: '1.0.0',
      adcpVersion: '3.2.0-rc.3',
      // Production shape: a null is never stripped before routing.
      validation: { requests: 'off', responses: 'off' },
    });

    const result = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_media_buy_delivery',
          arguments: {
            account: { account_id: 'account-a' },
            reporting_revision_id: null,
            media_buy_ids: ['media-buy-account-a'],
            start_date: '2026-09-01',
            end_date: '2026-09-02',
          },
        },
      },
      { authInfo: { clientId: 'buyer-a' } }
    );
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.deepEqual(seen, [['media-buy-account-a']], 'a null revision id is not an exact read');
  });

  test('refuses raw daily periods in a zone whose offset moves', async () => {
    // Boundaries advance by fixed milliseconds here while the spec advances
    // calendar days through local civil time. A P1D America/New_York
    // generation anchored at 05:00Z keeps computing 05:00Z after the spring
    // transition, where civil time says 04:00Z.
    const { service } = serviceFixture();
    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;
    const install = (schedule, overrides = {}) =>
      service.producer.installConfiguration({
        ...ledgerInput,
        ...overrides,
        schedule: { ...ledgerInput.schedule, ...schedule },
        account: { account_id: 'account-a' },
        sourceScope: { network_id: 'n' },
        sourceTimezone: overrides.sourceTimezone ?? 'UTC',
        sourceSettings: { ...sourceSettings, currency: 'USD' },
        contract: structuredClone(redactedReportingSourceOfferingV1.contract),
        constituents: [authorizedConstituent('account-a')],
        mediaBuyIds: ['media-buy-account-a'],
      });

    const origin = reportingScheduleOriginV1('source_timezone', 'America/New_York');
    const target = Date.parse('2026-03-01T00:00:00.000Z');
    const anchorMs = origin + Math.ceil((target - origin) / 86_400_000) * 86_400_000;
    await assert.rejects(
      install(
        { alignment: 'source_timezone', periodTimezone: 'America/New_York', anchor: new Date(anchorMs).toISOString() },
        { sourceTimezone: 'America/New_York' }
      ),
      /changes its UTC offset/,
      'a DST zone cannot be scheduled with fixed-length periods'
    );
  });

  test('refuses an official identity that understates the offset obligations expect', async () => {
    // expected_at is period end + officialAfterMilliseconds for an official
    // generation, so publishing the nominal SLA advertises PT2H while every
    // obligation is due six hours after close.
    const authoritative = adapter();
    const { cadence, ...sourceOffering } = authoritative.sourceOffering;
    authoritative.sourceOffering = {
      ...sourceOffering,
      publicationClass: 'AUTHORITATIVE',
      finalization: {
        schedule: { sourceLocalReadyTime: '01:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: 'PT15M',
        worstCaseAvailabilityLag: 'PT1H',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P7D',
        correctionPolicy: 'immutable_correction',
      },
      revisionSemantics: 'official_with_declared_correction_policy',
    };
    authoritative.deliveryOffering.supported_finality = ['official'];
    authoritative.deliveryOffering.schedule.delivery_sla = 'PT6H';
    const { service } = serviceFixture({ adapters: { fixture: authoritative } });

    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;
    const install = schedule =>
      service.producer.installConfiguration({
        ...ledgerInput,
        requiredFinality: 'official',
        finalityPolicy: {
          policyId: 'policy-1',
          basis: 'contractual_cutoff',
          durationAfterPeriodEndMilliseconds: 21_600_000,
        },
        schedule: {
          ...ledgerInput.schedule,
          deliverySlaMilliseconds: 21_600_000,
          officialAfterMilliseconds: 21_600_000,
          ...schedule,
        },
        account: { account_id: 'account-a' },
        sourceScope: { network_id: 'n' },
        sourceTimezone: 'UTC',
        sourceSettings: { ...sourceSettings, currency: 'USD' },
        contract: structuredClone(redactedReportingSourceOfferingV1.contract),
        constituents: [authorizedConstituent('account-a')],
        mediaBuyIds: ['media-buy-account-a'],
      });

    await assert.rejects(
      install({ deliverySlaDuration: 'PT2H' }),
      /deliverySlaDuration does not describe the offset its obligations expect/,
      'the published SLA must equal the offset obligations are due at'
    );

    // Publishing the official deadline itself is truthful.
    const consistent = await install({ deliverySlaDuration: 'PT6H' });
    assert.equal(consistent.schedule.deliverySlaDuration, 'PT6H');
  });

  test('does not destroy retained replay when a slice fails after reclaiming capacity', async () => {
    // Reclamation used to commit during projection/encoding, so a slice that
    // was later refused — invalid temporal evidence here — had already deleted
    // a valid replay to make room for work that never staged.
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      media_buy_id: 'fixture-media-buy',
      impressions: index,
      spend: '0.10',
    }));
    let invalidTemporal = false;
    const retained = createInlineReportingSourceExecutor(
      request =>
        invalidTemporal
          ? {
              reporting_period: { start: request.start_date, end: request.end_date },
              currency: 'USD',
              reporting_rows: rows,
              // Before the period even starts: refused as invalid evidence,
              // well after capacity has been arranged for.
              data_through: '2020-01-01T00:00:00.000Z',
              observed_at: '2020-01-01T00:00:00.000Z',
            }
          : rows,
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `pressure-slice-${String(index).padStart(4, '0')}`;

    // Fill the scope until it is under byte pressure.
    const staged = [];
    for (let index = 0; index < 47; index += 1) {
      const request = redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) });
      const sealed = await retained.execute(request, ctx());
      assert.equal(sealed.ok, true, `slice ${index}`);
      const object = (JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8')).objects ?? [])[0];
      staged.push({
        objectRef: object.objectRef,
        objectGeneration: object.objectGeneration,
        sourceScope: request.sourceScope,
        account: request.account,
        delivery_config_id: request.delivery_config_id,
        delivery_config_version: request.delivery_config_version,
        report_definition_id: request.report_definition_id,
        reporting_obligation_id: request.reporting_obligation_id,
        maxBytes: 8 * 1024 * 1024,
        signal: new AbortController().signal,
      });
    }
    const readable = async () => {
      let count = 0;
      for (const input of staged) {
        try {
          await retained.read({ ...input, signal: new AbortController().signal });
          count += 1;
        } catch {
          /* reclaimed */
        }
      }
      return count;
    };
    const before = await readable();
    assert.ok(before > 0, 'the scope must hold retained replays to risk');

    // A slice that reaches capacity handling and is then refused.
    invalidTemporal = true;
    const refused = await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(900) }), ctx());
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'SOURCE_PERMANENT');

    assert.equal(await readable(), before, 'a failed admission must not destroy retained replay');
  });

  test('refuses a future-dated anchor in a zone whose offset moves', async () => {
    // An anchor past now + horizon collapsed the scan to a zero-width window,
    // so a DST zone was accepted without ever being probed.
    // account_resolved leaves the zone unpinned, so nothing but the offset scan
    // can refuse this configuration.
    const { service } = zonedFixture('America/New_York', { accountResolved: true });
    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;
    const origin = reportingScheduleOriginV1('source_timezone', 'America/New_York');
    const target = Date.parse('2030-01-15T00:00:00.000Z');
    const anchorMs = origin + Math.ceil((target - origin) / 86_400_000) * 86_400_000;

    await assert.rejects(
      service.producer.installConfiguration({
        ...ledgerInput,
        schedule: {
          ...ledgerInput.schedule,
          alignment: 'source_timezone',
          periodTimezone: 'America/New_York',
          anchor: new Date(anchorMs).toISOString(),
        },
        account: { account_id: 'account-a' },
        sourceScope: { network_id: 'n' },
        sourceTimezone: 'America/New_York',
        sourceSettings: { ...sourceSettings, currency: 'USD' },
        contract: structuredClone(redactedReportingSourceOfferingV1.contract),
        constituents: [authorizedConstituent('account-a')],
        mediaBuyIds: ['media-buy-account-a'],
      }),
      /changes its UTC offset/,
      'a future anchor must still be probed for variable offset'
    );
  });

  test('does not destroy count-reclaimed replay when the slice then fails', async () => {
    // The count ceilings reclaimed before executeAndSeal ran, so a slice
    // refused by a later check had already deleted a valid replay.
    let invalidTemporal = false;
    const retained = createInlineReportingSourceExecutor(
      request =>
        invalidTemporal
          ? {
              reporting_period: { start: request.start_date, end: request.end_date },
              currency: 'USD',
              reporting_rows: [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
              data_through: '2020-01-01T00:00:00.000Z',
              observed_at: '2020-01-01T00:00:00.000Z',
            }
          : [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }],
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `count-slice-${String(index).padStart(4, '0')}`;

    // Fill the scope to its 100-execution ceiling, keeping the first readable.
    const first = redactedReportingSourceRequestV1({ sourceExecutionKey: key(0) });
    const sealed = await retained.execute(first, ctx());
    assert.equal(sealed.ok, true);
    const object = (JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8')).objects ?? [])[0];
    const readFirst = () =>
      retained.read({
        objectRef: object.objectRef,
        objectGeneration: object.objectGeneration,
        sourceScope: first.sourceScope,
        account: first.account,
        delivery_config_id: first.delivery_config_id,
        delivery_config_version: first.delivery_config_version,
        report_definition_id: first.report_definition_id,
        reporting_obligation_id: first.reporting_obligation_id,
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      });
    assert.ok((await readFirst()).byteLength > 0, 'the first execution is replayable');
    for (let index = 1; index < 100; index += 1) {
      assert.equal(
        (await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) }), ctx())).ok,
        true,
        `slice ${index}`
      );
    }

    // The 101st needs a count reclamation and is then refused.
    invalidTemporal = true;
    const refused = await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(100) }), ctx());
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'SOURCE_PERMANENT');

    assert.ok((await readFirst()).byteLength > 0, 'a slice refused after admission must leave the count victim intact');
  });

  test('reclaims global byte pressure from whichever scope holds it', async () => {
    // A fresh scope has no victims of its own, so searching only its own scope
    // left it STAGING_FAILED while other scopes held the global budget.
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      media_buy_id: 'fixture-media-buy',
      impressions: index,
      spend: '0.10',
    }));
    const retained = createInlineReportingSourceExecutor(
      () => rows,
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const scoped = (scope, index) => {
      const value = redactedReportingSourceRequestV1({
        sourceExecutionKey: `global-${scope}-${String(index).padStart(4, '0')}`,
      });
      value.sourceScope = { connection: `fixture-global-${scope}`, region: 'test' };
      return value;
    };

    // Consume the global budget across other scopes, each staying under its
    // own per-scope ceiling.
    let staged = 0;
    for (let scope = 0; scope < 12; scope += 1) {
      for (let index = 0; index < 46; index += 1) {
        const result = await retained.execute(scoped(scope, index), ctx());
        if (result.ok) staged += 1;
      }
    }
    assert.ok(staged > 0, 'the other scopes must hold staged evidence');

    // A fresh scope must still be able to stage, by reclaiming globally.
    const fresh = await retained.execute(scoped(99, 0), ctx());
    assert.equal(fresh.ok, true, `a fresh scope must reclaim globally, got ${fresh.ok ? '' : fresh.error.code}`);
  });

  test('advances past a zero-byte victim when reclaiming for capacity', async () => {
    // An empty slice reclaims its count and state but frees no bytes. Treating
    // that as "nothing left to reclaim" stranded the scope in STAGING_FAILED
    // with byte-producing victims still available behind it.
    const bulk = Array.from({ length: 10_000 }, (_, index) => ({
      media_buy_id: 'fixture-media-buy',
      impressions: index,
      spend: '0.10',
    }));
    let emptySlice = true;
    const retained = createInlineReportingSourceExecutor(
      () => (emptySlice ? [] : bulk),
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `zero-byte-${String(index).padStart(4, '0')}`;

    // Oldest entry stages nothing, so it is the first victim and frees 0 bytes.
    assert.equal(
      (await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(0) }), ctx())).ok,
      true
    );
    emptySlice = false;
    for (let index = 1; index <= 47; index += 1) {
      assert.equal(
        (await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) }), ctx())).ok,
        true,
        `slice ${index}`
      );
    }

    // Under byte pressure the zero-byte victim must not stop the search.
    const next = await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(48) }), ctx());
    assert.equal(next.ok, true, `slice 48 must reclaim past the empty victim, got ${next.ok ? '' : next.error.code}`);
  });

  test('credits the bytes its count victim is about to release', async () => {
    // The count ceiling reserves a victim the same commit will delete, so its
    // bytes belong to this slice. Discarding them does not fail outright —
    // byte pressure just reclaims more victims instead — so what is asserted
    // is that a single admission consumes only the one victim it needed.
    const rowsOf = count =>
      Array.from({ length: count }, (_, index) => ({
        media_buy_id: 'fixture-media-buy',
        impressions: index,
        spend: '0.10',
      }));
    const large = rowsOf(50_000);
    const filler = rowsOf(4_000);
    let issued = 0;
    const retained = createInlineReportingSourceExecutor(
      () => {
        const index = issued;
        issued += 1;
        // Oldest and the admitting slice are large; the scope in between sits
        // just under its byte ceiling.
        return index === 0 || index === 100 ? large : filler;
      },
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `credit-slice-${String(index).padStart(4, '0')}`;

    const staged = [];
    for (let index = 0; index < 100; index += 1) {
      const request = redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) });
      const sealed = await retained.execute(request, ctx());
      assert.equal(sealed.ok, true, `slice ${index}`);
      const object = (JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8')).objects ?? [])[0];
      staged.push({
        objectRef: object.objectRef,
        objectGeneration: object.objectGeneration,
        sourceScope: request.sourceScope,
        account: request.account,
        delivery_config_id: request.delivery_config_id,
        delivery_config_version: request.delivery_config_version,
        report_definition_id: request.report_definition_id,
        reporting_obligation_id: request.reporting_obligation_id,
        maxBytes: 8 * 1024 * 1024,
      });
    }
    const readable = async () => {
      let count = 0;
      for (const input of staged) {
        try {
          await retained.read({ ...input, signal: new AbortController().signal });
          count += 1;
        } catch {
          /* reclaimed */
        }
      }
      return count;
    };
    const before = await readable();

    // The 101st hits the count ceiling and needs roughly what its count victim
    // is about to release.
    const next = await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(100) }), ctx());
    assert.equal(next.ok, true, `slice 100 must stage, got ${next.ok ? '' : next.error.code}`);

    assert.equal(
      before - (await readable()),
      1,
      'crediting the count victim must make further byte reclamation unnecessary'
    );
  });

  test('never deletes evidence a concurrent replay joined after reservation', async () => {
    // A replay can join a reserved victim between planning and commit.
    // Reservation keeps the entry replayable on purpose, so the joiner must
    // not have its evidence deleted underneath it.
    let gate;
    const gated = new Promise(resolve => {
      gate = resolve;
    });
    let slow = false;
    const retained = createInlineReportingSourceExecutor(
      async () => {
        if (slow) await gated;
        return [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }];
      },
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `join-slice-${String(index).padStart(4, '0')}`;

    const oldest = redactedReportingSourceRequestV1({ sourceExecutionKey: key(0) });
    const sealed = await retained.execute(oldest, ctx());
    assert.equal(sealed.ok, true);
    const object = (JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8')).objects ?? [])[0];
    for (let index = 1; index < 100; index += 1) {
      assert.equal(
        (await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) }), ctx())).ok,
        true,
        `slice ${index}`
      );
    }

    // Hold the 101st inside its fetch, with the oldest entry reserved.
    slow = true;
    const admitting = retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(100) }), ctx());
    await new Promise(resolve => setImmediate(resolve));
    // A replay joins the reserved victim while that admission is in flight.
    const replay = await retained.execute(oldest, ctx());
    assert.equal(replay.ok, true, 'a reserved entry stays replayable');
    gate();
    assert.equal((await admitting).ok, true);

    // The joiner's evidence must still be readable.
    const bytes = await retained.read({
      objectRef: object.objectRef,
      objectGeneration: object.objectGeneration,
      sourceScope: oldest.sourceScope,
      account: oldest.account,
      delivery_config_id: oldest.delivery_config_id,
      delivery_config_version: oldest.delivery_config_version,
      report_definition_id: oldest.report_definition_id,
      reporting_obligation_id: oldest.reporting_obligation_id,
      maxBytes: 1024 * 1024,
      signal: new AbortController().signal,
    });
    assert.ok(bytes.byteLength > 0, 'a successful concurrent replay must not be invalidated');
  });

  test('refuses coverage whose constituent-metric product exceeds the slice bound', async () => {
    // Every slice carries one availability cell per constituent-metric pair,
    // and the source contract bounds that product. 501 constituents against
    // two metrics installed cleanly and then failed every execution.
    const many = Array.from({ length: 501 }, (_, index) => {
      const constituent = authorizedConstituent('account-a');
      constituent.constituentId = `constituent-${index}`;
      return constituent;
    });
    const { service } = serviceFixture({ resolveCoverage: () => ({ constituents: many }) });
    await assert.rejects(
      service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } }),
      /per-slice metric availability bound/,
      '501 constituents x 2 metrics exceeds the bound and must not install'
    );
  });

  test('a stale admission cannot delete a claim that was revoked and re-taken', async t => {
    // A reserves V; a replay revokes it; B re-reserves V; A commits. With a
    // bare reserved flag A saw "reserved" and deleted B's victim — evidence a
    // replay had already been served from.
    //
    // Every wait below is bounded, so a build without the fix fails on the
    // assertion or the budget rather than hanging the suite.
    const budget = async (promise, label, ms = 10_000) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const waitUntil = async (predicate, label, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };

    let stall = false;
    let entered = 0;
    const gates = [];
    const retained = createInlineReportingSourceExecutor(
      async () => {
        if (stall) {
          entered += 1;
          await new Promise(resolve => gates.push(resolve));
        }
        return [{ media_buy_id: 'fixture-media-buy', impressions: 1, spend: '0.10' }];
      },
      structuredClone(redactedReportingSourceOfferingV1),
      { replayRetention: { evictSettled: true } }
    );
    const ctx = () => ({ signal: new AbortController().signal });
    const key = index => `aba-slice-${String(index).padStart(4, '0')}`;

    // Whatever the outcome, every held fetch is released and awaited, so a
    // build without the fix fails on its assertion instead of leaving the
    // runner waiting on work nobody will unblock.
    const inFlight = [];
    t.after(async () => {
      stall = false;
      while (gates.length > 0) gates.shift()();
      await Promise.allSettled(inFlight);
    });

    const oldest = redactedReportingSourceRequestV1({ sourceExecutionKey: key(0) });
    const sealed = await retained.execute(oldest, ctx());
    assert.equal(sealed.ok, true);
    const object = (JSON.parse(Buffer.from(Object.values(sealed.manifestBytes)).toString('utf8')).objects ?? [])[0];
    for (let index = 1; index < 100; index += 1) {
      assert.equal(
        (await retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(index) }), ctx())).ok,
        true,
        `slice ${index}`
      );
    }

    // A reserves the oldest and is held inside its fetch.
    stall = true;
    const admissionA = retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(100) }), ctx());
    inFlight.push(admissionA);
    await waitUntil(() => entered === 1, 'admission A to enter its fetch');

    // A replay revokes A's claim on the oldest entry.
    assert.equal((await retained.execute(oldest, ctx())).ok, true, 'a claimed entry stays replayable');

    // B re-reserves that same entry and is held too.
    const admissionB = retained.execute(redactedReportingSourceRequestV1({ sourceExecutionKey: key(101) }), ctx());
    inFlight.push(admissionB);
    await waitUntil(() => entered === 2, 'admission B to enter its fetch');

    // A commits first. Its claim was revoked and re-taken, so it must leave
    // the entry alone — B still holds the claim and has not committed.
    gates.shift()();
    assert.equal((await budget(admissionA, 'admission A')).ok, true);

    const readOldest = () =>
      retained.read({
        objectRef: object.objectRef,
        objectGeneration: object.objectGeneration,
        sourceScope: oldest.sourceScope,
        account: oldest.account,
        delivery_config_id: oldest.delivery_config_id,
        delivery_config_version: oldest.delivery_config_version,
        report_definition_id: oldest.report_definition_id,
        reporting_obligation_id: oldest.reporting_obligation_id,
        maxBytes: 1024 * 1024,
        signal: new AbortController().signal,
      });
    const bytes = await budget(readOldest(), 'read after A committed');
    assert.ok(bytes.byteLength > 0, "a stale commit must not delete another transaction's claim");

    gates.shift()();
    assert.equal((await budget(admissionB, 'admission B')).ok, true);
  });

  test('installs the recovery window it advertises, so pending matches the promise', async () => {
    // recoveryDeadlineAt drives the buyer-facing consumer_status_pending
    // signal, and it is computed from the configured window. A configuration
    // undercutting the advertised value marked buyers pending hours before the
    // deadline the capability promised.
    const { service } = serviceFixture();
    assert.equal(service.capabilities.automated_recovery_window_seconds, 86_400);
    await assert.rejects(
      service.installConfiguration(
        configuration({
          schedule: {
            anchor: '2026-09-01T00:00:00.000Z',
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 3_600_000,
          },
        }),
        { account: { id: 'account-a', ctx_metadata: {} } }
      ),
      /must equal the advertised automated recovery window/,
      'a shorter window would page buyers before the advertised deadline'
    );

    const installed = await service.installConfiguration(configuration(), {
      account: { id: 'account-a', ctx_metadata: {} },
    });
    assert.equal(installed.schedule.recoveryWindowMilliseconds, 86_400_000);
  });

  test('refuses to widen a tenant cycle into a deployment-wide scan without the explicit opt-in', async () => {
    const { service } = serviceFixture();
    const seen = [];
    service.producer.planObligations = async (_now, options) => {
      seen.push(['plan', options?.account_id]);
      return [];
    };
    service.producer.runWorker = async options => {
      seen.push(['worker', options?.account_id]);
      return { claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 };
    };

    for (const cycle of [{ accountId: '' }, { accountId: '   '.repeat(100) }, {}, { deploymentWide: false }]) {
      await assert.rejects(
        service.runCycle(cycle),
        /deploymentWide: true or a bounded non-empty accountId/,
        `an unscoped cycle must fail closed: ${JSON.stringify(cycle)}`
      );
    }
    await assert.rejects(
      service.runCycle({ deploymentWide: true, accountId: 'account-a' }),
      /cannot combine deploymentWide with an accountId/
    );
    assert.deepEqual(seen, [], 'no rejected cycle reached the producer');

    await service.runCycle({ deploymentWide: true });
    assert.deepEqual(seen, [
      ['plan', undefined],
      ['worker', undefined],
    ]);
  });

  test('pins the official deadline to the advertised delivery SLA', async () => {
    const officialAdapter = adapter();
    const { cadence, ...sourceOffering } = officialAdapter.sourceOffering;
    officialAdapter.sourceOffering = {
      ...sourceOffering,
      publicationClass: 'AUTHORITATIVE',
      finalization: {
        // Finalizes 01:00 source-local the same day, then PT15M to publish:
        // reachable inside the PT2H official SLA advertised below.
        schedule: { sourceLocalReadyTime: '01:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: cadence.expectedAvailabilityLag,
        // Worst case 1h after a 01:00 finalization = a 2h floor, exactly the
        // PT2H the offering advertises below.
        worstCaseAvailabilityLag: 'PT1H',
        triggerSupport: cadence.triggerSupport,
        correctionWindow: 'P7D',
        correctionPolicy: 'immutable_correction',
      },
      revisionSemantics: 'official_with_declared_correction_policy',
    };
    officialAdapter.deliveryOffering.supported_finality = ['official'];
    officialAdapter.deliveryOffering.schedule.delivery_sla = 'PT2H';
    const { service } = serviceFixture({ adapters: { fixture: officialAdapter } });
    const advertised = service.capabilities.offerings[0].schedule.delivery_sla;
    assert.equal(advertised, 'PT2H');

    const official = overrides =>
      configuration({
        requiredFinality: 'official',
        finalityPolicy: {
          policyId: 'policy-1',
          basis: 'contractual_cutoff',
          durationAfterPeriodEndMilliseconds: 7_200_000,
        },
        schedule: {
          anchor: '2026-09-01T00:00:00.000Z',
          periodMilliseconds: 86_400_000,
          deliverySlaMilliseconds: 7_200_000,
          recoveryWindowMilliseconds: 86_400_000,
          ...overrides,
        },
      });
    const context = { account: { id: 'account-a', ctx_metadata: {} } };

    await assert.rejects(
      service.installConfiguration(official({ officialAfterMilliseconds: 21_600_000 }), context),
      /official deadline must equal the advertised delivery SLA/,
      'a divergent official deadline would make discovery untruthful'
    );

    // The omitted deadline derives the advertised SLA, and an explicit one may
    // only restate it; both describe the same expected_at.
    const derived = await service.installConfiguration(official(), context);
    assert.equal(derived.schedule.officialAfterMilliseconds, undefined);
    assert.equal(derived.schedule.deliverySlaMilliseconds, 7_200_000);
    const restated = await service.installConfiguration(
      { ...official({ officialAfterMilliseconds: 7_200_000 }), delivery_config_id: 'delivery-config-restated' },
      context
    );
    assert.equal(restated.schedule.officialAfterMilliseconds, 7_200_000);
  });

  test('replays a pre-service configuration generation without breaking its fingerprint', async () => {
    const { service, store } = serviceFixture();
    const context = { account: { id: 'account-a', ctx_metadata: {} } };
    const input = configuration();
    const { expectedCurrency, expectedSourceTimezone, sourceSettings, ...ledgerInput } = input;

    // Exactly what a pre-service deployment installed straight through the
    // producer: no reserved adapter route key in sourceScope.
    const legacy = await service.producer.installConfiguration({
      ...ledgerInput,
      account: { account_id: 'account-a' },
      sourceScope: { network_id: 'network-account-a' },
      sourceTimezone: 'UTC',
      sourceSettings: { ...sourceSettings, currency: 'USD' },
      contract: structuredClone(redactedReportingSourceOfferingV1.contract),
      constituents: [authorizedConstituent('account-a')],
      mediaBuyIds: ['media-buy-account-a'],
    });
    assert.equal(legacy.sourceScope._adcp_reporting_adapter, undefined);

    const replayed = await service.installConfiguration(configuration(), context);
    assert.equal(replayed.configurationId, legacy.configurationId);
    assert.equal(replayed.semanticFingerprint, legacy.semanticFingerprint);
    assert.deepEqual(replayed.sourceScope, { network_id: 'network-account-a' });
    assert.equal((await store.listConfigurations('account-a')).length, 1);

    // The keyless scope is reused only for that exact predecessor: a changed
    // route still fails immutability, and a new generation carries the key.
    const rerouted = serviceFixture({
      store,
      resolveSource: () => ({ adapterId: 'fixture', sourceScope: { network_id: 'other' }, sourceTimezone: 'UTC' }),
    });
    await assert.rejects(rerouted.service.installConfiguration(configuration(), context), /immutable/i);

    const next = await service.installConfiguration(configuration({ delivery_config_version: 2 }), context);
    assert.deepEqual(next.sourceScope, {
      network_id: 'network-account-a',
      _adcp_reporting_adapter: 'fixture',
    });
  });

  test('keeps scheduling later tenants after one account cycle fails', async () => {
    const { service } = serviceFixture();
    const planned = [];
    const errors = [];
    service.producer.planObligations = async (_now, options) => {
      planned.push(options?.account_id);
      if (options?.account_id === 'account-a') throw new Error('account-a upstream is down');
      return [];
    };
    service.producer.runWorker = async () => ({ claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 });

    service.start({
      intervalMilliseconds: 60_000,
      accountIds: ['account-a', 'account-b', 'account-c'],
      onError: error => {
        errors.push(String(error));
      },
    });
    while (planned.length < 3) await new Promise(resolve => setImmediate(resolve));
    await service.stop();

    assert.deepEqual(planned, ['account-a', 'account-b', 'account-c']);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /account-a upstream is down/);
  });

  test('runs explicitly per account and shuts down a deployment-wide scheduler gracefully', async () => {
    const { service } = serviceFixture();
    // The deployment-wide scheduler works off the ledger's account roster, so
    // give it one installed tenant to find.
    await service.installConfiguration(configuration(), { account: { id: 'account-a', ctx_metadata: {} } });
    const seen = [];
    service.producer.planObligations = async (_now, options) => {
      seen.push(['plan', options?.account_id]);
      return [];
    };
    service.producer.runWorker = async options => {
      seen.push(['worker', options?.account_id]);
      return { claimed: 0, revisionsCommitted: 0, notReady: 0, failed: 0 };
    };
    await service.runCycle({ accountId: 'account-a' });
    assert.deepEqual(seen, [
      ['plan', 'account-a'],
      ['worker', 'account-a'],
    ]);

    seen.length = 0;
    // A deployment-wide scheduler now enumerates the ledger's roster so each
    // tenant gets its own bounded cycle; `runCycle({ deploymentWide: true })`
    // remains the single unscoped sweep for callers that want it.
    service.start({ intervalMilliseconds: 60_000, deploymentWide: true });
    for (let tick = 0; tick < 200 && seen.length < 2; tick += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await service.stop();
    assert.equal(service.running, false);
    assert.deepEqual(seen, [
      ['plan', 'account-a'],
      ['worker', 'account-a'],
    ]);

    const errors = [];
    service.start({
      intervalMilliseconds: 60_000,
      accountIds: () => undefined,
      onError: error => {
        errors.push(error);
        throw new Error('observer failure');
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.running, true);
    await service.stop();
    assert.match(String(errors[0]), /must return an array/);
  });
});
