// createAdcpServerFromPlatform projects media_buy.buying_modes from the handlers the platform
// registers, or from a seller-declared capabilities.buyingModes checked against those handlers
// (adcp-client#3629). The wholesale feed capability blocks ride capabilities.overrides.

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { AgentClient, UnsupportedBuyingModeError, supportsBuyingMode } = require('../dist/lib/index.js');

const accounts = {
  resolve: async ref => ({
    id: ref?.account_id ?? 'modes_acc_1',
    operator: 'modes.example.com',
    ctx_metadata: {},
    authInfo: { kind: 'api_key' },
  }),
};

const capabilityBase = {
  specialisms: ['sales-non-guaranteed'],
  creative_agents: [],
  channels: ['display'],
  pricingModels: ['cpm'],
  config: {},
};

const salesHandlers = (getProducts = async () => ({ products: [] })) => ({
  getProducts,
  createMediaBuy: async () => ({
    media_buy_id: 'mb_1',
    status: 'pending_creatives',
    confirmed_at: '2026-04-28T00:00:00Z',
    packages: [],
  }),
  updateMediaBuy: async () => ({ media_buy_id: 'mb_1', status: 'active' }),
  syncCreatives: async () => [],
  getMediaBuyDelivery: async () => ({
    currency: 'USD',
    reporting_period: { start: '2026-04-01', end: '2026-04-30' },
    media_buy_deliveries: [],
  }),
});

const lifecycleHandlers = (extra = {}) => ({
  listProducts: async () => ({ outcome: 'listed', products: [], feed_version: 'feed-1', cache_scope: 'public' }),
  buyProducts: async () => ({ media_buy_id: 'mb_1' }),
  controlMediaBuy: async () => ({ media_buy_id: 'mb_1', revision: 2 }),
  getMediaBuys: async () => ({ media_buys: [] }),
  getMediaBuyDelivery: async () => ({
    currency: 'USD',
    reporting_period: { start: '2026-04-01', end: '2026-04-30' },
    media_buy_deliveries: [],
  }),
  ...extra,
});

/** A direct-buy seller: sales.getProducts answers every buying mode it is asked. */
function salesPlatform(capabilities = {}, parts = {}) {
  return {
    capabilities: { ...capabilityBase, ...capabilities },
    statusMappers: {},
    accounts,
    sales: salesHandlers(),
    ...parts,
  };
}

/** A compact-lifecycle seller with no sales.getProducts, so no brief path unless `lifecycle` adds one. */
function cataloguePlatform(capabilities = {}, lifecycle = {}) {
  return {
    capabilities: { ...capabilityBase, ...capabilities },
    statusMappers: {},
    accounts,
    mediaBuyLifecycle: lifecycleHandlers(lifecycle),
  };
}

/** A walled-garden seller that registers no product-discovery handler at all. */
function ingestionOnlyPlatform(capabilities = {}) {
  return {
    capabilities: { ...capabilityBase, specialisms: ['sales-social'], ...capabilities },
    statusMappers: {},
    accounts,
    sales: { syncCreatives: async () => [] },
  };
}

const serverOptions = { name: 'buying-modes', version: '0.0.1', validation: { requests: 'off', responses: 'strict' } };

async function capabilitiesOf(platform, options = {}) {
  const server = createAdcpServerFromPlatform(platform, { ...serverOptions, ...options });
  const result = await server.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: {} },
  });
  assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

const modesOf = async (platform, options) => (await capabilitiesOf(platform, options)).media_buy?.buying_modes;

