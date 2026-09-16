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
    constituents: request.coverage.constituents,
    mediaBuyIds: request.coverage.mediaBuyIds,
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
