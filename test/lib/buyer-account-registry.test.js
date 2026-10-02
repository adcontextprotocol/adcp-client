const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  BuyerAccountRegistry,
  SingleAgentClient,
  AgentClient,
  createProductCache,
  adcpErrorToTypedError,
  AccountNotProvisionedError,
} = require('../../dist/lib/index.js');

const account = { brand: { domain: 'brand.example' }, operator: 'agency.example' };
function provisionResult(status = 'active') {
  return {
    success: true,
    status: 'completed',
    metadata: {},
    data: {
      accounts: [{ ...account, account_id: 'seller-id', status, action: 'created' }],
    },
  };
}
test('ensure coalesces concurrent provisioning and returns the seller handle and status (#3093)', async () => {
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      calls++;
      return provisionResult();
    }
  );
  const results = await Promise.all([registry.ensure(account), registry.ensure(account), registry.ensure(account)]);
  assert.equal(calls, 1);
  assert.equal(results[0].account_id, 'seller-id');
  results[0].account.brand.domain = 'mutated.example';
  assert.equal((await registry.get(account)).account.brand.domain, 'brand.example');
  await registry.ensure(account);
  assert.equal(calls, 1);
});
test('registry storage isolates sellers and callers and survives a new client (#3093)', async () => {
  const records = new Map();
  const storage = { get: async key => records.get(key), set: async (key, value) => records.set(key, value) };
  const first = new BuyerAccountRegistry(
    () => 'seller:caller-a',
    async () => provisionResult(),
    storage
  );
  await first.ensure(account);
  const restarted = new BuyerAccountRegistry(
    () => 'seller:caller-a',
    async () => {
      throw Error('already provisioned');
    },
    storage
  );
  assert.equal((await restarted.ensure(account)).status, 'active');
  for (const scope of ['other-seller:caller-a', 'seller:caller-b']) {
    assert.equal(
      await new BuyerAccountRegistry(
        () => scope,
        async () => provisionResult(),
        storage
      ).get(account),
      undefined
    );
  }
});
test('dry runs and failed rows never mark an account provisioned (#3093)', async () => {
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult()
  );
  await registry.observeSync([account], provisionResult().data.accounts, true);
  assert.equal(await registry.get(account), undefined);
  await registry.observeSync([account], [{ ...account, status: 'active', action: 'failed' }]);
  assert.equal(await registry.get(account), undefined);
});
test('account status notifications repair from list_accounts instead of trusting notification order (#3093)', async () => {
  let registry;
  registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult(),
    undefined,
    async id => {
      assert.equal(id, 'seller-id');
      return [{ ...account, account_id: id, status: 'suspended' }];
    }
  );
  await registry.ensure(account);
  await registry.applyStatusChange({ account_id: 'seller-id', status: 'active' });
  assert.equal((await registry.get(account)).status, 'suspended');
});
for (const code of ['ACCOUNT_NOT_FOUND', 'ACCOUNT_SETUP_REQUIRED', 'ACCOUNT_PAYMENT_REQUIRED']) {
  test(`${code} is a typed buyer setup failure (#3093)`, () => {
    const error = adcpErrorToTypedError({ code, message: 'setup failure' });
    assert.equal(error.code, code);
    assert.equal(error.fault, 'buyer_setup');
  });
}
function client(policy = 'off') {
  const c = new SingleAgentClient(
    { id: 'seller', name: 'Seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
    { accountPolicy: policy }
  );
  c.getCapabilities = async () => ({ account: { requiredForProducts: false, supportedBilling: ['operator'] } });
  return c;
}
test('off preserves existing requests; auto uses public discovery; strict refuses unknown keys (#3093)', async () => {
  const input = { account, brief: 'sports' };
  assert.equal(await client().applyAccountPolicy('get_products', input), input);
  assert.deepEqual(await client('auto').applyAccountPolicy('get_products', input), {
    brand: account.brand,
    brief: 'sports',
  });
  assert.ok(input.account, 'input remains unchanged');
  await assert.rejects(client('strict').applyAccountPolicy('get_products', input), AccountNotProvisionedError);
  await assert.rejects(client('auto').applyAccountPolicy('create_media_buy', input), AccountNotProvisionedError);
  await assert.rejects(
    client('auto').applyAccountPolicy('get_products', { ...input, push_notification_config: {} }),
    AccountNotProvisionedError
  );
});
test('auto keeps provisioned discovery scope and refuses required-account public fallback (#3093)', async () => {
  const c = client('auto');
  await c.accounts.observeSync([account], provisionResult().data.accounts);
  const input = { account, brief: 'sports' };
  assert.equal(await c.applyAccountPolicy('get_products', input), input);
  const fresh = client('auto');
  fresh.getCapabilities = async () => ({ account: { requiredForProducts: true } });
  await assert.rejects(fresh.applyAccountPolicy('get_products', input), AccountNotProvisionedError);
});
test('ensure sends billing terms and entity once; wrapper exposes the same registry (#3093)', async () => {
  const c = client();
  const calls = [];
  c.syncAccounts = async request => {
    calls.push(request);
    return provisionResult();
  };
  const billingEntity = { legal_name: 'Buyer Ltd' };
  await c.accounts.ensure(account, { billing: 'operator', paymentTerms: 'net_30', billingEntity });
  await c.accounts.ensure(account);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accounts[0].payment_terms, 'net_30');
  assert.deepEqual(calls[0].accounts[0].billing_entity, billingEntity);
  const wrapper = new AgentClient({
    id: 'seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
  });
  assert.ok(wrapper.accounts instanceof BuyerAccountRegistry);
});

