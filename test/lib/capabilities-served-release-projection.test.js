const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const {
  projectCapabilitiesForRelease,
  projectExperimentalFeaturesForRelease,
} = require('../../dist/lib/server/capabilities-release-projection.js');
const { ADCP_VERSION } = require('../../dist/lib/index.js');
const { toReleasePrecisionVersion } = require('../../dist/lib/version.js');

const SERVED = toReleasePrecisionVersion(ADCP_VERSION);
const NEWER_FIELDS = ['issue_reporting', 'open_opportunities', 'supported_match_keys'];

function buildSeller(events) {
  return createAdcpServer({
    stateStore: new InMemoryStateStore(),
    name: 'capability projection',
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
    version: '1.0.0',
    adcpVersion: ADCP_VERSION,
    validation: { requests: 'off', responses: 'strict' },
    onVersionTranslation: e => events.push(e),
    resolveAccount: async ref => ({ id: ref.account_id ?? 'a' }),
    accounts: { requestAccount: async () => ({ outcome: 'pending' }) },
    mediaBuy: {
      getProducts: async () => ({ products: [] }),
      reportMediaBuyIssue: async () => ({}),
      listProposals: async () => ({ outcome: 'listed', proposals: [], opportunities: [] }),
    },
    capabilities: {
      account: { supportedBilling: ['operator'] },
      overrides: {
        media_buy: {
          issue_reporting: true,
          open_opportunities: { list_proposals: true },
          supported_match_keys: [{ uid_type: 'hashed_email', scopes: ['individuals'], uses: ['audience_include'] }],
          vendor_ext_key: 'adopter-extension',
        },
        experimental_features: ['media_buy.match_keys', 'trusted_match.core'],
      },
    },
  });
}

async function capabilitiesAt(seller, version) {
  const res = await seller.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: { adcp_version: version } },
  });
  assert.notEqual(res.isError, true, `get_adcp_capabilities at ${version} must not error`);
  return res.structuredContent ?? res;
}

for (const version of ['3.2', '3.1']) {
  test(`a ${version} caller gets capabilities without 3.3-only fields`, async () => {
    const events = [];
    const body = await capabilitiesAt(buildSeller(events), version);

    assert.equal(body.business_calendars, undefined);
    for (const key of NEWER_FIELDS) assert.equal(body.media_buy[key], undefined, key);
    assert.equal(body.account?.requests, undefined);

    assert.ok(!body.experimental_features.includes('media_buy.match_keys'));
    assert.ok(body.experimental_features.includes('trusted_match.core'));
    assert.ok(body.library_version);
    assert.equal(body.media_buy.vendor_ext_key, 'adopter-extension');

    assert.equal(events.length, 1);
    assert.equal(events[0].tool, 'get_adcp_capabilities');
    assert.equal(events[0].direction, 'response');
    assert.equal(events[0].fromVersion, ADCP_VERSION);
    const drifts = events[0].drifts;
    assert.ok(drifts.length > 0);
    assert.ok(drifts.every(d => d.type === 'version_downgrade_fields_dropped'));
    const stripped = drifts.flatMap(d => d.strippedFields);
    for (const key of NEWER_FIELDS) {
      assert.ok(
        stripped.some(p => p.includes(key)),
        `drift names ${key}`
      );
    }
    assert.ok(drifts.some(d => d.message.includes('media_buy.match_keys')));
  });
}

test('a caller at the served release gets everything and no translation event', async () => {
  const events = [];
  const body = await capabilitiesAt(buildSeller(events), SERVED);

  for (const key of NEWER_FIELDS) assert.notEqual(body.media_buy[key], undefined, key);
  assert.notEqual(body.account?.requests, undefined);
  assert.equal(body.media_buy.vendor_ext_key, 'adopter-extension');
  for (const id of ['media_buy.match_keys', 'trusted_match.core'])
    assert.ok(body.experimental_features.includes(id), id);
  assert.equal(events.length, 0);
});

