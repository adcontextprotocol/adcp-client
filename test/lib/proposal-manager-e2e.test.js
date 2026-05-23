/**
 * E2E smoke tests confirming the v1.5 ProposalManager dispatch wiring is
 * actually in the runtime. Goes through `dispatchTestRequest` so the
 * full pipeline (schema validation, idempotency, account resolution,
 * platform handler) runs.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createAdcpServerFromPlatform, InMemoryProposalStore } = require('../../dist/lib/server/index.js');

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

test('e2e: getProducts persists drafts to store after manager returns', async () => {
  const store = new InMemoryProposalStore();
  const proposalManager = {
    capabilities: { salesSpecialism: 'sales-guaranteed' },
    getProducts: async () => ({
      products: [
        {
          product_id: 'prod_a',
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