function products(data) {
  return { success: true, status: 'completed', metadata: {}, data };
}
test('product cache fails closed on absent cache_scope and isolates seller/account overlays (#3093)', () => {
  const cache = createProductCache();
  const request = { buying_mode: 'wholesale' };
  cache.write('seller-a', request, products({ products: [{ product_id: 'p' }] }));
  assert.equal(cache.read('seller-a', request), undefined);
  cache.write(
    'seller-a',
    { ...request, account },
    products({
      products: [{ product_id: 'account-p' }],
      cache_scope: 'account',
      wholesale_feed_version: 'v1',
      pricing_version: 'p1',
    })
  );
  assert.equal(cache.read('seller-a', request), undefined);
  assert.equal(cache.read('seller-b', { ...request, account }), undefined);
  assert.equal(cache.read('seller-a', { ...request, account: { ...account, currency: 'USD' } }), undefined);
  assert.deepEqual(cache.conditionalParams('seller-a', { ...request, account }), {
    ...request,
    account,
    if_wholesale_feed_version: 'v1',
    if_pricing_version: 'p1',
  });
});
test('conditional unchanged responses reuse only an exactly scoped cached snapshot (#3093)', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const cache = createProductCache({ publicTtl: 10 });
  const request = { buying_mode: 'wholesale' };
  cache.write(
    'seller',
    request,
    products({
      products: [{ product_id: 'p' }],
      cache_scope: 'public',
      wholesale_feed_version: 'v1',
      pricing_version: 'p1',
    })
  );
  t.mock.timers.tick(11);
  assert.equal(cache.read('seller', request), undefined);
  const result = cache.write(
    'seller',
    request,
    products({ unchanged: true, cache_scope: 'public', wholesale_feed_version: 'v1', pricing_version: 'p1' })
  );
  assert.equal(result.data.products[0].product_id, 'p');
  const changedPrice = cache.write(
    'seller',
    request,
    products({ unchanged: true, cache_scope: 'public', wholesale_feed_version: 'v1', pricing_version: 'different' })
  );
  assert.equal(changedPrice.data.products, undefined);
});

