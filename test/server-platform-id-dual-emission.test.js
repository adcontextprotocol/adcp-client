// AdCP 3.3 platform_id / seller_id dual emission on sync_audiences and
// sync_event_sources: server responses, stored task results, version adapter.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createAdcpServer } = require('../dist/lib/server/create-adcp-server');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { createInMemoryTaskRegistry } = require('../dist/lib/server/decisioning/runtime/task-registry');
const { createIdempotencyStore, memoryBackend } = require('../dist/lib/server/idempotency');
const { downgradeResponse, projectResponseForRelease } = require('../dist/lib/adapters/version/index.js');
const { ADCP_VERSION } = require('../dist/lib/version');

const OFF = { requests: 'off', responses: 'off' };
const KEY = '8f4e2a1c-d6b8-4f9e-9a3c-7b1d5e8f2a4d';

const call = (server, name, args) =>
  server.dispatchTestRequest({ method: 'tools/call', params: { name, arguments: args } });

const audienceArgs = (extra = {}) => ({
  audiences: [{ audience_id: 'aud_1', identifiers: ['e1'] }],
  idempotency_key: KEY,
  account: { account_id: 'acc_1' },
  ...extra,
});
const eventSourceArgs = (extra = {}) => ({
  event_sources: [{ event_source_id: 'es_1', name: 'pixel' }],
  idempotency_key: KEY,
  account: { account_id: 'acc_1' },
  ...extra,
});

const audienceRow = ids => ({ audience_id: 'aud_1', action: 'created', status: 'matching', ...ids });
const eventRow = ids => ({ event_source_id: 'es_1', action: 'created', ...ids });

const SHAPES = [
  ['platform_id only', { platform_id: 'p1' }, { platform_id: 'p1', seller_id: 'p1' }, { seller_id: 'p1' }],
  ['seller_id only', { seller_id: 'p1' }, { platform_id: 'p1', seller_id: 'p1' }, { seller_id: 'p1' }],
  ['both equal', { platform_id: 'p1', seller_id: 'p1' }, { platform_id: 'p1', seller_id: 'p1' }, { seller_id: 'p1' }],
];

function legacyServer({ audiences, eventSources, ...config } = {}) {
  return createAdcpServer({
    name: 'Test',
    version: '1.0.0',
    validation: OFF,
    resolveAccount: async ref => ({ id: ref.account_id }),
    eventTracking: {
      syncAudiences: async () => ({ audiences: audiences() }),
      syncEventSources: async () => ({ event_sources: eventSources() }),
    },
    ...config,
  });
}

