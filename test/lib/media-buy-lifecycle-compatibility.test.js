process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { AgentClient } = require('../../dist/lib/core/AgentClient');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { adcpError } = require('../../dist/lib/server/errors');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency');

async function withDualSurfaceSeller(serverAdcpVersion, buyerAdcpVersion, run, options = {}) {
  const calls = [];
  const legacyRequests = [];
  let mediaBuy = {
    media_buy_id: 'hidden-legacy-media-buy-1',
    status: 'active',
    packages: [],
    revision: 1,
    currency: 'USD',
    total_budget: 1000,
    start_time: '2027-01-01T00:00:00Z',
    end_time: '2027-02-01T00:00:00Z',
    confirmed_at: '2027-01-01T00:00:00Z',
  };
  const supportedVersions = ['3.0.25', '3.1.18', '3.2.0-rc.1'].filter(version => {
    if (serverAdcpVersion.startsWith('3.0.')) return version.startsWith('3.0.');
    if (serverAdcpVersion.startsWith('3.1.')) return !version.startsWith('3.2.');
    return true;
  });
  const server = createAdcpServer({
    name: 'dual-surface-seller',
    version: '1.0.0',
    adcpVersion: serverAdcpVersion,
    ...(options.defaultAdcpVersion && { defaultAdcpVersion: options.defaultAdcpVersion }),
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveSessionKey: () => 'dual-surface-seller',
    ...(options.mcpToolProfile && { mcpToolProfile: options.mcpToolProfile }),
    capabilities: { supported_versions: supportedVersions },
    validation: { requests: 'strict', responses: 'off' },
    mediaBuy: {
      listProducts: async params => {
        calls.push(['list_products', params.adcp_version, params.adcp_major_version]);
        return {
          outcome: 'listed',
          products: [],
          feed_version: 'feed-modern',
          cache_scope: 'public',
        };
      },
      requestProposals: async () =>
        adcpError('TERMS_REJECTED', { message: 'fixture rejection', recovery: 'correctable' }),
      getProducts: async params => {
        legacyRequests.push(structuredClone(params));
        calls.push(['get_products', params.adcp_version, params.adcp_major_version]);
        if (params.buying_mode === 'brief' || params.buying_mode === 'refine') {
          const refinedProposalId = params.refine?.find(item => item.scope === 'proposal')?.proposal_id;
          const proposalId =
            refinedProposalId ??
            (params.brief?.includes('to accept')
              ? 'hidden-legacy-proposal-accept'
              : params.brief?.includes('to decline')
                ? 'hidden-legacy-proposal-decline'
                : 'hidden-legacy-proposal-1');
          return {
            products: [],
            proposals: params.refine?.some(item => item.scope === 'proposal' && item.action === 'omit')
              ? []
              : [
                  {
                    proposal_id: proposalId,
                    name: 'Hidden legacy proposal',
                    proposal_status: 'committed',
                    expires_at: '2099-12-31T23:59:59Z',
                    allocations: [],
                  },
                ],
            cache_scope: 'account',
          };
        }
        return { products: options.legacyProducts ?? [], cache_scope: 'public' };
      },
      createMediaBuy: async params => {
        calls.push(['create_media_buy', params.adcp_version, params.adcp_major_version, structuredClone(params)]);
        mediaBuy = {
          ...mediaBuy,
          revision: 1,
          status: 'active',
          total_budget:
            typeof params.total_budget === 'object' ? params.total_budget.amount : (params.total_budget ?? 1000),
          start_time: params.start_time,
          end_time: params.end_time,
        };
        return mediaBuy;
      },
      updateMediaBuy: async params => {
        calls.push(['update_media_buy', params.adcp_version, params.adcp_major_version, structuredClone(params)]);
        mediaBuy = {
          ...mediaBuy,
          revision: mediaBuy.revision + 1,
          ...(params.total_budget !== undefined && {
            total_budget: typeof params.total_budget === 'object' ? params.total_budget.amount : params.total_budget,
          }),
          ...(params.start_time !== undefined && { start_time: params.start_time }),
          ...(params.end_time !== undefined && { end_time: params.end_time }),
          status: params.canceled === true ? 'canceled' : params.paused === true ? 'paused' : 'active',
        };
        return mediaBuy;
      },
      getMediaBuys: async params => {
        calls.push(['get_media_buys', params.adcp_version, params.adcp_major_version, structuredClone(params)]);
        return { media_buys: [mediaBuy] };
      },
      getMediaBuyDelivery: async params => {
        calls.push(['get_media_buy_delivery', params.adcp_version, params.adcp_major_version, structuredClone(params)]);
        return {
          reporting_period: { start: '2027-01-01T00:00:00Z', end: '2027-02-01T00:00:00Z' },
          currency: 'USD',
          media_buy_deliveries: [],
        };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: `buyer-${buyerAdcpVersion}`, version: '1.0.0' });
  await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
  const buyer = AgentClient.fromMCPClient(mcpClient, {
    adcpVersion: buyerAdcpVersion,
    validation: { requests: 'strict', responses: 'off' },
    ...(options.legacyFormatConverter && { legacyFormatConverter: options.legacyFormatConverter }),
  });
  try {
    await run({ buyer, mcpClient, calls, legacyRequests, getMediaBuy: () => mediaBuy });
  } finally {
    await Promise.allSettled([mcpClient.close(), server.close()]);
  }
}

test('dual-surface seller defaults unversioned MCP callers to 3.1 while explicit 3.2 remains reachable', async () => {
  await withDualSurfaceSeller(
    '3.2.0-rc.1',
    '3.2.0-rc.1',
    async ({ mcpClient, calls }) => {
      const sdkTools = await AgentClient.fromMCPClient(mcpClient, {
        adcpVersion: '3.2.0-rc.1',
        validation: { requests: 'strict', responses: 'off' },
      }).getAgentInfo();
      assert.ok(sdkTools.tools.some(tool => tool.name === 'list_products'));
      assert.ok(!sdkTools.tools.some(tool => tool.name === 'get_products'));

      const defaultTools = await mcpClient.listTools();
      assert.strictEqual(defaultTools._meta.adcp_version, '3.1.18');
      assert.ok(defaultTools.tools.some(tool => tool.name === 'get_products'));
      assert.ok(!defaultTools.tools.some(tool => tool.name === 'list_products'));

      const explicitTools = await mcpClient.listTools({ _meta: { adcp_version: '3.2.0-rc.1' } });
      assert.strictEqual(explicitTools._meta.adcp_version, '3.2.0-rc.1');
      assert.ok(explicitTools.tools.some(tool => tool.name === 'list_products'));
      assert.ok(!explicitTools.tools.some(tool => tool.name === 'get_products'));

      const established = await mcpClient.callTool({
        name: 'get_products',
        arguments: { buying_mode: 'wholesale' },
      });
      assert.notStrictEqual(established.isError, true, JSON.stringify(established.structuredContent));
      assert.strictEqual(established.structuredContent.adcp_version, '3.1');

      const compact = await mcpClient.callTool({
        name: 'list_products',
        arguments: { adcp_version: '3.2-rc.1', max_results: 10 },
      });
      assert.notStrictEqual(compact.isError, true, JSON.stringify(compact.structuredContent));
      assert.strictEqual(compact.structuredContent.adcp_version, '3.2-rc.1');
      assert.deepStrictEqual(
        calls.map(([tool]) => tool),
        ['get_products', 'list_products']
      );
    },
    { defaultAdcpVersion: '3.1.18' }
  );
});

test('forced established diagnostics use actual MCP tool discovery on an all-tools 3.2 seller', async () => {
  await withDualSurfaceSeller(
    '3.2.0-rc.1',
    '3.2.0-rc.1',
    async ({ buyer, calls }) => {
      const lifecycle = await buyer.negotiateMediaBuyLifecycle({
        preferredLifecycle: 'established',
        principalScope: 'forced-established-buyer',
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
      const result = await lifecycle.listProducts({ max_results: 5 });

      assert.strictEqual(result.compatibility.lifecycle, 'established');
      assert.deepStrictEqual(result.compatibility.tools_used, ['get_products']);
      const direct = await lifecycle.buyProducts({
        idempotency_key: 'forced-established-direct-0001',
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        feed_version: 'forced-feed-1',
        pricing_version: 'forced-price-1',
        purchases: [{ product_id: 'forced-product-1', pricing_option_id: 'po-1', budget: 1000 }],
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
      });
      assert.strictEqual(direct.success, true, JSON.stringify(direct));
      for (const [index, paused] of [true, false].entries()) {
        const controlled = await lifecycle.controlMediaBuy({
          idempotency_key: `forced-established-control-${index}-0001`,
          account: { account_id: 'account-1' },
          media_buy_id: 'hidden-legacy-media-buy-1',
          revision: index + 1,
          paused,
        });
        assert.strictEqual(controlled.success, true, JSON.stringify(controlled));
      }
      const budget = await lifecycle.controlMediaBuy({
        idempotency_key: 'forced-established-budget-0001',
        account: { account_id: 'account-1' },
        media_buy_id: 'hidden-legacy-media-buy-1',
        revision: 3,
        packages: [{ package_id: 'forced-package-1', budget: 900 }],
      });
      assert.strictEqual(budget.success, true, JSON.stringify(budget));
      const callsBeforeDate = calls.length;
      await assert.rejects(
        lifecycle.controlMediaBuy({
          idempotency_key: 'forced-established-date-0001',
          account: { account_id: 'account-1' },
          media_buy_id: 'hidden-legacy-media-buy-1',
          revision: 4,
          start_time: '2027-01-02T00:00:00Z',
        }),
        error => error.code === 'UNSUPPORTED_FEATURE' && /start_time/.test(error.feature)
      );
      assert.strictEqual(calls.length, callsBeforeDate);
      const canceled = await lifecycle.controlMediaBuy({
        idempotency_key: 'forced-established-cancel-0001',
        account: { account_id: 'account-1' },
        media_buy_id: 'hidden-legacy-media-buy-1',
        revision: 4,
        canceled: true,
        cancellation_reason: 'buyer_request',
      });
      assert.strictEqual(canceled.success, true, JSON.stringify(canceled));
      const directReadback = await lifecycle.getMediaBuys({
        account: { account_id: 'account-1' },
        media_buy_ids: ['hidden-legacy-media-buy-1'],
      });
      assert.strictEqual(directReadback.data.media_buys[0].status, 'canceled');

      const forDecline = await lifecycle.requestProposals({
        idempotency_key: 'forced-established-request-decline-0001',
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        brief: 'Proposal to decline',
      });
      assert.strictEqual(forDecline.data.outcome, 'proposed');
      const declined = await lifecycle.declineProposals({
        idempotency_key: 'forced-established-decline-0001',
        declines: [{ proposal_id: forDecline.data.proposals[0].proposal_id, reason: 'budget_changed' }],
      });
      assert.strictEqual(declined.data.outcome, 'legacy_unconfirmed');
      const requested = await lifecycle.requestProposals({
        idempotency_key: 'forced-established-request-accept-0001',
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        brief: 'Proposal to accept',
      });
      const finalized = await lifecycle.refineProposals({
        idempotency_key: 'forced-established-finalize-0001',
        refinements: [{ proposal_id: requested.data.proposals[0].proposal_id, action: 'finalize' }],
      });
      assert.strictEqual(finalized.data.outcome, 'legacy_projected');
      const accepted = await lifecycle.acceptProposal({
        idempotency_key: 'forced-established-accept-0001',
        account: { account_id: 'account-1' },
        proposal_id: finalized.data.proposals[0].proposal_id,
        total_budget: { amount: 1000, currency: 'USD' },
        established_fallback: {
          brand: { domain: 'example.com' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      });
      assert.strictEqual(accepted.success, true, JSON.stringify(accepted));
      const postAccept = await lifecycle.controlMediaBuy({
        idempotency_key: 'forced-established-post-accept-0001',
        account: { account_id: 'account-1' },
        media_buy_id: 'hidden-legacy-media-buy-1',
        revision: 1,
        paused: true,
      });
      assert.strictEqual(postAccept.success, true, JSON.stringify(postAccept));
      const readback = await lifecycle.getMediaBuys({
        account: { account_id: 'account-1' },
        media_buy_ids: ['hidden-legacy-media-buy-1'],
      });
      assert.strictEqual(readback.data.media_buys[0].media_buy_id, 'hidden-legacy-media-buy-1');
      const delivery = await lifecycle.getMediaBuyDelivery({
        account: { account_id: 'account-1' },
        media_buy_ids: ['hidden-legacy-media-buy-1'],
        start_date: '2027-01-01',
        end_date: '2027-01-02',
      });
      assert.strictEqual(delivery.data.currency, 'USD');
      assert.ok(calls.every(([tool]) => !tool.includes('products') || tool === 'get_products'));
      assert.ok(
        calls.some(([tool, , , params]) => tool === 'update_media_buy' && params.packages?.[0]?.budget === 900)
      );
    },
    { mcpToolProfile: 'all' }
  );
});

test('SDK buyer uses the compact lifecycle against a 3.2 seller profile', async () => {
  await withDualSurfaceSeller('3.2.0-rc.1', '3.2.0-rc.1', async ({ buyer, mcpClient, calls }) => {
    const listed = await mcpClient.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'list_products'));
    assert.ok(!listed.tools.some(tool => tool.name === 'get_products'));

    const result = await buyer.listProducts({ max_results: 10 });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(result.data.feed_version, 'feed-modern');
    assert.deepStrictEqual(calls, [['list_products', '3.2-rc.1', 3]]);

    const lifecycle = await buyer.negotiateMediaBuyLifecycle();
    const compatible = await lifecycle.listProducts({ max_results: 5 });
    assert.strictEqual(lifecycle.negotiated_version, '3.2-rc.1');
    assert.strictEqual(compatible.compatibility.lifecycle, 'compact');
    assert.deepStrictEqual(compatible.compatibility.tools_used, ['list_products']);
    assert.strictEqual(compatible.data.feed_version, 'feed-modern');
    assert.deepStrictEqual(calls.at(-1), ['list_products', '3.2-rc.1', 3]);

    const rejected = await mcpClient.callTool({
      name: 'request_proposals',
      arguments: {
        idempotency_key: 'proposal-error-key-0001',
        brand: { domain: 'example.com' },
        brief: 'test',
      },
    });
    assert.strictEqual(rejected.isError, true);
    // InMemoryTransport supplies no authenticated principal. The official
    // MCP client must still receive the framework's structured auth error;
    // declaring a success-only outputSchema would make the SDK reject this
    // response before it reached the caller.
    assert.strictEqual(
      rejected.structuredContent.adcp_error.code,
      'AUTH_MISSING',
      JSON.stringify(rejected.structuredContent)
    );
  });
});

for (const adcpVersion of ['3.1.18', '3.0.25']) {
  test(`SDK buyer pinned to ${adcpVersion} can call a 3.2 seller's hidden legacy facade`, async () => {
    await withDualSurfaceSeller('3.2.0-rc.1', adcpVersion, async ({ buyer, mcpClient, calls, legacyRequests }) => {
      const listed = await mcpClient.listTools();
      assert.ok(!listed.tools.some(tool => tool.name === 'get_products'));

      const result = await buyer.getProducts({ buying_mode: 'wholesale' });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      const expectedWireClaim = adcpVersion === '3.1.18' ? ['get_products', '3.1', 3] : ['get_products', undefined, 3];
      assert.deepStrictEqual(calls, [expectedWireClaim]);

      const lifecycle = await buyer.negotiateMediaBuyLifecycle();
      const compatible = await lifecycle.listProducts({
        idempotency_key: `legacy-list-${adcpVersion}`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        criteria: { offer_filters: { countries: ['US'] } },
        cursor: 'legacy-cursor-1',
        max_results: 5,
      });
      assert.strictEqual(lifecycle.negotiated_version, adcpVersion === '3.1.18' ? '3.1' : '3.0');
      assert.strictEqual(compatible.compatibility.lifecycle, 'established');
      assert.strictEqual(compatible.compatibility.compatibility, 'lossless_projection');
      assert.deepStrictEqual(compatible.compatibility.tools_used, ['get_products']);
      assert.deepStrictEqual(calls.at(-1), expectedWireClaim);
      assert.deepStrictEqual(legacyRequests.at(-1), {
        buying_mode: 'wholesale',
        idempotency_key: `legacy-list-${adcpVersion}`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        filters: { countries: ['US'] },
        pagination: { cursor: 'legacy-cursor-1', max_results: 5 },
        ...(adcpVersion === '3.1.18' && { adcp_version: '3.1' }),
        adcp_major_version: 3,
      });
    });
  });

  test(`SDK buyer pinned to ${adcpVersion} preserves the full hidden legacy lifecycle on a normal 3.2 profile`, async () => {
    await withDualSurfaceSeller('3.2.0-rc.1', adcpVersion, async ({ buyer, mcpClient, calls }) => {
      const listedTools = await mcpClient.listTools();
      for (const hidden of ['get_products', 'create_media_buy', 'update_media_buy']) {
        assert.ok(!listedTools.tools.some(tool => tool.name === hidden), `${hidden} must stay hidden from tools/list`);
      }

      const discovered = await buyer.getProducts({ buying_mode: 'wholesale' });
      assert.equal(discovered.success, true, JSON.stringify(discovered));
      const direct = await buyer.createMediaBuy({
        idempotency_key: `hidden-direct-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        packages: [
          {
            buyer_ref: 'hidden-package-1',
            product_id: 'product-1',
            pricing_option_id: 'price-1',
            budget: 1000,
          },
        ],
      });
      assert.equal(direct.success, true, JSON.stringify(direct));

      const controls = [
        { idempotency_key: `hidden-pause-${adcpVersion}-0001`, revision: 1, paused: true },
        { idempotency_key: `hidden-resume-${adcpVersion}-0001`, revision: 2, paused: false },
        {
          idempotency_key: `hidden-commercial-${adcpVersion}-0001`,
          revision: 3,
          total_budget: { amount: 1250, currency: 'USD' },
          start_time: '2027-01-02T00:00:00Z',
          end_time: '2027-02-02T00:00:00Z',
        },
        {
          idempotency_key: `hidden-cancel-${adcpVersion}-0001`,
          revision: 4,
          canceled: true,
          cancellation_reason: 'buyer_request',
        },
      ];
      for (const control of controls) {
        const result = await buyer.updateMediaBuy({
          account: { account_id: 'account-1' },
          media_buy_id: 'hidden-legacy-media-buy-1',
          ...control,
        });
        assert.equal(result.success, true, JSON.stringify(result));
      }
      const controlledReadback = await buyer.getMediaBuys({
        account: { account_id: 'account-1' },
        media_buy_ids: ['hidden-legacy-media-buy-1'],
      });
      assert.equal(controlledReadback.data.media_buys[0].revision, 5);
      assert.equal(controlledReadback.data.media_buys[0].status, 'canceled');
      assert.equal(controlledReadback.data.media_buys[0].total_budget, 1250);
      assert.equal(controlledReadback.data.media_buys[0].start_time, '2027-01-02T00:00:00Z');
      assert.equal(controlledReadback.data.media_buys[0].end_time, '2027-02-02T00:00:00Z');

      const requested = await buyer.getProducts({
        buying_mode: 'brief',
        brief: 'Reach readers',
        account: { account_id: 'account-1' },
      });
      assert.equal(requested.data.proposals[0].proposal_id, 'hidden-legacy-proposal-1');
      const finalized = await buyer.getProducts({
        buying_mode: 'refine',
        refine: [{ scope: 'proposal', proposal_id: 'hidden-legacy-proposal-1', action: 'finalize' }],
      });
      assert.equal(finalized.data.proposals[0].proposal_id, 'hidden-legacy-proposal-1');
      const declined = await buyer.getProducts({
        buying_mode: 'refine',
        refine: [{ scope: 'proposal', proposal_id: 'hidden-legacy-proposal-1', action: 'omit' }],
      });
      assert.deepEqual(declined.data.proposals, []);

      const accepted = await buyer.createMediaBuy({
        idempotency_key: `hidden-accept-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
        total_budget: { amount: 1000, currency: 'USD' },
        proposal_id: 'hidden-legacy-proposal-1',
      });
      assert.equal(accepted.success, true, JSON.stringify(accepted));
      const postAcceptControl = await buyer.updateMediaBuy({
        idempotency_key: `hidden-post-accept-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        media_buy_id: 'hidden-legacy-media-buy-1',
        revision: 1,
        paused: true,
      });
      assert.equal(postAcceptControl.success, true, JSON.stringify(postAcceptControl));
      const postAcceptReadback = await buyer.getMediaBuys({
        account: { account_id: 'account-1' },
        media_buy_ids: ['hidden-legacy-media-buy-1'],
      });
      assert.equal(postAcceptReadback.data.media_buys[0].revision, 2);
      assert.equal(postAcceptReadback.data.media_buys[0].status, 'paused');

      const compactFirst = await buyer.negotiateMediaBuyLifecycle({
        principalScope: `hidden-coordinator-${adcpVersion}`,
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
      const compatibleList = await compactFirst.listProducts({ max_results: 5 });
      assert.equal(compatibleList.compatibility.lifecycle, 'established');
      assert.deepEqual(compatibleList.compatibility.tools_used, ['get_products']);
      const compatibleBuy = await compactFirst.buyProducts({
        idempotency_key: `hidden-compatible-buy-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        feed_version: 'hidden-compatible-feed-1',
        pricing_version: 'hidden-compatible-price-1',
        purchases: [{ product_id: 'product-1', pricing_option_id: 'price-1', budget: 1000 }],
        start_time: '2027-01-01T00:00:00Z',
        end_time: '2027-02-01T00:00:00Z',
      });
      assert.equal(compatibleBuy.success, true, JSON.stringify(compatibleBuy));
      const compatiblePause = await compactFirst.controlMediaBuy({
        idempotency_key: `hidden-compatible-pause-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        media_buy_id: 'hidden-legacy-media-buy-1',
        revision: 1,
        paused: true,
      });
      assert.equal(compatiblePause.success, true, JSON.stringify(compatiblePause));
      const compatibleForDecline = await compactFirst.requestProposals({
        idempotency_key: `hidden-compatible-request-decline-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        brief: 'Proposal to decline',
      });
      const compatibleDecline = await compactFirst.declineProposals({
        idempotency_key: `hidden-compatible-decline-${adcpVersion}-0001`,
        declines: [{ proposal_id: compatibleForDecline.data.proposals[0].proposal_id, reason: 'other' }],
      });
      assert.equal(compatibleDecline.data.outcome, 'legacy_unconfirmed');
      const compatibleRequest = await compactFirst.requestProposals({
        idempotency_key: `hidden-compatible-request-accept-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        brand: { domain: 'example.com' },
        brief: 'Proposal to accept',
      });
      const compatibleFinalize = await compactFirst.refineProposals({
        idempotency_key: `hidden-compatible-finalize-${adcpVersion}-0001`,
        refinements: [{ proposal_id: compatibleRequest.data.proposals[0].proposal_id, action: 'finalize' }],
      });
      const compatibleAccept = await compactFirst.acceptProposal({
        idempotency_key: `hidden-compatible-accept-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        proposal_id: compatibleFinalize.data.proposals[0].proposal_id,
        total_budget: { amount: 1000, currency: 'USD' },
        established_fallback: {
          brand: { domain: 'example.com' },
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        },
      });
      assert.equal(compatibleAccept.success, true, JSON.stringify(compatibleAccept));
      const compatiblePostAccept = await compactFirst.controlMediaBuy({
        idempotency_key: `hidden-compatible-post-accept-${adcpVersion}-0001`,
        account: { account_id: 'account-1' },
        media_buy_id: 'hidden-legacy-media-buy-1',
        revision: 1,
        paused: true,
      });
      assert.equal(compatiblePostAccept.success, true, JSON.stringify(compatiblePostAccept));

      assert.ok(calls.some(call => call[0] === 'create_media_buy'));
      assert.ok(calls.some(call => call[0] === 'update_media_buy'));
      assert.ok(calls.some(call => call[0] === 'get_media_buys'));
    });
  });

  test(`SDK buyer and seller pinned to ${adcpVersion} use the advertised legacy facade`, async () => {
    await withDualSurfaceSeller(adcpVersion, adcpVersion, async ({ buyer, mcpClient, calls }) => {
      const listed = await mcpClient.listTools();
      assert.ok(listed.tools.some(tool => tool.name === 'get_products'));
      assert.ok(!listed.tools.some(tool => tool.name === 'list_products'));

      const result = await buyer.getProducts({ buying_mode: 'wholesale' });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      const expectedWireClaim = adcpVersion === '3.1.18' ? ['get_products', '3.1', 3] : ['get_products', undefined, 3];
      assert.deepStrictEqual(calls, [expectedWireClaim]);

      const lifecycle = await buyer.negotiateMediaBuyLifecycle();
      const compatible = await lifecycle.listProducts({ max_results: 5 });
      assert.strictEqual(lifecycle.negotiated_version, adcpVersion === '3.1.18' ? '3.1' : '3.0');
      assert.deepStrictEqual(compatible.compatibility.tools_used, ['get_products']);
      assert.deepStrictEqual(calls.at(-1), expectedWireClaim);
    });
  });
}

for (const lane of [
  {
    name: '3.1 served release',
    negotiatedVersion: '3.1.18',
    capabilities: {
      version: 'v3',
      servedVersion: '3.1.18',
      supportedVersions: ['3.1.18'],
      idempotency: { replayTtlSeconds: 3600 },
      mediaBuyLifecycleTools: ['get_products'],
      discoveredTools: ['get_products'],
    },
  },
  {
    name: 'metadata-free 3.0',
    negotiatedVersion: '3.0',
    capabilities: {
      version: 'v3',
      idempotency: { replayTtlSeconds: 3600 },
      mediaBuyLifecycleTools: ['get_products'],
      discoveredTools: ['get_products'],
    },
  },
]) {
  test(`3.2-pinned buyer projects ${lane.name} claims to a hidden legacy handler`, async () => {
    await withDualSurfaceSeller(
      '3.2.0-rc.1',
      '3.2.0-rc.1',
      async ({ buyer, mcpClient, calls, legacyRequests }) => {
        const compactTools = await mcpClient.listTools({ _meta: { adcp_version: '3.2-rc.1' } });
        assert.ok(!compactTools.tools.some(tool => tool.name === 'get_products'));

        buyer.getCapabilities = async () => lane.capabilities;
        const lifecycle = await buyer.negotiateMediaBuyLifecycle({
          principalScope: 'hidden-boundary-buyer',
          legacyPurchaseSellerSessionScope: 'hidden-boundary-seller-session',
          allowedLosses: ['feed_version_not_atomic', 'pricing_version_not_atomic'],
        });
        const result = await lifecycle.listProducts({
          idempotency_key: `hidden-${lane.negotiatedVersion}-list-0001`,
          account: { account_id: 'account-hidden-boundary' },
          criteria: { offer_filters: { countries: ['US'] } },
          cursor: 'hidden-boundary-cursor',
          max_results: 7,
        });

        assert.equal(lifecycle.negotiated_version, lane.negotiatedVersion);
        assert.equal(result.success, true, JSON.stringify(result));
        assert.deepStrictEqual(calls.at(-1), [
          'get_products',
          lane.negotiatedVersion.startsWith('3.1') ? '3.1' : undefined,
          3,
        ]);
        assert.deepStrictEqual(legacyRequests.at(-1), {
          buying_mode: 'wholesale',
          adcp_major_version: 3,
          ...(lane.negotiatedVersion.startsWith('3.1') && { adcp_version: '3.1' }),
          idempotency_key: `hidden-${lane.negotiatedVersion}-list-0001`,
          account: { account_id: 'account-hidden-boundary' },
          filters: { countries: ['US'] },
          pagination: { cursor: 'hidden-boundary-cursor', max_results: 7 },
        });

        const continuation = result.data.purchase_continuation;
        assert.ok(continuation, JSON.stringify(result));
        assert.equal(continuation.kind, 'legacy_create');
        const legacyCreateIdempotencyKey = lane.negotiatedVersion.startsWith('3.1')
          ? '6ec62a3e-9859-4b29-943f-53f10c988c2f'
          : 'fc689f57-d34d-43b7-a7b9-8aa38f69af59';
        const purchased = await lifecycle.continueLegacyPurchase({
          idempotency_key: lane.negotiatedVersion.startsWith('3.1')
            ? 'ccf730a8-a043-4b51-a7a3-e1cb77a908b9'
            : '38a18528-b290-4a18-bf5d-58f05d481c14',
          continuation_token: continuation.continuation_token,
          account: { account_id: 'account-hidden-boundary' },
          selected_product_ids: ['hidden-product-1'],
          accepted_losses: continuation.losses,
          legacy_create_request: {
            idempotency_key: legacyCreateIdempotencyKey,
            account: { account_id: 'account-hidden-boundary' },
            brand: { domain: 'example.com' },
            packages: [{ product_id: 'hidden-product-1', pricing_option_id: 'hidden-price-1', budget: 100 }],
            start_time: '2027-01-01T00:00:00Z',
            end_time: '2027-02-01T00:00:00Z',
          },
        });
        assert.equal(purchased.success, true, JSON.stringify(purchased));
        const createCall = calls.findLast(([tool]) => tool === 'create_media_buy');
        assert.deepStrictEqual(createCall.slice(0, 3), [
          'create_media_buy',
          lane.negotiatedVersion.startsWith('3.1') ? '3.1' : undefined,
          3,
        ]);
        assert.deepStrictEqual(createCall[3], {
          adcp_major_version: 3,
          ...(lane.negotiatedVersion.startsWith('3.1') && { adcp_version: '3.1' }),
          idempotency_key: legacyCreateIdempotencyKey,
          account: { account_id: 'account-hidden-boundary' },
          brand: { domain: 'example.com' },
          packages: [{ product_id: 'hidden-product-1', pricing_option_id: 'hidden-price-1', budget: 100 }],
          start_time: '2027-01-01T00:00:00Z',
          end_time: '2027-02-01T00:00:00Z',
        });
      },
      {
        legacyProducts: [
          {
            product_id: 'hidden-product-1',
            name: 'Hidden legacy product',
            description: 'Purchasable through the legacy facade',
            publisher_properties: [{ publisher_domain: 'example.com', selection_type: 'all' }],
            format_ids: [{ agent_url: 'https://formats.example/catalog', id: 'hidden-display' }],
            delivery_type: 'non_guaranteed',
            pricing_options: [
              {
                pricing_option_id: 'hidden-price-1',
                pricing_model: 'cpm',
                currency: 'USD',
                fixed_price: 10,
              },
            ],
            reporting_capabilities: {
              available_reporting_frequencies: ['daily'],
              expected_delay_minutes: 60,
              timezone: 'UTC',
              supports_webhooks: false,
              available_metrics: ['impressions'],
              date_range_support: 'date_range',
            },
          },
        ],
        legacyFormatConverter: () => ({
          format_option_id: 'hidden-format-option',
          format_kind: 'custom',
          format_shape: 'display',
          format_schema: {
            uri: 'https://formats.example/schemas/hidden-display.json',
            digest: `sha256:${'a'.repeat(64)}`,
          },
          params: {},
        }),
      }
    );
  });
}