test('buyer registry and cache operate through the official MCP client (#3093)', async t => {
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  let syncCalls = 0;
  const catalogCalls = [];
  const server = createAdcpServer({
    name: 'seller',
    version: '1.0.0',
    validation: { requests: 'off', responses: 'off' },
    capabilities: { account: { supportedBilling: ['operator'] }, media_buy: { buyingModes: ['wholesale', 'brief'] } },
    resolveAccount: async ref => ({ id: 'seller-id', name: 'Account', status: 'active', ...ref }),
    accounts: {
      syncAccounts: async params => {
        syncCalls++;
        return {
          accounts: params.accounts.map(ref => ({
            brand: ref.brand,
            operator: ref.operator,
            account_id: 'seller-id',
            status: 'active',
            action: 'created',
          })),
        };
      },
      listAccounts: async () => ({
        accounts: [{ ...account, account_id: 'seller-id', name: 'Account', status: 'suspended' }],
      }),
    },
    mediaBuy: {
      getProducts: async params => {
        catalogCalls.push(params);
        return params.if_wholesale_feed_version
          ? {
              unchanged: true,
              cache_scope: params.account ? 'account' : 'public',
              wholesale_feed_version: 'v1',
              pricing_version: 'p1',
            }
          : {
              products: [],
              cache_scope: params.account ? 'account' : 'public',
              wholesale_feed_version: 'v1',
              pricing_version: 'p1',
            };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'buyer', version: '1.0.0' });
  await mcp.connect(clientTransport);
  t.after(async () => {
    await mcp.close();
    await server.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    accountPolicy: 'auto',
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
    productCache: createProductCache({ publicTtl: 0, accountTtl: 0 }),
  });
  const publicResult = await buyer.getProducts({ buying_mode: 'wholesale', account });
  assert.equal(publicResult.success, true);
  assert.equal(catalogCalls[0].account, undefined);
  await buyer.accounts.ensure(account, { billing: 'operator', paymentTerms: 'net_30' });
  await buyer.accounts.ensure(account);
  assert.equal(syncCalls, 1);
  await buyer.getProducts({ buying_mode: 'wholesale', account });
  await buyer.getProducts({ buying_mode: 'wholesale', account });
  assert.ok(catalogCalls[1].account);
  assert.equal(catalogCalls[2].if_wholesale_feed_version, 'v1');
  assert.equal(catalogCalls[2].if_pricing_version, 'p1');
  await buyer.accounts.applyStatusChange({ account_id: 'seller-id' });
  assert.equal((await buyer.accounts.get(account)).status, 'suspended');
});

test('registry matches countries, rejects ambiguous rows, and accepts seller defaults (#3093)', async () => {
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult()
  );
  const us = { ...account, brand: { ...account.brand, countries: ['US'] } };
  const ca = { ...account, brand: { ...account.brand, countries: ['CA'] } };
  await registry.observeSync(
    [us, ca],
    [
      { ...us, account_id: 'us', status: 'active' },
      { ...ca, account_id: 'ca', status: 'suspended' },
    ]
  );
  assert.equal((await registry.get(us)).account_id, 'us');
  assert.equal((await registry.get(ca)).status, 'suspended');
  await registry.observeSync(
    [account],
    [
      { ...us, account_id: 'us', status: 'active' },
      { ...ca, account_id: 'ca', status: 'suspended' },
    ]
  );
  assert.equal(await registry.get(account), undefined);
  await registry.observeSync(
    [account],
    [{ ...account, account_id: 'defaults', currency: 'USD', timezone: 'UTC', status: 'active' }]
  );
  assert.equal((await registry.get(account)).account_id, 'defaults');
});
test('authoritative repair updates original aliases after restart and invalidates missing handles (#3093)', async () => {
  const records = new Map();
  const storage = { get: async k => records.get(k), set: async (k, v) => records.set(k, v) };
  const first = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult(),
    storage
  );
  await first.ensure(account);
  let rows = [{ account_id: 'seller-id', status: 'suspended', currency: 'USD' }];
  const restarted = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      throw Error('must not re-provision');
    },
    storage,
    async () => rows
  );
  await restarted.applyStatusChange({ account_id: 'seller-id' });
  assert.equal((await restarted.get(account)).status, 'suspended');
  rows = [];
  await restarted.applyStatusChange({ account_id: 'seller-id' });
  assert.equal((await restarted.get(account)).status, 'unknown');
});
test('plain resolveAccount calls share provisioning and preserve payment errors (#3093)', async () => {
  const c = client();
  let calls = 0;
  c.syncAccounts = async () => {
    calls++;
    return provisionResult();
  };
  await Promise.all([c.resolveAccount({ ...account }), c.resolveAccount({ ...account })]);
  assert.equal(calls, 1);
  const held = client();
  held.syncAccounts = async () => ({
    success: false,
    status: 'failed',
    error: 'payment',
    adcpError: { code: 'ACCOUNT_PAYMENT_REQUIRED', message: 'payment' },
    metadata: {},
  });
  await assert.rejects(
    held.resolveAccount(account),
    error => error.code === 'ACCOUNT_PAYMENT_REQUIRED' && error.fault === 'buyer_setup'
  );
});
test('provisioning capacity is bounded before sending another setup request (#3093)', async () => {
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      calls++;
      return provisionResult();
    },
    undefined,
    undefined,
    { maxEntries: 2 }
  );
  await registry.ensure(account);
  await assert.rejects(registry.ensure({ ...account, operator: 'other.example' }), /capacity/);
  assert.equal(calls, 1);
});
test('a caller pricing validator bypasses automatic cache conditions and cache entries are bounded (#3093)', () => {
  const cache = createProductCache({ maxEntries: 1 });
  const request = { buying_mode: 'wholesale' };
  cache.write(
    'seller',
    request,
    products({ products: [], cache_scope: 'public', wholesale_feed_version: 'v1', pricing_version: 'p1' })
  );
  const explicit = { ...request, if_pricing_version: 'caller' };
  assert.equal(cache.conditionalParams('seller', explicit), explicit);
  cache.write('seller', { ...request, brief: 'another' }, products({ products: [], cache_scope: 'public' }));
  assert.equal(cache.read('seller', request), undefined);
});