describe('media_buy.buying_modes derived from the registered handlers', () => {
  it('a seller that declares nothing and registers no catalogue handler gets what it got before', async () => {
    assert.deepStrictEqual(await modesOf(salesPlatform()), ['brief']);
    assert.deepStrictEqual(await modesOf(salesPlatform({ supportsProposals: true })), ['brief', 'refine']);
    assert.deepStrictEqual(await modesOf(ingestionOnlyPlatform()), ['brief']);
    // A proposal path without a catalogue handler: still brief + refine.
    const proposals = cataloguePlatform(
      {},
      { requestProposals: async () => ({ outcome: 'rejected', reason: 'fixture' }), listProducts: undefined }
    );
    assert.deepStrictEqual(await modesOf({ ...proposals, sales: salesHandlers() }), ['brief', 'refine']);
  });

  it('registering mediaBuyLifecycle.listProducts adds wholesale', async () => {
    const both = salesPlatform({}, { mediaBuyLifecycle: lifecycleHandlers() });
    assert.deepStrictEqual(await modesOf(both), ['brief', 'wholesale']);
    const withProposals = salesPlatform({ supportsProposals: true }, { mediaBuyLifecycle: lifecycleHandlers() });
    assert.deepStrictEqual(await modesOf(withProposals), ['brief', 'refine', 'wholesale']);
  });

  it('a platform with only a catalogue handler advertises wholesale alone', async () => {
    assert.deepStrictEqual(await modesOf(cataloguePlatform()), ['wholesale']);
  });

  it('a catalogue handler beside a proposal path keeps brief and refine', async () => {
    const platform = cataloguePlatform(
      {},
      { requestProposals: async () => ({ outcome: 'rejected', reason: 'fixture' }) }
    );
    assert.deepStrictEqual(await modesOf(platform), ['brief', 'refine', 'wholesale']);
  });
});

describe('capabilities.buyingModes', () => {
  it('is honoured as declared, without duplicates', async () => {
    assert.deepStrictEqual(await modesOf(salesPlatform({ buyingModes: ['wholesale'] })), ['wholesale']);
    assert.deepStrictEqual(await modesOf(salesPlatform({ buyingModes: ['brief', 'wholesale'] })), [
      'brief',
      'wholesale',
    ]);
    assert.deepStrictEqual(await modesOf(salesPlatform({ buyingModes: ['wholesale', 'refine', 'wholesale'] })), [
      'wholesale',
      'refine',
    ]);
  });

  it('can narrow what the handlers imply', async () => {
    const platform = cataloguePlatform(
      { buyingModes: ['wholesale'] },
      { requestProposals: async () => ({ outcome: 'rejected', reason: 'fixture' }) }
    );
    assert.deepStrictEqual(await modesOf(platform), ['wholesale']);
  });

  it('wins over overrides.media_buy.buying_modes, which the framework value still overwrites', async () => {
    const declared = salesPlatform({
      buyingModes: ['wholesale'],
      overrides: { media_buy: { buying_modes: ['brief'] } },
    });
    assert.deepStrictEqual(await modesOf(declared), ['wholesale']);
    const overrideOnly = salesPlatform({ overrides: { media_buy: { buying_modes: ['wholesale'] } } });
    assert.deepStrictEqual(await modesOf(overrideOnly), ['brief']);
  });

  it('accepts a handler registered through legacyHandlers.mediaBuy', async () => {
    const platform = ingestionOnlyPlatform({ buyingModes: ['wholesale'] });
    const modes = await modesOf(platform, {
      legacyHandlers: { mediaBuy: { getProducts: async () => ({ products: [] }) } },
    });
    assert.deepStrictEqual(modes, ['wholesale']);
  });

  it('refuses at construction a mode that has no handler, naming the mode', () => {
    const refused = (platform, pattern, options) => {
      assert.throws(
        () => createAdcpServerFromPlatform(platform, { ...serverOptions, ...options }),
        error => {
          assert.strictEqual(error.name, 'PlatformConfigError');
          assert.strictEqual(error.code, 'PLATFORM_CONFIG_INVALID');
          assert.strictEqual(error.configField, 'capabilities.buyingModes');
          assert.match(error.message, pattern);
          return true;
        }
      );
    };
    // No discovery handler at all.
    refused(ingestionOnlyPlatform({ buyingModes: ['wholesale'] }), /'wholesale' needs sales\.getProducts/);
    refused(ingestionOnlyPlatform({ buyingModes: ['brief'] }), /'brief' needs sales\.getProducts or a proposal path/);
    refused(ingestionOnlyPlatform({ buyingModes: ['refine'] }), /'refine' needs sales\.getProducts or a proposal path/);
    // A catalogue handler serves wholesale, not briefs.
    refused(
      cataloguePlatform({ buyingModes: ['brief', 'wholesale'] }),
      /'brief' needs sales\.getProducts or a proposal path/
    );
  });

  it('refuses an empty list and a value that is not a buying mode', () => {
    assert.throws(
      () => createAdcpServerFromPlatform(salesPlatform({ buyingModes: [] }), serverOptions),
      /capabilities\.buyingModes must list at least one of 'brief', 'wholesale', 'refine'/
    );
    assert.throws(
      () => createAdcpServerFromPlatform(salesPlatform({ buyingModes: ['wholesale', 'retail'] }), serverOptions),
      /contains "retail", which is not a buying mode/
    );
  });
});

