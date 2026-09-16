const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const {
  createReliableReportingService,
  runReliableReportingServiceConformanceV1,
} = require('../../dist/lib/reporting/service/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
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
  return {
    sourceOffering: structuredClone(redactedReportingSourceOfferingV1),
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
  { alignment = 'source_timezone', periodDuration = 'P1D', minimumWindow, periodTimezone } = {}
) {
  const zoned = adapter();
  zoned.sourceOffering.sourceTimezone = { ...zoned.sourceOffering.sourceTimezone, ianaTimezone: timezone };
  if (minimumWindow) {
    zoned.sourceOffering.windowing = { ...zoned.sourceOffering.windowing, minimumWindow };
  }
  zoned.deliveryOffering.schedule = {
    ...zoned.deliveryOffering.schedule,
    alignment,
    period_duration: periodDuration,
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

  test('refuses schedule semantics the installed executor cannot satisfy', async () => {
    const context = { account: { id: 'account-a', ctx_metadata: {} } };

    // Alignment the service does not generate periods for.
    for (const alignment of ['billing_cycle', 'account_timezone']) {
      const { service } = zonedFixture('UTC', { alignment });
      await assert.rejects(
        service.installConfiguration(configuration(), context),
        /cannot honor '.*' period alignment/,
        `${alignment} must be refused`
      );
    }

    // UTC-aligned offerings need a zero-offset source timezone.
    const utcAligned = zonedFixture('Asia/Kolkata', { alignment: 'utc' });
    await assert.rejects(
      utcAligned.service.installConfiguration(
        configuration({
          expectedSourceTimezone: 'Asia/Kolkata',
          schedule: {
            anchor: '2026-09-01T18:30:00.000Z', // Kolkata-local midnight
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /UTC offset is zero/
    );

    // An anchor that is not source-local midnight: the executor refuses every
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
      /anchor must fall on source-local midnight/
    );

    // A delivery offering that advertises UTC periods while its source resolves
    // to a different zone. The source/offering timezone agreement check does
    // not see this: it compares the *source* offering, not the advertised
    // period timezone buyers read from discovery.
    const mismatched = zonedFixture('Asia/Kolkata', { periodTimezone: 'UTC' });
    await assert.rejects(
      mismatched.service.installConfiguration(
        configuration({
          expectedSourceTimezone: 'Asia/Kolkata',
          schedule: {
            anchor: '2026-09-01T18:30:00.000Z',
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /pins a period timezone that is not the resolved source timezone/
    );

    // A DST-observing zone: `anchor + n * 24h` drifts off local midnight after
    // the transition, so fixed-length periods cannot express its local days.
    const dst = zonedFixture('America/New_York');
    await assert.rejects(
      dst.service.installConfiguration(
        configuration({
          expectedSourceTimezone: 'America/New_York',
          schedule: {
            anchor: '2026-09-01T04:00:00.000Z', // 2026-09-01T00:00 EDT
            periodMilliseconds: 86_400_000,
            deliverySlaMilliseconds: 0,
            recoveryWindowMilliseconds: 86_400_000,
          },
        }),
        context
      ),
      /changes its UTC offset/
    );

    // Sub-day windows have no source-local midnight boundary. The inline
    // executor refuses the offering outright, so the service never constructs.
    assert.throws(
      () => zonedFixture('UTC', { periodDuration: 'PT12H', minimumWindow: 'PT12H' }),
      /whole source-day fixed windows/
    );

    // Positive control: a fixed-offset non-UTC zone is still installable, so
    // the rule is "no offset changes", not "UTC only".
    const kolkata = zonedFixture('Asia/Kolkata');
    const installed = await kolkata.service.installConfiguration(
      configuration({
        expectedSourceTimezone: 'Asia/Kolkata',
        schedule: {
          anchor: '2026-09-01T18:30:00.000Z',
          periodMilliseconds: 86_400_000,
          deliverySlaMilliseconds: 0,
          recoveryWindowMilliseconds: 86_400_000,
        },
      }),
      context
    );
    assert.equal(installed.sourceTimezone, 'Asia/Kolkata');
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
        schedule: { sourceLocalReadyTime: '02:00', daysAfterPeriodEnd: 0 },
        expectedAvailabilityLag: cadence.expectedAvailabilityLag,
        worstCaseAvailabilityLag: cadence.worstCaseAvailabilityLag,
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
    service.start({ intervalMilliseconds: 60_000, deploymentWide: true });
    await new Promise(resolve => setImmediate(resolve));
    await service.stop();
    assert.equal(service.running, false);
    assert.deepEqual(seen, [
      ['plan', undefined],
      ['worker', undefined],
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