test('pending ensure repairs approval without accepting billing terms again (#3093)', async () => {
  let syncCalls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      syncCalls++;
      return provisionResult('pending_approval');
    },
    undefined,
    async () => [{ ...account, account_id: 'seller-id', status: 'active', currency: 'USD' }]
  );
  assert.equal((await registry.ensure(account)).status, 'pending_approval');
  assert.equal((await registry.ensure(account)).status, 'active');
  assert.equal(syncCalls, 1);
});
test('client-credentials scope survives token rotation and isolates other principals (#3093)', async () => {
  const records = new Map();
  const storage = { get: async k => records.get(k), set: async (k, v) => records.set(k, v) };
  const make = clientId =>
    new SingleAgentClient(
      {
        id: 'seller',
        name: 'seller',
        agent_uri: 'https://seller.example/mcp',
        protocol: 'mcp',
        oauth_client_credentials: {
          client_id: clientId,
          client_secret: 'test-only-secret',
          token_endpoint: 'https://auth.example/token',
        },
      },
      { accountStorage: storage }
    );
  const first = make('caller-a');
  await first.accounts.observeSync([account], provisionResult().data.accounts);
  first.normalizedAgent.oauth_tokens = { access_token: 'rotated-test-token' };
  assert.equal((await first.accounts.get(account)).status, 'active');
  assert.equal(await make('caller-b').accounts.get(account), undefined);
});
test('conditional cache snapshots survive eviction and asynchronous completion (#3093)', async () => {
  const cache = createProductCache({ publicTtl: 0 });
  const c = new SingleAgentClient(
    { id: 'seller', name: 'seller', agent_uri: 'https://seller.example/mcp', protocol: 'mcp' },
    { validateFeatures: false, productCache: cache }
  );
  let calls = 0;
  c.executeAndHandle = async (_task, _handler, params) => {
    calls++;
    if (calls === 1)
      return products({ products: [], cache_scope: 'public', wholesale_feed_version: 'v1', pricing_version: 'p1' });
    assert.equal(params.if_wholesale_feed_version, 'v1');
    cache.clear();
    return {
      success: true,
      status: 'submitted',
      metadata: {},
      submitted: {
        waitForCompletion: async () =>
          products({
            unchanged: true,
            cache_scope: 'public',
            wholesale_feed_version: 'v1',
            pricing_version: 'p1',
          }),
      },
    };
  };
  await c.getProducts({ buying_mode: 'wholesale' });
  const pending = await c.getProducts({ buying_mode: 'wholesale' });
  const completed = await pending.submitted.waitForCompletion();
  assert.deepEqual(completed.data.products, []);
  assert.equal(completed.data.unchanged, undefined);
});
test('registry observation failures never mask a completed seller operation (#3093)', async () => {
  const c = client();
  const result = products({ accounts: provisionResult().data.accounts });
  c.accounts.observeSync = async () => {
    throw Error('private backend details');
  };
  const context = {
    kind: 'single-agent',
    taskType: 'sync_accounts',
    canonical: false,
    productPolicyRequest: {},
    accountRegistry: { scope: c.accountScope(), refs: [account] },
  };
  const finalized = await c.finalizeTaskResult(result, context);
  assert.equal(finalized.success, true);
  assert.deepEqual(finalized.data, result.data);
  assert.equal(JSON.stringify(finalized).includes('private backend details'), false);
});

