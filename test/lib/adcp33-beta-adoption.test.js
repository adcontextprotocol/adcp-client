const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { AgentClient, ADCP_VERSION } = require('../../dist/lib/index.js');
const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
const { InMemoryStateStore } = require('../../dist/lib/server/state-store.js');
const { convertRequest, releaseDefinesTool } = require('../../dist/lib/adapters/version/index.js');

const proposals = { outcome: 'listed', proposals: [], opportunities: [] };
const collections = {
  outcome: 'listed',
  collections: [],
  collections_version: 'collections-v1',
  cache_scope: 'public',
};

test('the official MCP client reaches both 3.3 discovery tools without provisioning or synthesizing status', async t => {
  const resolutions = [];
  const completions = [];
  const seller = createAdcpServer({
    stateStore: new InMemoryStateStore(),
    name: 'AdCP 3.3 discovery',
    version: '1.0.0',
    adcpVersion: ADCP_VERSION,
    validation: { requests: 'strict', responses: 'strict' },
    resolveAccount: async (ref, ctx) => {
      resolutions.push({ ref, provisioning: ctx.provisioning });
      return ref.account_id === 'account-allowed' ? { id: ref.account_id } : null;
    },
    mediaBuy: {
      listProducts: async () => ({ outcome: 'listed', products: [] }),
      listCollections: async () => collections,
      listProposals: async () => proposals,
    },
  });
  const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'SDK 17 buyer', version: '1.0.0' });
  await seller.connect(sellerTransport);
  const dispatch = sellerTransport.onmessage;
  sellerTransport.onmessage = (message, extra) =>
    dispatch(message, { ...extra, authInfo: { token: 'test-buyer', clientId: 'buyer', scopes: [] } });
  await mcp.connect(buyerTransport);
  t.after(async () => {
    await mcp.close();
    await seller.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    adcpVersion: ADCP_VERSION,
    webhookUrlTemplate: 'https://buyer.example/webhooks/{operation_id}',
    handlers: {
      onListCollectionsStatusChange: data => completions.push(data.outcome),
      onListProposalsStatusChange: data => completions.push(data.outcome),
    },
  });
  const stableCapabilities = await seller.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: { adcp_version: '3.2' } },
  });
  assert.equal(stableCapabilities.isError, undefined, JSON.stringify(stableCapabilities));
  assert.ok(!stableCapabilities.structuredContent.media_buy?.lifecycle_tools?.includes('list_proposals'));
  const betaCapabilities = await seller.dispatchTestRequest({
    method: 'tools/call',
    params: { name: 'get_adcp_capabilities', arguments: { adcp_version: '3.3-beta.0' } },
  });
  assert.ok(betaCapabilities.structuredContent.adcp.supported_versions.includes('3.3-beta.0'));
  assert.ok(betaCapabilities.structuredContent.adcp.supported_versions.includes('3.2'));
  for (const feature of [
    'media_buy.collection_catalog',
    'media_buy.collection_cards',
    'media_buy.open_opportunities',
  ]) {
    assert.ok(betaCapabilities.structuredContent.experimental_features.includes(feature));
    assert.ok(!stableCapabilities.structuredContent.experimental_features?.includes(feature));
  }
  const catalog = await buyer.listCollections();
  assert.equal(catalog.success, true, JSON.stringify(catalog.error));
  assert.deepEqual(catalog.data.collections, []);
  assert.equal(catalog.data.status, undefined);
  const listed = await buyer.listProposals({ account: { account_id: 'account-allowed' } });
  assert.equal(listed.success, true, JSON.stringify(listed.error));
  assert.deepEqual(listed.data.proposals, []);
  assert.equal(listed.data.status, undefined);
  assert.ok(resolutions.length > 0);
  assert.ok(resolutions.every(entry => entry.provisioning === false));
  assert.deepEqual(completions, ['listed', 'listed']);
  const denied = await buyer.listProposals({ account: { account_id: 'account-denied' } });
  assert.equal(denied.success, false);
  assert.equal(denied.adcpError?.code, 'ACCOUNT_NOT_FOUND');
});