test('a 3.0 caller gets the experimental-id filter and no 3.3-only properties', async () => {
  const events = [];
  const seller = buildSeller(events);
  const res = await seller.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: { adcp_version: '3.0' } },
  });
  assert.notEqual(res.isError, true);
  const body = res.structuredContent ?? res;

  assert.ok(!body.experimental_features.includes('media_buy.match_keys'));
  assert.ok(body.experimental_features.includes('trusted_match.core'));
  for (const key of NEWER_FIELDS) assert.equal(body.media_buy[key], undefined, key);
  assert.equal(body.account?.requests, undefined);

  assert.equal(events.length, 1);
  assert.equal(events[0].toVersion, '3.0');
  assert.ok(events[0].drifts.every(d => d.type === 'version_downgrade_fields_dropped'));
  assert.ok(events[0].drifts.some(d => d.message.includes('media_buy.match_keys')));
});

function build33Payload() {
  return {
    adcp: { major_versions: [3] },
    supported_protocols: ['media_buy'],
    business_calendars: [{ calendar_id: 'cal', timezone: 'America/New_York', valid_from: '2026-01-01' }],
    account: { supported_billing: ['operator'], requests: { supported: true } },
    media_buy: {
      issue_reporting: true,
      open_opportunities: { list_proposals: true },
      supported_match_keys: [{ uid_type: 'hashed_email', scopes: ['individuals'], uses: ['audience_include'] }],
      vendor_ext_key: 'adopter-extension',
    },
    library_version: '1.2.3',
    experimental_features: [
      'media_buy.match_keys',
      'account.requests',
      'protocol.principal',
      'media_buy.reporting_delivery',
      'measurement.core',
      'trusted_match.core',
    ],
  };
}

for (const to of ['3.2', '3.1']) {
  test(`projectCapabilitiesForRelease removes the 3.3-only fields at ${to}`, () => {
    const { data } = projectCapabilitiesForRelease(build33Payload(), { fromVersion: ADCP_VERSION, toVersion: to });
    assert.equal(data.business_calendars, undefined);
    for (const key of NEWER_FIELDS) assert.equal(data.media_buy[key], undefined, key);
    assert.equal(data.account.requests, undefined);
    assert.equal(data.media_buy.vendor_ext_key, 'adopter-extension');
    assert.equal(data.library_version, '1.2.3');
  });
}

test('projectCapabilitiesForRelease drops feature ids the target release never defined', () => {
  const at32 = projectCapabilitiesForRelease(build33Payload(), { fromVersion: ADCP_VERSION, toVersion: '3.2' });
  assert.deepEqual(at32.data.experimental_features, [
    'protocol.principal',
    'media_buy.reporting_delivery',
    'measurement.core',
    'trusted_match.core',
  ]);
  const at31 = projectCapabilitiesForRelease(build33Payload(), { fromVersion: ADCP_VERSION, toVersion: '3.1' });
  assert.deepEqual(at31.data.experimental_features, ['measurement.core', 'trusted_match.core']);
});

test('projectCapabilitiesForRelease reports drifts per minor step', () => {
  const { drifts } = projectCapabilitiesForRelease(build33Payload(), { fromVersion: ADCP_VERSION, toVersion: '3.1' });
  assert.ok(drifts.length > 0);
  assert.ok(drifts.every(d => d.type === 'version_downgrade_fields_dropped'));
  const steps = [...new Set(drifts.map(d => `${d.fromVersion}->${d.toVersion}`))];
  assert.equal(steps.length, 2);
  assert.ok(steps[0].startsWith(`${ADCP_VERSION}->3.2`), steps[0]);
  assert.ok(steps[1].startsWith('3.2->3.1'), steps[1]);
  const featureDrifts = drifts.filter(d => d.strippedFields.every(p => p.startsWith('experimental_features[')));
  assert.equal(featureDrifts.length, 2);
  assert.ok(featureDrifts[0].message.includes('media_buy.match_keys'));
  assert.ok(featureDrifts[1].message.includes('protocol.principal'));
});

test('projectCapabilitiesForRelease deletes experimental_features when every id is newer', () => {
  const input = { ...build33Payload(), experimental_features: ['media_buy.match_keys', 'account.requests'] };
  const { data } = projectCapabilitiesForRelease(input, { fromVersion: ADCP_VERSION, toVersion: '3.2' });
  assert.equal('experimental_features' in data, false);
});

test('projectCapabilitiesForRelease does not mutate its input and preserves key order', () => {
  const input = build33Payload();
  const snapshot = structuredClone(input);
  const { data } = projectCapabilitiesForRelease(input, { fromVersion: ADCP_VERSION, toVersion: '3.2' });
  assert.deepEqual(input, snapshot);
  assert.notEqual(data, input);
  const expected = Object.keys(input).filter(k => k !== 'business_calendars');
  assert.deepEqual(Object.keys(data), expected);
});