test('overlapping status repairs discard an older active snapshot (#3093)', async () => {
  const replies = [];
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult(),
    undefined,
    () => new Promise(resolve => replies.push(resolve))
  );
  await registry.ensure(account);
  const first = registry.applyStatusChange({ account_id: 'seller-id' });
  while (replies.length < 1) await new Promise(resolve => setImmediate(resolve));
  const second = registry.applyStatusChange({ account_id: 'seller-id' });
  while (replies.length < 2) await new Promise(resolve => setImmediate(resolve));
  replies[1]([{ ...account, account_id: 'seller-id', status: 'suspended' }]);
  await second;
  replies[0]([{ ...account, account_id: 'seller-id', status: 'active' }]);
  await first;
  assert.equal((await registry.get(account)).status, 'suspended');
});

test('cancelling one provisioning wait preserves single-flight and rejects conflicting terms (#3093)', async () => {
  let complete;
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async (_ref, _billing, opts) => {
      calls++;
      assert.equal(opts.signal, undefined);
      return new Promise(resolve => {
        complete = resolve;
      });
    }
  );
  const controller = new AbortController();
  const first = registry.ensure(account, { billing: 'operator' }, { signal: controller.signal });
  const aborted = assert.rejects(first, /aborted/);
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  const second = registry.ensure(account, { billing: 'operator' }, { signal: new AbortController().signal });
  await assert.rejects(registry.ensure(account, { billing: 'agent' }, { timeout: 100 }), /different billing/);
  controller.abort();
  await aborted;
  complete(provisionResult());
  assert.equal((await second).status, 'active');
  assert.equal(calls, 1);
});

test('terminal submitted setup failure permits a deliberate retry (#3093)', async () => {
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      if (++calls > 1) return provisionResult();
      return {
        success: true,
        status: 'submitted',
        metadata: { taskId: 'setup-task' },
        submitted: {
          waitForCompletion: async () => ({
            success: false,
            status: 'failed',
            metadata: {},
            error: 'Setup failed',
            adcpError: { code: 'ACCOUNT_SETUP_REQUIRED', message: 'Setup failed' },
          }),
        },
      };
    }
  );
  await assert.rejects(registry.ensure(account), { code: 'ACCOUNT_SETUP_REQUIRED' });
  assert.equal((await registry.ensure(account)).status, 'active');
  assert.equal(calls, 2);
});

test('authorization-code refresh retains this client grant without sharing another user (#3093)', async () => {
  const config = {
    id: 'oauth-seller',
    name: 'Seller',
    agent_uri: 'https://seller.example/mcp',
    protocol: 'mcp',
    oauth_client: { client_id: 'shared-app' },
    oauth_tokens: { access_token: 'user-a-token', refresh_token: 'user-a-refresh' },
  };
  const first = new SingleAgentClient(config);
  const second = new SingleAgentClient({
    ...config,
    oauth_tokens: { access_token: 'user-b-token', refresh_token: 'user-b-refresh' },
  });
  await first.accounts.observeSync([account], provisionResult().data.accounts);
  first.normalizedAgent.oauth_tokens = { access_token: 'user-a-new-token', refresh_token: 'user-a-new-refresh' };
  assert.equal((await first.accounts.get(account)).status, 'active');
  assert.equal(await second.accounts.get(account), undefined);
});

