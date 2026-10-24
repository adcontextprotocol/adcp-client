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

function server(seen = []) {
  return createAdcpServer({
    name: 'Translating seller',
    version: '1.0.0',
    capabilities: { supported_versions: ['3.1', '3.2'] },
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

describe('createAdcpServer translates for older buyers', () => {
  it('converts the response down to a 3.1 buyer and validates it as 3.1', async () => {
    const seen = [];
    const response = await call(server(seen), { adcp_version: '3.1', media_buy_ids: ['mb_1'] });
    assert.notStrictEqual(response.isError, true, JSON.stringify(response.structuredContent));
    const body = response.structuredContent;
    assert.strictEqual(body.adcp_version, '3.1');
    assert.strictEqual(
      body.currency,
      'USD',
      'the root currency 3.1 requires is filled from the shared per-buy currency'
    );
    assert.strictEqual(body.media_buy_deliveries[0].pacing_index, undefined, '3.2-only fields are removed');
    assert.strictEqual(body.media_buy_deliveries[0].currency, undefined);
    for (const part of response.content ?? []) assert.ok(!String(part.text ?? '').includes('pacing_index'));
    assert.strictEqual(seen[0].servedAdcpVersion, '3.1');
  });

  it('leaves a 3.2 buyer’s response as the handler returned it', async () => {
    const response = await call(server(), { adcp_version: '3.2', media_buy_ids: ['mb_1'] });
    assert.notStrictEqual(response.isError, true, JSON.stringify(response.structuredContent));
    const body = response.structuredContent;
    assert.strictEqual(body.media_buy_deliveries[0].pacing_index, 1.02);
    assert.strictEqual(body.media_buy_deliveries[0].currency, 'USD');
    assert.strictEqual(body.currency, undefined);
  });
});

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

describe('version translation visibility and async results', () => {
  const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');

  it('reports each response conversion to onVersionTranslation', async () => {
    const events = [];
    const adcpServer = createAdcpServer({
      name: 'Translating seller',
      version: '1.0.0',
      capabilities: { supported_versions: ['3.1', '3.2'] },
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
      version: '1.0.0',
      capabilities: { supported_versions: ['3.1', '3.2'] },
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
      version: '1.0.0',
      capabilities: { supported_versions: ['3.1', '3.2'] },
      taskRegistry,
      resolveAccountFromAuth: async () => ({ id: 'acct_1' }),
      mediaBuy: { getMediaBuyDelivery: async () => structuredClone(DELIVERY_32) },
    });
    const buyer = { authInfo: { credential: { kind: 'api_key', key_id: 'buyer-1' } } };
    const poll = async adcp_version =>
      adcpServer.dispatchTestRequest(
        {
          method: 'tools/call',
          params: { name: 'get_task_status', arguments: { adcp_version, task_id: task.taskId, include_result: true } },
        },
        buyer
      );
    const legacy = await poll('3.1');
    assert.notStrictEqual(legacy.isError, true, JSON.stringify(legacy.structuredContent));
    assert.strictEqual(legacy.structuredContent.result.media_buy_id, 'mb_1');
    assert.strictEqual(legacy.structuredContent.result.name, undefined, 'the 3.2-only name is removed');
    const current = await poll('3.2');
    assert.strictEqual(current.structuredContent.result.name, 'Q1 launch');
  });
});
