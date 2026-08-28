process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const express = require('express');

const { AgentClient, proposalTermsDigest } = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { createA2AAdapter } = require('../../dist/lib/server/a2a-adapter.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { AdcpError } = require('../../dist/lib/server/decisioning/index.js');
const { validateRequest, validateResponse, formatIssues } = require('../../dist/lib/validation/index.js');
const { createTestProduct } = require('./test-fixtures.js');

const ACCOUNT = { account_id: 'release-gate-account' };
const BRAND = { domain: 'buyer.example' };
const START = '2027-01-01T00:00:00Z';
const END = '2027-02-01T00:00:00Z';
const PASSTHROUGH_INPUT = z.object({}).passthrough();

function assertSchema(direction, tool, payload, version) {
  const outcome =
    direction === 'request' ? validateRequest(tool, payload, version) : validateResponse(tool, payload, version);
  assert.equal(outcome.valid, true, `${version} ${tool} ${direction} schema failure: ${formatIssues(outcome.issues)}`);
}

function toolResult(tool, data, version) {
  assertSchema('response', tool, data, version);
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

async function withHonestEstablishedSeller(version, run) {
  const calls = [];
  const mutations = [];
  const replays = new Map();
  const product = createTestProduct({
    format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' }],
  });
  const proposals = ['legacy-proposal-1', 'legacy-proposal-2'].map((proposal_id, index) => ({
    proposal_id,
    name: `Legacy proposal ${index + 1}`,
    proposal_status: 'committed',
    expires_at: '2099-12-31T23:59:59Z',
    allocations: [{ product_id: product.product_id, pricing_option_id: 'po-1', allocation_percentage: 100 }],
  }));
  let currentMediaBuy = {
    revision: 1,
    status: 'pending_creatives',
    total_budget: 1000,
    start_time: START,
    end_time: END,
  };
  const mediaBuy = state => ({
    media_buy_id: 'legacy-media-buy-1',
    status: state.status,
    packages: [],
    revision: state.revision,
    currency: 'USD',
    total_budget: state.total_budget,
    start_time: state.start_time,
    end_time: state.end_time,
    confirmed_at: '2027-01-01T00:00:00Z',
  });

  const server = new McpServer({ name: `honest-${version}-seller`, version: '1.0.0' });
  const register = (tool, handler) => {
    server.registerTool(tool, { inputSchema: PASSTHROUGH_INPUT }, async args => {
      assertSchema('request', tool, args, version);
      calls.push({ tool, args: structuredClone(args) });
      return handler(args);
    });
  };
  const mutate = (tool, args, build) => {
    const key = args.idempotency_key;
    assert.equal(typeof key, 'string', `${tool} must carry an idempotency key`);
    const fingerprint = JSON.stringify(args);
    const replay = replays.get(`${tool}:${key}`);
    if (replay) {
      if (replay.fingerprint === fingerprint) return toolResult(tool, replay.data, version);
      return {
        isError: true,
        content: [{ type: 'text', text: 'idempotency key reused with changed payload' }],
        structuredContent: {
          adcp_error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'idempotency key reused with changed payload',
            recovery: 'terminal',
          },
        },
      };
    }
    const data = build();
    replays.set(`${tool}:${key}`, { fingerprint, data });
    mutations.push({ tool, key, args: structuredClone(args) });
    return toolResult(tool, data, version);
  };

  register('get_adcp_capabilities', () => {
    const data = {
      adcp: {
        major_versions: [3],
        idempotency: { supported: true, replay_ttl_seconds: 86400 },
        ...(version.startsWith('3.1') && { supported_versions: ['3.0', '3.1'], build_version: version }),
        ...(version.startsWith('3.2') && {
          supported_versions: ['3.0', '3.1', version.replace('.0-', '-')],
          build_version: version,
        }),
      },
      supported_protocols: ['media_buy'],
      media_buy: {
        ...(version.startsWith('3.1') && { features: { canonical_creatives: true } }),
      },
      ...(version.startsWith('3.0') && {
        account: {
          require_operator_auth: false,
          required_for_products: false,
          sandbox: true,
          supported_billing: ['operator'],
        },
      }),
    };
    return toolResult('get_adcp_capabilities', data, version);
  });
  register('get_products', args => {
    let data;
    if (args.buying_mode === 'wholesale') {
      data = {
        products: [product],
        cache_scope: 'public',
        wholesale_feed_version: 'legacy-feed-1',
        pricing_version: 'legacy-price-1',
        pagination: { has_more: false },
      };
    } else if (args.buying_mode === 'refine') {
      const isDecline = args.refine?.some(item => item.scope === 'proposal' && item.action === 'omit');
      data = { products: [], proposals: isDecline ? [] : [proposals[0]], cache_scope: 'account' };
    } else {
      data = { products: [], proposals, cache_scope: 'account' };
    }
    return toolResult('get_products', data, version);
  });
  register('create_media_buy', args =>
    mutate('create_media_buy', args, () => {
      currentMediaBuy = {
        revision: 1,
        status: 'pending_creatives',
        total_budget:
          typeof args.total_budget === 'object' && args.total_budget !== null
            ? args.total_budget.amount
            : (args.total_budget ?? 1000),
        start_time: args.start_time ?? START,
        end_time: args.end_time ?? END,
      };
      return mediaBuy(currentMediaBuy);
    })
  );
  register('update_media_buy', args =>
    mutate('update_media_buy', args, () => {
      assert.equal(args.revision, currentMediaBuy.revision, 'update must carry the authoritative revision');
      currentMediaBuy = {
        ...currentMediaBuy,
        revision: currentMediaBuy.revision + 1,
        ...(args.total_budget !== undefined && {
          total_budget:
            typeof args.total_budget === 'object' && args.total_budget !== null
              ? args.total_budget.amount
              : args.total_budget,
        }),
        ...(args.start_time !== undefined && { start_time: args.start_time }),
        ...(args.end_time !== undefined && { end_time: args.end_time }),
        status: args.canceled === true ? 'canceled' : args.paused === true ? 'paused' : 'active',
      };
      return mediaBuy(currentMediaBuy);
    })
  );
  register('get_media_buys', () => toolResult('get_media_buys', { media_buys: [mediaBuy(currentMediaBuy)] }, version));
  register('get_media_buy_delivery', () =>
    toolResult(
      'get_media_buy_delivery',
      {
        reporting_period: { start: START, end: END },
        currency: 'USD',
        media_buy_deliveries: [],
      },
      version
    )
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: `compact-buyer-for-${version}`, version: '1.0.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  const buyer = AgentClient.fromMCPClient(mcp, {
    adcpVersion: '3.2.0-beta.8',
    validation: { requests: 'strict', responses: 'strict' },
  });
  try {
    await run({ buyer, calls, mutations, product });
  } finally {
    await Promise.allSettled([mcp.close(), server.close()]);
  }
}