function platformServer({ audiences, eventSources, supportedVersions, taskRegistry } = {}) {
  const platform = {
    capabilities: {
      specialisms: ['audience-sync', 'sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
      ...(supportedVersions && { supported_versions: supportedVersions }),
    },
    accounts: {
      resolve: async ref => ({ id: ref?.account_id ?? 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async () => ({ products: [], cache_scope: 'account' }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
      syncEventSources: async () => ({ event_sources: eventSources() }),
    },
    audiences: {
      syncAudiences: async () => audiences(),
      pollAudienceStatuses: async () => new Map(),
    },
  };
  return createAdcpServerFromPlatform(platform, {
    name: 'p',
    version: '0.0.1',
    validation: OFF,
    ...(taskRegistry && { taskRegistry }),
  });
}

function assertOk(result) {
  assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
}

describe('sync rows through createAdcpServer', () => {
  for (const [label, handlerIds, both, sellerOnly] of SHAPES) {
    it(`${label}: caller at the pin gets both names`, async () => {
      const server = legacyServer({
        audiences: () => [audienceRow(handlerIds)],
        eventSources: () => [eventRow(handlerIds)],
      });
      const aud = await call(server, 'sync_audiences', audienceArgs());
      assertOk(aud);
      assert.deepStrictEqual(aud.structuredContent.audiences[0], audienceRow(both));
      const ev = await call(server, 'sync_event_sources', eventSourceArgs());
      assertOk(ev);
      assert.deepStrictEqual(ev.structuredContent.event_sources[0], eventRow(both));
    });

    it(`${label}: adcp_version 3.2 caller gets seller_id only`, async () => {
      const server = legacyServer({
        audiences: () => [audienceRow(handlerIds)],
        eventSources: () => [eventRow(handlerIds)],
      });
      const aud = await call(server, 'sync_audiences', audienceArgs({ adcp_version: '3.2' }));
      assertOk(aud);
      assert.deepStrictEqual(aud.structuredContent.audiences[0], audienceRow(sellerOnly));
      const ev = await call(server, 'sync_event_sources', eventSourceArgs({ adcp_version: '3.2' }));
      assertOk(ev);
      assert.deepStrictEqual(ev.structuredContent.event_sources[0], eventRow(sellerOnly));
    });
  }

  it('leaves rows without either name untouched', async () => {
    const server = legacyServer({ audiences: () => [audienceRow({})], eventSources: () => [] });
    const aud = await call(server, 'sync_audiences', audienceArgs());
    assertOk(aud);
    assert.deepStrictEqual(aud.structuredContent.audiences[0], audienceRow({}));
  });

  it('rejects a mismatch with INTERNAL_ERROR', async () => {
    const server = legacyServer({
      audiences: () => [audienceRow({ platform_id: 'a', seller_id: 'b' })],
      eventSources: () => [eventRow({ platform_id: 'a', seller_id: 'b' })],
    });
    for (const [tool, args] of [
      ['sync_audiences', audienceArgs()],
      ['sync_event_sources', eventSourceArgs()],
      [
        'sync_audiences',
        audienceArgs({ adcp_version: '3.2', idempotency_key: 'a2a2a2a2-d6b8-4f9e-9a3c-7b1d5e8f2a4d' }),
      ],
    ]) {
      const result = await call(server, tool, args);
      assert.strictEqual(result.isError, true, tool);
      assert.strictEqual(result.structuredContent.adcp_error.code, 'INTERNAL_ERROR', tool);
      assert.match(result.structuredContent.adcp_error.message, /platform_id and seller_id differ/);
    }
  });

  it('does not re-run the handler on an exact replay after a mismatch', async () => {
    let calls = 0;
    const server = legacyServer({
      audiences: () => {
        calls += 1;
        return [audienceRow({ platform_id: 'a', seller_id: 'b' })];
      },
      eventSources: () => [],
      idempotency: createIdempotencyStore({ backend: memoryBackend() }),
      resolveIdempotencyPrincipal: () => 'principal-1',
    });
    const extra = { authInfo: { clientId: 'principal-1' } };
    const first = await server.dispatchTestRequest(
      { method: 'tools/call', params: { name: 'sync_audiences', arguments: audienceArgs() } },
      extra
    );
    assert.strictEqual(first.structuredContent.adcp_error.code, 'INTERNAL_ERROR');
    const second = await server.dispatchTestRequest(
      { method: 'tools/call', params: { name: 'sync_audiences', arguments: audienceArgs() } },
      extra
    );
    assert.strictEqual(second.isError, true);
    assert.strictEqual(calls, 1, 'the mutating handler must not run again');
  });

  it('does not touch other tools', async () => {
    const server = createAdcpServer({
      name: 'Test',
      version: '1.0.0',
      validation: OFF,
      mediaBuy: { getProducts: async () => ({ products: [{ product_id: 'p', platform_id: 'x', seller_id: 'y' }] }) },
    });
    const result = await call(server, 'get_products', { buying_mode: 'wholesale' });
    assert.deepStrictEqual(result.structuredContent.products[0], { product_id: 'p', platform_id: 'x', seller_id: 'y' });
  });
});

describe('sync rows through createAdcpServerFromPlatform', () => {
  for (const [label, handlerIds, both, sellerOnly] of SHAPES) {
    it(`${label}: pin gets both names, 3.2 gets seller_id only`, async () => {
      const server = platformServer({
        audiences: () => [audienceRow(handlerIds)],
        eventSources: () => [eventRow(handlerIds)],
        supportedVersions: ['3.2', ADCP_VERSION],
      });
      const aud = await call(server, 'sync_audiences', audienceArgs());
      assertOk(aud);
      assert.deepStrictEqual(aud.structuredContent.audiences[0], audienceRow(both));
      const ev = await call(server, 'sync_event_sources', eventSourceArgs());
      assertOk(ev);
      assert.deepStrictEqual(ev.structuredContent.event_sources[0], eventRow(both));

      const aud32 = await call(
        server,
        'sync_audiences',
        audienceArgs({ adcp_version: '3.2', idempotency_key: 'b1b1b1b1-d6b8-4f9e-9a3c-7b1d5e8f2a4d' })
      );
      assertOk(aud32);
      assert.deepStrictEqual(aud32.structuredContent.audiences[0], audienceRow(sellerOnly));
      const ev32 = await call(
        server,
        'sync_event_sources',
        eventSourceArgs({ adcp_version: '3.2', idempotency_key: 'b2b2b2b2-d6b8-4f9e-9a3c-7b1d5e8f2a4d' })
      );
      assertOk(ev32);
      assert.deepStrictEqual(ev32.structuredContent.event_sources[0], eventRow(sellerOnly));
    });
  }

  it('rejects a mismatch with INTERNAL_ERROR', async () => {
    const bad = { platform_id: 'a', seller_id: 'b' };
    const server = platformServer({ audiences: () => [audienceRow(bad)], eventSources: () => [eventRow(bad)] });
    const aud = await call(server, 'sync_audiences', audienceArgs());
    assert.strictEqual(aud.isError, true);
    assert.strictEqual(aud.structuredContent.adcp_error.code, 'INTERNAL_ERROR');
    const ev = await call(server, 'sync_event_sources', eventSourceArgs());
    assert.strictEqual(ev.isError, true);
    assert.strictEqual(ev.structuredContent.adcp_error.code, 'INTERNAL_ERROR');
  });
});

describe('in-memory TaskRegistry.complete', () => {
  const scope = { accountId: 'acc_1', ownerScope: 'account:acc_1' };

  async function create(registry, tool) {
    return registry.create({ tool, accountId: 'acc_1' });
  }

  it('stores both names for sync_audiences and sync_event_sources', async () => {
    const registry = createInMemoryTaskRegistry();
    const a = await create(registry, 'sync_audiences');
    const e = await create(registry, 'sync_event_sources');
    assert.strictEqual(
      (await registry.complete(a.taskId, scope, { audiences: [{ seller_id: 's' }] })).outcome,
      'applied'
    );
    assert.strictEqual(
      (await registry.complete(e.taskId, scope, { event_sources: [{ platform_id: 'p' }] })).outcome,
      'applied'
    );
    assert.deepStrictEqual((await registry.getTask(a.taskId, scope)).result.audiences[0], {
      seller_id: 's',
      platform_id: 's',
    });
    assert.deepStrictEqual((await registry.getTask(e.taskId, scope)).result.event_sources[0], {
      platform_id: 'p',
      seller_id: 'p',
    });
  });

  it('throws on a mismatch and leaves the task non-terminal', async () => {
    const registry = createInMemoryTaskRegistry();
    const ref = await create(registry, 'sync_audiences');
    await assert.rejects(
      () => registry.complete(ref.taskId, scope, { audiences: [{ platform_id: 'a', seller_id: 'b' }] }),
      /platform_id.*seller_id|identical/
    );
    const record = await registry.getTask(ref.taskId, scope);
    assert.strictEqual(record.status, 'submitted');
    assert.strictEqual(record.result, undefined);
    // a corrected write still lands
    assert.strictEqual(
      (await registry.complete(ref.taskId, scope, { audiences: [{ platform_id: 'a' }] })).outcome,
      'applied'
    );
  });

  it('is idempotent: a second complete reports already_terminal and keeps the first result', async () => {
    const registry = createInMemoryTaskRegistry();
    const ref = await create(registry, 'sync_audiences');
    await registry.complete(ref.taskId, scope, { audiences: [{ platform_id: 'p' }] });
    const again = await registry.complete(ref.taskId, scope, { audiences: [{ platform_id: 'other' }] });
    assert.strictEqual(again.outcome, 'already_terminal');
    assert.strictEqual((await registry.getTask(ref.taskId, scope)).result.audiences[0].platform_id, 'p');
  });

  it('leaves other tools results alone', async () => {
    const registry = createInMemoryTaskRegistry();
    const ref = await create(registry, 'create_media_buy');
    const result = { audiences: [{ platform_id: 'a', seller_id: 'b' }], event_sources: [{ platform_id: 'p' }] };
    assert.strictEqual((await registry.complete(ref.taskId, scope, result)).outcome, 'applied');
    assert.strictEqual((await registry.getTask(ref.taskId, scope)).result, result);
  });
});

describe('version adapter and stored task results', () => {
  it('downgradeResponse 3.3 -> 3.2 carries platform_id as seller_id', () => {
    const { data } = downgradeResponse(
      'sync_audiences',
      { audiences: [{ audience_id: 'a', action: 'created', platform_id: 'p' }] },
      { fromVersion: ADCP_VERSION, toVersion: '3.2' }
    );
    assert.strictEqual(data.audiences[0].seller_id, 'p');
    assert.strictEqual('platform_id' in data.audiences[0], false);
    const { data: ev } = downgradeResponse(
      'sync_event_sources',
      { event_sources: [{ event_source_id: 'e', action: 'created', platform_id: 'p', seller_id: 'p' }] },
      { fromVersion: ADCP_VERSION, toVersion: '3.2' }
    );
    assert.deepStrictEqual(ev.event_sources[0], { event_source_id: 'e', action: 'created', seller_id: 'p' });
  });

  it('projectResponseForRelease keeps both names at the pin', () => {
    const out = projectResponseForRelease(
      'sync_audiences',
      { audiences: [{ audience_id: 'a', action: 'created', platform_id: 'p', seller_id: 'p' }] },
      ADCP_VERSION,
      ADCP_VERSION
    );
    assert.strictEqual(out.audiences[0].platform_id, 'p');
    assert.strictEqual(out.audiences[0].seller_id, 'p');
  });

  async function storedTaskServer(storedResult, { stripPlatformId = false } = {}) {
    const registry = createInMemoryTaskRegistry();
    const ref = await registry.create({ tool: 'sync_audiences', accountId: 'acc_1' });
    await registry.complete(ref.taskId, ref, storedResult);
    if (stripPlatformId) {
      // Simulate a row written by an older release: one name only.
      const realGet = registry.getTask.bind(registry);
      registry.getTask = async (id, s) => {
        const record = await realGet(id, s);
        if (!record) return record;
        return {
          ...record,
          result: { audiences: record.result.audiences.map(({ platform_id: _p, ...rest }) => rest) },
        };
      };
    }
    const server = platformServer({
      audiences: () => [],
      eventSources: () => [],
      supportedVersions: ['3.2', ADCP_VERSION],
      taskRegistry: registry,
    });
    return { server, taskId: ref.taskId };
  }

  const statusArgs = taskId => ({ task_id: taskId, include_result: true, account: { account_id: 'acc_1' } });
  const resultOf = r => r.structuredContent.result ?? r.structuredContent.task?.result;

  for (const tool of ['tasks_get', 'get_task_status']) {
    it(`${tool}: a 3.3 reader gets both names`, async () => {
      const { server, taskId } = await storedTaskServer({
        audiences: [{ audience_id: 'a', action: 'created', platform_id: 'p' }],
      });
      const r = await call(server, tool, statusArgs(taskId));
      assertOk(r);
      const row = resultOf(r).audiences[0];
      assert.strictEqual(row.platform_id, 'p');
      assert.strictEqual(row.seller_id, 'p');
    });

    it(`${tool}: a legacy stored row with seller_id only reads back with both names`, async () => {
      const { server, taskId } = await storedTaskServer(
        { audiences: [{ audience_id: 'a', action: 'created', platform_id: 'p' }] },
        { stripPlatformId: true }
      );
      const r = await call(server, tool, statusArgs(taskId));
      assertOk(r);
      const row = resultOf(r).audiences[0];
      assert.strictEqual(row.platform_id, 'p');
      assert.strictEqual(row.seller_id, 'p');
    });
  }
});