test('3.3 refuses an unresolved account even when legacy reference pass-through was explicitly configured', async () => {
  let calls = 0;
  const seller = createAdcpServer({
    stateStore: new InMemoryStateStore(),
    name: 'Unresolved account guard',
    version: '1.0.0',
    adcpVersion: ADCP_VERSION,
    strictAccountReferences: false,
    mediaBuy: {
      listProposals: async () => {
        calls++;
        return proposals;
      },
    },
  });
  try {
    const result = await seller.dispatchTestRequest({
      method: 'tools/call',
      params: { name: 'list_proposals', arguments: { account: { account_id: 'unresolved' } } },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'ACCOUNT_NOT_FOUND');
    assert.equal(calls, 0);
  } finally {
    await seller.close();
  }
});

test('stable 3.2 uses its own schemas and reports a dropped 3.3 discovery option', () => {
  assert.equal(releaseDefinesTool('list_collections', ADCP_VERSION), true);
  assert.equal(releaseDefinesTool('list_proposals', ADCP_VERSION), true);
  assert.equal(releaseDefinesTool('list_collections', '3.2'), false);
  assert.equal(releaseDefinesTool('list_proposals', '3.2'), false);
  const translated = convertRequest(
    'get_products',
    { buying_mode: 'wholesale', include_collections: true },
    {
      fromVersion: ADCP_VERSION,
      toVersion: '3.2',
    }
  );
  assert.equal(translated.params.include_collections, undefined);
  assert.ok(translated.drifts.some(drift => drift.strippedFields?.includes('include_collections')));
});

test('proposal discovery enforces caller and account scope with request validation off', async () => {
  let calls = 0;
  const seller = createAdcpServer({
    name: 'Scoped proposals',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    validation: { requests: 'off', responses: 'off' },
    mediaBuy: {
      listProposals: async () => {
        calls++;
        return proposals;
      },
    },
  });
  try {
    const request = { method: 'tools/call', params: { name: 'list_proposals', arguments: {} } };
    const anonymous = await seller.dispatchTestRequest(request);
    assert.equal(anonymous.structuredContent.adcp_error.code, 'AUTH_MISSING');
    const authenticated = await seller.dispatchTestRequest(request, {
      authInfo: { token: 'test-buyer', clientId: 'buyer', scopes: [] },
    });
    assert.equal(authenticated.structuredContent.adcp_error.code, 'ACCOUNT_REQUIRED');
    assert.equal(calls, 0);
  } finally {
    await seller.close();
  }
});

test('a preview buyer discovers a stable seller without sending an unsupported preview marker', async t => {
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = require('zod');
  const probes = [];
  const requests = [];
  const seller = new McpServer({ name: 'Stable-only seller', version: '1.0.0' });
  seller.registerTool(
    'get_adcp_capabilities',
    { inputSchema: { adcp_major_version: z.literal(3).optional(), adcp_version: z.never().optional() } },
    async params => {
      probes.push(params);
      return {
        content: [],
        structuredContent: {
          status: 'completed',
          adcp_version: '3.2',
          adcp: { major_versions: [3], supported_versions: ['3.2'], idempotency: { supported: false } },
          supported_protocols: ['media_buy'],
          media_buy: { features: { canonical_creatives: true }, buying_modes: ['wholesale'] },
        },
      };
    }
  );
  seller.registerTool(
    'get_products',
    { inputSchema: { adcp_version: z.literal('3.2'), buying_mode: z.literal('wholesale') } },
    async params => {
      requests.push(params);
      return { content: [], structuredContent: { adcp_version: '3.2', products: [], cache_scope: 'public' } };
    }
  );
  const [buyerTransport, sellerTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'Preview buyer', version: '1.0.0' });
  await seller.connect(sellerTransport);
  await mcp.connect(buyerTransport);
  t.after(async () => {
    await mcp.close();
    await seller.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    adcpVersion: ADCP_VERSION,
    validation: { requests: 'off', responses: 'off' },
  });
  const result = await buyer.getProducts({ buying_mode: 'wholesale' });
  assert.equal(result.success, true, result.error);
  assert.ok(probes.length > 0);
  assert.ok(probes.every(probe => probe.adcp_version === undefined));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].adcp_version, '3.2');
});
