const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AgentClient,
  SingleAgentClient,
  BuyerAccountRegistry,
  AccountNotProvisionedError,
  AccountPendingApprovalError,
  AccountSetupRequiredError,
  AccountPaymentRequiredError,
  parseCapabilitiesResponse,
  isMutatingTask,
} = require('../../dist/lib/index.js');

const account = { brand: { domain: 'brand.example' }, operator: 'agency.example' };
const agent = { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' };
const rows = (status = 'active') => [{ ...account, account_id: 'seller-id', status, action: 'created' }];
const result = (status = 'active') => ({
  success: true,
  status: 'completed',
  metadata: {},
  data: { accounts: rows(status) },
});

function client(config = {}, stable = true) {
  const c = new SingleAgentClient(agent, config);
  c.getCapabilities = async () =>
    parseCapabilitiesResponse({
      adcp: { major_versions: [3], supported_versions: ['3.2.3'] },
      account: { supported_billing: ['operator'], ...(typeof stable === 'boolean' && { stable_account_id: stable }) },
    });
  c.syncAccounts = async () => result();
  return c;
}

test('stable_account_id is opt-in evidence; malformed declarations never enable it', () => {
  for (const value of [undefined, false, true, 'true', 1, null]) {
    const caps = parseCapabilitiesResponse({ account: { stable_account_id: value } });
    assert.equal(caps.account.stableAccountId, typeof value === 'boolean' ? value : undefined);
  }
});

for (const policy of ['off', 'auto', 'strict']) {
  test(`stable-ID sellers receive the same ID for discovery, creatives, and buys (${policy})`, async t => {
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
        supported_versions: ['3.2.3'],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
      },
      supported_protocols: ['media_buy'],
      account: { require_operator_auth: false, stable_account_id: true, supported_billing: ['operator'] },
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
    const provisioned = await buyer.accounts.ensure(account);
    assert.equal(provisioned.account_id, 'seller-id');
    assert.deepEqual(provisioned.account, account);
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
      assert.deepEqual(call.params.account, { account_id: 'seller-id' });
    }
    assert.equal(isMutatingTask('sync_creatives'), true);
    assert.ok(sent.find(call => call.name === 'sync_creatives').params.idempotency_key);
    assert.equal(sent.filter(call => call.name === 'sync_accounts').length, 1);
  });
}

test('legacy sellers retain natural keys; the override keeps natural keys on stable-ID sellers', async () => {
  for (const [config, stable] of [
    [{ accountPolicy: 'auto' }, false],
    [{ accountPolicy: 'auto' }, null],
    [{ accountPolicy: 'auto', accountReferenceMode: 'natural-key' }, true],
  ]) {
    const c = client(config, stable);
    await c.accounts.ensure(account);
    for (const task of ['get_products', 'list_products', 'sync_creatives', 'create_media_buy', 'get_media_buys']) {
      const params = { account };
      assert.equal(await c.applyAccountPolicy(task, params), params);
    }
    assert.deepEqual(await c.resolveAccount(account), account);
    assert.deepEqual(await c.resolveAccount({ ...account, includeDetails: true }), {
      reference: account,
      account_id: 'seller-id',
      naturalKey: account,
    });
  }
});

test('resolveAccount selects the ID without policy opt-in and details retain the natural key', async () => {
  for (const config of [{}, { accountPolicy: 'auto' }]) {
    const c = client(config);
    assert.deepEqual(await c.resolveAccount(account), { account_id: 'seller-id' });
    assert.equal((await c.accounts.getByAccountId('seller-id')).account_id, 'seller-id');
    assert.deepEqual(await c.resolveAccount({ ...account, includeDetails: true }), {
      reference: { account_id: 'seller-id' },
      account_id: 'seller-id',
      naturalKey: account,
    });
  }
});