test('an unconditional cache recovery replaces the stale pricing snapshot (#3093)', async () => {
  const c = client();
  c.config.productCache = createProductCache({ publicTtl: 0 });
  c.config.validateFeatures = false;
  let calls = 0;
  c.executeAndHandle = async (_task, _handler, params) => {
    calls++;
    if (calls === 2)
      return {
        success: true,
        status: 'completed',
        metadata: {},
        data: { unchanged: true, cache_scope: 'public', wholesale_feed_version: 'v1', pricing_version: 'p2' },
      };
    assert.equal(params.if_wholesale_feed_version, calls === 4 ? 'v1' : undefined);
    if (calls === 4) assert.equal(params.if_pricing_version, 'p2');
    return {
      success: true,
      status: 'completed',
      metadata: {},
      data: {
        products: [],
        cache_scope: 'public',
        wholesale_feed_version: 'v1',
        ...(calls > 1 && { pricing_version: 'p2' }),
      },
    };
  };
  await c.getProducts({ brief: 'inventory' });
  await c.getProducts({ brief: 'inventory' });
  await c.getProducts({ brief: 'inventory' });
  assert.equal(calls, 4);
});

test('pending approval survives unavailable list_accounts without accepting terms again (#3093)', async () => {
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      calls++;
      return provisionResult('pending_approval');
    },
    undefined,
    async () => {
      throw Error('list unavailable');
    }
  );
  await registry.ensure(account);
  assert.equal((await registry.ensure(account)).status, 'pending_approval');
  assert.equal((await registry.get(account)).status, 'pending_approval');
  assert.equal(calls, 1);
});

test('a stale storage miss cannot trigger provisioning twice (#3093)', async () => {
  let releaseRead;
  let calls = 0;
  let reads = 0;
  const records = new Map();
  const storage = {
    get: async key => {
      if (++reads === 2)
        return new Promise(resolve => {
          releaseRead = () => resolve(undefined);
        });
      return records.get(key);
    },
    set: async (key, value) => records.set(key, value),
  };
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      calls++;
      return provisionResult();
    },
    storage
  );
  const first = registry.ensure(account);
  const second = registry.ensure(account);
  while (!releaseRead) await new Promise(resolve => setImmediate(resolve));
  await first;
  releaseRead();
  await second;
  assert.equal(calls, 1);
});

test('completed async setup with a failed account row is retryable (#3093)', async () => {
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      if (++calls > 1) return provisionResult();
      return {
        success: true,
        status: 'submitted',
        metadata: { taskId: 'row-failure' },
        submitted: {
          waitForCompletion: async () => {
            const result = provisionResult();
            result.data.accounts[0].action = 'failed';
            result.data.accounts[0].errors = [{ code: 'ACCOUNT_SETUP_REQUIRED', message: 'Credit setup failed' }];
            return result;
          },
        },
      };
    }
  );
  await assert.rejects(registry.ensure(account), { code: 'ACCOUNT_SETUP_REQUIRED' });
  assert.equal((await registry.ensure(account)).status, 'active');
  assert.equal(calls, 2);
});

test('a throwing result callback cannot lose successful provisioning (#3093)', async () => {
  let calls = 0;
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => {
      calls++;
      return provisionResult();
    }
  );
  await assert.rejects(
    registry.ensure(account, {}, undefined, () => {
      throw Error('callback failure');
    }),
    /callback failure/
  );
  assert.equal((await registry.ensure(account)).status, 'active');
  assert.equal(calls, 1);
});