async function withHonestV25Seller(run) {
  const version = 'v2.5';
  const calls = [];
  const mutations = [];
  const replays = new Map();
  const product = createTestProduct({
    format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' }],
  });
  const server = new McpServer({ name: 'honest-v2.5-seller', version: '1.0.0' });
  const register = (tool, handler) => {
    server.registerTool(tool, { inputSchema: PASSTHROUGH_INPUT }, async args => {
      assertSchema('request', tool, args, version);
      calls.push({ tool, args: structuredClone(args) });
      return handler(args);
    });
  };
  const mutate = (tool, args, build) => {
    const key = `${tool}:${args.buyer_ref ?? args.media_buy_id}`;
    const fingerprint = JSON.stringify(args);
    const replay = replays.get(key);
    if (replay) {
      if (replay.fingerprint === fingerprint) return toolResult(tool, replay.data, version);
      return {
        isError: true,
        content: [{ type: 'text', text: 'buyer_ref reused with changed payload' }],
        structuredContent: {
          errors: [{ code: 'invalid_request', message: 'buyer_ref reused with changed payload' }],
        },
      };
    }
    const data = build();
    replays.set(key, { fingerprint, data });
    mutations.push({ tool, key, args: structuredClone(args) });
    return toolResult(tool, data, version);
  };

  register('get_products', () => toolResult('get_products', { products: [product] }, version));
  register('create_media_buy', args =>
    mutate('create_media_buy', args, () => ({
      media_buy_id: 'v25-media-buy-1',
      buyer_ref: args.buyer_ref ?? args.media_buy_id,
      packages: [],
    }))
  );
  register('update_media_buy', args =>
    mutate('update_media_buy', args, () => ({
      media_buy_id: 'v25-media-buy-1',
      buyer_ref: args.buyer_ref ?? args.media_buy_id,
      affected_packages: [],
    }))
  );
  register('get_media_buy_delivery', () =>
    toolResult(
      'get_media_buy_delivery',
      {
        reporting_period: { start: START, end: END },
        currency: 'USD',
        media_buy_deliveries: [],
      },
      version
    )
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'compact-buyer-for-v2.5', version: '1.0.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  const buyer = AgentClient.fromMCPClient(mcp, {
    adcpVersion: '3.2.0-beta.8',
    allowV2: true,
    validation: { requests: 'strict', responses: 'strict' },
  });
  try {
    await run({ buyer, calls, mutations, product });
  } finally {
    await Promise.allSettled([mcp.close(), server.close()]);
  }
}

async function withHonestEstablishedProposalState(state, run) {
  const version = '3.1.18';
  const server = new McpServer({ name: `honest-proposal-${state}`, version: '1.0.0' });
  const register = (tool, handler) => {
    server.registerTool(tool, { inputSchema: PASSTHROUGH_INPUT }, async args => {
      assertSchema('request', tool, args, version);
      return handler(args);
    });
  };
  register('get_adcp_capabilities', () =>
    toolResult(
      'get_adcp_capabilities',
      {
        adcp: {
          major_versions: [3],
          supported_versions: ['3.0', '3.1'],
          build_version: version,
          idempotency: { supported: true, replay_ttl_seconds: 86400 },
        },
        supported_protocols: ['media_buy'],
        media_buy: { features: { canonical_creatives: true } },
      },
      version
    )
  );
  register('get_products', () =>
    toolResult(
      'get_products',
      {
        status: state,
        task_id: `proposal-${state}-task`,
        message: state === 'input-required' ? 'Clarify the inventory constraint.' : 'Proposal work queued.',
      },
      version
    )
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: `proposal-${state}-buyer`, version: '1.0.0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  const buyer = AgentClient.fromMCPClient(mcp, {
    adcpVersion: '3.2.0-beta.8',
    validation: { requests: 'strict', responses: 'strict' },
  });
  try {
    await run(buyer);
  } finally {
    await Promise.allSettled([mcp.close(), server.close()]);
  }
}

test('3.2 compact facade preserves the honest v2.5 direct subset and types unavailable capabilities', async () => {
  await withHonestV25Seller(async ({ buyer, calls, mutations, product }) => {
    const lifecycle = await buyer.negotiateMediaBuyLifecycle({
      principalScope: 'release-gate-buyer',
      legacyPurchaseSellerSessionScope: 'release-gate-v25-seller-session',
      allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic', 'revision_not_atomic'],
    });
    assert.equal(lifecycle.negotiated_version, '2.5');
    assert.equal(lifecycle.lifecycle, 'established');
    const listed = await lifecycle.listProducts({ brand: BRAND });
    assert.equal(listed.success, true, JSON.stringify(listed));
    assert.equal(listed.data.products[0].product_id, product.product_id);

    const intent = {
      idempotency_key: 'v25-direct-release-gate-0001',
      account: ACCOUNT,
      brand: BRAND,
      feed_version: 'v25-unversioned-feed',
      purchases: [{ product_id: product.product_id, pricing_option_id: 'po-1', budget: 1000 }],
      start_time: START,
      end_time: END,
    };
    const first = await lifecycle.buyProducts(intent);
    const replay = await lifecycle.buyProducts(intent);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(replay.success, true, JSON.stringify(replay));
    assert.equal(mutations.filter(call => call.tool === 'create_media_buy').length, 1);

    const paused = await lifecycle.controlMediaBuy({
      idempotency_key: 'v25-pause-release-gate-0001',
      account: ACCOUNT,
      media_buy_id: 'v25-media-buy-1',
      revision: 1,
      paused: true,
    });
    assert.equal(paused.success, true, JSON.stringify(paused));
    assert.deepEqual(paused.compatibility.losses, ['revision_not_atomic']);
    await assert.rejects(
      lifecycle.getMediaBuyDelivery({
        account: ACCOUNT,
        media_buy_ids: ['v25-media-buy-1'],
        start_date: '2027-01-01',
        end_date: '2027-01-02',
      }),
      error => error.code === 'UNSUPPORTED_FEATURE' && error.feature === 'media_buy_delivery_readback'
    );

    const proposals = await lifecycle.requestProposals({
      account: ACCOUNT,
      brand: BRAND,
      brief: 'test',
    });
    assert.equal(proposals.success, true, JSON.stringify(proposals));
    assert.equal(proposals.data.outcome, 'products_available');
    assert.equal(proposals.data.products[0].product_id, product.product_id);
    assert.equal(proposals.data.purchase_continuation.kind, 'legacy_create');

    for (const operation of [
      () => lifecycle.listProducts({ brand: BRAND, max_results: 1 }),
      () => lifecycle.getMediaBuys({ account: ACCOUNT }),
      () =>
        lifecycle.controlMediaBuy({
          account: ACCOUNT,
          media_buy_id: 'v25-media-buy-1',
          revision: 1,
          canceled: true,
        }),
    ]) {
      await assert.rejects(operation(), error => error.code === 'UNSUPPORTED_FEATURE');
    }
    assert.equal(calls[0].tool, 'get_products');
    assert.equal(calls[0].args.buying_mode, undefined);
    assert.equal(calls.find(call => call.tool === 'create_media_buy').args.idempotency_key, undefined);
    assert.equal(calls.find(call => call.tool === 'create_media_buy').args.buyer_ref, intent.idempotency_key);
  });
});