test('auth-required sellers keep ID references and expose the selected ID in details', async () => {
  const c = client({ accountReferenceMode: 'natural-key' });
  const caps = await c.getCapabilities();
  c.getCapabilities = async () => ({ ...caps, account: { ...caps.account, requireOperatorAuth: true } });
  c.listAccounts = async () => result();
  assert.deepEqual(await c.resolveAccount({ includeDetails: true }), {
    reference: { account_id: 'seller-id' },
    account_id: 'seller-id',
  });
});

test('reference selection reloads bindings and status after awaiting capabilities', async () => {
  for (const change of ['replacement', 'suspended', 'principal']) {
    const c = client({ accountPolicy: 'strict' });
    await c.accounts.ensure(account);
    const caps = await c.getCapabilities();
    c.getCapabilities = async () => {
      if (change === 'principal') c.config.accountRegistryScope = 'another-caller';
      else
        await c.accounts.observeSync(
          [account],
          [
            {
              ...rows()[0],
              account_id: change === 'replacement' ? 'new-id' : 'seller-id',
              status: change === 'suspended' ? 'suspended' : 'active',
            },
          ]
        );
      return caps;
    };
    if (change === 'replacement') {
      assert.deepEqual((await c.applyAccountPolicy('sync_creatives', { account })).account, { account_id: 'new-id' });
    } else {
      await assert.rejects(
        c.applyAccountPolicy('sync_creatives', { account }),
        change === 'principal' ? AccountNotProvisionedError : AccountSetupRequiredError
      );
    }
  }
});

test('explicit ID references and provisioning references are preserved', async () => {
  const c = client({ accountPolicy: 'strict' });
  await c.accounts.ensure(account);
  for (const task of ['get_products', 'sync_creatives', 'create_media_buy']) {
    const params = { account: { account_id: 'seller-id' } };
    assert.equal(await c.applyAccountPolicy(task, params), params);
  }
  const params = { account };
  assert.equal(await c.applyAccountPolicy('sync_accounts', params), params);
});

test('default resolution honours a newer status repair instead of an older active sync result', async () => {
  for (const status of ['suspended', 'pending_approval']) {
    const c = client();
    await c.resolveAccount(account);
    c.listAccounts = async () => result(status);
    c.syncAccounts = async () => {
      await c.accounts.applyStatusChange({ account_id: 'seller-id' });
      return result();
    };
    await assert.rejects(
      c.resolveAccount(account),
      status === 'pending_approval' ? AccountPendingApprovalError : /did not establish an active account/
    );
    assert.equal((await c.accounts.get(account)).status, status);
  }
});

test('the default routing cache evicts old bindings and still syncs every resolution', async () => {
  const c = client();
  let calls = 0;
  c.syncAccounts = async params => {
    calls++;
    const ref = params.accounts[0];
    return {
      ...result(),
      data: { accounts: [{ ...ref, account_id: ref.brand.domain, status: 'active', action: 'created' }] },
    };
  };
  await c.resolveAccount(account);
  c._accounts.maxEntries = 4;
  for (let i = 0; i < 8; i++) {
    const key = { ...account, brand: { domain: `brand${i}.example` } };
    assert.deepEqual(await c.resolveAccount(key), { account_id: key.brand.domain });
    assert.ok(c._accounts.entries.size <= 4);
  }
  assert.deepEqual(await c.resolveAccount(account), { account_id: account.brand.domain });
  assert.equal(calls, 10);
  assert.equal(c.accountRegistryExplicitlyAccessed, false);
});

test('automatic aliases are bounded, while explicitly used registries retain capacity checks', async () => {
  const c = client();
  c.syncAccounts = async params => ({
    ...result(),
    data: { accounts: [{ ...params.accounts[0], account_id: 'seller-id', status: 'active', action: 'created' }] },
  });
  await c.resolveAccount(account);
  c._accounts.maxEntries = 4;
  for (let i = 0; i < 8; i++) {
    const key = { ...account, brand: { domain: `brand${i}.example` } };
    assert.deepEqual(await c.resolveAccount(key), { account_id: 'seller-id' });
    assert.ok((await c.accounts.getByAccountId('seller-id')).aliases.length <= 4);
  }
  await assert.rejects(c.accounts.ensure({ ...account, brand: { domain: 'new.example' } }), /capacity reached/);
});

