/**
 * Server-side cross-version translation (adcp-client#3370).
 *
 * Handlers are written against the server's release. A buyer on an older
 * release gets the handler's response converted down to its release, with
 * what that release cannot express removed, before response validation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createAdcpServer } = require('../dist/lib/server/create-adcp-server');

const DELIVERY_32 = {
  reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-01-02T00:00:00Z' },
  media_buy_deliveries: [
    {
      media_buy_id: 'mb_1',
      status: 'active',
      currency: 'USD',
      pacing_index: 1.02,
      totals: { impressions: 1000, spend: 12.5 },
      by_package: [],
    },
  ],
};

function identityConfig(enabled) {
  if (!enabled) return {};
  const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');
  const { InMemoryStateStore } = require('../dist/lib/server/state-store');
  return {
    stateStore: new InMemoryStateStore(),
    identity33: { authorize: async () => {} },
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }), ttlSeconds: 86400 }),
  };
}

function server(seen = [], identity33 = false) {
  return createAdcpServer({
    name: 'Translating seller',
    ...identityConfig(identity33),
    version: '1.0.0',
    capabilities: { supported_versions: ['3.0', '3.1', '3.2', '3.3-beta.5'] },
    validation: { requests: 'strict', responses: 'strict' },
    mediaBuy: {
      getMediaBuyDelivery: async (params, ctx) => {
        seen.push({ params, servedAdcpVersion: ctx.servedAdcpVersion });
        return structuredClone(DELIVERY_32);
      },
    },
  });
}

async function call(adcpServer, args) {
  return adcpServer.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_media_buy_delivery', arguments: args },
  });
}

for (const identity33 of [false, true]) {
  describe(`createAdcpServer translates for older buyers (identity33=${identity33})`, () => {
    for (const release of ['3.0', '3.1']) {
      it(`converts the response down to ${release} and validates it`, async () => {
        const seen = [];
        const response = await call(server(seen, identity33), { adcp_version: release, media_buy_ids: ['mb_1'] });
        assert.notStrictEqual(response.isError, true, JSON.stringify(response.structuredContent));
        const body = response.structuredContent;
        assert.strictEqual(body.adcp_version, release === '3.0' ? undefined : release);
        assert.strictEqual(
          body.currency,
          'USD',
          'the root currency 3.1 requires is filled from the shared per-buy currency'
        );
        assert.strictEqual(body.media_buy_deliveries[0].pacing_index, undefined, '3.2-only fields are removed');
        assert.strictEqual(body.media_buy_deliveries[0].currency, undefined);
        for (const part of response.content ?? []) assert.ok(!String(part.text ?? '').includes('pacing_index'));
        assert.strictEqual(seen[0].servedAdcpVersion, release);
      });
    }
    for (const release of ['3.2', '3.3-beta.5']) {
      it(`preserves the delivery fields for ${release}`, async () => {
        const response = await call(server([], identity33), { adcp_version: release, media_buy_ids: ['mb_1'] });
        assert.notStrictEqual(response.isError, true, JSON.stringify(response.structuredContent));
        const body = response.structuredContent;
        assert.strictEqual(body.media_buy_deliveries[0].pacing_index, 1.02);
        assert.strictEqual(body.media_buy_deliveries[0].currency, 'USD');
        assert.strictEqual(body.currency, undefined);
      });
    }
  });
}

describe('server-direction converters', () => {
  const { convertRequestFromRelease, convertResponseToRelease } = require('../dist/lib/adapters/version/translate');

  it('runs upgradeRequest adapters from the served release up to the server release, oldest first', () => {
    const order = [];
    const adapters = key => ({
      toolName: 'probe',
      upgradeRequest: params => {
        order.push(key);
        return { params: { ...params, [`via_${key}`]: true }, drift: { type: `up_${key}`, message: key } };
      },
    });
    const { params, drifts } = convertRequestFromRelease(
      'probe',
      {},
      { fromVersion: '3.0', toVersion: '3.2.5', adapters }
    );
    assert.deepStrictEqual(order, ['3.0', '3.1']);
    assert.deepStrictEqual(params, { 'via_3.0': true, 'via_3.1': true });
    assert.deepStrictEqual(
      drifts.map(drift => [drift.type, drift.fromVersion, drift.toVersion]),
      [
        ['up_3.0', '3.0', '3.1'],
        ['up_3.1', '3.1', '3.2.5'],
      ]
    );
  });

  it('chains response downgrades through 3.1 to 3.0 and reports each step', () => {
    const { data, drifts } = convertResponseToRelease('get_media_buy_delivery', structuredClone(DELIVERY_32), {
      fromVersion: '3.2.5',
      toVersion: '3.0',
      adapters: key => require('../dist/lib/adapters/version/index').getVersionAdapter(key, 'get_media_buy_delivery'),
    });
    assert.strictEqual(data.currency, 'USD');
    assert.strictEqual(data.media_buy_deliveries[0].pacing_index, undefined);
    assert.ok(drifts.some(drift => drift.type === 'delivery_currency_to_root' && drift.toVersion === '3.1'));
    assert.ok(drifts.some(drift => drift.type === 'version_downgrade_fields_dropped' && drift.toVersion === '3.1'));
  });
});

for (const identity33 of [false, true]) {
  describe(`version translation visibility and async results (identity33=${identity33})`, () => {
    const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');

    it('reports each response conversion to onVersionTranslation', async () => {
      const events = [];
      const adcpServer = createAdcpServer({
        name: 'Translating seller',
        ...identityConfig(identity33),
        version: '1.0.0',
        capabilities: { supported_versions: ['3.0', '3.1', '3.2', '3.3-beta.5'] },
        onVersionTranslation: event => events.push(event),
        mediaBuy: { getMediaBuyDelivery: async () => structuredClone(DELIVERY_32) },
      });
      await call(adcpServer, { adcp_version: '3.1', media_buy_ids: ['mb_1'] });
      await call(adcpServer, { adcp_version: '3.2', media_buy_ids: ['mb_1'] });
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].tool, 'get_media_buy_delivery');
      assert.strictEqual(events[0].direction, 'response');
      assert.strictEqual(events[0].toVersion, '3.1');
      const dropped = events[0].drifts.find(drift => drift.type === 'version_downgrade_fields_dropped');
      assert.ok(dropped.strippedFields.includes('media_buy_deliveries[0].pacing_index'));
    });

    it('ignores a throwing onVersionTranslation callback', async () => {
      const adcpServer = createAdcpServer({
        name: 'Translating seller',
        ...identityConfig(identity33),
        version: '1.0.0',
        capabilities: { supported_versions: ['3.0', '3.1', '3.2', '3.3-beta.5'] },
        onVersionTranslation: () => {
          throw new Error('observer failed');
        },
        mediaBuy: { getMediaBuyDelivery: async () => structuredClone(DELIVERY_32) },
      });
      const response = await call(adcpServer, { adcp_version: '3.1', media_buy_ids: ['mb_1'] });
      assert.notStrictEqual(response.isError, true);
      assert.strictEqual(response.structuredContent.currency, 'USD');
    });

    it('converts a stored task result down for a buyer polling get_task_status on 3.1', async () => {
      const events = [];
      const taskRegistry = createInMemoryTaskRegistry();
      const owner = { accountId: 'acct_1', ownerScope: 'api_key:buyer-1' };
      const task = await taskRegistry.create({ tool: 'create_media_buy', ...owner });
      await taskRegistry.complete(task.taskId, owner, {
        media_buy_id: 'mb_1',
        media_buy_status: 'active',
        name: 'Q1 launch',
        packages: [],
      });
      const adcpServer = createAdcpServer({
        name: 'Translating seller',
        ...identityConfig(identity33),
        version: '1.0.0',
        capabilities: { supported_versions: ['3.0', '3.1', '3.2', '3.3-beta.5'] },
        taskRegistry,
        onVersionTranslation: event => events.push(event),
        resolveAccountFromAuth: async () => ({ id: 'acct_1' }),
        mediaBuy: { getMediaBuyDelivery: async () => structuredClone(DELIVERY_32) },
      });
      const buyer = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };
      const poll = async adcp_version =>
        adcpServer.dispatchTestRequest(
          {
            method: 'tools/call',
            params: {
              name: 'get_task_status',
              arguments: { adcp_version, task_id: task.taskId, include_result: true },
            },
          },
          buyer
        );
      const legacy = await poll('3.1');
      assert.notStrictEqual(legacy.isError, true, JSON.stringify(legacy.structuredContent));
      assert.strictEqual(legacy.structuredContent.result.media_buy_id, 'mb_1');
      assert.strictEqual(legacy.structuredContent.result.name, undefined, 'the 3.2-only name is removed');
      assert.ok(events.some(event => event.tool === 'create_media_buy' && event.toVersion === '3.1'));
      const current = await poll('3.2');
      assert.strictEqual(current.structuredContent.result.name, 'Q1 launch');
    });
  });
}

describe('envelope fields survive response down-conversion', () => {
  const { downgradeResponse } = require('../dist/lib/adapters/version/index');
  it('keeps protocol-envelope fields a 3.2 proposal-flow schema does not compose', () => {
    const response = {
      status: 'completed',
      message: 'Listed one product.',
      context: { trace: 'abc' },
      outcome: 'listed',
      feed_version: 'feed-1',
      cache_scope: 'public',
      products: [{ product_id: 'prod_1', name: 'Premium video', hold_policy: { available: false } }],
    };
    const { data, drifts } = downgradeResponse('list_products', response, {
      fromVersion: '3.3.0-beta.5',
      toVersion: '3.2',
    });
    assert.strictEqual(data.status, 'completed');
    assert.strictEqual(data.message, 'Listed one product.');
    assert.deepStrictEqual(data.context, { trace: 'abc' });
    assert.strictEqual(data.products[0].hold_policy, undefined, 'the 3.3 field is still removed');
    const reported = drifts.flatMap(drift => drift.strippedFields ?? []);
    assert.ok(!reported.includes('status'));
  });
});

describe('experimental 3.3 match keys', () => {
  const { downgradeResponse } = require('../dist/lib/adapters/version/index');
  const MATCH_KEY = { uid_type: 'uid2', scopes: ['individuals'], uses: ['frequency_cap'] };
  const products = () => ({
    status: 'completed',
    products: [
      {
        product_id: 'prod_1',
        name: 'Premium video',
        identity: { persistent_identifier: true, match_keys: [MATCH_KEY] },
      },
    ],
  });

  it('removes Product.identity.match_keys for a 3.2 buyer and reports it', () => {
    const { data, drifts } = downgradeResponse('get_products', products(), {
      fromVersion: '3.3.0-beta.5',
      toVersion: '3.2',
    });
    assert.deepStrictEqual(data.products[0].identity, { persistent_identifier: true });
    const dropped = drifts.find(drift => drift.type === 'version_downgrade_fields_dropped');
    assert.deepStrictEqual(dropped.strippedFields, ['products[0].identity.match_keys']);
  });

  it('keeps Product.identity.match_keys for a 3.3 beta.5 buyer', () => {
    const { data, drifts } = downgradeResponse('get_products', products(), {
      fromVersion: '3.3.0-beta.5',
      toVersion: '3.3.0-beta.5',
    });
    assert.deepStrictEqual(data.products[0].identity.match_keys, [MATCH_KEY]);
    assert.deepStrictEqual(drifts, []);
  });
});

it('keeps identity authorization ahead of dispatch for an older buyer', async () => {
  const args = { adcp_version: '3.1', media_buy_ids: ['mb_1'] };
  let handled = false;
  let authorized;
  const adcpServer = createAdcpServer({
    ...identityConfig(true),
    name: 'Denied legacy buyer',
    version: '1.0.0',
    capabilities: { supported_versions: ['3.1', '3.3-beta.5'] },
    validation: { requests: 'strict', responses: 'strict' },
    identity33: {
      authorize: async (_ctx, tool, params) => {
        authorized = { tool, params };
        throw new Error('denied');
      },
    },
    mediaBuy: {
      getMediaBuyDelivery: async () => {
        handled = true;
        return structuredClone(DELIVERY_32);
      },
    },
  });
  const response = await call(adcpServer, args);
  assert.strictEqual(response.isError, true);
  assert.strictEqual(handled, false);
  assert.deepStrictEqual(authorized, { tool: 'get_media_buy_delivery', params: args });
  assert.strictEqual(response.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
});

it('upgrades an older identity request after authorization and before handler dispatch', async () => {
  const { getVersionAdapter } = require('../dist/lib/adapters/version');
  const adapter = getVersionAdapter('3.1', 'get_media_buy_delivery');
  const originalUpgrade = adapter.upgradeRequest;
  const upgradedIds = ['mb_upgraded'];
  // Current adapters have no request-side rename. Instrument the existing adapter
  // to exercise the server's upgrade hook and its ordering through real dispatch.
  adapter.upgradeRequest = params => ({
    params: { ...params, media_buy_ids: upgradedIds },
    drift: { type: 'test_request_upgrade', message: 'Instrumented request upgrade' },
  });
  try {
    const authorized = [];
    const handled = [];
    const events = [];
    const adcpServer = createAdcpServer({
      ...identityConfig(true),
      name: 'Request translation',
      version: '1.0.0',
      capabilities: { supported_versions: ['3.1', '3.3-beta.5'] },
      validation: { requests: 'strict', responses: 'strict' },
      identity33: { authorize: async (_ctx, _tool, params) => authorized.push(structuredClone(params)) },
      onVersionTranslation: event => events.push(event),
      mediaBuy: {
        getMediaBuyDelivery: async params => {
          handled.push(structuredClone(params));
          return structuredClone(DELIVERY_32);
        },
      },
    });
    for (const release of ['3.1', '3.3-beta.5']) {
      const args = { adcp_version: release, media_buy_ids: ['mb_1'] };
      const response = await call(adcpServer, args);
      assert.notStrictEqual(response.isError, true, JSON.stringify(response.structuredContent));
      assert.deepStrictEqual(authorized.at(-1), args);
      assert.deepStrictEqual(handled.at(-1).media_buy_ids, release === '3.1' ? upgradedIds : args.media_buy_ids);
      assert.deepStrictEqual(args.media_buy_ids, ['mb_1'], 'the caller payload is not mutated');
    }
    const upgrades = events.filter(event => event.direction === 'request');
    assert.strictEqual(upgrades.length, 1);
    assert.strictEqual(upgrades[0].tool, 'get_media_buy_delivery');
    assert.strictEqual(upgrades[0].fromVersion, '3.1');
  } finally {
    if (originalUpgrade === undefined) delete adapter.upgradeRequest;
    else adapter.upgradeRequest = originalUpgrade;
  }
});