describe('wholesale feed capability blocks', () => {
  it('capabilities.overrides can declare wholesale_feed_versioning and wholesale_feed_webhooks', async () => {
    const capabilities = await capabilitiesOf(
      cataloguePlatform({
        overrides: {
          wholesale_feed_versioning: { supported: true, cache_scope_account: true },
          wholesale_feed_webhooks: {
            supported: true,
            event_types: ['product.created', 'product.priced', 'wholesale_feed.bulk_change'],
          },
        },
      })
    );
    assert.deepStrictEqual(capabilities.wholesale_feed_versioning, { supported: true, cache_scope_account: true });
    assert.deepStrictEqual(capabilities.wholesale_feed_webhooks, {
      supported: true,
      event_types: ['product.created', 'product.priced', 'wholesale_feed.bulk_change'],
    });
    assert.deepStrictEqual(capabilities.media_buy.buying_modes, ['wholesale']);
  });

  it('a seller that declares neither advertises neither', async () => {
    const capabilities = await capabilitiesOf(cataloguePlatform());
    assert.strictEqual(capabilities.wholesale_feed_versioning, undefined);
    assert.strictEqual(capabilities.wholesale_feed_webhooks, undefined);
  });
});

describe('the SDK buyer client and a seller that declares wholesale', () => {
  async function connect(platform, t) {
    const server = createAdcpServerFromPlatform(platform, {
      ...serverOptions,
      validation: { requests: 'off', responses: 'off' },
    });
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'Buying modes buyer', version: '1.0.0' });
    await server.connect(sellerTransport);
    await mcp.connect(buyerTransport);
    t.after(async () => {
      await mcp.close();
      await server.close();
    });
    return AgentClient.fromMCPClient(mcp, { validation: { requests: 'off', responses: 'off' } });
  }

  it('sends a wholesale get_products request instead of refusing it', async t => {
    const requests = [];
    const platform = salesPlatform({ buyingModes: ['wholesale'] });
    platform.sales = salesHandlers(async req => {
      requests.push(req);
      return { products: [], cache_scope: 'public' };
    });
    const buyer = await connect(platform, t);
    const result = await buyer.getProducts({ buying_mode: 'wholesale' });
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].buying_mode, 'wholesale');
  });

  it('still refuses wholesale from a seller whose handlers and declaration do not include it', async t => {
    const requests = [];
    const platform = salesPlatform({ buyingModes: ['brief'] });
    platform.sales = salesHandlers(async req => {
      requests.push(req);
      return { products: [] };
    });
    const buyer = await connect(platform, t);
    await assert.rejects(buyer.getProducts({ buying_mode: 'wholesale' }), error => {
      assert.ok(error instanceof UnsupportedBuyingModeError);
      assert.deepStrictEqual(error.declaredModes, ['brief']);
      return true;
    });
    assert.strictEqual(requests.length, 0);
  });

  it('reads a derived wholesale declaration from a catalogue-only seller and lists its products', async t => {
    const requests = [];
    const buyer = await connect(
      cataloguePlatform(
        {},
        {
          listProducts: async req => {
            requests.push(req);
            return { outcome: 'listed', products: [], feed_version: 'feed-1', cache_scope: 'public' };
          },
        }
      ),
      t
    );
    const capabilities = await buyer.getCapabilities();
    assert.deepStrictEqual(capabilities.buyingModes, ['wholesale']);
    assert.strictEqual(supportsBuyingMode(capabilities, 'wholesale'), true);
    const result = await buyer.listProducts({});
    assert.strictEqual(result.success, true, result.error);
    assert.strictEqual(requests.length, 1);
  });
});