for (const state of ['submitted', 'input-required']) {
  test(`established proposal projection preserves honest ${state} wire state without fabricating an outcome`, async () => {
    await withHonestEstablishedProposalState(state, async buyer => {
      const lifecycle = await buyer.negotiateMediaBuyLifecycle({ principalScope: 'release-gate-buyer' });
      const result = await lifecycle.requestProposals({
        idempotency_key: `proposal-${state}-release-gate-0001`,
        account: ACCOUNT,
        brand: BRAND,
        brief: 'Reach readers',
      });
      assert.equal(result.status, state);
      assert.equal(result.data.status, state);
      assert.equal(result.data.task_id, `proposal-${state}-task`);
      assert.equal(result.compatibility.lifecycle, 'established');
      assert.deepEqual(result.compatibility.tools_used, ['get_products']);
      assert.equal(result.data.operation, undefined);
      assert.equal(result.data.outcome, undefined);
    });
  });
}

for (const version of ['3.0.25', '3.1.18', '3.2.0-beta.8']) {
  test(`3.2 compact facade preserves the complete ${version} direct lifecycle over honest MCP wire`, async () => {
    await withHonestEstablishedSeller(version, async ({ buyer, calls, mutations }) => {
      const lifecycle = await buyer.negotiateMediaBuyLifecycle({
        principalScope: 'release-gate-buyer',
        allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
      });
      const listed = await lifecycle.listProducts({ account: ACCOUNT, brand: BRAND, max_results: 1 });
      assert.equal(listed.success, true, JSON.stringify(listed));
      assert.equal(lifecycle.lifecycle, 'established');
      assert.equal(
        lifecycle.negotiated_version,
        version.startsWith('3.2') ? '3.2-beta.8' : version.startsWith('3.1') ? '3.1' : '3.0'
      );
      assert.equal(listed.data.feed_version, 'legacy-feed-1');
      assert.equal(listed.data.pricing_version, 'legacy-price-1');
      assert.equal(listed.data.products.length, 1, JSON.stringify(listed.data));
      assert.equal(listed.data.products[0].product_id, 'test-product-1');
      assert.equal(listed.data.products[0].format_options.length, 1);
      assert.ok(listed.data.raw.projection, 'established raw retains the SDK canonical source projection');
      assert.ok(Array.isArray(listed.data.raw.projection.diagnostics));

      const purchase = {
        product_id: 'test-product-1',
        pricing_option_id: 'po-1',
        budget: 1000,
        agency_estimate_number: 'AE-1',
        context: { buyer_ref: 'stable-package-reference' },
        start_time: START,
        end_time: END,
        ext: {},
        impressions: 10_000,
        pacing: 'even',
        targeting_overlay: {},
        ...(!version.startsWith('3.0') && {
          format_option_refs: [
            {
              scope: 'product',
              format_option_id: listed.data.products[0].format_options[0].format_option_id,
            },
          ],
        }),
      };
      const intent = {
        idempotency_key: `direct-${version}-0001`,
        account: ACCOUNT,
        brand: BRAND,
        feed_version: listed.data.feed_version,
        pricing_version: listed.data.pricing_version,
        purchases: [purchase],
        start_time: START,
        end_time: END,
        ...(version.startsWith('3.2') && { total_budget: { amount: 1000, currency: 'USD' } }),
        context: { buyer_ref: 'stable-buyer-reference' },
      };
      const first = await lifecycle.buyProducts(intent);
      const replay = await lifecycle.buyProducts(intent);
      assert.equal(first.success, true);
      assert.equal(replay.success, true);
      assert.equal(mutations.filter(call => call.tool === 'create_media_buy').length, 1);
      assert.deepEqual(first.compatibility.losses, ['feed_version_not_atomic', 'pricing_version_not_atomic']);

      const conflict = await lifecycle.buyProducts({
        ...intent,
        purchases: [{ ...intent.purchases[0], budget: 1100 }],
      });
      assert.equal(conflict.success, false);
      assert.equal(mutations.filter(call => call.tool === 'create_media_buy').length, 1);

      const pause = await lifecycle.controlMediaBuy({
        idempotency_key: `pause-${version}-0001`,
        account: ACCOUNT,
        media_buy_id: 'legacy-media-buy-1',
        revision: 1,
        paused: true,
      });
      assert.equal(pause.success, true);
      assert.equal(pause.data.revision, 2);
      const resume = await lifecycle.controlMediaBuy({
        idempotency_key: `resume-${version}-0001`,
        account: ACCOUNT,
        media_buy_id: 'legacy-media-buy-1',
        revision: 2,
        paused: false,
      });
      assert.equal(resume.success, true);
      assert.equal(resume.data.revision, 3);
      const budget = await lifecycle.controlMediaBuy({
        idempotency_key: `budget-${version}-0001`,
        account: ACCOUNT,
        media_buy_id: 'legacy-media-buy-1',
        revision: 3,
        packages: [{ package_id: 'legacy-package-1', budget: 900 }],
      });
      assert.equal(budget.success, true);
      assert.equal(budget.data.revision, 4);
      const mutationsBeforeUnsupportedDate = mutations.length;
      await assert.rejects(
        lifecycle.controlMediaBuy({
          idempotency_key: `date-${version}-0001`,
          account: ACCOUNT,
          media_buy_id: 'legacy-media-buy-1',
          revision: 4,
          start_time: '2027-01-02T00:00:00Z',
          end_time: '2027-02-02T00:00:00Z',
        }),
        error => error.code === 'UNSUPPORTED_FEATURE' && /start_time|end_time/.test(error.feature)
      );
      assert.equal(mutations.length, mutationsBeforeUnsupportedDate, 'unsupported dates must not dispatch a mutation');
      const cancel = await lifecycle.controlMediaBuy({
        idempotency_key: `cancel-${version}-0001`,
        account: ACCOUNT,
        media_buy_id: 'legacy-media-buy-1',
        revision: 4,
        canceled: true,
        cancellation_reason: 'buyer_request',
      });
      assert.equal(cancel.success, true);
      assert.equal(cancel.data.revision, 5);
      const readback = await lifecycle.getMediaBuys({ account: ACCOUNT, media_buy_ids: ['legacy-media-buy-1'] });
      const delivery = await lifecycle.getMediaBuyDelivery({
        account: ACCOUNT,
        media_buy_ids: ['legacy-media-buy-1'],
        start_date: '2027-01-01',
        end_date: '2027-01-02',
      });
      assert.equal(readback.data.media_buys[0].media_buy_id, 'legacy-media-buy-1');
      assert.equal(readback.data.media_buys[0].revision, 5);
      assert.equal(readback.data.media_buys[0].status, 'canceled');
      assert.equal(delivery.data.currency, 'USD');
      const budgetWire = calls.find(
        call => call.tool === 'update_media_buy' && call.args.packages?.[0]?.budget === 900
      );
      assert.equal(budgetWire.args.packages[0].package_id, 'legacy-package-1');

      const getProductsWire = calls.find(call => call.tool === 'get_products').args;
      assert.equal(getProductsWire.buying_mode, 'wholesale');
      assert.deepEqual(getProductsWire.pagination, { max_results: 1 });
      assert.deepEqual(getProductsWire.account, ACCOUNT);
      assert.deepEqual(getProductsWire.brand, BRAND);
      const createWire = calls.find(call => call.tool === 'create_media_buy').args;
      assert.equal(createWire.purchases, undefined);
      assert.equal(createWire.feed_version, undefined);
      assert.equal(createWire.pricing_version, undefined);
      assert.equal(createWire.packages[0].product_id, 'test-product-1');
      assert.equal(createWire.context.buyer_ref, 'stable-buyer-reference');
      assert.equal(createWire.packages[0].context.buyer_ref, 'stable-package-reference');
      assert.equal(createWire.packages[0].agency_estimate_number, 'AE-1');
      assert.equal(createWire.packages[0].start_time, START);
      assert.equal(createWire.packages[0].end_time, END);
      assert.deepEqual(createWire.packages[0].ext, {});
      assert.equal(createWire.packages[0].impressions, 10_000);
      assert.equal(createWire.packages[0].pacing, 'even');
      assert.deepEqual(createWire.packages[0].targeting_overlay, {});
      if (version.startsWith('3.0')) assert.equal(createWire.packages[0].format_option_refs, undefined);
      else assert.deepEqual(createWire.packages[0].format_option_refs, purchase.format_option_refs);
    });
  });

  test(`3.2 compact facade preserves ordinary ${version} proposal execution with explicit losses`, async () => {
    await withHonestEstablishedSeller(version, async ({ buyer, calls, mutations }) => {
      const lifecycle = await buyer.negotiateMediaBuyLifecycle({
        principalScope: 'release-gate-buyer',
        allowedLosses: [
          'proposal_terms_digest_not_enforced',
          'proposal_terms_digest_unavailable',
          'proposal_snapshot_not_immutable',
          'proposal_decline_not_terminal',
          'proposal_decline_reason_not_forwarded',
        ],
      });
      const proposed = await lifecycle.requestProposals({
        idempotency_key: `request-${version}-0001`,
        account: ACCOUNT,
        brand: BRAND,
        brief: 'Reach readers with display inventory',
        criteria: {
          offer_filters: {
            is_fixed_price: true,
            required_performance_standards: [
              {
                metric: 'viewability',
                threshold: 0.7,
                vendor: { domain: 'measurement.example' },
              },
            ],
            ...(!version.startsWith('3.0') && {
              required_vendor_metrics: [{ vendor: { domain: 'measurement.example' } }],
            }),
          },
        },
      });
      assert.equal(proposed.success, true, JSON.stringify(proposed));
      assert.equal(proposed.data.operation, 'request');
      assert.equal(proposed.data.outcome, 'proposed');
      assert.equal(proposed.data.proposals.length, 2, JSON.stringify(proposed.data));
      assert.equal(proposed.data.proposals[0].proposal_id, 'legacy-proposal-1');
      assert.equal(proposed.data.proposals[0].terms_digest, undefined);

      const finalized = await lifecycle.refineProposals({
        idempotency_key: `finalize-${version}-0001`,
        refinements: [{ proposal_id: 'legacy-proposal-1', action: 'finalize' }],
      });
      assert.equal(finalized.success, true, JSON.stringify(finalized));
      assert.equal(finalized.data.operation, 'refine');
      assert.equal(finalized.data.outcome, 'legacy_projected');
      assert.equal(finalized.data.proposals[0].proposal_id, 'legacy-proposal-1');

      const declined = await lifecycle.declineProposals({
        idempotency_key: `decline-${version}-0001`,
        declines: [{ proposal_id: 'legacy-proposal-2', reason: 'budget_changed' }],
      });
      assert.equal(declined.success, true, JSON.stringify(declined));
      assert.equal(declined.data.operation, 'decline');
      assert.equal(declined.data.outcome, 'legacy_unconfirmed');
      assert.deepEqual(declined.data.results, [{ proposal_id: 'legacy-proposal-2', outcome: 'unconfirmed' }]);

      const accepted = await lifecycle.acceptProposal({
        idempotency_key: `accept-${version}-0001`,
        account: ACCOUNT,
        proposal_id: 'legacy-proposal-1',
        total_budget: { amount: 1000, currency: 'USD' },
        established_fallback: { brand: BRAND, start_time: START, end_time: END },
      });
      assert.equal(accepted.success, true);
      assert.deepEqual(accepted.compatibility.losses, [
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
      ]);
      assert.equal(mutations.filter(call => call.tool === 'create_media_buy').length, 1);
      const proposalWire = calls.find(call => call.tool === 'create_media_buy').args;
      assert.equal(proposalWire.proposal_id, 'legacy-proposal-1');
      assert.equal(proposalWire.proposal_terms_digest, undefined);
      assert.equal(proposalWire.established_fallback, undefined);
      assert.deepEqual(proposalWire.brand, BRAND);
      assert.equal(proposalWire.start_time, START);
      assert.equal(proposalWire.end_time, END);
      const paused = await lifecycle.controlMediaBuy({
        idempotency_key: `proposal-pause-${version}-0001`,
        account: ACCOUNT,
        media_buy_id: 'legacy-media-buy-1',
        revision: 1,
        paused: true,
      });
      assert.equal(paused.success, true, JSON.stringify(paused));
      assert.equal(paused.data.revision, 2);
      const proposalReadback = await lifecycle.getMediaBuys({
        account: ACCOUNT,
        media_buy_ids: ['legacy-media-buy-1'],
      });
      assert.equal(proposalReadback.data.media_buys[0].revision, 2);
      assert.equal(proposalReadback.data.media_buys[0].status, 'paused');
      const proposalReadWire = calls.find(
        call => call.tool === 'get_products' && call.args.buying_mode === 'brief'
      ).args;
      assert.equal(proposalReadWire.filters.is_fixed_price, true);
      assert.equal(proposalReadWire.filters.required_performance_standards[0].vendor.domain, 'measurement.example');
      if (version.startsWith('3.0')) assert.equal(proposalReadWire.filters.required_vendor_metrics, undefined);
      else assert.equal(proposalReadWire.filters.required_vendor_metrics[0].vendor.domain, 'measurement.example');
    });
  });
}