test('stable-ID resolution rejects ambiguous rows instead of reusing a cached active binding', async () => {
  const c = client();
  await c.resolveAccount(account);
  c.syncAccounts = async () => ({ ...result(), data: { accounts: [...rows('suspended'), ...rows()] } });
  await assert.rejects(c.resolveAccount(account), /ambiguous rows/);
});

test('automatic cache eviction after observation does not turn a successful sync into an error', async () => {
  const c = client();
  await c.resolveAccount(account);
  const observe = c._accounts.observeSync.bind(c._accounts);
  c._accounts.observeSync = async (...args) => {
    await observe(...args);
    c._accounts.entries.clear();
  };
  assert.deepEqual(await c.resolveAccount(account), { account_id: 'seller-id' });
});

test('a natural binding is only published after its ID alias is available', async () => {
  const records = new Map();
  let release;
  let published;
  const ready = new Promise(resolve => {
    published = resolve;
  });
  const held = new Promise(resolve => {
    release = resolve;
  });
  const c = client({
    accountPolicy: 'strict',
    accountStorage: {
      get: async key => records.get(key),
      set: async (key, value) => {
        records.set(key, structuredClone(value));
        if (key.includes('["natural"') && value.account_id && !value.setupTerms) {
          published();
          await held;
        }
      },
    },
  });
  const setup = c.accounts.ensure(account);
  await ready;
  try {
    const selected = await c.applyAccountPolicy('get_products', { account });
    assert.deepEqual(selected.account, { account_id: 'seller-id' });
    assert.deepEqual(await c.applyAccountPolicy('get_products', selected), selected);
  } finally {
    release();
    await setup;
  }
});

test('wrapper exposes detailed results and retains nested task sessions', async () => {
  const buyer = new AgentClient(agent);
  buyer.client.getCapabilities = client().getCapabilities;
  buyer.client.syncAccounts = async () => ({ ...result(), metadata: { contextId: 'account-session' } });
  assert.deepEqual(await buyer.resolveAccount({ ...account, includeDetails: true }), {
    reference: { account_id: 'seller-id' },
    account_id: 'seller-id',
    naturalKey: account,
  });
  assert.equal(buyer.currentContextId, 'account-session');
});

test('registry ID lookup survives restart and keeps sellers and callers isolated', async () => {
  const records = new Map();
  const storage = {
    get: async key => records.get(key),
    set: async (key, row) => records.set(key, structuredClone(row)),
  };
  for (const adapter of [undefined, storage]) {
    const registry = new BuyerAccountRegistry(
      () => 'seller:caller',
      async () => result(),
      adapter
    );
    await registry.ensure(account);
    const indexed = await registry.getByAccountId('seller-id');
    assert.equal(indexed.account_id, 'seller-id');
    assert.deepEqual(indexed.aliases, [account]);
    indexed.aliases[0].operator = 'changed';
    assert.deepEqual((await registry.getByAccountId('seller-id')).aliases, [account]);
    if (adapter) {
      const restarted = new BuyerAccountRegistry(
        () => 'seller:caller',
        async () => {
          throw Error('unexpected provision');
        },
        adapter,
        async () => [{ account_id: 'seller-id', status: 'suspended' }]
      );
      assert.equal((await restarted.getByAccountId('seller-id')).status, 'active');
      await restarted.applyStatusChange({ account_id: 'seller-id' });
      assert.equal((await restarted.get(account)).status, 'suspended');
      for (const scope of ['other-seller:caller', 'seller:other-caller']) {
        const other = new BuyerAccountRegistry(
          () => scope,
          async () => result(),
          adapter
        );
        assert.equal(await other.getByAccountId('seller-id'), undefined);
      }
    }
  }
});

