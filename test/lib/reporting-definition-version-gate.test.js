// A report definition at contract_version 1.2 serves AdCP 3.3 callers only
// (core/reporting-report-definition.json x-adcp-validation.package_dimension, adcp-client#3709).
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

process.env.NODE_ENV = 'test';

const { createReliableReportingService } = require('../../dist/lib/reporting/service/index.js');
const {
  redactedReportingSourceOfferingV1,
  redactedReportingSourceRequestV1,
} = require('../../dist/lib/reporting/source/index.js');
const { createAdcpServerFromPlatform } = require('../../dist/lib/server/decisioning/runtime/from-platform.js');
const { PlatformConfigError } = require('../../dist/lib/server/decisioning/runtime/validate-platform.js');
const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');
const { MemoryLedgerStore } = require('../helpers/memory-reporting-ledger-store.js');

const SHA_11 = redactedReportingSourceOfferingV1.contract.reportDefinitionSha256;
const SHA_12 = 'b'.repeat(64);
const ID_11 = redactedReportingSourceOfferingV1.offeringId;
const ID_12 = 'fixture-daily-snapshot-v12';

function deliveryOffering(source) {
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

/** A fixture adapter; `variant` re-keys it to its own offering id and report definition. */
function adapter({ offeringId = ID_11, sha = SHA_11 } = {}) {
  const sourceOffering = structuredClone(redactedReportingSourceOfferingV1);
  sourceOffering.cadence = {
    ...sourceOffering.cadence,
    expectedAvailabilityLag: 'PT0S',
    worstCaseAvailabilityLag: 'PT0S',
  };
  sourceOffering.offeringId = offeringId;
  sourceOffering.contract = {
    ...sourceOffering.contract,
    reportDefinitionSha256: sha,
    reportDefinitionUri: `https://sdk.example/reporting/${offeringId}.json`,
  };
  return {
    sourceOffering,
    deliveryOffering: deliveryOffering(sourceOffering),
    fetchSlice: (request, context) => ({
      reporting_period: { start: request.start_date, end: request.end_date },
      currency: context.sourceSettings.currency,
      reporting_rows: [],
    }),
  };
}

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

function configuration(offeringId, overrides = {}) {
  const request = redactedReportingSourceRequestV1();
  const { currency: _currency, ...sourceSettings } = request.sourceSettings;
  return {
    delivery_config_id: 'delivery-config',
    delivery_config_version: 1,
    offeringId,
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

function serviceFixture(overrides = {}) {
  const store = new MemoryLedgerStore();
  const service = createReliableReportingService({
    store,
    adapters: { fixture: adapter() },
    contact: { name: 'Reporting operations', email: 'reporting@example.com' },
    automatedRecoveryWindowSeconds: 86_400,
    statusRetentionDays: redactedReportingSourceOfferingV1.retentionDays,
    resolveSource: account => ({
      adapterId: 'fixture',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    resolveCurrency: () => 'USD',
    resolveCoverage: account => ({ constituents: [authorizedConstituent(account.id)] }),
    ...overrides,
  });
  return { service, store };
}

/** One service with a declared-1.1 and a declared-1.2 offering, or only the 1.2 one. */
function twoOfferings(overrides = {}) {
  return serviceFixture({
    adapters: { v11: adapter(), v12: adapter({ offeringId: ID_12, sha: SHA_12 }) },
    resolveSource: account => ({
      adapterId: 'v11',
      sourceScope: { network_id: `network-${account.id}` },
      sourceTimezone: 'UTC',
    }),
    reportDefinitionVersions: { [SHA_11]: '1.1', [SHA_12]: '1.2' },
    ...overrides,
  });
}

const account = { id: 'account-a', ctx_metadata: {} };

/** Captures console.warn lines tagged [adcp/reporting] while `fn` runs. */
function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => lines.push(args.map(String).join(' '));
  try {
    const value = fn();
    return { value, lines: lines.filter(line => line.includes('[adcp/reporting]')) };
  } finally {
    console.warn = original;
  }
}

describe('reportDefinitionVersions option validation', () => {
  test('rejects a key that is not 64 lowercase hex', () => {
    for (const key of ['abc', 'A'.repeat(64), SHA_11.toUpperCase(), `${SHA_11}0`, 'g'.repeat(64)]) {
      assert.throws(
        () => serviceFixture({ reportDefinitionVersions: { [key]: '1.1' } }),
        error => error instanceof TypeError && /lowercase-hex/.test(error.message),
        `key ${key}`
      );
    }
  });

  test('rejects a version outside 1.0, 1.1, 1.2', () => {
    for (const version of ['1.3', '2.0', 1.1, undefined, null, '']) {
      assert.throws(
        () => serviceFixture({ reportDefinitionVersions: { [SHA_11]: version } }),
        error => error instanceof TypeError && /must be one of 1\.0, 1\.1, 1\.2/.test(error.message),
        `version ${String(version)}`
      );
    }
  });

  test('rejects a non-object map', () => {
    for (const map of ['1.2', 12, [], [SHA_11], null]) {
      assert.throws(
        () => serviceFixture({ reportDefinitionVersions: map }),
        error => error instanceof TypeError && /reportDefinitionVersions must map/.test(error.message),
        `map ${JSON.stringify(map)}`
      );
    }
  });

  test('rejects an unknown undeclaredReportDefinitions value', () => {
    for (const value of ['withhold', 'assume_1_2', '', null, true]) {
      assert.throws(
        () =>
          serviceFixture({
            reportDefinitionVersions: { [SHA_11]: '1.1' },
            undeclaredReportDefinitions: value,
          }),
        error => error instanceof TypeError && /undeclaredReportDefinitions/.test(error.message),
        `value ${String(value)}`
      );
    }
  });

  test('accepts a map covering every version', () => {
    const { service } = serviceFixture({ reportDefinitionVersions: { [SHA_11]: '1.0' } });
    assert.equal(service.platform.adcp33OnlyOfferingIds, undefined);
  });
});

describe('platform.adcp33OnlyOfferingIds', () => {
  test('lists only the offerings declared 1.2', () => {
    const { service } = twoOfferings();
    assert.deepEqual(service.platform.adcp33OnlyOfferingIds, [ID_12]);
  });

  test('is absent when every offering is declared 1.0 or 1.1', () => {
    const { service } = serviceFixture({ reportDefinitionVersions: { [SHA_11]: '1.1' } });
    assert.equal('adcp33OnlyOfferingIds' in service.platform, false);
  });

  test('is absent for an undeclared offering under the default', () => {
    const { service } = serviceFixture({ adapters: { fixture: adapter({ offeringId: 'undeclared-default-absent' }) } });
    assert.equal('adcp33OnlyOfferingIds' in service.platform, false);
  });

  test('withhold_from_pre_3_3 adds the undeclared offerings to the declared 1.2 ones', () => {
    const { service } = twoOfferings({
      adapters: {
        v11: adapter(),
        v12: adapter({ offeringId: ID_12, sha: SHA_12 }),
        undeclared: adapter({ offeringId: 'undeclared-offering', sha: 'c'.repeat(64) }),
      },
      undeclaredReportDefinitions: 'withhold_from_pre_3_3',
    });
    assert.deepEqual([...service.platform.adcp33OnlyOfferingIds].sort(), [ID_12, 'undeclared-offering'].sort());
  });

  test('withhold_from_pre_3_3 does not withhold a declared 1.1 offering', () => {
    const { service } = serviceFixture({
      reportDefinitionVersions: { [SHA_11]: '1.1' },
      undeclaredReportDefinitions: 'withhold_from_pre_3_3',
    });
    assert.equal('adcp33OnlyOfferingIds' in service.platform, false);
  });
});

describe('undeclared report definition warning', () => {
  test('names the offering, sha256, URI and option once per process under the default', () => {
    const offeringId = 'warned-offering-once';
    const sha = 'd'.repeat(64);
    const build = () => serviceFixture({ adapters: { fixture: adapter({ offeringId, sha }) } });
    const first = captureWarnings(build);
    assert.equal(first.lines.length, 1);
    const [line] = first.lines;
    assert.match(line, /\[adcp\/reporting\]/);
    assert.ok(line.includes(JSON.stringify(offeringId)), 'names the offering id');
    assert.ok(line.includes(sha), 'names the sha256');
    assert.ok(line.includes(`https://sdk.example/reporting/${offeringId}.json`), 'names the URI');
    assert.ok(line.includes('reportDefinitionVersions'), 'names the option to set');
    const second = captureWarnings(build);
    assert.deepEqual(second.lines, [], 'deduped per process');
  });

  test('does not warn when the definition is declared', () => {
    const { lines } = captureWarnings(() =>
      serviceFixture({
        adapters: { fixture: adapter({ offeringId: 'declared-no-warning', sha: 'e'.repeat(64) }) },
        reportDefinitionVersions: { ['e'.repeat(64)]: '1.1' },
      })
    );
    assert.deepEqual(lines, []);
  });

  test('does not warn under withhold_from_pre_3_3', () => {
    const { lines } = captureWarnings(() =>
      serviceFixture({
        adapters: { fixture: adapter({ offeringId: 'withheld-no-warning', sha: 'f'.repeat(64) }) },
        undeclaredReportDefinitions: 'withhold_from_pre_3_3',
      })
    );
    assert.deepEqual(lines, []);
  });
});

describe('installConfiguration servedAdcpVersion gate', () => {
  async function install(servedAdcpVersion, offeringId) {
    const { service } = twoOfferings();
    return service.installConfiguration(configuration(offeringId), {
      account,
      ...(servedAdcpVersion !== undefined ? { servedAdcpVersion } : {}),
    });
  }

  for (const served of ['3.2', '3.2.10']) {
    test(`refuses a 1.2 offering for a caller served ${served}`, async () => {
      await assert.rejects(
        () => install(served, ID_12),
        error => {
          assert.ok(error instanceof AdcpError);
          assert.equal(error.code, 'UNSUPPORTED_FEATURE');
          assert.equal(error.recovery, 'correctable');
          assert.equal(error.field, 'reporting_delivery_configs');
          assert.deepEqual(error.details, { offering_id: ID_12, delivery_config_id: 'delivery-config' });
          return true;
        }
      );
    });
  }

  for (const served of ['3.3', '3.3.0-rc.3', '3.3.0-beta.1', undefined, 'not-a-version']) {
    test(`does not refuse a 1.2 offering for a caller served ${String(served)}`, async () => {
      // A refusal would be the AdcpError; anything later in installation is out of scope here.
      await install(served, ID_12).catch(error => {
        assert.ok(
          !(
            error instanceof AdcpError &&
            error.code === 'UNSUPPORTED_FEATURE' &&
            error.field === 'reporting_delivery_configs'
          ),
          `unexpected 3.3-only refusal: ${error.message}`
        );
      });
    });
  }

  test('does not refuse a 1.1 offering for a caller served 3.2', async () => {
    await install('3.2', ID_11).catch(error => {
      assert.ok(
        !(error instanceof AdcpError && error.code === 'UNSUPPORTED_FEATURE'),
        `unexpected refusal: ${error.message}`
      );
    });
  });
});

function platformFor(service, { upsert, withSales = false } = {}) {
  return service.install({
    capabilities: { specialisms: [], config: {} },
    ...(withSales ? { sales: { getProducts: async () => ({ products: [] }) } } : {}),
    accounts: {
      resolution: 'explicit',
      resolve: async ref => ({ id: ref?.account_id ?? 'account-a', ctx_metadata: {} }),
      upsert: upsert ?? (async () => []),
    },
  });
}

function serverFor(platform, options = {}) {
  return createAdcpServerFromPlatform(platform, {
    name: 'definition-gate',
    version: '1.0.0',
    validation: { requests: 'strict', responses: 'strict' },
    ...options,
  });
}

async function capabilities(server, adcpVersion) {
  const result = await server.dispatchTestRequest({
    method: 'tools/call',
    params: {
      name: 'get_adcp_capabilities',
      arguments: adcpVersion === undefined ? {} : { adcp_version: adcpVersion },
    },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

const CALLER_3_3 = '3.3-rc.3';
const FEATURE = 'media_buy.reporting_delivery';

describe('get_adcp_capabilities per caller pin', () => {
  const ids = body => body.media_buy?.reporting_delivery?.offerings.map(offering => offering.offering_id).sort();
  const only12 = () =>
    serviceFixture({
      adapters: { fixture: adapter({ offeringId: ID_12, sha: SHA_12 }) },
      reportDefinitionVersions: { [SHA_12]: '1.2' },
    }).service;

  // A seller with a sales tool available at 3.2 keeps the media_buy protocol, and so
  // reporting_delivery, for 3.2 callers: the case where a 1.2 definition could leak.
  test('a 3.2 caller sees only the 1.1 offering; a 3.3 caller and an unpinned caller see both', async () => {
    const { service } = twoOfferings();
    const server = serverFor(platformFor(service, { withSales: true }));
    assert.deepEqual(ids(await capabilities(server, '3.2')), [ID_11]);
    assert.deepEqual(ids(await capabilities(server, CALLER_3_3)), [ID_11, ID_12].sort());
    assert.deepEqual(ids(await capabilities(server)), [ID_11, ID_12].sort());
  });

  test('with only a 1.2 offering a 3.2 caller gets neither reporting_delivery nor its feature id', async () => {
    const server = serverFor(platformFor(only12(), { withSales: true }));
    const legacy = await capabilities(server, '3.2');
    assert.equal(legacy.media_buy?.reporting_delivery, undefined);
    assert.ok(!(legacy.experimental_features ?? []).includes(FEATURE));
    const current = await capabilities(server, CALLER_3_3);
    assert.deepEqual(ids(current), [ID_12]);
    assert.ok(current.experimental_features.includes(FEATURE));
  });

  test('a 1.1-only service keeps reporting_delivery and its feature id for a 3.2 caller', async () => {
    const { service } = serviceFixture({ reportDefinitionVersions: { [SHA_11]: '1.1' } });
    const server = serverFor(platformFor(service, { withSales: true }));
    const legacy = await capabilities(server, '3.2');
    assert.deepEqual(ids(legacy), [ID_11]);
    assert.ok(legacy.experimental_features.includes(FEATURE));
  });

  // With no media_buy tool available at 3.2 (the reporting tools are bound to the server's 3.3 pin),
  // filterCapabilitiesForToolAvailability drops the whole media_buy protocol for a 3.2 caller.
  test('on a reporting-only platform a 3.2 caller gets no reporting_delivery', async () => {
    const { service } = twoOfferings();
    const server = serverFor(platformFor(service));
    assert.equal((await capabilities(server, '3.2')).media_buy?.reporting_delivery, undefined);
    assert.deepEqual(ids(await capabilities(server, CALLER_3_3)), [ID_11, ID_12].sort());
  });
});

describe('createAdcpServerFromPlatform boot refusal', () => {
  test('a server pinned below 3.3 refuses a declared 1.2 offering', () => {
    const { service } = twoOfferings();
    assert.throws(
      () => serverFor(platformFor(service), { adcpVersion: '3.2.1' }),
      error => error instanceof PlatformConfigError && error.message.includes(ID_12)
    );
  });

  test('a server pinned below 3.3 refuses an undeclared offering under withhold_from_pre_3_3', () => {
    const { service } = serviceFixture({ undeclaredReportDefinitions: 'withhold_from_pre_3_3' });
    assert.throws(
      () => serverFor(platformFor(service), { adcpVersion: '3.2.1' }),
      error => error instanceof PlatformConfigError && error.message.includes(ID_11)
    );
  });

  test('the same server starts with only 1.1 offerings', () => {
    const { service } = serviceFixture({ reportDefinitionVersions: { [SHA_11]: '1.1' } });
    const server = serverFor(platformFor(service), { adcpVersion: '3.2.1' });
    assert.ok(server);
  });
});

describe('sync_accounts reporting_delivery_configs', () => {
  function accountEntry(operator, configs) {
    return {
      brand: { domain: `${operator}.example` },
      operator: `${operator}.example`,
      billing: 'operator',
      ...(configs ? { reporting_delivery_configs: configs } : {}),
    };
  }
  const config = (offeringId, deliveryConfigId) => ({
    offering_id: offeringId,
    delivery_config_id: deliveryConfigId,
    delivery_config_version: 1,
  });

  async function sync(adcpVersion, accounts) {
    const { service } = twoOfferings();
    const received = [];
    const platform = platformFor(service, {
      upsert: async (refs, _ctx) => {
        received.push(...refs);
        return refs.map((ref, i) => ({
          account_id: `acct-${i}`,
          brand: ref.brand,
          operator: ref.operator,
          action: 'created',
          status: 'active',
          billing: ref.billing,
        }));
      },
    });
    platform.capabilities.supportedBillings = ['operator'];
    const server = serverFor(platform, { validation: { requests: 'off', responses: 'off' } });
    const result = await server.dispatchTestRequest({
      method: 'tools/call',
      params: {
        name: 'sync_accounts',
        arguments: {
          accounts,
          idempotency_key: 'definition-gate-0001',
          ...(adcpVersion ? { adcp_version: adcpVersion } : {}),
        },
      },
    });
    return { result, received, rows: result.structuredContent?.accounts };
  }

  test('a 3.2 caller: the 1.2 row fails per entry and only the other reaches upsert', async () => {
    const { received, rows, result } = await sync('3.2', [
      accountEntry('first', [config(ID_12, 'cfg-12')]),
      accountEntry('second', [config(ID_11, 'cfg-11')]),
    ]);
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(rows[0].action, 'failed');
    const [error] = rows[0].errors;
    assert.equal(error.code, 'UNSUPPORTED_FEATURE');
    assert.equal(error.recovery, 'correctable');
    assert.equal(error.field, 'reporting_delivery_configs');
    assert.deepEqual(error.details, { offering_id: ID_12, delivery_config_id: 'cfg-12' });
    assert.notEqual(rows[1].action, 'failed');
    assert.equal(received.length, 1);
    assert.equal(received[0].operator, 'second.example');
  });

  test('a 3.2 caller: an entry with no configs is applied', async () => {
    const { received, rows } = await sync('3.2', [
      accountEntry('first', [config(ID_12, 'cfg-12')]),
      accountEntry('second'),
    ]);
    assert.equal(rows[0].action, 'failed');
    assert.notEqual(rows[1].action, 'failed');
    assert.deepEqual(
      received.map(entry => entry.operator),
      ['second.example']
    );
  });

  test('a 3.3 caller passes both entries to upsert', async () => {
    const { received, rows } = await sync(CALLER_3_3, [
      accountEntry('first', [config(ID_12, 'cfg-12')]),
      accountEntry('second', [config(ID_11, 'cfg-11')]),
    ]);
    assert.ok(
      rows.every(row => row.action !== 'failed'),
      JSON.stringify(rows)
    );
    assert.deepEqual(
      received.map(entry => entry.operator),
      ['first.example', 'second.example']
    );
  });
});