test('the same compact-first buyer facade projects established direct and proposal lifecycles over official A2A', async () => {
  const calls = [];
  let a2aMediaBuy = {
    media_buy_id: 'a2a-media-buy-1',
    status: 'pending_creatives',
    packages: [],
    revision: 1,
    currency: 'USD',
    total_budget: 1000,
    confirmed_at: '2027-01-01T00:00:00Z',
  };
  const product = createTestProduct({
    format_ids: [{ agent_url: 'https://creative.adcontextprotocol.org', id: 'display_300x250' }],
  });
  const adcp = createAdcpServer({
    name: 'a2a-established-release-gate',
    version: '1.0.0',
    adcpVersion: '3.1.18',
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveSessionKey: () => 'a2a-release-gate',
    capabilities: { supported_versions: ['3.0', '3.1'] },
    validation: { requests: 'strict', responses: 'strict' },
    mediaBuy: {
      getProducts: async params => {
        calls.push({ tool: 'get_products', args: structuredClone(params) });
        if (params.buying_mode === 'brief') {
          return {
            products: [],
            proposals: ['a2a-legacy-proposal-1', 'a2a-legacy-proposal-2'].map(proposal_id => ({
              proposal_id,
              name: 'A2A legacy proposal',
              proposal_status: 'committed',
              expires_at: '2099-12-31T23:59:59Z',
              allocations: [{ product_id: product.product_id, pricing_option_id: 'po-1', allocation_percentage: 100 }],
            })),
            cache_scope: 'account',
          };
        }
        if (params.buying_mode === 'refine') {
          const declined = params.refine?.some(item => item.scope === 'proposal' && item.action === 'omit');
          return {
            products: [],
            proposals: declined
              ? []
              : [
                  {
                    proposal_id: 'a2a-legacy-proposal-1',
                    name: 'A2A finalized legacy proposal',
                    proposal_status: 'committed',
                    expires_at: '2099-12-31T23:59:59Z',
                    allocations: [
                      { product_id: product.product_id, pricing_option_id: 'po-1', allocation_percentage: 100 },
                    ],
                  },
                ],
            cache_scope: 'account',
          };
        }
        return {
          products: [product],
          cache_scope: 'public',
          wholesale_feed_version: 'a2a-feed-1',
          pricing_version: 'a2a-price-1',
        };
      },
      createMediaBuy: async params => {
        calls.push({ tool: 'create_media_buy', args: structuredClone(params) });
        a2aMediaBuy = { ...a2aMediaBuy, revision: 1, status: 'pending_creatives' };
        return a2aMediaBuy;
      },
      updateMediaBuy: async params => {
        calls.push({ tool: 'update_media_buy', args: structuredClone(params) });
        assert.equal(params.revision, a2aMediaBuy.revision);
        a2aMediaBuy = {
          ...a2aMediaBuy,
          revision: a2aMediaBuy.revision + 1,
          status: params.canceled === true ? 'canceled' : params.paused === true ? 'paused' : 'active',
        };
        return a2aMediaBuy;
      },
      getMediaBuys: async params => {
        calls.push({ tool: 'get_media_buys', args: structuredClone(params) });
        return { media_buys: [a2aMediaBuy] };
      },
      getMediaBuyDelivery: async params => {
        calls.push({ tool: 'get_media_buy_delivery', args: structuredClone(params) });
        return {
          reporting_period: { start: START, end: END },
          currency: 'USD',
          media_buy_deliveries: [],
        };
      },
    },
  });
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  server.keepAliveTimeout = 60_000;
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/a2a`;
  createA2AAdapter({
    server: adcp,
    async authenticate() {
      return { token: 'release-gate', clientId: 'compact-buyer', scopes: ['media_buy'] };
    },
    agentCard: {
      name: 'A2A established release gate',
      description: 'Established lifecycle transport fixture',
      url,
      version: '1.0.0',
      provider: { organization: 'AdCP test', url: 'https://adcontextprotocol.org' },
      securitySchemes: {},
    },
  }).mount(app);

  try {
    const buyer = new AgentClient(
      { id: 'a2a-release-gate', name: 'A2A release gate', agent_uri: url, protocol: 'a2a' },
      { adcpVersion: '3.2.0-beta.8', validation: { requests: 'strict', responses: 'strict' } }
    );
    const lifecycle = await buyer.negotiateMediaBuyLifecycle({
      principalScope: 'release-gate-buyer',
      allowedLosses: [
        'feed_version_not_atomic',
        'pricing_version_not_atomic',
        'proposal_terms_digest_not_enforced',
        'proposal_terms_digest_unavailable',
        'proposal_snapshot_not_immutable',
        'proposal_decline_not_terminal',
        'proposal_decline_reason_not_forwarded',
      ],
    });
    const listed = await lifecycle.listProducts({ account: ACCOUNT, brand: BRAND });
    assert.equal(listed.success, true, JSON.stringify(listed));
    assert.equal(lifecycle.lifecycle, 'established');
    assert.equal(listed.data.feed_version, 'a2a-feed-1');

    const bought = await lifecycle.buyProducts({
      idempotency_key: 'a2a-direct-release-gate-0001',
      account: ACCOUNT,
      brand: BRAND,
      feed_version: listed.data.feed_version,
      pricing_version: listed.data.pricing_version,
      purchases: [{ product_id: product.product_id, pricing_option_id: 'po-1', budget: 1000 }],
      start_time: START,
      end_time: END,
    });
    assert.equal(bought.success, true, JSON.stringify(bought));
    for (const [index, paused] of [true, false].entries()) {
      const controlled = await lifecycle.controlMediaBuy({
        idempotency_key: `a2a-direct-control-${index}-0001`,
        account: ACCOUNT,
        media_buy_id: 'a2a-media-buy-1',
        revision: index + 1,
        paused,
      });
      assert.equal(controlled.success, true, JSON.stringify(controlled));
    }
    const budget = await lifecycle.controlMediaBuy({
      idempotency_key: 'a2a-direct-budget-0001',
      account: ACCOUNT,
      media_buy_id: 'a2a-media-buy-1',
      revision: 3,
      packages: [{ package_id: 'a2a-package-1', budget: 900 }],
    });
    assert.equal(budget.success, true, JSON.stringify(budget));
    const callsBeforeUnsupportedDate = calls.length;
    await assert.rejects(
      lifecycle.controlMediaBuy({
        idempotency_key: 'a2a-direct-date-0001',
        account: ACCOUNT,
        media_buy_id: 'a2a-media-buy-1',
        revision: 4,
        start_time: '2027-01-02T00:00:00Z',
        end_time: '2027-02-02T00:00:00Z',
      }),
      error => error.code === 'UNSUPPORTED_FEATURE' && /start_time|end_time/.test(error.feature)
    );
    assert.equal(calls.length, callsBeforeUnsupportedDate);
    const canceled = await lifecycle.controlMediaBuy({
      idempotency_key: 'a2a-direct-cancel-0001',
      account: ACCOUNT,
      media_buy_id: 'a2a-media-buy-1',
      revision: 4,
      canceled: true,
      cancellation_reason: 'buyer_request',
    });
    assert.equal(canceled.success, true, JSON.stringify(canceled));
    const directReadback = await lifecycle.getMediaBuys({ account: ACCOUNT, media_buy_ids: ['a2a-media-buy-1'] });
    assert.equal(directReadback.data.media_buys[0].revision, 5);
    assert.equal(directReadback.data.media_buys[0].status, 'canceled');
    const directDelivery = await lifecycle.getMediaBuyDelivery({
      account: ACCOUNT,
      media_buy_ids: ['a2a-media-buy-1'],
      start_date: '2027-01-01',
      end_date: '2027-01-02',
    });
    assert.equal(directDelivery.data.currency, 'USD');
    const proposed = await lifecycle.requestProposals({
      idempotency_key: 'a2a-proposal-request-gate-0001',
      account: ACCOUNT,
      brand: BRAND,
      brief: 'Reach readers with display inventory',
    });
    assert.equal(proposed.success, true, JSON.stringify(proposed));
    assert.equal(proposed.data.proposals[0].proposal_id, 'a2a-legacy-proposal-1');
    const finalized = await lifecycle.refineProposals({
      idempotency_key: 'a2a-proposal-finalize-gate-0001',
      refinements: [{ proposal_id: 'a2a-legacy-proposal-1', action: 'finalize' }],
    });
    assert.equal(finalized.data.outcome, 'legacy_projected');
    const declined = await lifecycle.declineProposals({
      idempotency_key: 'a2a-proposal-decline-gate-0001',
      declines: [{ proposal_id: 'a2a-legacy-proposal-2', reason: 'budget_changed' }],
    });
    assert.equal(declined.data.outcome, 'legacy_unconfirmed');
    const accepted = await lifecycle.acceptProposal({
      idempotency_key: 'a2a-proposal-accept-gate-0001',
      account: ACCOUNT,
      proposal_id: 'a2a-legacy-proposal-1',
      total_budget: { amount: 1000, currency: 'USD' },
      established_fallback: { brand: BRAND, start_time: START, end_time: END },
    });
    assert.equal(accepted.success, true, JSON.stringify(accepted));
    assert.deepEqual(accepted.compatibility.losses, [
      'proposal_terms_digest_not_enforced',
      'proposal_terms_digest_unavailable',
      'proposal_snapshot_not_immutable',
    ]);
    const postAcceptControl = await lifecycle.controlMediaBuy({
      idempotency_key: 'a2a-proposal-pause-gate-0001',
      account: ACCOUNT,
      media_buy_id: 'a2a-media-buy-1',
      revision: 1,
      paused: true,
    });
    assert.equal(postAcceptControl.data.revision, 2);
    const proposalReadback = await lifecycle.getMediaBuys({ account: ACCOUNT, media_buy_ids: ['a2a-media-buy-1'] });
    assert.equal(proposalReadback.data.media_buys[0].revision, 2);
    assert.deepEqual(
      calls.map(call => call.tool),
      [
        'get_products',
        'create_media_buy',
        'update_media_buy',
        'update_media_buy',
        'update_media_buy',
        'update_media_buy',
        'get_media_buys',
        'get_media_buy_delivery',
        'get_products',
        'get_products',
        'get_products',
        'create_media_buy',
        'update_media_buy',
        'get_media_buys',
      ]
    );
    assert.equal(calls[1].args.packages[0].product_id, product.product_id);
    assert.equal(calls[4].args.packages[0].budget, 900);
    assert.equal(calls[11].args.proposal_id, 'a2a-legacy-proposal-1');
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }
});

test('the compact-first buyer uses the native 3.2 lifecycle discovered over official A2A', async () => {
  const calls = [];
  const product = {
    product_id: 'a2a-compact-product-1',
    name: 'A2A compact product',
    pricing_options: [
      {
        pricing_option_id: 'a2a-compact-price-1',
        pricing_model: 'cpm',
        currency: 'USD',
        fixed_price: 10,
      },
    ],
  };
  const commercialTerms = {
    brand: BRAND,
    start_time: START,
    end_time: END,
    total_budget: { amount: 1000, currency: 'USD' },
    purchases: [
      {
        product_id: product.product_id,
        pricing_option_id: 'a2a-compact-price-1',
        pricing: product.pricing_options[0],
        start_time: START,
        end_time: END,
      },
    ],
  };
  const draftProposal = {
    proposal_id: 'a2a-compact-proposal-1',
    proposal_kind: 'new_media_buy',
    proposal_status: 'draft',
    expires_at: '2099-12-31T23:59:59Z',
    name: 'A2A compact proposal',
    commercial_terms: commercialTerms,
    terms_digest: proposalTermsDigest(commercialTerms),
  };
  const declinedProposal = { ...draftProposal, proposal_id: 'a2a-compact-proposal-2' };
  const committedProposal = {
    ...draftProposal,
    proposal_id: 'a2a-compact-proposal-final-1',
    parent_proposal_id: draftProposal.proposal_id,
    proposal_status: 'committed',
  };
  const mediaBuys = new Map();
  const accepted = (proposal, mediaBuyId) => ({
    ...proposal,
    proposal_status: 'accepted',
    media_buy_id: mediaBuyId,
    accepted_at: '2026-08-20T00:00:00Z',
  });
  const commitment = (proposal, mediaBuyId, packageId) => ({
    status: 'completed',
    media_buy_id: mediaBuyId,
    media_buy_status: 'active',
    revision: 1,
    accepted_proposal: accepted(proposal, mediaBuyId),
    purchase_bindings: [{ purchase_index: 0, product_id: product.product_id, package_id: packageId }],
    available_actions: [],
  });
  const readback = (commitmentResult, account, context) => ({
    media_buy_id: commitmentResult.media_buy_id,
    accepted_proposal_id: commitmentResult.accepted_proposal.proposal_id,
    accepted_proposal_terms_digest: commitmentResult.accepted_proposal.terms_digest,
    accepted_proposal: commitmentResult.accepted_proposal,
    account: { ...account, name: 'Release gate account', status: 'active' },
    status: commitmentResult.media_buy_status,
    revision: commitmentResult.revision,
    currency: 'USD',
    total_budget: 1000,
    start_time: START,
    end_time: END,
    confirmed_at: '2026-08-20T00:00:00Z',
    available_actions: [],
    context,
    packages: [
      {
        package_id: commitmentResult.purchase_bindings[0].package_id,
        product_id: product.product_id,
        budget: 1000,
      },
    ],
  });
  const refineProposals = async params => {
    calls.push({ tool: 'refine_proposals', args: structuredClone(params) });
    return {
      results: [
        {
          source_proposal_id: draftProposal.proposal_id,
          outcome: 'finalized',
          proposal: committedProposal,
        },
      ],
      products: [product],
    };
  };
  const adcp = createAdcpServer({
    name: 'a2a-compact-release-gate',
    version: '1.0.0',
    adcpVersion: '3.2.0-beta.8',
    capabilities: { supported_versions: ['3.0', '3.1', '3.2-beta.8'] },
    validation: { requests: 'strict', responses: 'strict' },
    mediaBuy: {
      listProducts: async params => {
        calls.push({ tool: 'list_products', args: structuredClone(params) });
        return {
          outcome: 'listed',
          products: [product],
          feed_version: 'a2a-compact-feed-1',
          pricing_version: 'a2a-compact-price-version-1',
          cache_scope: 'account',
        };
      },
      requestProposals: async params => {
        calls.push({ tool: 'request_proposals', args: structuredClone(params) });
        return { outcome: 'proposed', proposals: [draftProposal, declinedProposal], products: [product] };
      },
      declineProposals: async params => {
        calls.push({ tool: 'decline_proposals', args: structuredClone(params) });
        return { results: [{ proposal_id: declinedProposal.proposal_id, outcome: 'declined' }] };
      },
      acceptProposal: async params => {
        calls.push({ tool: 'accept_proposal', args: structuredClone(params) });
        const result = commitment(committedProposal, 'a2a-compact-proposal-buy-1', 'a2a-compact-proposal-package-1');
        mediaBuys.set(result.media_buy_id, readback(result, params.account, { internal_campaign_id: 'proposal-1' }));
        return result;
      },
      buyProducts: async params => {
        calls.push({ tool: 'buy_products', args: structuredClone(params) });
        const directTerms = {
          brand: params.brand,
          start_time: params.start_time,
          end_time: params.end_time,
          total_budget: { amount: 1000, currency: 'USD' },
          purchases: commercialTerms.purchases,
        };
        const directProposal = {
          proposal_id: 'a2a-compact-direct-proposal-1',
          proposal_kind: 'new_media_buy',
          proposal_status: 'draft',
          name: 'A2A compact direct purchase',
          commercial_terms: directTerms,
          terms_digest: proposalTermsDigest(directTerms),
        };
        const result = commitment(directProposal, 'a2a-compact-direct-buy-1', 'a2a-compact-direct-package-1');
        mediaBuys.set(result.media_buy_id, readback(result, params.account, params.context));
        return result;
      },
      controlMediaBuy: async params => {
        calls.push({ tool: 'control_media_buy', args: structuredClone(params) });
        const current = mediaBuys.get(params.media_buy_id);
        if (params.revision !== current.revision) {
          throw new AdcpError('CONFLICT', { message: 'The supplied media-buy revision is stale.' });
        }
        current.revision += 1;
        current.status = params.canceled === true ? 'canceled' : params.paused === true ? 'paused' : 'active';
        if (params.canceled === true) {
          current.cancellation = {
            canceled_at: '2026-08-20T00:05:00Z',
            canceled_by: 'buyer',
            reason: params.cancellation_reason,
          };
        }
        return {
          status: 'completed',
          media_buy_id: params.media_buy_id,
          media_buy_status: current.status,
          revision: current.revision,
          available_actions: [],
        };
      },
      getMediaBuys: async params => {
        calls.push({ tool: 'get_media_buys', args: structuredClone(params) });
        return { media_buys: params.media_buy_ids.map(id => mediaBuys.get(id)) };
      },
      getMediaBuyDelivery: async params => {
        calls.push({ tool: 'get_media_buy_delivery', args: structuredClone(params) });
        return {
          reporting_period: { start: START, end: END },
          currency: 'USD',
          media_buy_deliveries: params.media_buy_ids.map(mediaBuyId => ({
            media_buy_id: mediaBuyId,
            status: mediaBuys.get(mediaBuyId).status,
            totals: { spend: 25, impressions: 2500 },
            by_package: [],
          })),
        };
      },
    },
    proposalNegotiation: {
      capabilities: { supported_dimensions: [] },
      resolveScope: () => ({ tenant_id: 'a2a-compact-seller', principal_id: 'compact-buyer' }),
      refineProposals,
    },
  });
  const app = express();
  app.use(express.json());
  const server = app.listen(0);
  server.keepAliveTimeout = 60_000;
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/a2a`;
  createA2AAdapter({
    server: adcp,
    async authenticate() {
      return { token: 'release-gate', clientId: 'compact-buyer', scopes: ['media_buy'] };
    },
    agentCard: {
      name: 'A2A compact release gate',
      description: 'Native compact lifecycle transport fixture',
      url,
      version: '1.0.0',
      provider: { organization: 'AdCP test', url: 'https://adcontextprotocol.org' },
      securitySchemes: {},
    },
  }).mount(app);

  try {
    const buyer = new AgentClient(
      { id: 'a2a-compact-release-gate', name: 'A2A compact release gate', agent_uri: url, protocol: 'a2a' },
      { adcpVersion: '3.2.0-beta.8', validation: { requests: 'strict', responses: 'strict' } }
    );
    const capabilities = await buyer.getAdcpCapabilities({});
    assert.equal(capabilities.success, true, JSON.stringify(capabilities));
    const lifecycle = await buyer.negotiateMediaBuyLifecycle({ principalScope: 'release-gate-buyer' });
    assert.equal(lifecycle.lifecycle, 'compact');
    assert.equal(lifecycle.negotiated_version, '3.2-beta.8');

    const listed = await lifecycle.listProducts({ account: ACCOUNT, brand: BRAND });
    assert.equal(listed.success, true, JSON.stringify(listed));
    assert.equal(listed.compatibility.lifecycle, 'compact');
    assert.equal(listed.data.products[0].product_id, product.product_id);

    const proposed = await lifecycle.requestProposals({
      idempotency_key: 'a2a-compact-request-0001',
      account: ACCOUNT,
      brand: BRAND,
      brief: 'Reach readers',
      context: { internal_campaign_id: 'proposal-1' },
    });
    assert.equal(proposed.success, true, JSON.stringify(proposed));
    assert.equal(proposed.data.outcome, 'proposed');
    assert.deepEqual(
      proposed.data.proposals.map(proposal => proposal.proposal_id),
      [draftProposal.proposal_id, declinedProposal.proposal_id]
    );

    const finalized = await lifecycle.refineProposals({
      idempotency_key: 'a2a-compact-refine-0001',
      refinements: [{ proposal_id: draftProposal.proposal_id, action: 'finalize' }],
    });
    assert.equal(finalized.success, true, JSON.stringify(finalized));
    assert.equal(finalized.data.results[0].proposal.proposal_id, committedProposal.proposal_id);

    const declined = await lifecycle.declineProposals({
      idempotency_key: 'a2a-compact-decline-0001',
      declines: [{ proposal_id: declinedProposal.proposal_id, reason: 'budget_changed' }],
    });
    assert.equal(declined.success, true, JSON.stringify(declined));
    assert.equal(declined.data.results[0].outcome, 'declined');

    const proposalBuy = await lifecycle.acceptProposal({
      idempotency_key: 'a2a-compact-accept-0001',
      account: ACCOUNT,
      proposal_id: committedProposal.proposal_id,
      proposal_terms_digest: committedProposal.terms_digest,
    });
    assert.equal(proposalBuy.success, true, JSON.stringify(proposalBuy));
    assert.equal(proposalBuy.data.accepted_proposal.proposal_id, committedProposal.proposal_id);

    const bought = await lifecycle.buyProducts({
      idempotency_key: 'a2a-compact-buy-0001',
      account: ACCOUNT,
      brand: BRAND,
      feed_version: listed.data.feed_version,
      pricing_version: listed.data.pricing_version,
      purchases: [{ product_id: product.product_id, pricing_option_id: 'a2a-compact-price-1', budget: 1000 }],
      start_time: START,
      end_time: END,
      context: { internal_campaign_id: 'direct-1' },
    });
    assert.equal(bought.success, true, JSON.stringify(bought));
    assert.equal(bought.data.media_buy_id, 'a2a-compact-direct-buy-1');

    for (const [journey, mediaBuyId] of [
      ['proposal', proposalBuy.data.media_buy_id],
      ['direct', bought.data.media_buy_id],
    ]) {
      for (const [index, control] of [{ paused: true }, { paused: false }, { canceled: true }].entries()) {
        const controlled = await lifecycle.controlMediaBuy({
          idempotency_key: `a2a-compact-${journey}-control-${index}-0001`,
          account: ACCOUNT,
          media_buy_id: mediaBuyId,
          revision: index + 1,
          ...control,
          ...(control.canceled && { cancellation_reason: 'buyer_request' }),
        });
        assert.equal(controlled.success, true, JSON.stringify(controlled));
        assert.equal(controlled.data.revision, index + 2);
      }
    }

    const callsBeforeConflict = calls.length;
    const conflict = await lifecycle.controlMediaBuy({
      idempotency_key: 'a2a-compact-stale-control-0001',
      account: ACCOUNT,
      media_buy_id: bought.data.media_buy_id,
      revision: 1,
      paused: true,
    });
    assert.equal(conflict.success, false, JSON.stringify(conflict));
    assert.equal(conflict.adcpError.code, 'CONFLICT');
    assert.equal(calls.length, callsBeforeConflict + 1);

    const mediaBuyIds = [proposalBuy.data.media_buy_id, bought.data.media_buy_id];
    const read = await lifecycle.getMediaBuys({ account: ACCOUNT, media_buy_ids: mediaBuyIds });
    assert.equal(read.success, true, JSON.stringify(read));
    assert.deepEqual(
      read.data.media_buys.map(mediaBuy => [mediaBuy.media_buy_id, mediaBuy.revision, mediaBuy.status]),
      mediaBuyIds.map(id => [id, 4, 'canceled'])
    );
    assert.deepEqual(
      read.data.media_buys.map(mediaBuy => mediaBuy.account.account_id),
      [ACCOUNT.account_id, ACCOUNT.account_id]
    );
    assert.deepEqual(
      read.data.media_buys.map(mediaBuy => mediaBuy.context.internal_campaign_id),
      ['proposal-1', 'direct-1']
    );
    assert.deepEqual(
      read.data.media_buys.map(mediaBuy => mediaBuy.currency),
      ['USD', 'USD']
    );
    const delivery = await lifecycle.getMediaBuyDelivery({
      account: ACCOUNT,
      media_buy_ids: mediaBuyIds,
      start_date: '2027-01-01',
      end_date: '2027-01-02',
    });
    assert.deepEqual(
      delivery.data.media_buy_deliveries.map(row => row.media_buy_id),
      mediaBuyIds
    );
    assert.equal(delivery.data.currency, 'USD');

    assert.deepEqual(calls[0].args.account, ACCOUNT);
    assert.deepEqual(calls[1].args.brand, BRAND);
    assert.equal(calls[1].args.context.internal_campaign_id, 'proposal-1');
    assert.deepEqual(calls[4].args.account, ACCOUNT);
    assert.equal(calls[5].args.context.internal_campaign_id, 'direct-1');
    assert.deepEqual(
      calls.map(call => call.tool),
      [
        'list_products',
        'request_proposals',
        'refine_proposals',
        'decline_proposals',
        'accept_proposal',
        'buy_products',
        'control_media_buy',
        'control_media_buy',
        'control_media_buy',
        'control_media_buy',
        'control_media_buy',
        'control_media_buy',
        'control_media_buy',
        'get_media_buys',
        'get_media_buy_delivery',
      ]
    );
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
  }
});
