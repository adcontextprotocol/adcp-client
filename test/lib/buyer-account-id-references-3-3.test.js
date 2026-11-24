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
