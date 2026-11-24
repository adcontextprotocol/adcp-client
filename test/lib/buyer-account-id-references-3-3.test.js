// AdCP 3.3 (adcp#8474): sellers MUST accept { account_id } on every account-scoped
// task once the account is resolved, and buyers MUST NOT require the deprecated
// `account.stable_account_id` flag before sending it. Mirrors adcp-client-python#1954.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentClient,
  SingleAgentClient,
  AccountSetupRequiredError,
  parseCapabilitiesResponse,
} = require('../../dist/lib/index.js');

const account = { brand: { domain: 'brand.example' }, operator: 'agency.example' };
const agent = { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
const rows = () => [{ ...account, account_id: 'seller-id', status: 'active', action: 'created' }];
const result = () => ({ success: true, status: 'completed', metadata: {}, data: { accounts: rows() } });

// `stable` undefined omits the flag; false sends an explicit stable_account_id: false.
function client(config = {}, { versions = ['3.3-rc.3'], stable } = {}) {
  const c = new SingleAgentClient(agent, config);
  c.getCapabilities = async () =>
    parseCapabilitiesResponse({
      adcp: { major_versions: [3], supported_versions: versions },
      account: { supported_billing: ['operator'], ...(stable !== undefined && { stable_account_id: stable }) },
    });
  c.syncAccounts = async () => result();
  return c;
}

const ID_REF = { account_id: 'seller-id' };
const TASKS = ['get_products', 'list_products', 'sync_creatives', 'create_media_buy', 'get_media_buys'];

for (const policy of ['off', 'auto', 'strict']) {
  test(`3.3 seller without stable_account_id gets { account_id } after provisioning (${policy})`, async () => {
    const c = client({ accountPolicy: policy });
    await c.accounts.provision(account);
    for (const task of TASKS) {
      const params = { account, brief: 'Inventory' };
      assert.deepEqual((await c.applyAccountPolicy(task, params)).account, ID_REF, task);
    }
    assert.deepEqual(await c.resolveAccount(account), ID_REF);
    assert.deepEqual(await c.resolveAccount({ ...account, includeDetails: true }), {
      reference: ID_REF,
      account_id: 'seller-id',
      naturalKey: account,
    });
  });

  test(`3.3 seller without stable_account_id: wire calls carry { account_id } over MCP (${policy})`, async t => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { z } = require('zod');
    const seller = new McpServer({ name: 'Seller', version: '1.0.0' });
    const sent = [];
    const tool = (name, handler) =>
      seller.registerTool(name, { inputSchema: z.object({}).passthrough() }, async params => {
        sent.push({ name, params });
        const data = handler(params);
        return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      });
    tool('get_adcp_capabilities', () => ({
      adcp: {
        major_versions: [3],
        supported_versions: ['3.3-rc.3'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      supported_protocols: ['media_buy'],
      account: { require_operator_auth: false, supported_billing: ['operator'] },
      media_buy: { buying_modes: ['brief'] },
    }));
    tool('sync_accounts', params => ({
      accounts: params.accounts.map(ref => ({ ...ref, account_id: 'seller-id', status: 'active', action: 'created' })),
    }));
    tool('get_products', () => ({ products: [] }));
    tool('sync_creatives', () => ({ creatives: [] }));
    tool('create_media_buy', () => ({ media_buy_id: 'buy-id', packages: [] }));
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    await seller.connect(sellerTransport);
    const mcp = new Client({ name: 'Buyer', version: '1.0.0' });
    await mcp.connect(buyerTransport);
    t.after(async () => {
      await mcp.close();
      await seller.close();
    });
    const buyer = AgentClient.fromMCPClient(mcp, {
      accountPolicy: policy,
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
    });
    await buyer.accounts.provision(account);
    assert.equal((await buyer.getProducts({ account, brief: 'Inventory' })).success, true);
    assert.equal((await buyer.syncCreativesLegacy({ account, creatives: [] })).success, true);
    assert.equal(
      (
        await buyer.createMediaBuyLegacy({
          account,
          packages: [],
          start_time: 'asap',
          end_time: '2027-01-01T00:00:00Z',
        })
      ).success,
      true
    );
    for (const name of ['get_products', 'sync_creatives', 'create_media_buy']) {
      const call = sent.find(call => call.name === name);
      assert.ok(call, `${name} reached the seller`);
      assert.deepEqual(call.params.account, ID_REF, name);
    }
    // sync_accounts itself is provisioning: it carries the natural key.
    const sync = sent.find(call => call.name === 'sync_accounts');
    assert.deepEqual(sync.params.accounts[0].brand, account.brand);
    assert.equal(sync.params.accounts[0].account_id, undefined);
  });
}

test("accountReferenceMode 'natural-key' keeps the natural key at 3.3", async () => {
  const c = client({ accountPolicy: 'auto', accountReferenceMode: 'natural-key' });
  await c.accounts.provision(account);
  for (const task of TASKS) {
    const params = { account };
    assert.equal(await c.applyAccountPolicy(task, params), params, task);
  }
  assert.deepEqual(await c.resolveAccount(account), account);
});

test('a 3.2-only seller without the flag keeps the natural key', async () => {
  for (const policy of ['off', 'auto', 'strict']) {
    const c = client({ accountPolicy: policy }, { versions: ['3.2.3'] });
    await c.accounts.provision(account);
    for (const task of TASKS) {
      const params = { account };
      assert.equal(await c.applyAccountPolicy(task, params), params, `${policy} ${task}`);
    }
    assert.deepEqual(await c.resolveAccount(account), account);
  }
});

test('sync_accounts entries and list_accounts filters keep the natural key at 3.3', async () => {
  const c = client({ accountPolicy: 'auto' });
  await c.accounts.provision(account);
  const sync = { accounts: [account] };
  assert.equal(await c.applyAccountPolicy('sync_accounts', sync), sync);
  const filter = { account };
  assert.equal(await c.applyAccountPolicy('list_accounts', filter), filter);
});

test('a known 3.3 account without an account_id keeps its natural key and does not throw', async () => {
  const c = client({ accountPolicy: 'auto' });
  c.syncAccounts = async () => ({
    ...result(),
    data: { accounts: [{ ...account, status: 'active', action: 'created' }] },
  });
  await c.accounts.provision(account);
  const params = { account };
  assert.equal(await c.applyAccountPolicy('get_products', params), params);
  assert.deepEqual(await c.resolveAccount(account), account);
  // A seller that declares the flag and returns no id is still a setup error.
  const declared = client({ accountPolicy: 'auto' }, { stable: true });
  declared.syncAccounts = c.syncAccounts;
  await assert.rejects(declared.resolveAccount(account), AccountSetupRequiredError);
  await assert.rejects(declared.applyAccountPolicy('get_products', { account }), AccountSetupRequiredError);
});

test('an explicit stable_account_id: false at 3.3 still gets { account_id }', async () => {
  const c = client({ accountPolicy: 'auto' }, { stable: false });
  await c.accounts.provision(account);
  assert.deepEqual((await c.applyAccountPolicy('get_products', { account })).account, ID_REF);
  assert.deepEqual(await c.resolveAccount(account), ID_REF);
});

test('the caller params object is not mutated when the account is swapped for an id', async () => {
  const c = client({ accountPolicy: 'auto' });
  await c.accounts.provision(account);
  const params = { account: { ...account }, brief: 'Inventory' };
  const snapshot = structuredClone(params);
  const routed = await c.applyAccountPolicy('get_products', params);
  assert.notEqual(routed, params);
  assert.deepEqual(routed.account, ID_REF);
  assert.deepEqual(params, snapshot);
});

// --- Swap-path regressions found in cold review (PR #3800) ---

const { computeGovernedPayloadHash } = require('../../dist/lib/index.js');
const { validateRequest } = require('../../dist/lib/validation/schema-validator.js');

const WIRE_VERSION = '3.3.0-rc.3';

test('a request carrying governance_context keeps its authored natural-key account', async () => {
  const c = client({ accountPolicy: 'auto' });
  await c.accounts.provision(account);
  const params = {
    account,
    brand: account.brand,
    packages: [],
    start_time: 'asap',
    end_time: '2027-01-01T00:00:00Z',
    governance_context: 'opaque-governance-token',
  };
  const authoredHash = computeGovernedPayloadHash(params);
  const routed = await c.applyAccountPolicy('create_media_buy', params);
  assert.deepEqual(routed.account, account);
  // The authorization's payload hash still covers exactly what goes on the wire.
  assert.equal(computeGovernedPayloadHash(routed), authoredHash);
  // Without governance_context the same request is swapped.
  const { governance_context: _, ...ungoverned } = params;
  assert.deepEqual((await c.applyAccountPolicy('create_media_buy', ungoverned)).account, ID_REF);
});

const BRAND_CASES = [
  ['request_proposals', { brief: 'Inventory', idempotency_key: 'rp-account-id-0001' }],
  [
    'buy_products',
    {
      idempotency_key: 'bp-account-id-0001',
      feed_version: 'v1',
      purchases: [{ product_id: 'p1', pricing_option_id: 'po1', budget: 1000 }],
      start_time: 'asap',
      end_time: '2027-01-01T00:00:00Z',
    },
  ],
  ['list_products', { criteria: { catalog: { type: 'product', catalog_id: 'c' } } }],
];

for (const [task, extra] of BRAND_CASES) {
  test(`${task} keeps the natural key's brand at top level after the account swap`, async () => {
    const c = client({ accountPolicy: 'auto' });
    await c.accounts.provision(account);
    const params = { account, ...extra };
    const routed = await c.applyAccountPolicy(task, params);
    assert.deepEqual(routed.account, ID_REF);
    assert.deepEqual(routed.brand, account.brand);
    const outcome = validateRequest(task, routed, WIRE_VERSION);
    assert.equal(outcome.valid, true, JSON.stringify(outcome));
    // An explicit caller brand is never overridden.
    const explicit = { domain: 'explicit.example' };
    const kept = await c.applyAccountPolicy(task, { ...params, brand: explicit });
    assert.deepEqual(kept.account, ID_REF);
    assert.deepEqual(kept.brand, explicit);
  });
}

test('learned format routes survive the account swap: no SDK-minted format_option_ref reaches the seller', async t => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = require('zod');
  const { packageRefsForFormatOptions } = require('../../dist/lib/index.js');

  async function run(config) {
    const sent = [];
    const seller = new McpServer({ name: 'Seller', version: '1.0.0' });
    const tool = (name, handler) =>
      seller.registerTool(name, { inputSchema: z.object({}).passthrough() }, async params => {
        sent.push({ name, params });
        const data = handler(params);
        return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
      });
    tool('get_adcp_capabilities', () => ({
      adcp: {
        major_versions: [3],
        supported_versions: ['3.3-rc.3'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      supported_protocols: ['media_buy'],
      account: { require_operator_auth: false, supported_billing: ['operator'] },
      media_buy: { buying_modes: ['brief'], features: { canonical_creatives: true } },
    }));
    tool('sync_accounts', params => ({
      accounts: params.accounts.map(ref => ({ ...ref, account_id: 'seller-id', status: 'active', action: 'created' })),
    }));
    tool('get_products', () => ({
      products: [
        {
          product_id: 'p1',
          name: 'MREC',
          description: 'banner',
          format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org/', id: 'display_300x250_image' }],
          pricing_options: [{ pricing_option_id: 'po1', pricing_model: 'cpm', currency: 'USD', fixed_price: 5 }],
        },
      ],
    }));
    tool('create_media_buy', () => ({ media_buy_id: 'buy-id', packages: [] }));
    const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
    await seller.connect(sellerTransport);
    const mcp = new Client({ name: 'Buyer', version: '1.0.0' });
    await mcp.connect(buyerTransport);
    t.after(async () => {
      await mcp.close();
      await seller.close();
    });
    const buyer = AgentClient.fromMCPClient(mcp, {
      accountPolicy: 'auto',
      validateFeatures: false,
      validation: { requests: 'off', responses: 'off' },
      ...config,
    });
    await buyer.accounts.provision(account);
    const discovered = await buyer.getProducts({ account, brief: 'Inventory' });
    assert.equal(discovered.success, true);
    const product = discovered.data.products[0];
    const selected = packageRefsForFormatOptions(product, [product.format_options[0].format_option_id]);
    const created = await buyer.createMediaBuy({
      account,
      brand: account.brand,
      idempotency_key: 'route-account-id-0001',
      start_time: 'asap',
      end_time: '2027-01-01T00:00:00Z',
      packages: [{ ...selected, product_id: 'p1', budget: 1000, pricing_option_id: 'po1' }],
    });
    assert.equal(created.success, true, JSON.stringify(created));
    return sent.find(call => call.name === 'create_media_buy').params;
  }

  const byId = await run({});
  const byKey = await run({ accountReferenceMode: 'natural-key' });
  assert.deepEqual(byId.account, ID_REF);
  assert.deepEqual(byKey.account, account);
  // Same package selection with and without the swap, and nothing SDK-minted.
  assert.deepEqual(byId.packages[0], byKey.packages[0]);
  assert.doesNotMatch(JSON.stringify(byId.packages), /migrated_/);
  for (const params of [byId, byKey]) {
    assert.equal(params.packages[0].format_kind, 'image');
    assert.deepEqual(params.packages[0].params, { width: 300, height: 250 });
    assert.equal(params.packages[0].format_option_ref, undefined);
  }
});
