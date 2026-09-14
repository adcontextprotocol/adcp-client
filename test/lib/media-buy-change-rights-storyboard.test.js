const { test } = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { serve } = require('../../dist/lib/index.js');
const { proposalTermsDigest } = require('../../dist/lib/negotiation/verification.js');
const { createAdcpServer } = require('../../dist/lib/server/legacy/v5/index.js');
const { ADCP_CAPABILITIES, getSdkServer } = require('../../dist/lib/server/adcp-server.js');
const { createIdempotencyStore, memoryBackend } = require('../../dist/lib/server/idempotency/index.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { AdcpError } = require('../../dist/lib/server/decisioning/async-outcome.js');
const { mediaBuyActionResolver } = require('../../dist/lib/server/media-buy-action-resolver.js');
const { assertUpdateMediaBuyAllowed } = require('../../dist/lib/server/media-buy-actions.js');
const { TOOL_INPUT_SHAPE, toMcpResponse } = require('../../dist/lib/server/test-controller.js');
const { getComplianceStoryboardById } = require('../../dist/lib/testing/storyboard/index.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const VERSION = require('../../package.json').adcp_version;

test('matching change-rights compliance storyboard runs through the seller resolver over strict MCP', async () => {
  const storyboard = getComplianceStoryboardById('media_buy_seller/change_rights_state_projection');
  assert.ok(storyboard);
  let state;
  const calls = [];
  const controls = [];
  const projection = () =>
    mediaBuyActionResolver.resolve({
      buy: state,
      decide: () => ({ authorization: true, governance: true, policy: true }),
    }).available_actions;
  const adcpServer = createAdcpServer({
    name: 'Change rights storyboard seller',
    version: '1.0.0',
    adcpVersion: VERSION,
    idempotency: createIdempotencyStore({ backend: memoryBackend({ sweepIntervalMs: 0 }) }),
    resolveIdempotencyPrincipal: () => 'change-rights-buyer',
    stateStore: new InMemoryStateStore(),
    validation: { requests: 'strict', responses: 'strict' },
    mediaBuy: {
      async getMediaBuys(request) {
        calls.push('get');
        assert.deepEqual(request.media_buy_ids, [state.media_buy_id]);
        return { media_buys: [{ ...state, available_actions: projection() }] };
      },
      async controlMediaBuy(request) {
        calls.push('control');
        controls.push(structuredClone(request));
        assert.equal(request.media_buy_id, state.media_buy_id);
        if (request.revision !== state.revision)
          throw new AdcpError('CONFLICT', { message: 'Refresh the current revision.' });
        assertUpdateMediaBuyAllowed({ ...state, available_actions: projection() }, request, {
          task: 'control_media_buy',
          now: Date.now(),
        });
        if (request.paused === true) state.status = 'paused';
        if (request.paused === false) state.status = 'active';
        if (request.total_budget) state.total_budget = request.total_budget.amount;
        state.revision += 1;
        return {
          status: 'completed',
          media_buy_id: state.media_buy_id,
          media_buy_status: state.status,
          revision: state.revision,
          available_actions: projection(),
        };
      },
    },
  });
  adcpServer[ADCP_CAPABILITIES].compliance_testing = { scenarios: ['seed_creative', 'seed_media_buy'] };
  getSdkServer(adcpServer).registerTool(
    'comply_test_controller',
    {
      description: 'Seed the published compliance fixtures.',
      inputSchema: { ...TOOL_INPUT_SHAPE, account: z.record(z.string(), z.unknown()).optional() },
    },
    async request => {
      calls.push(request.scenario);
      if (request.scenario === 'seed_media_buy') {
        state = { ...structuredClone(request.params.fixture), media_buy_id: request.params.media_buy_id };
        state.revision = 1;
        state.confirmed_at = '2026-01-01T00:00:00Z';
        state.accepted_proposal.terms_digest = proposalTermsDigest(state.accepted_proposal.commercial_terms);
        state.accepted_proposal_id = state.accepted_proposal.proposal_id;
        state.accepted_proposal_terms_digest = state.accepted_proposal.terms_digest;
        delete state.account;
      }
      return toMcpResponse({ status: 'completed', success: true, simulated: { seeded: true } });
    }
  );
  const server = serve(() => adcpServer, {
    port: 0,
    authenticate: () => ({ principal: 'change-rights-buyer' }),
    onListening: () => {},
  });
  if (!server.listening)
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  try {
    const result = await runStoryboard(`http://127.0.0.1:${server.address().port}/mcp`, storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['comply_test_controller', 'get_media_buys', 'control_media_buy'],
    });
    assert.equal(result.overall_passed, true, JSON.stringify(result, null, 2));
    assert.equal(result.failed_count, 0, JSON.stringify(result, null, 2));
    assert.equal(result.skipped_count, 0, JSON.stringify(result, null, 2));
    assert.ok(calls.includes('seed_media_buy'));
    assert.equal(state.status, 'paused');
    assert.equal(state.revision, 2, 'negative paths must not mutate state');
    const mcp = new Client({ name: 'change-rights-race-buyer', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    try {
      const pause = controls.find(request => request.paused === true);
      const unpack = response =>
        response.structuredContent ?? JSON.parse(response.content.find(c => c.type === 'text').text);
      const replay = unpack(await mcp.callTool({ name: 'control_media_buy', arguments: pause }));
      assert.equal(replay.revision, 2);
      assert.equal(state.revision, 2, 'idempotent replay must not execute the action twice');
      const stale = unpack(
        await mcp.callTool({
          name: 'control_media_buy',
          arguments: { ...pause, idempotency_key: 'race-stale', revision: 1 },
        })
      );
      assert.equal(stale.errors?.[0]?.code ?? stale.adcp_error?.code, 'CONFLICT');
      const denied = unpack(
        await mcp.callTool({
          name: 'control_media_buy',
          arguments: { ...pause, idempotency_key: 'race-current', revision: 2 },
        })
      );
      assert.equal(denied.errors[0].code, 'ACTION_NOT_ALLOWED');
      assert.equal(denied.errors[0].details.reason, 'wrong_status');
      assert.ok(denied.errors[0].details.currently_available_actions.some(a => a.action === 'resume'));
      assert.equal(state.revision, 2);
    } finally {
      await mcp.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
