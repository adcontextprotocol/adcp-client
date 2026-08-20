process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { AgentClient } = require('../../dist/lib/core/AgentClient');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server');
const { adcpError } = require('../../dist/lib/server/errors');

async function withDualSurfaceSeller(serverAdcpVersion, buyerAdcpVersion, run, options = {}) {
  const calls = [];
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
  const supportedVersions = ['3.0.24', '3.1.15', '3.2.0-beta.3'].filter(version => {
    if (serverAdcpVersion.startsWith('3.0.')) return version.startsWith('3.0.');
    if (serverAdcpVersion.startsWith('3.1.')) return !version.startsWith('3.2.');
    return true;
  });
  const server = createAdcpServer({
    name: 'dual-surface-seller',
    version: '1.0.0',
    adcpVersion: serverAdcpVersion,
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
        return { products: [], cache_scope: 'public' };
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
  });
  try {
    await run({ buyer, mcpClient, calls, getMediaBuy: () => mediaBuy });
  } finally {
    await Promise.allSettled([mcpClient.close(), server.close()]);
  }
}

test('forced established diagnostics use actual MCP tool discovery on an all-tools 3.2 seller', async () => {
  await withDualSurfaceSeller(
    '3.2.0-beta.3',
    '3.2.0-beta.3',
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
  await withDualSurfaceSeller('3.2.0-beta.3', '3.2.0-beta.3', async ({ buyer, mcpClient, calls }) => {
    const listed = await mcpClient.listTools();
    assert.ok(listed.tools.some(tool => tool.name === 'list_products'));
    assert.ok(!listed.tools.some(tool => tool.name === 'get_products'));

    const result = await buyer.listProducts({ max_results: 10 });
    assert.strictEqual(result.success, true, JSON.stringify(result));
    assert.strictEqual(result.data.feed_version, 'feed-modern');
    assert.deepStrictEqual(calls, [['list_products', '3.2-beta.3', 3]]);

    const lifecycle = await buyer.negotiateMediaBuyLifecycle();
    const compatible = await lifecycle.listProducts({ max_results: 5 });
    assert.strictEqual(lifecycle.negotiated_version, '3.2-beta.3');
    assert.strictEqual(compatible.compatibility.lifecycle, 'compact');
    assert.deepStrictEqual(compatible.compatibility.tools_used, ['list_products']);
    assert.strictEqual(compatible.data.feed_version, 'feed-modern');
    assert.deepStrictEqual(calls.at(-1), ['list_products', '3.2-beta.3', 3]);

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

for (const adcpVersion of ['3.1.15', '3.0.24']) {
  test(`SDK buyer pinned to ${adcpVersion} can call a 3.2 seller's hidden legacy facade`, async () => {
    await withDualSurfaceSeller('3.2.0-beta.3', adcpVersion, async ({ buyer, mcpClient, calls }) => {
      const listed = await mcpClient.listTools();
      assert.ok(!listed.tools.some(tool => tool.name === 'get_products'));

      const result = await buyer.getProducts({ buying_mode: 'wholesale' });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      const expectedWireClaim = adcpVersion === '3.1.15' ? ['get_products', '3.1', 3] : ['get_products', undefined, 3];
      assert.deepStrictEqual(calls, [expectedWireClaim]);

      const lifecycle = await buyer.negotiateMediaBuyLifecycle();
      const compatible = await lifecycle.listProducts({ max_results: 5 });
      assert.strictEqual(lifecycle.negotiated_version, adcpVersion === '3.1.15' ? '3.1' : '3.0');
      assert.strictEqual(compatible.compatibility.lifecycle, 'established');
      assert.strictEqual(compatible.compatibility.compatibility, 'lossless_projection');
      assert.deepStrictEqual(compatible.compatibility.tools_used, ['get_products']);
      assert.deepStrictEqual(calls.at(-1), expectedWireClaim);
    });
  });

  test(`SDK buyer pinned to ${adcpVersion} preserves the full hidden legacy lifecycle on a normal 3.2 profile`, async () => {
    await withDualSurfaceSeller('3.2.0-beta.3', adcpVersion, async ({ buyer, mcpClient, calls }) => {
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
      const expectedWireClaim = adcpVersion === '3.1.15' ? ['get_products', '3.1', 3] : ['get_products', undefined, 3];
      assert.deepStrictEqual(calls, [expectedWireClaim]);

      const lifecycle = await buyer.negotiateMediaBuyLifecycle();
      const compatible = await lifecycle.listProducts({ max_results: 5 });
      assert.strictEqual(lifecycle.negotiated_version, adcpVersion === '3.1.15' ? '3.1' : '3.0');
      assert.deepStrictEqual(compatible.compatibility.tools_used, ['get_products']);
      assert.deepStrictEqual(calls.at(-1), expectedWireClaim);
    });
  });
}