test('storage ID lookup receives the exact scope and rejects mismatched aliases', async () => {
  let scope = 'seller:caller';
  let returned = { account: { account_id: 'seller-id' }, account_id: 'seller-id', status: 'active' };
  const storage = {
    get: async () => undefined,
    set: async () => {},
    getByAccountId: async (id, partition) => {
      assert.equal(id, 'seller-id');
      assert.equal(partition, 'seller:caller');
      return returned;
    },
  };
  const registry = new BuyerAccountRegistry(
    () => scope,
    async () => result(),
    storage
  );
  assert.equal((await registry.getByAccountId('seller-id')).status, 'active');
  returned = { ...returned, account: { account_id: 'other-id' } };
  const other = new BuyerAccountRegistry(
    () => scope,
    async () => result(),
    storage
  );
  assert.equal(await other.getByAccountId('seller-id'), undefined);
  storage.getByAccountId = async () => {
    scope = 'seller:other-caller';
    return returned;
  };
  assert.equal(await other.getByAccountId('seller-id'), undefined);
});

test('strict discovery requires an account on stable-ID sellers, including when no reference is sent', async () => {
  const c = client({ accountPolicy: 'strict' });
  c.executeAndHandle = async () => {
    throw Error('must not dispatch');
  };
  for (const params of [
    { brief: 'Inventory' },
    { brand: account.brand, brief: 'Inventory' },
    { account, brief: 'Inventory' },
  ]) {
    await assert.rejects(c.getProducts(params), AccountNotProvisionedError);
  }
  await c.accounts.ensure(account);
  await assert.rejects(c.getProducts({ brief: 'Inventory' }), AccountNotProvisionedError);
  const legacy = client({ accountPolicy: 'strict' }, false);
  assert.deepEqual(await legacy.applyAccountPolicy('get_products', { brand: account.brand }), { brand: account.brand });
});

test('creative sync requires active provisioning and bypass options preserve governed payloads', async () => {
  const c = client({ accountPolicy: 'strict' });
  await assert.rejects(c.syncCreativesLegacy({ account, creatives: [] }), AccountNotProvisionedError);
  for (const [status, error] of [
    ['pending_approval', AccountPendingApprovalError],
    ['payment_required', AccountPaymentRequiredError],
    ['suspended', AccountSetupRequiredError],
  ]) {
    await c.accounts.observeSync([account], rows(status));
    await assert.rejects(c.syncCreativesLegacy({ account, creatives: [] }), error);
  }
  await c.accounts.observeSync([account], rows());
  const params = { account, creatives: [] };
  for (const options of [{ preserveGovernedPayload: true }, { skipAccountValidation: true }]) {
    assert.equal(await c.applyAccountPolicy('sync_creatives', params, options), params);
  }
  const filter = { account };
  assert.equal(await c.applyAccountPolicy('list_accounts', filter), filter);
});

test('stable-ID declarations without an ID fail instead of sending a natural key', async () => {
  const c = client({ accountPolicy: 'auto' });
  c.syncAccounts = async () => ({
    ...result(),
    data: { accounts: [{ ...account, status: 'active', action: 'created' }] },
  });
  await assert.rejects(c.resolveAccount(account), AccountSetupRequiredError);
  await assert.rejects(c.applyAccountPolicy('get_products', { account }), AccountSetupRequiredError);
});

test('only an AdCP 4+ wire contract requires IDs without the declaration', async () => {
  const c = client({ accountPolicy: 'auto' }, false);
  const caps = await c.getCapabilities();
  c.getCapabilities = async () => ({ ...caps, supportedVersions: ['3.2.3', '4.0.0'], servedVersion: '4.0.0' });
  await c.accounts.ensure(account);
  assert.deepEqual((await c.applyAccountPolicy('get_products', { account })).account, account);
  c.config.wireAdcpVersion = '4.0.0';
  assert.deepEqual((await c.applyAccountPolicy('get_products', { account })).account, { account_id: 'seller-id' });
  c.getCapabilities = async () => ({ ...caps, _synthetic: true, account: { ...caps.account, stableAccountId: true } });
  assert.deepEqual((await c.applyAccountPolicy('get_products', { account })).account, account);
});
