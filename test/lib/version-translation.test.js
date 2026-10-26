/**
 * Cross-version translation (adcp-client#3370).
 *
 * Application code builds requests in the client's own AdCP release. The
 * client negotiates the highest release the seller supports, converts the
 * request down every minor step to it, validates it against that release,
 * and converts the response back up. Everything removed on the way down is
 * reported in debug_logs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SingleAgentClient,
  AgentClient,
  ProtocolClient,
  ProtocolFeatureUnsupportedError,
  VersionUnsupportedError,
} = require('../../dist/lib/index.js');
const {
  negotiateAdcpRelease,
  translationSteps,
  projectToolPayload,
  convertRequest,
  convertResponse,
} = require('../../dist/lib/adapters/version/index.js');

const CLIENT_VERSION = '3.2.5';

function caps(supportedVersions, overrides = {}) {
  return {
    version: 'v3',
    majorVersions: [3],
    ...(supportedVersions !== undefined && { supportedVersions }),
    protocols: ['media_buy'],
    features: {},
    extensions: [],
    idempotency: { replayTtlSeconds: 86400 },
    _synthetic: false,
    ...overrides,
  };
}

const ACCOUNT = { brand: { domain: 'nike.com' }, operator: 'agency.example' };

function mediaBuyRequest(extra = {}) {
  return {
    idempotency_key: 'version-translation-0001',
    account: ACCOUNT,
    brand: { domain: 'nike.com' },
    start_time: 'asap',
    end_time: '2027-01-31T23:59:59Z',
    bidding: { bid_amount: 4.5 },
    name: 'Q1 launch',
    packages: [
      {
        product_id: 'prod_1',
        pricing_option_id: 'po_1',
        budget: 1000,
        targeting_overlay: { geo_countries: ['US'] },
        creative_assignments: [{ creative_id: 'cr_1', rotation_mode: 'even' }],
      },
      { product_id: 'prod_2', pricing_option_id: 'po_2', budget: 500, bidding: { bid_amount: 9 } },
    ],
    ...extra,
  };
}

describe('negotiateAdcpRelease', () => {
  test('picks the highest release on or below the client line', () => {
    assert.deepEqual(negotiateAdcpRelease(CLIENT_VERSION, caps(['3.0', '3.1'])), {
      version: '3.1',
      source: 'supported_versions',
      downgraded: true,
    });
  });

  test('keeps the client pin when the seller supports its line', () => {
    assert.deepEqual(negotiateAdcpRelease(CLIENT_VERSION, caps(['3.1', '3.2'])), {
      version: CLIENT_VERSION,
      source: 'same_release',
      downgraded: false,
    });
  });

  test('never selects an older-line prerelease', () => {
    assert.equal(negotiateAdcpRelease(CLIENT_VERSION, caps(['3.0', '3.1-beta.1'])).version, '3.0');
  });

  test('a prerelease client does not match a GA seller of its line', () => {
    assert.equal(negotiateAdcpRelease('3.2.0-beta.6', caps(['3.1', '3.2'])).version, '3.1');
    assert.equal(negotiateAdcpRelease('3.2.0-beta.6', caps(['3.2.0-beta.6'])).source, 'same_release');
  });

  test('a 3.3 preview requires its exact advertised prerelease and otherwise selects stable 3.2', () => {
    const preview = '3.3.0-beta.0';
    for (const exact of [preview, '3.3-beta.0']) {
      assert.deepEqual(negotiateAdcpRelease(preview, caps(['3.2', exact])), {
        version: preview,
        source: 'same_release',
        downgraded: false,
      });
    }
    for (const other of ['3.3', '3.3-beta', '3.3-beta.1', '3.3.1-beta.0', '3.3-rc.0']) {
      assert.deepEqual(negotiateAdcpRelease(preview, caps(['3.2', other])), {
        version: '3.2',
        source: 'supported_versions',
        downgraded: true,
      });
    }
  });

  test('a preview cannot be inferred from missing, synthetic, or served-only discovery', () => {
    const preview = '3.3.0-beta.0';
    for (const evidence of [
      undefined,
      caps([preview], { _synthetic: true }),
      ...['3.3-beta.0', '3.3-beta.1', '3.3', '3.2-beta.6'].map(servedVersion => caps(undefined, { servedVersion })),
    ]) {
      assert.equal(negotiateAdcpRelease(preview, evidence).reason, 'no_common_version');
    }
    assert.equal(negotiateAdcpRelease(preview, caps(undefined, { servedVersion: '3.2' })).version, '3.2');
    assert.equal(negotiateAdcpRelease(preview, caps(undefined)).version, '3.0');
  });

  test('reports no common release when the seller is only newer', () => {
    const result = negotiateAdcpRelease('3.1', caps(['3.2']));
    assert.equal(result.reason, 'no_common_version');
    assert.equal(result.version, undefined);
  });

  test('falls back to the served release, then to 3.0 for a metadata-free v3 seller', () => {
    assert.equal(negotiateAdcpRelease(CLIENT_VERSION, caps(undefined, { servedVersion: '3.1' })).version, '3.1');
    assert.equal(negotiateAdcpRelease(CLIENT_VERSION, caps(undefined)).version, '3.0');
  });

  test('does not negotiate on synthetic capabilities', () => {
    assert.equal(negotiateAdcpRelease(CLIENT_VERSION, caps(['3.1'], { _synthetic: true })), undefined);
  });
});

describe('translationSteps', () => {
  test('chains one step per consecutive minor pair', () => {
    assert.deepEqual(translationSteps(CLIENT_VERSION, '3.0'), [
      { upper: CLIENT_VERSION, lower: '3.1', key: '3.1' },
      { upper: '3.1', lower: '3.0', key: '3.0' },
    ]);
    assert.deepEqual(translationSteps(CLIENT_VERSION, '3.2'), []);
  });
});

describe('projectToolPayload', () => {
  test('removes what 3.1 cannot express and leaves everything else', () => {
    const request = mediaBuyRequest({ ext: { vendor: { anything: true } } });
    request.packages[0].targeting_overlay.device_platform_exclude = ['ios'];
    request.packages[1].bidding = { max_bid: 9 };
    const { value, dropped } = projectToolPayload('create_media_buy', 'request', request, CLIENT_VERSION, '3.1');
    const paths = dropped.map(drop => drop.path);
    for (const path of [
      'bidding',
      'name',
      'packages[0].targeting_overlay.device_platform_exclude',
      'packages[0].creative_assignments[0].rotation_mode',
      'packages[1].bidding',
    ]) {
      assert.ok(paths.includes(path), `expected ${path} in ${paths.join(', ')}`);
    }
    assert.deepEqual(value.packages[0].targeting_overlay, { geo_countries: ['US'] });
    assert.deepEqual(value.ext, { vendor: { anything: true } });
    assert.equal(value.account, request.account, 'unchanged branches keep their identity');
  });

  test('returns the original reference when nothing changes', () => {
    const request = { media_buy_ids: ['mb_1'] };
    const result = projectToolPayload('get_media_buy_delivery', 'request', request, CLIENT_VERSION, '3.1');
    assert.equal(result.value, request);
    assert.deepEqual(result.dropped, []);
  });
});

describe('convertRequest', () => {
  test('moves bidding.bid_amount to package bid_price before projecting', () => {
    const { params, drifts, identityFields, refusedFields } = convertRequest('create_media_buy', mediaBuyRequest(), {
      fromVersion: CLIENT_VERSION,
      toVersion: '3.1',
    });
    assert.equal(params.bidding, undefined);
    assert.equal(params.packages[0].bid_price, 4.5, 'inherits the media-buy bid');
    assert.equal(params.packages[1].bid_price, 9, 'keeps its own bid');
    assert.equal(params.packages[1].bidding, undefined);
    assert.deepEqual(identityFields, []);
    assert.deepEqual(refusedFields, [], 'labels and rotation hints are descriptive');
    const moved = drifts.find(drift => drift.type === 'bidding_moved_to_bid_price');
    assert.deepEqual(moved.movedFields, [
      { from: 'bidding', to: 'packages[0].bid_price' },
      { from: 'packages[1].bidding', to: 'packages[1].bid_price' },
    ]);
    const dropped = drifts.find(drift => drift.type === 'version_downgrade_fields_dropped');
    assert.equal(dropped.fromVersion, CLIENT_VERSION);
    assert.equal(dropped.toVersion, '3.1');
    assert.ok(dropped.strippedFields.includes('name'));
    assert.ok(!dropped.strippedFields.includes('bidding'), 'moved fields are not reported as dropped');
  });

  test('removes a media-buy bid default that every package overrides, without refusing', () => {
    const request = mediaBuyRequest();
    request.packages[0].bid_price = 3;
    const { params, drifts, refusedFields } = convertRequest('create_media_buy', request, {
      fromVersion: CLIENT_VERSION,
      toVersion: '3.1',
    });
    assert.equal(params.bidding, undefined);
    assert.equal(params.packages[0].bid_price, 3, 'a package bid_price is kept');
    assert.equal(params.packages[1].bid_price, 9, 'a package bidding.bid_amount moves');
    assert.deepEqual(refusedFields, []);
    const onlyOverrides = mediaBuyRequest();
    onlyOverrides.packages[0].bid_price = 3;
    onlyOverrides.packages[1] = { ...onlyOverrides.packages[1], bidding: undefined, bid_price: 4 };
    const result = convertRequest('create_media_buy', onlyOverrides, { fromVersion: CLIENT_VERSION, toVersion: '3.1' });
    assert.equal(result.params.bidding, undefined);
    assert.deepEqual(result.refusedFields, []);
    assert.ok(result.drifts.some(drift => drift.type === 'redundant_bidding_default_removed'));
    assert.ok(drifts.some(drift => drift.type === 'bidding_moved_to_bid_price'));
  });

  test('refuses mutation fields whose loss changes what the seller does', () => {
    const request = mediaBuyRequest({ daily_budget_cap: 100 });
    request.packages[0].targeting_overlay.device_platform_exclude = ['ios'];
    request.packages[1].bidding = { max_bid: 9 };
    const { refusedFields } = convertRequest('create_media_buy', request, {
      fromVersion: CLIENT_VERSION,
      toVersion: '3.1',
    });
    assert.deepEqual(refusedFields.map(field => field.path).sort(), [
      'daily_budget_cap',
      'packages[0].targeting_overlay.device_platform_exclude',
      'packages[1].bidding',
    ]);
    assert.ok(refusedFields.every(field => field.introducedIn === '3.2'));
  });

  test('refuses every lost field of an update', () => {
    const { refusedFields } = convertRequest(
      'update_media_buy',
      { media_buy_id: 'mb_1', idempotency_key: 'version-translation-0002', name: 'Renamed' },
      { fromVersion: CLIENT_VERSION, toVersion: '3.1' }
    );
    assert.deepEqual(
      refusedFields.map(field => field.path),
      ['name']
    );
  });

  test('drops what reads cannot express without refusing', () => {
    const { params, refusedFields, identityFields } = convertRequest(
      'get_products',
      {
        brief: 'shoes',
        brand: { domain: 'nike.com', countries: ['CA'] },
        targeting_overlay: { geo_countries: ['CA'] },
      },
      { fromVersion: CLIENT_VERSION, toVersion: '3.1' }
    );
    assert.deepEqual(params.brand, { domain: 'nike.com' });
    assert.equal(params.targeting_overlay, undefined);
    assert.deepEqual(refusedFields, []);
    assert.deepEqual(identityFields, [], 'a top-level brand is not an account key');
  });

  test('treats account references inside filters as account identity', () => {
    const { identityFields } = convertRequest(
      'list_creatives',
      { filters: { accounts: [{ ...ACCOUNT, currency: 'CAD' }] } },
      { fromVersion: CLIENT_VERSION, toVersion: '3.1' }
    );
    assert.deepEqual(
      identityFields.map(field => field.path),
      ['filters.accounts[0].currency']
    );
  });

  test('chains 3.2 to 3.0 through both steps', () => {
    const request = {
      brief: 'running shoes',
      brand: { domain: 'nike.com', brand_kit_override: { colors: { accent: '#000' } } },
      targeting_overlay: { geo_countries: ['US'] },
    };
    const { params, drifts } = convertRequest('get_products', request, {
      fromVersion: CLIENT_VERSION,
      toVersion: '3.0',
    });
    assert.equal(params.targeting_overlay, undefined);
    assert.equal(params.brand.brand_kit_override, undefined);
    assert.deepEqual(
      drifts.map(drift => [drift.type, drift.toVersion]),
      [
        ['version_downgrade_fields_dropped', '3.1'],
        ['pre31_brand_fields_stripped', '3.0'],
      ]
    );
  });

  test('reports account-key fields separately and drops them only under reduce', () => {
    const request = mediaBuyRequest({
      account: { brand: { domain: 'nike.com', countries: ['CA'] }, operator: 'agency.example', currency: 'CAD' },
    });
    const refused = convertRequest('create_media_buy', request, { fromVersion: CLIENT_VERSION, toVersion: '3.1' });
    assert.deepEqual(
      refused.identityFields.map(field => field.path),
      ['account.brand.countries', 'account.currency']
    );
    assert.ok(!refused.drifts.some(drift => drift.type === 'account_identity_reduced'));

    const reduced = convertRequest('create_media_buy', request, {
      fromVersion: CLIENT_VERSION,
      toVersion: '3.1',
      accountIdentity: 'reduce',
    });
    assert.deepEqual(reduced.params.account, { brand: { domain: 'nike.com' }, operator: 'agency.example' });
    const drift = reduced.drifts.find(entry => entry.type === 'account_identity_reduced');
    assert.deepEqual(drift.strippedFields, ['account.brand.countries', 'account.currency']);
  });
});

describe('convertResponse', () => {
  test('moves the 3.1 media-buy status alias to media_buy_status', () => {
    const response = { adcp_version: '3.1', status: 'active', media_buy_id: 'mb_1', packages: [] };
    const { data, drifts } = convertResponse('create_media_buy', response, {
      fromVersion: '3.1',
      toVersion: CLIENT_VERSION,
    });
    assert.equal(data.media_buy_status, 'active');
    assert.equal(data.status, 'completed');
    assert.equal(drifts[0].type, 'media_buy_status_alias_moved');
    assert.equal(drifts[0].fromVersion, '3.1');
  });

  test('moves an un-echoed 3.1 lifecycle alias but not a 3.1 task status (adcp-client#3432)', () => {
    const lifecycle = { status: 'pending_creatives', media_buy_id: 'mb_1', packages: [] };
    const moved = convertResponse('create_media_buy', lifecycle, { fromVersion: '3.1', toVersion: CLIENT_VERSION });
    assert.equal(moved.data.media_buy_status, 'pending_creatives');
    assert.equal(moved.drifts[0].type, 'media_buy_status_alias_moved');

    for (const status of ['completed', 'rejected', 'canceled']) {
      const taskStatus = { status, media_buy_id: 'mb_1', packages: [] };
      const kept = convertResponse('create_media_buy', taskStatus, { fromVersion: '3.1', toVersion: CLIENT_VERSION });
      assert.equal(kept.data, taskStatus, status);
      assert.ok(!('media_buy_status' in kept.data), status);
      assert.ok(!kept.drifts.some(d => d.type === 'media_buy_status_alias_moved'), status);
    }
  });

  test('copies the 3.1 root delivery currency onto each media buy', () => {
    const response = {
      currency: 'USD',
      reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' },
      media_buy_deliveries: [{ media_buy_id: 'mb_1' }, { media_buy_id: 'mb_2', currency: 'USD' }],
    };
    const { data, drifts } = convertResponse('get_media_buy_delivery', response, {
      fromVersion: '3.1',
      toVersion: CLIENT_VERSION,
    });
    assert.deepEqual(
      data.media_buy_deliveries.map(delivery => delivery.currency),
      ['USD', 'USD']
    );
    assert.equal(drifts[0].type, 'delivery_currency_per_media_buy');
  });

  test('is a no-op on the same line', () => {
    const response = { status: 'completed', media_buy_id: 'mb_1' };
    assert.equal(
      convertResponse('create_media_buy', response, { fromVersion: '3.2', toVersion: CLIENT_VERSION }).data,
      response
    );
  });
});

/** Minimal durable-storage stand-in with the compare-and-set 'reduce' requires. */
function casStorage(rows = new Map()) {
  return {
    rows,
    async get(key) {
      const row = rows.get(key);
      return row && structuredClone(row);
    },
    async set(key, value) {
      rows.set(key, structuredClone(value));
    },
    async compareAndSet(key, expectedRevision, value) {
      if (rows.get(key)?.revision !== expectedRevision) return false;
      rows.set(key, structuredClone(value));
      return true;
    },
  };
}

