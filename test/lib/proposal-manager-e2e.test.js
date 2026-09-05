/**
 * E2E smoke tests confirming the v1.5 ProposalManager dispatch wiring is
 * actually in the runtime. Goes through `dispatchTestRequest` so the
 * full pipeline (schema validation, idempotency, account resolution,
 * platform handler) runs.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createAdcpServerFromPlatform,
  createInMemoryTaskRegistry,
  InMemoryProposalStore,
  withResponseSummary,
} = require('../../dist/lib/server/index.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');

function buildPlatform({ proposalManager, sales, capabilities = {} }) {
  return {
    capabilities: {
      specialisms: ['sales-guaranteed'],
      adcp_version: '3.0.6',
      channels: ['display'],
      pricingModels: ['cpm'],
      ...capabilities,
    },
    accounts: {
      resolution: 'derived',
      resolve: async () => ({ id: 'acct_1', metadata: {} }),
    },
    sales,
    proposalManager,
  };
}

const authInfo = { token: 'tok', clientId: 'client', scopes: [] };

test('e2e: proposal capability is auto-derived when ProposalManager is wired', async () => {
  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed' },
    getProducts: async () => ({ products: [], proposals: [] }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager, sales: {} }), {
    name: 'e2e',
    version: '1.0',
    proposalStore: new InMemoryProposalStore(),
    validation: { requests: 'off', responses: 'off' },
  });

  const res = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_adcp_capabilities', arguments: {} } },
    { authInfo }
  );
  assert.strictEqual(res.structuredContent.media_buy.supports_proposals, true);
});

test('e2e: explicit proposal capability false is projected for direct-buy sellers', async () => {
  const sales = {
    getProducts: async () => ({ products: [] }),
    createMediaBuy: async () => ({ media_buy_id: 'mb_x', packages: [] }),
  };
  const server = createAdcpServerFromPlatform(
    buildPlatform({ proposalManager: undefined, sales, capabilities: { supportsProposals: false } }),
    {
      name: 'e2e',
      version: '1.0',
      validation: { requests: 'off', responses: 'off' },
    }
  );

  const res = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_adcp_capabilities', arguments: {} } },
    { authInfo }
  );
  assert.strictEqual(res.structuredContent.media_buy.supports_proposals, false);
});

test('e2e: getProducts routes through ProposalManager when wired', async () => {
  const calls = { manager: 0, sales: 0 };
  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed' },
    getProducts: async () => {
      calls.manager += 1;
      return { products: [], proposals: [] };
    },
  };
  const sales = {
    getProducts: async () => {
      calls.sales += 1;
      return { products: [], proposals: [] };
    },
    createMediaBuy: async () => ({
      media_buy_id: 'mb_x',
      buyer_ref: 'br',
      packages: [],
      status: 'pending_creative',
    }),
    updateMediaBuy: async () => ({
      media_buy_id: 'mb_x',
      buyer_ref: 'br',
      packages: [],
      status: 'active',
    }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager, sales }), {
    name: 'e2e',
    version: '1.0',
    proposalStore: new InMemoryProposalStore(),
    validation: { requests: 'off', responses: 'off' }, // skip wire schema validation for synthetic responses
  });
  await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );
  assert.strictEqual(calls.manager, 1, 'manager.getProducts should fire');
  assert.strictEqual(calls.sales, 0, 'sales.getProducts should NOT fire when manager is wired');
});

test('e2e: getProducts validates push config before proposal finalization and normal manager dispatch (#2836)', async () => {
  const invalidPushConfigs = [
    ['malformed config', null, 'push_notification_config'],
    [
      'unsupported URL scheme',
      { url: 'ftp://buyer.example.com/webhook', operation_id: 'op_unsupported_scheme' },
      'push_notification_config.url',
    ],
    [
      'invalid token',
      { url: 'https://buyer.example.com/webhook', token: 'short', operation_id: 'op_short_token' },
      'push_notification_config.token',
    ],
  ];

  for (const [label, push_notification_config, field] of invalidPushConfigs) {
    const store = new InMemoryProposalStore();
    store.putDraft({
      proposalId: 'p1',
      accountId: 'acct_1',
      recipes: new Map(),
      proposalPayload: { proposal_id: 'p1' },
    });
    let finalizeCalls = 0;
    let getProductsCalls = 0;
    const proposalManager = {
      capabilities: { salesSpecialism: 'sales-guaranteed', finalize: true },
      getProducts: async () => {
        getProductsCalls += 1;
        return { products: [], proposals: [] };
      },
      finalizeProposal: async () => {
        finalizeCalls += 1;
        throw new Error('must not finalize');
      },
    };
    const server = createAdcpServerFromPlatform(
      buildPlatform({ proposalManager, sales: {}, capabilities: { adcp_version: '3.2.0-rc.0' } }),
      {
        name: `push-before-finalize-${label}`,
        version: '1.0',
        proposalStore: store,
        validation: { requests: 'off', responses: 'off' },
      }
    );

    const intercepted = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_products',
          arguments: {
            adcp_version: '3.2.0-rc.0',
            buying_mode: 'refine',
            refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1' }],
            push_notification_config,
          },
        },
      },
      { authInfo }
    );
    assert.strictEqual(intercepted.isError, true, label);
    assert.strictEqual(intercepted.structuredContent.adcp_error.code, 'INVALID_REQUEST', label);
    assert.strictEqual(intercepted.structuredContent.adcp_error.field, field, label);
    assert.strictEqual(finalizeCalls, 0, `${label}: finalizeProposal must not run`);

    const normal = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'get_products',
          arguments: { adcp_version: '3.2.0-rc.0', buying_mode: 'brief', push_notification_config },
        },
      },
      { authInfo }
    );
    assert.strictEqual(normal.isError, true, label);
    assert.strictEqual(normal.structuredContent.adcp_error.code, 'INVALID_REQUEST', label);
    assert.strictEqual(normal.structuredContent.adcp_error.field, field, label);
    assert.strictEqual(getProductsCalls, 0, `${label}: proposalManager.getProducts must not run`);
  }
});

test('e2e: getProducts rejects wholesale push before proposal finalization (#2836)', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p1' },
  });
  let finalizeCalls = 0;
  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed', finalize: true },
    getProducts: async () => ({ products: [], proposals: [] }),
    finalizeProposal: async () => {
      finalizeCalls += 1;
      throw new Error('must not finalize');
    },
  };
  const server = createAdcpServerFromPlatform(
    buildPlatform({ proposalManager, sales: {}, capabilities: { adcp_version: '3.2.0-rc.0' } }),
    {
      name: 'wholesale-push-before-finalize',
      version: '1.0',
      proposalStore: store,
      validation: { requests: 'off', responses: 'off' },
      taskWebhookEmitter: {
        emit: async params => ({
          delivery_id: params.delivery_id,
          idempotency_key: 'test-delivery',
          attempts: 1,
          delivered: true,
          errors: [],
        }),
      },
    }
  );

  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          adcp_version: '3.2.0-rc.0',
          buying_mode: 'wholesale',
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1' }],
          push_notification_config: {
            url: 'https://buyer.example.com/webhook',
            operation_id: 'op_wholesale_finalize',
          },
        },
      },
    },
    { authInfo }
  );

  assert.strictEqual(response.isError, true);
  assert.strictEqual(response.structuredContent.adcp_error.code, 'INVALID_REQUEST');
  assert.strictEqual(response.structuredContent.adcp_error.field, 'push_notification_config');
  assert.strictEqual(response.structuredContent.adcp_error.recovery, 'correctable');
  assert.strictEqual(
    response.structuredContent.adcp_error.message,
    'get_products buying_mode=wholesale is synchronous and does not support push_notification_config; use incomplete[] for partial feed results.'
  );
  assert.strictEqual(finalizeCalls, 0, 'finalizeProposal must not run');
});

test('e2e: native getProducts can customize MCP text without changing structured payload', async () => {
  const disclosure = 'Synthetic sample data for demonstration only.';
  const sales = {
    getProducts: async () =>
      withResponseSummary(
        {
          products: [],
          cache_scope: 'public',
          ext: { example_vendor: { storefront: { demo: true } } },
        },
        disclosure
      ),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager: undefined, sales }), {
    name: 'e2e',
    version: '1.0',
    validation: { requests: 'off', responses: 'strict' },
  });

  const response = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );

  assert.strictEqual(response.content[0].text, disclosure);
  assert.deepStrictEqual(response.structuredContent.ext, {
    example_vendor: { storefront: { demo: true } },
  });
  assert.strictEqual(response.structuredContent.status, 'completed');
  assert.strictEqual('summary' in response.structuredContent, false);
  assert.strictEqual('payload' in response.structuredContent, false);
});

test('e2e: native getProducts summary survives sandbox seeded-product merging', async () => {
  const disclosure = JSON.stringify({ disclosure: 'synthetic' });
  const platform = buildPlatform({
    proposalManager: undefined,
    sales: {
      getProducts: async () => withResponseSummary({ products: [], cache_scope: 'public' }, disclosure),
    },
  });
  platform.accounts.resolve = async () => ({ id: 'acct_1', mode: 'sandbox', metadata: {} });
  const server = createAdcpServerFromPlatform(platform, {
    name: 'e2e',
    version: '1.0',
    validation: { requests: 'off', responses: 'off' },
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    testController: {
      getSeededProducts: () => [
        {
          product_id: 'seed_1',
          name: 'Seeded product',
          description: 'Sandbox fixture',
          publisher_properties: [],
          format_options: [{ format_kind: 'image', params: {} }],
          delivery_type: 'guaranteed',
          pricing_options: [],
          reporting_capabilities: {},
        },
      ],
    },
  });

  const request = {
    method: 'tools/call',
    params: {
      name: 'get_products',
      arguments: {
        buying_mode: 'brief',
        idempotency_key: 'summary-replay-key-0001',
        account: { brand: { domain: 'example.com' }, operator: 'example.com', sandbox: true },
        context: { correlation_id: 'buyer-value' },
      },
    },
  };
  const response = await server.dispatchTestRequest(request, { authInfo });

  assert.strictEqual(response.content[0].text, disclosure);
  assert.deepStrictEqual(
    response.structuredContent.products.map(product => product.product_id),
    ['seed_1']
  );
  assert.strictEqual(response.structuredContent.sandbox, true);

  const replayed = await server.dispatchTestRequest(request, { authInfo });
  assert.strictEqual(replayed.structuredContent.replayed, true);
  assert.strictEqual(replayed.content[0].text, disclosure);
});

test('e2e: response summaries reject unsafe text and async wrappers', async () => {
  assert.doesNotThrow(() => withResponseSummary({ products: [] }, 'x'.repeat(4096)));
  assert.throws(() => withResponseSummary({ products: [] }, 'x'.repeat(4097)), /exceeds 4096 UTF-8 bytes/);
  assert.throws(() => withResponseSummary({ products: [] }, 'unsafe\u0000text'), /unsafe control characters/);

  let handoffRan = false;
  const sales = {
    getProducts: async (_request, ctx) =>
      withResponseSummary(
        ctx.handoffToTask(async () => {
          handoffRan = true;
          return { products: [], cache_scope: 'public' };
        }),
        'Must not reach task storage.'
      ),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager: undefined, sales }), {
    name: 'e2e',
    version: '1.0',
    validation: { requests: 'off', responses: 'off' },
  });

  const response = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );

  assert.strictEqual(response.isError, true);
  assert.strictEqual(handoffRan, false);
  assert.notStrictEqual(response.content[0].text, 'Must not reach task storage.');
  assert.strictEqual(response.structuredContent?.task_id, undefined);

  const nestedServer = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () =>
          withResponseSummary(
            withResponseSummary({ products: [], cache_scope: 'public' }, 'Inner summary.'),
            'Outer summary.'
          ),
      },
    }),
    {
      name: 'e2e',
      version: '1.0',
      validation: { requests: 'off', responses: 'off' },
    }
  );
  const nestedResponse = await nestedServer.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );
  assert.strictEqual(nestedResponse.isError, true);
  assert.notStrictEqual(nestedResponse.content[0].text, 'Outer summary.');

  const terminalSummary = '{"disclosure":"terminal"}';
  const terminalServer = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async (_request, ctx) =>
          ctx.handoffToTask(async () => withResponseSummary({ products: [], cache_scope: 'public' }, terminalSummary)),
      },
    }),
    {
      name: 'e2e',
      version: '1.0',
      validation: { requests: 'off', responses: 'off' },
    }
  );
  const submitted = await terminalServer.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );
  const taskId = submitted.structuredContent?.task_id;
  assert.strictEqual(typeof taskId, 'string');
  await new Promise(resolve => setTimeout(resolve, 50));
  const failedTask = await terminalServer.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'tasks_get', arguments: { task_id: taskId } } },
    { authInfo }
  );
  assert.strictEqual(failedTask.structuredContent.status, 'failed');
  assert.strictEqual(JSON.stringify(failedTask).includes(terminalSummary), false);
});

test('e2e: response summaries fail closed outside native getProducts', async () => {
  const platform = buildPlatform({
    proposalManager: undefined,
    sales: { getProducts: async () => ({ products: [], cache_scope: 'public' }) },
  });
  platform.capabilities.adcp_version = '3.2.0-rc.0';
  platform.mediaBuyLifecycle = {
    listProducts: async () =>
      withResponseSummary({ products: [], feed_version: 'feed_1' }, 'Unsupported summary text.'),
  };
  const server = createAdcpServerFromPlatform(platform, {
    name: 'e2e',
    version: '1.0',
    validation: { requests: 'off', responses: 'off' },
    mcpToolProfile: 'all',
  });

  const response = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'list_products', arguments: {} } },
    { authInfo }
  );

  assert.strictEqual(response.isError, true);
  assert.notStrictEqual(response.content[0].text, 'Unsupported summary text.');
  assert.notDeepStrictEqual(response.structuredContent, {
    adcp_version: '3.2-rc.0',
  });

  const proposalStore = new InMemoryProposalStore();
  proposalStore.putDraft({
    proposalId: 'summary_misuse',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'summary_misuse' },
  });
  proposalStore.commit('summary_misuse', {
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: 'summary_misuse' },
  });
  const mutationServer = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [], cache_scope: 'public' }),
        createMediaBuy: async () =>
          withResponseSummary(
            { media_buy_id: 'mb_invalid', buyer_ref: 'br', packages: [], status: 'pending_creative' },
            'Unsupported mutation summary.'
          ),
      },
    }),
    {
      name: 'e2e',
      version: '1.0',
      proposalStore,
      validation: { requests: 'off', responses: 'off' },
    }
  );
  const mutationResponse = await mutationServer.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'summary_misuse', idempotency_key: 'summary-misuse-key-0001' },
      },
    },
    { authInfo }
  );
  assert.strictEqual(mutationResponse.isError, true);
  assert.notStrictEqual(mutationResponse.content[0].text, 'Unsupported mutation summary.');
});

test('e2e: getProducts persists drafts to store after manager returns', async () => {
  const store = new InMemoryProposalStore();
  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed' },
    getProducts: async () => ({
      products: [
        {
          product_id: 'prod_a',
          name: 'Product A',
          description: 'Canonical product fixture',
          format_options: [{ format_kind: 'image', params: {} }],
          implementation_config: { recipe_kind: 'mock', sku: 'a' },
        },
      ],
      proposals: [
        {
          proposal_id: 'p1',
          name: 'draft v1',
          allocations: [{ product_id: 'prod_a', allocation_percentage: 100 }],
        },
      ],
    }),
  };
  const sales = {
    createMediaBuy: async () => ({ media_buy_id: 'mb_x', buyer_ref: 'br', packages: [], status: 'pending_creative' }),
    updateMediaBuy: async () => ({ media_buy_id: 'mb_x', buyer_ref: 'br', packages: [], status: 'active' }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager, sales }), {
    name: 'e2e',
    version: '1.0',
    proposalStore: store,
    validation: { requests: 'off', responses: 'off' },
  });
  await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );
  const record = store.get('p1', { expectedAccountId: 'acct_1' });
  assert.ok(record, 'expected p1 to be persisted as draft');
  assert.strictEqual(record.state, 'draft');
  assert.strictEqual(record.recipes.get('prod_a').sku, 'a');
});

test('e2e: createMediaBuy with proposal_id reserves + hydrates ctx.recipes + finalizes', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map([['prod_a', { recipe_kind: 'mock', sku: 'a', priority: 'high' }]]),
    proposalPayload: { proposal_id: 'p1' },
  });
  store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: { proposal_id: 'p1' } });

  let seenRecipes = null;
  const sales = {
    getProducts: async () => ({ products: [] }),
    createMediaBuy: async (params, ctx) => {
      seenRecipes = ctx.recipes;
      return {
        media_buy_id: 'mb_xyz',
        buyer_ref: 'br',
        packages: [],
        status: 'pending_creative',
      };
    },
    updateMediaBuy: async () => ({ media_buy_id: 'mb_xyz', buyer_ref: 'br', packages: [], status: 'active' }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager: undefined, sales }), {
    name: 'e2e',
    version: '1.0',
    proposalStore: store,
    validation: { requests: 'off', responses: 'off' },
  });
  await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p1', idempotency_key: 'idem-key-test-0001-0000' },
      },
    },
    { authInfo }
  );
  assert.ok(seenRecipes, 'expected ctx.recipes to be populated');
  assert.strictEqual(seenRecipes.get('prod_a').priority, 'high');
  // Post-success: state is CONSUMED with media_buy_id back-ref
  const record = store.get('p1', { expectedAccountId: 'acct_1' });
  assert.strictEqual(record.state, 'consumed');
  assert.strictEqual(record.mediaBuyId, 'mb_xyz');
});

test('e2e: proposal-backed createMediaBuy handoff finalizes after task success', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p-handoff-success',
    accountId: 'acct_1',
    recipes: new Map([['prod_a', { recipe_kind: 'mock', sku: 'async-a' }]]),
    proposalPayload: { proposal_id: 'p-handoff-success' },
  });
  store.commit('p-handoff-success', {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: 'p-handoff-success' },
  });
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async (_params, ctx) =>
          ctx.handoffToTask(async () => ({
            media_buy_id: 'mb-handoff-success',
            buyer_ref: 'br',
            packages: [],
            status: 'pending_creative',
          })),
      },
    }),
    { name: 'e2e', version: '1.0', proposalStore: store, validation: { requests: 'off', responses: 'off' } }
  );
  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p-handoff-success', idempotency_key: 'idem-handoff-success-0001' },
      },
    },
    { authInfo }
  );
  await server.awaitTaskUnsafe(response.structuredContent.task_id);
  const record = store.get('p-handoff-success', { expectedAccountId: 'acct_1' });
  assert.strictEqual(record.state, 'consumed');
  assert.strictEqual(record.mediaBuyId, 'mb-handoff-success');
});

test('e2e: invalid push configuration is rejected before proposal reservation', async () => {
  const store = new InMemoryProposalStore();
  let calls = 0;
  store.putDraft({
    proposalId: 'p-invalid-push',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p-invalid-push' },
  });
  store.commit('p-invalid-push', {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: 'p-invalid-push' },
  });
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async () => {
          calls += 1;
          return { media_buy_id: 'must-not-run', packages: [] };
        },
      },
    }),
    { name: 'e2e', version: '1.0', proposalStore: store, validation: { requests: 'off', responses: 'off' } }
  );
  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          proposal_id: 'p-invalid-push',
          idempotency_key: 'idem-invalid-push-0001',
          push_notification_config: { url: 'https://127.0.0.1/hook', operation_id: 'invalid-push' },
        },
      },
    },
    { authInfo }
  );
  assert.strictEqual(response.isError, true);
  assert.strictEqual(calls, 0);
  assert.strictEqual(store.get('p-invalid-push', { expectedAccountId: 'acct_1' }).state, 'committed');
});

test('e2e: proposal-backed push handoff refusal releases its reservation and permits a polling retry (#2836)', async () => {
  const store = new InMemoryProposalStore();
  const proposalId = 'p-handoff-no-webhook-owner';
  store.putDraft({
    proposalId,
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: proposalId },
  });
  store.commit(proposalId, {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: proposalId },
  });
  let callbackRuns = 0;
  let createCalls = 0;
  const taskRegistry = createInMemoryTaskRegistry();
  const create = taskRegistry.create.bind(taskRegistry);
  taskRegistry.create = async args => {
    createCalls += 1;
    return create(args);
  };
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async (_params, ctx) =>
          ctx.handoffToTask(async () => {
            callbackRuns += 1;
            return { media_buy_id: 'mb-after-webhook-refusal', packages: [] };
          }),
      },
    }),
    {
      name: 'e2e',
      version: '1.0',
      proposalStore: store,
      taskRegistry,
      validation: { requests: 'off', responses: 'off' },
    }
  );

  const refused = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          proposal_id: proposalId,
          idempotency_key: 'idem-handoff-no-webhook-owner-0001',
          push_notification_config: { url: 'https://buyer.example.com/webhook', operation_id: 'no-webhook-owner' },
        },
      },
    },
    { authInfo }
  );
  assert.strictEqual(refused.isError, true);
  assert.strictEqual(refused.structuredContent.adcp_error.code, 'UNSUPPORTED_FEATURE');
  assert.strictEqual(refused.structuredContent.adcp_error.field, 'push_notification_config');
  assert.strictEqual(createCalls, 0, 'refusal must not allocate a task');
  assert.strictEqual(callbackRuns, 0, 'refusal must not run the handoff callback');
  assert.strictEqual(store.get(proposalId, { expectedAccountId: 'acct_1' }).state, 'committed');

  const retried = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: proposalId, idempotency_key: 'idem-handoff-no-webhook-owner-0002' },
      },
    },
    { authInfo }
  );
  assert.notStrictEqual(retried.isError, true);
  await server.awaitTaskUnsafe(retried.structuredContent.task_id);
  assert.strictEqual(callbackRuns, 1);
  assert.strictEqual(store.get(proposalId, { expectedAccountId: 'acct_1' }).state, 'consumed');
});

test('e2e: proposal-backed createMediaBuy handoff releases after task failure', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p-handoff-failure',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p-handoff-failure' },
  });
  store.commit('p-handoff-failure', {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: 'p-handoff-failure' },
  });
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async (_params, ctx) =>
          ctx.handoffToTask(async () => {
            throw new Error('async seller failure');
          }),
      },
    }),
    { name: 'e2e', version: '1.0', proposalStore: store, validation: { requests: 'off', responses: 'off' } }
  );
  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p-handoff-failure', idempotency_key: 'idem-handoff-failure-0001' },
      },
    },
    { authInfo }
  );
  await server.awaitTaskUnsafe(response.structuredContent.task_id);
  assert.strictEqual(store.get('p-handoff-failure', { expectedAccountId: 'acct_1' }).state, 'committed');
});

test('e2e: proposal-backed handoff rejection releases the reservation and remains a rejected task', async () => {
  const store = new InMemoryProposalStore();
  const proposalId = 'p-handoff-rejection';
  store.putDraft({
    proposalId,
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: proposalId },
  });
  store.commit(proposalId, {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: proposalId },
  });

  let attempts = 0;
  const taskRegistry = createInMemoryTaskRegistry();
  let rejectedTaskRef;
  const rejectTask = taskRegistry.reject.bind(taskRegistry);
  taskRegistry.reject = async (taskId, scope, result, reason) => {
    rejectedTaskRef = scope;
    return rejectTask(taskId, scope, result, reason);
  };
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async (_params, ctx) =>
          ctx.handoffToTask(async taskCtx => {
            attempts += 1;
            if (attempts === 1) {
              return taskCtx.reject(
                { decision: 'declined', reason_code: 'SALES_GUARANTEE_UNAVAILABLE' },
                'Guaranteed inventory is unavailable'
              );
            }
            return { media_buy_id: 'mb-after-rejection', buyer_ref: 'br', packages: [], status: 'pending_creative' };
          }),
      },
    }),
    {
      name: 'e2e',
      version: '1.0',
      proposalStore: store,
      taskRegistry,
      validation: { requests: 'off', responses: 'off' },
    }
  );

  const rejected = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: proposalId, idempotency_key: 'idem-handoff-rejection-0001' },
      },
    },
    { authInfo }
  );
  const rejectedTaskId = rejected.structuredContent.task_id;
  await server.awaitTaskUnsafe(rejectedTaskId);
  const rejectedTask = await taskRegistry.getTask(rejectedTaskId, rejectedTaskRef);
  assert.strictEqual(rejectedTask.status, 'rejected');
  assert.deepStrictEqual(rejectedTask.result, { decision: 'declined', reason_code: 'SALES_GUARANTEE_UNAVAILABLE' });
  assert.strictEqual(rejectedTask.statusMessage, 'Guaranteed inventory is unavailable');
  assert.strictEqual(rejectedTask.error, undefined);
  assert.strictEqual(store.get(proposalId, { expectedAccountId: 'acct_1' }).state, 'committed');

  const retried = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: proposalId, idempotency_key: 'idem-handoff-rejection-0002' },
      },
    },
    { authInfo }
  );
  await server.awaitTaskUnsafe(retried.structuredContent.task_id);
  const record = store.get(proposalId, { expectedAccountId: 'acct_1' });
  assert.strictEqual(attempts, 2);
  assert.strictEqual(record.state, 'consumed');
  assert.strictEqual(record.mediaBuyId, 'mb-after-rejection');
});

test('e2e: proposal-backed handoff keeps its fence when terminal success has no media_buy_id', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p-handoff-missing-id',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p-handoff-missing-id' },
  });
  store.commit('p-handoff-missing-id', {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: 'p-handoff-missing-id' },
  });
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async (_params, ctx) =>
          ctx.handoffToTask(async () => ({ buyer_ref: 'br', packages: [], status: 'pending_creative' })),
      },
    }),
    { name: 'e2e', version: '1.0', proposalStore: store, validation: { requests: 'off', responses: 'off' } }
  );
  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p-handoff-missing-id', idempotency_key: 'idem-handoff-missing-id-0001' },
      },
    },
    { authInfo }
  );
  await server.awaitTaskUnsafe(response.structuredContent.task_id);
  assert.strictEqual(store.get('p-handoff-missing-id', { expectedAccountId: 'acct_1' }).state, 'consuming');
});

test('e2e: proposal-backed handoff releases when task allocation fails', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p-handoff-allocation-failure',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p-handoff-allocation-failure' },
  });
  store.commit('p-handoff-allocation-failure', {
    expectedAccountId: 'acct_1',
    expiresAt: new Date(Date.now() + 60_000),
    proposalPayload: { proposal_id: 'p-handoff-allocation-failure' },
  });
  const taskRegistry = createInMemoryTaskRegistry();
  taskRegistry.create = async () => {
    throw new Error('task allocation unavailable');
  };
  const server = createAdcpServerFromPlatform(
    buildPlatform({
      proposalManager: undefined,
      sales: {
        getProducts: async () => ({ products: [] }),
        createMediaBuy: async (_params, ctx) =>
          ctx.handoffToTask(async () => ({ media_buy_id: 'never-created', packages: [] })),
      },
    }),
    {
      name: 'e2e',
      version: '1.0',
      proposalStore: store,
      taskRegistry,
      validation: { requests: 'off', responses: 'off' },
    }
  );
  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: {
          proposal_id: 'p-handoff-allocation-failure',
          idempotency_key: 'idem-handoff-allocation-failure-0001',
        },
      },
    },
    { authInfo }
  );
  assert.strictEqual(response.isError, true);
  assert.strictEqual(store.get('p-handoff-allocation-failure', { expectedAccountId: 'acct_1' }).state, 'committed');
});

test('e2e: createMediaBuy adapter throw → reservation rolled back to COMMITTED', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p1' },
  });
  store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: { proposal_id: 'p1' } });

  const sales = {
    getProducts: async () => ({ products: [] }),
    createMediaBuy: async () => {
      throw new Error('upstream timeout');
    },
    updateMediaBuy: async () => ({ media_buy_id: 'mb', buyer_ref: 'br', packages: [], status: 'active' }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager: undefined, sales }), {
    name: 'e2e',
    version: '1.0',
    proposalStore: store,
    validation: { requests: 'off', responses: 'off' },
  });
  await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p1', idempotency_key: 'idem-key-rollback-0001' },
      },
    },
    { authInfo }
  );
  // Adapter threw, framework wrapped; reservation should be released.
  assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'committed');
});

test('e2e: createMediaBuy Error arm → errors preserved and reservation rolled back to COMMITTED', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p1' },
  });
  store.commit('p1', { expiresAt: new Date(Date.now() + 60_000), proposalPayload: { proposal_id: 'p1' } });

  const errors = [
    { code: 'INVALID_REQUEST', message: 'package targeting is required', field: 'packages[0].targeting' },
    { code: 'BUDGET_TOO_LOW', message: 'package budget is below the product minimum', field: 'packages[0].budget' },
  ];
  const sales = {
    getProducts: async () => ({ products: [] }),
    createMediaBuy: async () => ({ errors }),
    updateMediaBuy: async () => ({ media_buy_id: 'mb', buyer_ref: 'br', packages: [], status: 'active' }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager: undefined, sales }), {
    name: 'e2e',
    version: '1.0',
    proposalStore: store,
    validation: { requests: 'off', responses: 'off' },
  });
  const response = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p1', idempotency_key: 'idem-key-error-arm-0001' },
      },
    },
    { authInfo }
  );

  assert.strictEqual(response.isError, true);
  assert.deepStrictEqual(
    response.structuredContent.errors,
    errors.map(error => ({ ...error, recovery: 'correctable' }))
  );
  assert.strictEqual(store.get('p1', { expectedAccountId: 'acct_1' }).state, 'committed');
});

test('e2e: v1 path unchanged when no proposalStore wired', async () => {
  const calls = [];
  const sales = {
    getProducts: async () => {
      calls.push('getProducts');
      return { products: [] };
    },
    createMediaBuy: async () => {
      calls.push('createMediaBuy');
      return { media_buy_id: 'mb_v1', buyer_ref: 'br', packages: [], status: 'pending_creative' };
    },
    updateMediaBuy: async () => {
      calls.push('updateMediaBuy');
      return { media_buy_id: 'mb_v1', buyer_ref: 'br', packages: [], status: 'active' };
    },
    getMediaBuyDelivery: async () => {
      calls.push('getMediaBuyDelivery');
      return { media_buy_deliveries: [], reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' } };
    },
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager: undefined, sales }), {
    name: 'e2e',
    version: '1.0',
    validation: { requests: 'off', responses: 'off' },
    // NOTE: no proposalStore
  });
  await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'get_products', arguments: { buying_mode: 'brief' } } },
    { authInfo }
  );
  await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'create_media_buy',
        arguments: { proposal_id: 'p1', idempotency_key: 'idem-key-v1path-0001-aa' },
      },
    },
    { authInfo }
  );
  assert.deepStrictEqual(calls, ['getProducts', 'createMediaBuy']);
});

test('e2e: finalize HITL — TaskHandoff commits proposal on completion + emits path=handoff log', async () => {
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map([['prod_a', { recipe_kind: 'mock' }]]),
    proposalPayload: { proposal_id: 'p1', name: 'draft' },
  });

  const expires = new Date(Date.now() + 3_600_000);
  let handoffRan = false;
  let logCaptured = null;
  const { setProposalLifecycleLogger } = require('../../dist/lib/server/index.js');
  setProposalLifecycleLogger({
    info: (message, fields) => {
      if (fields?.event === 'proposal.finalized') logCaptured = fields;
    },
  });

  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed', finalize: true },
    getProducts: async () => ({ products: [], proposals: [] }),
    finalizeProposal: async (req, ctx) => {
      // HITL slow path — adopter hands off to a background task. The
      // framework wraps this so store.commit fires when the handoff
      // resolves.
      return ctx.handoffToTask(async _taskCtx => {
        handoffRan = true;
        return {
          proposal: {
            proposal_id: req.proposalId,
            name: 'final',
            proposal_status: 'committed',
            expires_at: expires.toISOString(),
          },
          expiresAt: expires,
        };
      });
    },
  };
  const sales = {
    createMediaBuy: async () => ({
      media_buy_id: 'mb_x',
      buyer_ref: 'br',
      packages: [],
      status: 'pending_creative',
    }),
    updateMediaBuy: async () => ({ media_buy_id: 'mb_x', buyer_ref: 'br', packages: [], status: 'active' }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start_date: '2026-01-01', end_date: '2026-01-02' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager, sales }), {
    name: 'e2e-hitl',
    version: '1.0',
    proposalStore: store,
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveSessionKey: () => 'proposal-hitl',
    validation: { requests: 'off', responses: 'off' },
  });
  await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          buying_mode: 'refine',
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1' }],
        },
      },
    },
    { authInfo }
  );
  // Background task completes asynchronously after the dispatch returns
  // the Submitted envelope. Allow the next macrotask to run so the
  // wrapped handoff fn (and store.commit) fire.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(handoffRan, 'expected adopter handoff fn to run in background');
  const record = store.get('p1', { expectedAccountId: 'acct_1' });
  assert.strictEqual(record.state, 'committed', 'proposal should commit when HITL handoff resolves');
  assert.strictEqual(record.expiresAt.getTime(), expires.getTime());
  assert.ok(logCaptured, 'expected proposal.finalized log emission');
  assert.strictEqual(logCaptured.path, 'handoff', 'log should mark this as the handoff path');
});

test('e2e: HITL handoff result strips ctx_metadata + implementation_config before tasks/get returns it', async () => {
  // Regression for the security-review finding on PR #1562: the strip
  // chokepoint at projectSync only covered the sync arm. The HITL
  // handoff path emitted the projected result via tasks/get + webhook
  // verbatim — including any ctx_metadata or implementation_config the
  // adopter let through. Fix runs both strips inside dispatchHitl
  // before taskRegistry.complete so every downstream consumer
  // inherits clean state.
  const store = new InMemoryProposalStore();
  store.putDraft({
    proposalId: 'p1',
    accountId: 'acct_1',
    recipes: new Map(),
    proposalPayload: { proposal_id: 'p1' },
  });
  const expires = new Date(Date.now() + 60_000);

  // Adopter return carries server-only fields the strip MUST remove
  // before the buyer sees the resolved task artifact.
  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed', finalize: true },
    getProducts: async () => ({ products: [], proposals: [] }),
    finalizeProposal: async (req, ctx) => {
      return ctx.handoffToTask(async () => ({
        proposal: {
          proposal_id: req.proposalId,
          name: 'final',
          proposal_status: 'committed',
          expires_at: expires.toISOString(),
          // Embedded products carrying server-only fields the buyer
          // must NOT see.
          products: [
            {
              product_id: 'prod_a',
              implementation_config: {
                recipe_kind: 'gam',
                network_code: 'TOPOLOGY_LEAK_HITL',
                upstream_ids: { line_item_template_id: 'lit_secret_HITL' },
              },
              ctx_metadata: { gam_internal_token: 'BEARER_THAT_MUST_NOT_REACH_WIRE' },
            },
          ],
        },
        expiresAt: expires,
      }));
    },
  };
  const sales = {
    createMediaBuy: async () => ({ media_buy_id: 'mb', packages: [], status: 'pending_creative' }),
    updateMediaBuy: async () => ({ media_buy_id: 'mb', packages: [], status: 'active' }),
    getMediaBuyDelivery: async () => ({
      media_buy_deliveries: [],
      reporting_period: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    }),
  };
  const server = createAdcpServerFromPlatform(buildPlatform({ proposalManager, sales }), {
    name: 'e2e-hitl-strip',
    version: '1.0',
    proposalStore: store,
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveSessionKey: () => 'proposal-hitl-strip',
    validation: { requests: 'off', responses: 'off' },
  });
  const submitted = await server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          buying_mode: 'refine',
          refine: [{ scope: 'proposal', action: 'finalize', proposal_id: 'p1' }],
        },
      },
    },
    { authInfo }
  );
  // Pull out the task_id from the Submitted envelope, then poll
  // tasks/get to read what a buyer would actually see.
  const submittedJson = JSON.stringify(submitted);
  const taskIdMatch = submittedJson.match(/"task_id"\s*:\s*"([^"]+)"/);
  assert.ok(taskIdMatch, `submitted envelope missing task_id: ${submittedJson.slice(0, 300)}`);
  const taskId = taskIdMatch[1];

  // Wait for the background handoff to resolve.
  await new Promise(resolve => setTimeout(resolve, 50));

  const taskResp = await server.dispatchTestRequest(
    { method: 'tools/call', params: { name: 'tasks_get', arguments: { task_id: taskId } } },
    { authInfo }
  );
  const taskJson = JSON.stringify(taskResp);
  assert.ok(
    !taskJson.includes('TOPOLOGY_LEAK_HITL'),
    `tasks/get HITL result leaked implementation_config: ${taskJson.slice(0, 500)}`
  );
  assert.ok(
    !taskJson.includes('lit_secret_HITL'),
    `tasks/get HITL result leaked upstream_ids: ${taskJson.slice(0, 500)}`
  );
  assert.ok(
    !taskJson.includes('BEARER_THAT_MUST_NOT_REACH_WIRE'),
    `tasks/get HITL result leaked ctx_metadata: ${taskJson.slice(0, 500)}`
  );
});