test('internal unresolved registry states follow unknown-account discovery policy (#3093)', async () => {
  for (const status of ['unknown', 'provisioning', 'failed_provisioning']) {
    const c = client('auto');
    c.accounts.get = async () => ({ account, status });
    assert.deepEqual(await c.applyAccountPolicy('get_products', { account, brief: 'inventory' }), {
      brand: account.brand,
      brief: 'inventory',
    });
    await assert.rejects(c.applyAccountPolicy('create_media_buy', { account }), AccountNotProvisionedError);
  }
});

test('malformed account references bypass the product cache for normal validation (#3093)', () => {
  const cache = createProductCache();
  for (const malformed of [{ operator: 'agency.example' }, { account_id: 123 }, null, 'bad']) {
    const params = { account: malformed, brief: 'inventory' };
    assert.equal(cache.read('seller', params), undefined);
    assert.equal(cache.conditionalParams('seller', params), params);
    const result = { success: true, status: 'completed', metadata: {}, data: { products: [], cache_scope: 'account' } };
    assert.equal(cache.write('seller', params, result), result);
  }
});

test('known setup terms cannot silently change and survive authoritative status repair (#3093)', async () => {
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult(),
    undefined,
    async () => [{ ...account, account_id: 'seller-id', status: 'active' }]
  );
  await registry.ensure(account, { billing: 'operator', paymentTerms: 'net_30' });
  await registry.applyStatusChange({ account_id: 'seller-id' });
  await assert.rejects(
    registry.ensure(account, { billing: 'agent', paymentTerms: 'net_60' }),
    /different billing terms/
  );
  assert.equal((await registry.ensure(account, { billing: 'operator' })).status, 'active');
});

test('default-off clients do not accumulate unsolicited list observations (#3093)', () => {
  const c = client();
  assert.equal(c.accountRegistryContext('list_accounts', {}), undefined);
  void c.accounts;
  assert.ok(c.accountRegistryContext('list_accounts', {}));
});

test('ensure and resolveAccount share the seller default billing choice (#3093)', async () => {
  const c = client('auto');
  let calls = 0;
  c.syncAccounts = async () => {
    calls++;
    return provisionResult();
  };
  await Promise.all([c.accounts.ensure(account), c.resolveAccount(account)]);
  assert.equal(calls, 1);
});

test('seller-confirmed absence exposes a buyer-setup error and an explicit recovery path (#3093)', async () => {
  const registry = new BuyerAccountRegistry(
    () => 'seller',
    async () => provisionResult('pending_approval'),
    undefined,
    async () => []
  );
  await registry.ensure(account);
  await assert.rejects(
    registry.ensure(account),
    error => error.fault === 'buyer_setup' && /syncAccounts/.test(error.message)
  );
});

test('partial list pages do not invalidate a filtered account and repair skips unrelated rows (#3093)', async () => {
  const c = client('auto');
  c.syncAccounts = async () => provisionResult();
  await c.accounts.ensure(account);
  const page = {
    success: true,
    status: 'completed',
    metadata: {},
    data: { accounts: [], pagination: { has_more: true, cursor: 'page-2' } },
  };
  await c.finalizeTaskResult(page, {
    kind: 'single-agent',
    taskType: 'list_accounts',
    canonical: false,
    productPolicyRequest: {},
    accountRegistry: { scope: c.accountScope(), refs: [{ account_id: 'seller-id' }] },
  });
  assert.equal((await c.accounts.get(account)).status, 'active');
  let calls = 0;
  c.listAccounts = async params => {
    calls++;
    if (calls === 1)
      return {
        ...page,
        data: {
          accounts: [{ account_id: 'unrelated-id', status: 'active' }],
          pagination: { has_more: true, cursor: 'page-2' },
        },
      };
    assert.equal(params.pagination.cursor, 'page-2');
    return {
      ...page,
      data: {
        accounts: [{ ...account, account_id: 'seller-id', status: 'suspended' }],
        pagination: { has_more: false },
      },
    };
  };
  await c.accounts.applyStatusChange({ account_id: 'seller-id' });
  assert.equal((await c.accounts.get(account)).status, 'suspended');
  assert.equal(await c.accounts.get({ account_id: 'unrelated-id' }), undefined);
  assert.equal(calls, 2);
});