test('projectCapabilitiesForRelease is a no-op within one release', () => {
  const input = build33Payload();
  const result = projectCapabilitiesForRelease(input, { fromVersion: ADCP_VERSION, toVersion: ADCP_VERSION });
  assert.equal(result.data, input);
  assert.deepEqual(result.drifts, []);
});

test('projectExperimentalFeaturesForRelease filters ids only and leaves properties alone', () => {
  const input = build33Payload();
  const { data, drifts } = projectExperimentalFeaturesForRelease(input, {
    fromVersion: ADCP_VERSION,
    toVersion: '3.0',
  });
  assert.deepEqual(data.experimental_features, ['trusted_match.core']);
  assert.deepEqual({ ...data, experimental_features: undefined }, { ...input, experimental_features: undefined });
  assert.notEqual(data.business_calendars, undefined);
  assert.notEqual(data.media_buy.issue_reporting, undefined);
  assert.notEqual(data.account.requests, undefined);
  assert.ok(drifts.length > 0);
  assert.ok(drifts.every(d => d.type === 'version_downgrade_fields_dropped'));

  const { experimental_features: _omit, ...bare } = input;
  const result = projectExperimentalFeaturesForRelease(bare, { fromVersion: ADCP_VERSION, toVersion: '3.0' });
  assert.equal(result.data, bare);
  assert.deepEqual(result.drifts, []);
});

function buildIdentity33Seller(events) {
  return createAdcpServer({
    stateStore: new InMemoryStateStore(),
    name: 'identity33 capability projection',
    version: '1.0.0',
    identity33: { authorize: async () => {} },
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
    validation: { requests: 'off', responses: 'strict' },
    onVersionTranslation: e => events.push(e),
    resolveAccount: async ref => ({ id: ref.account_id ?? 'a' }),
    mediaBuy: {
      getProducts: async () => ({ products: [] }),
      reportMediaBuyIssue: async () => ({}),
      listProposals: async () => ({ outcome: 'listed', proposals: [], opportunities: [] }),
    },
    capabilities: {
      account: { supportedBilling: ['operator'] },
      request_signing: {
        supported: true,
        profiles: ['adcp/request-signing/v1', 'web-bot-auth'],
        covers_content_digest: 'required',
        required_for: [],
      },
      overrides: {
        media_buy: {
          issue_reporting: true,
          open_opportunities: { list_proposals: true },
          supported_match_keys: [{ uid_type: 'hashed_email', scopes: ['individuals'], uses: ['audience_include'] }],
          vendor_ext_key: 'adopter-extension',
        },
        experimental_features: ['media_buy.match_keys', 'trusted_match.core'],
      },
    },
  });
}

test('an identity33 server projects capabilities for a 3.2 caller', async () => {
  const events = [];
  const seller = buildIdentity33Seller(events);
  const body = await capabilitiesAt(seller, '3.2');

  for (const key of NEWER_FIELDS) assert.equal(body.media_buy[key], undefined, key);
  assert.equal(body.account?.requests, undefined);
  assert.ok(!body.experimental_features.includes('media_buy.match_keys'));
  assert.ok(body.experimental_features.includes('trusted_match.core'));
  assert.equal(body.request_signing.supported, true);
  assert.equal(body.request_signing.profiles, undefined);
  assert.ok(body.library_version);
  assert.equal(body.media_buy.vendor_ext_key, 'adopter-extension');

  assert.equal(events.length, 1);
  assert.equal(events[0].toVersion, '3.2');
  const stripped = events[0].drifts.flatMap(d => d.strippedFields);
  for (const path of [
    'request_signing.profiles',
    'media_buy.issue_reporting',
    'media_buy.open_opportunities',
    'media_buy.supported_match_keys',
  ]) {
    assert.ok(stripped.includes(path), path);
  }
  assert.ok(events[0].drifts.some(d => d.message.includes('media_buy.match_keys')));

  events.length = 0;
  const full = await capabilitiesAt(seller, SERVED);
  assert.ok(full.request_signing.profiles);
  assert.notEqual(full.media_buy.issue_reporting, undefined);
  assert.equal(events.length, 0);
});