function makeClient(sellerCapabilities, config = {}) {
  const client = new SingleAgentClient(
    { id: 'legacy-seller', name: 'Legacy seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
    {
      adcpVersion: CLIENT_VERSION,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      ...config,
    }
  );
  client.ensureEndpointDiscovered = async () => client.agent;
  client.getCapabilities = async () => sellerCapabilities;
  return client;
}

function captureDispatch(t, response = { status: 'completed' }) {
  const calls = [];
  t.mock.method(ProtocolClient, 'callTool', async (_agent, taskName, params, options) => {
    calls.push({ taskName, params, options });
    return typeof response === 'function' ? response(params) : response;
  });
  return calls;
}

describe('SingleAgentClient against an older seller', () => {
  test('both public buyers refuse an unadvertised beta before any tool dispatch', async t => {
    const calls = captureDispatch(t);
    for (const evidence of [
      caps(['3.3-beta.1']),
      caps(undefined, { servedVersion: '3.3-beta.0' }),
      caps(['3.3-beta.0'], { _synthetic: true }),
    ]) {
      for (const useWrapper of [false, true]) {
        const client = makeClient(evidence, { adcpVersion: '3.3.0-beta.0' });
        let buyer = client;
        if (useWrapper) {
          buyer = new AgentClient(client.agent, { adcpVersion: '3.3.0-beta.0' });
          buyer.client = client;
        }
        await assert.rejects(() => buyer.listCollections(), ProtocolFeatureUnsupportedError);
      }
    }
    assert.deepEqual(calls, []);
  });

  test('a beta buyer retains the 3.0 downgrade for real metadata-free v3 discovery', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(undefined), { adcpVersion: '3.3.0-beta.0' });
    await assert.rejects(() => client.listCollections(), ProtocolFeatureUnsupportedError);
    assert.deepEqual(calls, []);
    const negotiated = client.negotiateCallRelease(caps(undefined), undefined);
    assert.equal(negotiated.version, '3.0');
    assert.equal(negotiated.downgraded, true);
  });

  test('converts the request down, sends the negotiated release and reports the drops', async t => {
    const calls = captureDispatch(t, {
      structuredContent: { adcp_version: '3.1', status: 'active', media_buy_id: 'mb_1', packages: [] },
    });
    const client = makeClient(caps(['3.0', '3.1']));
    const result = await client.executeTask('create_media_buy', mediaBuyRequest());

    assert.equal(calls.length, 1);
    const { params, options } = calls[0];
    assert.equal(options.wireAdcpVersion, '3.1');
    assert.equal(params.bidding, undefined);
    assert.equal(params.name, undefined);
    assert.equal(params.packages[0].bid_price, 4.5);
    assert.equal(params.packages[0].targeting_overlay.device_platform_exclude, undefined);

    assert.equal(result.success, true, result.error);
    assert.equal(result.metadata.negotiatedAdcpVersion, '3.1');
    assert.equal(result.data.media_buy_status, 'active');
    const types = result.debug_logs.map(entry => entry.type);
    assert.ok(types.includes('version_downgrade_fields_dropped'), types.join(', '));
    assert.ok(types.includes('bidding_moved_to_bid_price'));
  });

  test('leaves requests to a seller on the client line untouched', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.1', '3.2']));
    const request = mediaBuyRequest();
    const result = await client.executeTask('create_media_buy', request);
    assert.equal(calls[0].options.wireAdcpVersion, undefined);
    assert.deepEqual(calls[0].params.bidding, { bid_amount: 4.5 });
    assert.equal(calls[0].params.name, 'Q1 launch');
    assert.equal(result.metadata.negotiatedAdcpVersion, undefined);
  });

  test('a seller without release metadata keeps the pre-negotiation behavior', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(undefined));
    const result = await client.executeTask('create_media_buy', mediaBuyRequest({ daily_budget_cap: 100 }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.wireAdcpVersion, undefined);
    assert.equal(calls[0].params.daily_budget_cap, 100);
    assert.equal(result.metadata.negotiatedAdcpVersion, undefined);
  });

  test('an explicit wireAdcpVersion override disables negotiation', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.0', '3.1']), { wireAdcpVersion: CLIENT_VERSION });
    await client.executeTask('create_media_buy', mediaBuyRequest());
    assert.deepEqual(calls[0].params.bidding, { bid_amount: 4.5 });
  });

  test('refuses an account key 3.1 cannot express by default', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.1']));
    await assert.rejects(
      client.executeTask(
        'create_media_buy',
        mediaBuyRequest({ account: { ...ACCOUNT, operator_unit: { id: 'desk-ca' } } })
      ),
      error => {
        assert.ok(error instanceof ProtocolFeatureUnsupportedError, error?.message);
        assert.equal(error.details.field, 'account.operator_unit');
        assert.equal(error.details.required_version, '3.2');
        assert.equal(error.details.current_version, '3.1');
        assert.match(error.message, /No request was sent/);
        assert.match(error.adcpError.suggestion, /accountIdentityDowngrade: 'reduce'/);
        return true;
      }
    );
    assert.equal(calls.length, 0);
  });

  test("reduces the account key under accountIdentityDowngrade: 'reduce'", async t => {
    const calls = captureDispatch(t, { status: 'completed', accounts: [] });
    const client = makeClient(caps(['3.1']), { accountIdentityDowngrade: 'reduce', accountStorage: casStorage() });
    const result = await client.executeTask('sync_accounts', {
      idempotency_key: 'version-translation-sync',
      accounts: [
        { ...ACCOUNT, billing: 'operator', currency: 'CAD', brand: { domain: 'nike.com', countries: ['CA'] } },
      ],
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params.accounts[0], {
      brand: { domain: 'nike.com' },
      operator: 'agency.example',
      billing: 'operator',
    });
    const drift = result.debug_logs.find(entry => entry.type === 'account_identity_reduced');
    assert.deepEqual(drift.strippedFields, ['accounts[0].brand.countries', 'accounts[0].currency']);
  });

  test('refuses a buy whose spend cap 3.1 cannot express', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.1']));
    await assert.rejects(client.executeTask('create_media_buy', mediaBuyRequest({ daily_budget_cap: 100 })), error => {
      assert.ok(error instanceof ProtocolFeatureUnsupportedError, error?.message);
      assert.equal(error.details.field, 'daily_budget_cap');
      assert.equal(error.details.required_version, '3.2');
      assert.match(error.message, /No request was sent/);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  test('converts a webhook completion up from the release the seller served', async () => {
    const client = makeClient(caps(['3.1']));
    const converted = client.convertWebhookResultToClientRelease({
      ok: true,
      protocol: 'mcp',
      envelope: {},
      result: { adcp_version: '3.1', currency: 'EUR', media_buy_deliveries: [{ media_buy_id: 'mb_1' }] },
      metadata: { taskId: 't', taskType: 'get_media_buy_delivery', operationId: 'op', status: 'completed' },
    });
    assert.equal(converted.media_buy_deliveries[0].currency, 'EUR');
  });

  test('refuses a 3.2-only task with a typed error instead of sending it', async t => {
    const calls = captureDispatch(t);
    const client = makeClient(caps(['3.0', '3.1']));
    await assert.rejects(client.executeTask('list_account_changes', { account: ACCOUNT }), error => {
      assert.ok(error instanceof ProtocolFeatureUnsupportedError, error?.message);
      assert.equal(error.details.tool, 'list_account_changes');
      assert.equal(error.details.current_version, '3.1');
      return true;
    });
    assert.equal(calls.length, 0);
  });

  test('requireV3ForMutations accepts a seller on an older release of the same major', async () => {
    const client = makeClient(caps(['3.0', '3.1']), { requireV3ForMutations: true });
    await client.requireSupportedMajor('create_media_buy');
    const newerOnly = makeClient(caps(['3.3']), { adcpVersion: '3.1', requireV3ForMutations: true });
    await assert.rejects(newerOnly.requireSupportedMajor('create_media_buy'), VersionUnsupportedError);
  });

  test('validates the converted request against the negotiated release', async t => {
    captureDispatch(t);
    const client = makeClient(caps(['3.1']), { validation: { requests: 'strict', responses: 'off' } });
    const versions = [];
    const original = client.executor.validateRequest.bind(client.executor);
    client.executor.validateRequest = (taskName, params, debugLogs, version) => {
      versions.push(version);
      return original(taskName, params, debugLogs, version);
    };
    await client.executeTask('get_products', {
      brief: 'running shoes',
      brand: { domain: 'nike.com' },
      targeting_overlay: { geo_countries: ['US'] },
    });
    assert.deepEqual(versions, [undefined, '3.1']);
  });
});

describe('sized inline-markup creatives to a seller before AdCP 3.3 (adcp-client#3436)', () => {
  const AAO = 'https://creative.adcontextprotocol.org/';
  const MARKUP =
    '<ins class="acme" style="width:300px;height:250px"><script src="https://ads.acme.example/t.js"></script></ins>';
  const formatIds = ['display_300x250_html', 'display_300x600_html'].map(id => ({ agent_url: AAO, id }));
  const creative = () => ({
    creative_id: 'cr_markup',
    name: 'Markup',
    format_kind: 'display_tag',
    assets: {
      html_creative: {
        asset_type: 'display_tag',
        delivery_type: 'inline_markup',
        markup_type: 'standard',
        markup: MARKUP,
        width: 300,
        height: 250,
      },
    },
  });
  const legacyCreative = {
    creative_id: 'cr_markup',
    name: 'Markup',
    format_id: { agent_url: AAO, id: 'display_300x250_html' },
    assets: { html_creative: { asset_type: 'html', content: MARKUP } },
  };

  for (const [label, sellerCaps, wire] of [
    ['3.0', caps(['3.0']), '3.0'],
    ['3.1 without canonical creatives', caps(['3.0', '3.1'], { features: { canonicalCreatives: false } }), '3.1'],
  ]) {
    test(`${label}: the size selects the legacy ref and is not sent as 3.3 asset fields`, async t => {
      const calls = captureDispatch(t, { structuredContent: { adcp_version: wire, creatives: [] } });
      const client = makeClient(sellerCaps, { adcpVersion: '3.3.0-beta.0' });

      const synced = await client.syncCreatives(
        { account: ACCOUNT, idempotency_key: 'markup-sync-000001', creatives: [creative()] },
        undefined,
        { creativeFormatProjection: { selectorContainers: [{ format_ids: formatIds }] } }
      );
      assert.equal(synced.success, true, synced.error);
      await client.createMediaBuy(
        mediaBuyRequest({
          bidding: undefined,
          name: undefined,
          packages: [
            {
              product_id: 'prod_html',
              pricing_option_id: 'po_1',
              budget: 1000,
              format_ids: formatIds,
              creatives: [creative()],
            },
          ],
        })
      );

      assert.deepEqual(
        calls.map(call => [call.taskName, call.options.wireAdcpVersion]),
        [
          ['sync_creatives', wire],
          ['create_media_buy', wire],
        ]
      );
      assert.deepEqual(calls[0].params.creatives, [legacyCreative]);
      assert.deepEqual(calls[1].params.packages[0].creatives, [legacyCreative]);
      const drops = (synced.debug_logs ?? []).filter(entry => entry.type === 'version_downgrade_fields_dropped');
      assert.deepEqual(drops, [], 'nothing left for the version translation to remove');
    });
  }

  test('a 3.3 seller receives the canonical display_tag with its rendered size', async t => {
    const calls = captureDispatch(t, { structuredContent: { creatives: [] } });
    const client = makeClient(caps(['3.2', '3.3.0-beta.0']), { adcpVersion: '3.3.0-beta.0' });
    await client.syncCreatives(
      { account: ACCOUNT, idempotency_key: 'markup-sync-000002', creatives: [creative()] },
      undefined,
      { creativeFormatProjection: { selectorContainers: [{ format_ids: formatIds }] } }
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.wireAdcpVersion, undefined);
    assert.deepEqual(calls[0].params.creatives, [creative()]);
  });
});

describe("account keys under accountIdentityDowngrade: 'reduce'", () => {
  const CAD = { brand: { domain: 'nike.com', countries: ['CA'] }, operator: 'agency.example', currency: 'CAD' };
  const USD = { brand: { domain: 'nike.com', countries: ['US'] }, operator: 'agency.example', currency: 'USD' };
  const REDUCED = { brand: { domain: 'nike.com' }, operator: 'agency.example' };

  function reducingClient(config = {}) {
    let sellerCaps = caps(['3.1']);
    const client = makeClient(sellerCaps, {
      accountIdentityDowngrade: 'reduce',
      accountStorage: casStorage(),
      ...config,
    });
    client.getCapabilities = async () => sellerCaps;
    return {
      client,
      upgradeSeller: () => {
        sellerCaps = caps(['3.1', '3.2']);
      },
    };
  }

  function seller(t) {
    const calls = [];
    t.mock.method(ProtocolClient, 'callTool', async (_agent, taskName, params, options) => {
      calls.push({ taskName, params, options });
      if (taskName === 'sync_accounts') {
        return {
          structuredContent: {
            accounts: (params.accounts ?? []).map(row => ({
              account_id: 'acc_nike',
              brand: row.brand,
              operator: row.operator,
              action: 'created',
              status: 'active',
            })),
          },
        };
      }
      return { structuredContent: { media_buy_id: 'mb_1', media_buy_status: 'active', packages: [] } };
    });
    return calls;
  }

  const syncRequest = (...keys) => ({
    idempotency_key: 'reduce-sync-000001',
    accounts: keys.map(key => ({ ...key, billing: 'operator' })),
  });
  const buyRequest = account => ({
    idempotency_key: 'reduce-buy-0000001',
    account,
    brand: { domain: 'nike.com' },
    start_time: 'asap',
    end_time: '2027-01-31T23:59:59Z',
    packages: [{ product_id: 'prod_1', pricing_option_id: 'po_1', budget: 100 }],
  });
  const collision = error => {
    assert.ok(error instanceof ProtocolFeatureUnsupportedError, error?.message);
    assert.equal(error.details.reason, 'account_identity_collision');
    assert.match(error.message, /No request was sent/);
    return true;
  };

  for (const accountPolicy of ['auto', 'strict']) {
    test(`a reduced account is registered under the buyer key (accountPolicy: ${accountPolicy})`, async t => {
      const calls = seller(t);
      const { client } = reducingClient({ accountPolicy });
      assert.equal((await client.executeTask('sync_accounts', syncRequest(CAD))).success, true);
      const entry = await client.accounts.get(CAD);
      assert.equal(entry.account_id, 'acc_nike');
      const result = await client.executeTask('create_media_buy', buyRequest(CAD));
      assert.equal(result.success, true, result.error);
      assert.deepEqual(calls.at(-1).params.account, REDUCED);
    });
  }

  test('accounts.ensure provisions a reduced account', async t => {
    seller(t);
    const { client } = reducingClient({ accountPolicy: 'auto' });
    const entry = await client.accounts.ensure(CAD, { billing: 'operator' });
    assert.equal(entry.account_id, 'acc_nike');
    assert.deepEqual((await client.accounts.reductionFor(CAD)).account, REDUCED);
  });

  test('refuses a second buyer key that reduces onto the same seller account', async t => {
    const calls = seller(t);
    const { client } = reducingClient();
    await client.executeTask('sync_accounts', syncRequest(CAD));
    await assert.rejects(client.executeTask('create_media_buy', buyRequest(USD)), collision);
    await assert.rejects(client.executeTask('create_media_buy', buyRequest(REDUCED)), collision);
    assert.deepEqual(
      calls.map(call => call.taskName),
      ['sync_accounts']
    );
  });

  test('refuses two keys in one request that reduce to the same account, and claims neither', async t => {
    const calls = seller(t);
    const { client } = reducingClient();
    await assert.rejects(client.executeTask('sync_accounts', syncRequest(CAD, USD)), collision);
    assert.equal(calls.length, 0);
    assert.equal(await client.accounts.reductionFor(CAD), undefined, 'a refused request leaves no claim behind');
    assert.equal((await client.executeTask('sync_accounts', syncRequest(USD))).success, true);
    assert.equal(calls.length, 1);
  });

  test('refuses a reduced key after the plain key reached the seller first', async t => {
    const calls = seller(t);
    const { client } = reducingClient();
    assert.equal((await client.executeTask('sync_accounts', syncRequest(REDUCED))).success, true);
    await assert.rejects(client.executeTask('create_media_buy', buyRequest(CAD)), collision);
    assert.deepEqual(
      calls.map(call => call.taskName),
      ['sync_accounts']
    );
    const plainAgain = await client.executeTask('create_media_buy', buyRequest(REDUCED));
    assert.equal(plainAgain.success, true, 'the plain key keeps working');
  });

  test('claims hold across client instances that share account storage', async t => {
    const calls = seller(t);
    const storage = casStorage();
    const first = makeClient(caps(['3.1']), { accountIdentityDowngrade: 'reduce', accountStorage: storage });
    const second = makeClient(caps(['3.1']), { accountIdentityDowngrade: 'reduce', accountStorage: storage });
    await first.executeTask('sync_accounts', syncRequest(CAD));
    await assert.rejects(second.executeTask('sync_accounts', syncRequest(USD)), collision);
    assert.equal(calls.length, 1);
  });

  test("refuses 'reduce' without compare-and-set account storage", () => {
    for (const accountStorage of [undefined, { get: async () => undefined, set: async () => {} }]) {
      assert.throws(
        () =>
          makeClient(caps(['3.1']), { accountIdentityDowngrade: 'reduce', ...(accountStorage && { accountStorage }) }),
        error => {
          assert.equal(error.code, 'CONFIGURATION_ERROR');
          assert.match(error.message, /requires accountStorage with compareAndSet/);
          return true;
        }
      );
    }
  });

  test('keeps the reduced key after the seller upgrades, until the account is moved', async t => {
    const calls = seller(t);
    const { client, upgradeSeller } = reducingClient();
    await client.executeTask('sync_accounts', syncRequest(CAD));
    upgradeSeller();

    const pending = await client.executeTask('create_media_buy', buyRequest(CAD));
    assert.deepEqual(calls.at(-1).params.account, REDUCED);
    assert.equal(calls.at(-1).options.wireAdcpVersion, undefined, 'the seller now speaks 3.2');
    const drift = pending.debug_logs.find(entry => entry.type === 'account_identity_migration_pending');
    assert.deepEqual(drift.accounts, [
      { path: 'account', fields: ['currency', 'brand.countries'], adcpVersion: '3.1' },
    ]);
    assert.match(drift.message, /open a new account/);

    await client.accounts.clearReduction(CAD);
    await client.executeTask('create_media_buy', buyRequest(CAD));
    assert.deepEqual(calls.at(-1).params.account, CAD);
    assert.equal(await client.accounts.reductionFor(CAD), undefined);
  });

  test('an operator_unit-only reduction points at an in-place rekey', async t => {
    const calls = seller(t);
    const { client, upgradeSeller } = reducingClient();
    const desk = { ...REDUCED, operator_unit: { id: 'desk-ca' } };
    await client.executeTask('sync_accounts', syncRequest(desk));
    upgradeSeller();
    const result = await client.executeTask('create_media_buy', buyRequest(desk));
    assert.deepEqual(calls.at(-1).params.account, REDUCED);
    const drift = result.debug_logs.find(entry => entry.type === 'account_identity_migration_pending');
    assert.match(drift.message, /operator_identity/);
  });

  test('refuses a 3.2 account move to a 3.1 seller', async t => {
    const calls = seller(t);
    const client = makeClient(caps(['3.1']));
    await assert.rejects(
      client.executeTask('sync_accounts', {
        idempotency_key: 'reduce-move-000001',
        accounts: [
          {
            account: { account_id: 'acc_nike' },
            operator_identity: { operator: 'agency.example', operator_unit: { id: 'desk-ca' } },
            revision: 3,
          },
        ],
      }),
      error => {
        assert.ok(error instanceof ProtocolFeatureUnsupportedError, error?.message);
        assert.match(error.adcpError.suggestion, /cannot rekey an account/);
        return true;
      }
    );
    assert.equal(calls.length, 0);
  });
});

describe('sync_creatives assignment_operations to a 3.1 seller', () => {
  test('moves assign-only operations to assignments with strict validation', () => {
    const { params, drifts, refusedFields } = convertRequest(
      'sync_creatives',
      {
        idempotency_key: 'assign-ops-0000001',
        assignments: [{ creative_id: 'cr_0', package_id: 'pkg_1' }],
        assignment_operations: [
          { operation: 'assign', creative_id: 'cr_1', package_id: 'pkg_1', weight: 50 },
          { operation: 'assign', creative_id: 'cr_2', package_id: 'pkg_2', placement_ids: ['top'] },
        ],
      },
      { fromVersion: CLIENT_VERSION, toVersion: '3.1' }
    );
    assert.deepEqual(params.assignments, [
      { creative_id: 'cr_0', package_id: 'pkg_1' },
      { creative_id: 'cr_1', package_id: 'pkg_1', weight: 50 },
      { creative_id: 'cr_2', package_id: 'pkg_2', placement_ids: ['top'] },
    ]);
    assert.equal(params.assignment_operations, undefined);
    assert.equal(params.validation_mode, 'strict');
    assert.deepEqual(refusedFields, []);
    assert.equal(drifts[0].type, 'assignment_operations_moved_to_assignments');
  });

  test('removes an empty assignment_operations without forcing strict validation', () => {
    const request = {
      idempotency_key: 'assign-ops-0000003',
      assignments: [{ creative_id: 'cr_0', package_id: 'pkg_1' }],
      assignment_operations: [],
    };
    const { params, refusedFields } = convertRequest('sync_creatives', request, {
      fromVersion: CLIENT_VERSION,
      toVersion: '3.1',
    });
    assert.equal(params.assignment_operations, undefined);
    assert.equal(params.validation_mode, undefined, 'the caller chose no mode');
    assert.deepEqual(params.assignments, request.assignments);
    assert.deepEqual(refusedFields, []);
  });

  test('refuses unassign and replace, which 3.1 cannot express', () => {
    const { refusedFields } = convertRequest(
      'sync_creatives',
      {
        idempotency_key: 'assign-ops-0000002',
        assignment_operations: [
          { operation: 'assign', creative_id: 'cr_1', package_id: 'pkg_1' },
          { operation: 'unassign', creative_id: 'cr_2', package_id: 'pkg_1' },
        ],
      },
      { fromVersion: CLIENT_VERSION, toVersion: '3.1' }
    );
    assert.deepEqual(
      refusedFields.map(field => field.path),
      ['assignment_operations']
    );
  });
});
