const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { applyBrandInvariant } = require('../../dist/lib/testing/storyboard/runner.js');
const { schemaAllowsTopLevelField } = require('../../dist/lib/validation/schema-loader.js');

const options = { brand: { domain: 'acmeoutdoor.example' }, sandbox: true };
for (const task of [
  'get_products',
  'list_products',
  'get_signals',
  'request_proposals',
  'refine_proposals',
  'decline_proposals',
]) {
  test(`${task} discovery does not invent an account (#3095)`, () => {
    const step = { id: 'probe', task, sample_request: {} };
    const request = applyBrandInvariant(buildRequest(step, {}, options), options, task);
    assert.equal(request.account, undefined);
    if (schemaAllowsTopLevelField(task, 'brand')) assert.deepEqual(request.brand, options.brand);
    assert.equal(JSON.parse(JSON.stringify(request)).account, undefined);
  });
  test(`${task} preserves an explicitly authored account (#3095)`, () => {
    const account = { account_id: 'provisioned-account' };
    assert.deepEqual(applyBrandInvariant({ account }, options, task).account, account);
  });
}
for (const task of ['get_products', 'get_signals']) {
  test(`${task} uses a provisioned context account (#3095)`, () => {
    const account = { account_id: 'synced-account' };
    const request = buildRequest({ id: 'discovery', task }, { account }, options);
    assert.deepEqual(request.account, account);
  });
}

test('unresolved discovery placeholders and dry-run rows never seed an account (#3095)', () => {
  const { CONTEXT_EXTRACTORS } = require('../../dist/lib/testing/storyboard/context.js');
  for (const task of ['get_products', 'get_signals']) {
    for (const ref of ['$context.account', { account_id: '$context.account_id' }]) {
      const request = buildRequest({ id: 'probe', task, sample_request: { account: ref } }, {}, options);
      assert.equal(request.account, undefined);
    }
  }
  assert.deepEqual(
    CONTEXT_EXTRACTORS.sync_accounts({
      dry_run: true,
      accounts: [{ brand: options.brand, operator: options.brand.domain, action: 'created' }],
    }),
    {}
  );
});
test('signals discovery reaches an official MCP server without an unprovisioned account (#3095)', async t => {
  const { createAdcpServer } = require('../../dist/lib/server/create-adcp-server.js');
  const { AgentClient } = require('../../dist/lib/index.js');
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const seen = [];
  const server = createAdcpServer({
    name: 'signals',
    version: '1',
    validation: { requests: 'off', responses: 'off' },
    resolveAccount: async () => null,
    signals: {
      getSignals: async params => {
        seen.push(params);
        return { signals: [] };
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'runner', version: '1' });
  await mcp.connect(clientTransport);
  t.after(async () => {
    await mcp.close();
    await server.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  const storyboard = {
    id: 'signals_discovery_probe',
    version: '1',
    title: 'Probe',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'discovery',
        title: 'Discovery',
        steps: [
          {
            id: 'discovery_probe',
            title: 'Probe signals',
            task: 'get_signals',
            sample_request: { signal_spec: 'auto' },
            validations: [],
          },
        ],
      },
    ],
  };
  const result = await runStoryboard('https://signals.example/mcp', storyboard, {
    brand: options.brand,
    agentTools: ['get_signals'],
    _profile: { name: 'signals', tools: ['get_signals'] },
    _client: {
      getSignals: (...args) => buyer.getSignals(...args),
      executeTask: (task, params, inputHandler, taskOptions) =>
        buyer.executeTask(task, params, inputHandler, taskOptions),
      resetContext: () => buyer.resetContext(),
    },
  });
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].account, undefined);
});
