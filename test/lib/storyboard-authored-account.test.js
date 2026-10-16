const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildRequest } = require('../../dist/lib/testing/storyboard/request-builder.js');
const { extractContext, applyContextOutputs } = require('../../dist/lib/testing/storyboard/context.js');

const OPTIONS = {
  brand: { domain: 'advertiser.example' },
  sandbox: true,
};
const SYNC_RESPONSE = {
  accounts: [
    {
      account_id: 'stable-account',
      brand: OPTIONS.brand,
      operator: 'synced-buyer.example',
      sandbox: true,
      action: 'created',
    },
  ],
};
const SYNC_CONTEXT = {
  ...extractContext('sync_accounts', SYNC_RESPONSE),
  ...applyContextOutputs(SYNC_RESPONSE, [{ key: 'acct', path: 'accounts[0].account_id' }]),
};

for (const [task, fields] of [
  ['get_products', { buying_mode: 'brief' }],
  ['get_products', { buying_mode: 'refine' }],
  ['create_media_buy', { packages: [{ product_id: 'product-1', pricing_option_id: 'cpm', budget: 1000 }] }],
  ['create_media_buy', { proposal_id: 'proposal-1', total_budget: { amount: 1000, currency: 'USD' } }],
  ['get_media_buys', {}],
  ['get_media_buy_delivery', {}],
  ['update_media_buy', { media_buy_id: 'buy-1', paused: true }],
]) {
  describe(`${task} ${fields.buying_mode ?? (fields.proposal_id ? 'proposal' : '')} authored account precedence (#3195, #3267)`, () => {
    function request(account, context = SYNC_CONTEXT, options = OPTIONS) {
      return buildRequest(
        { id: 'account-probe', task, sample_request: { ...fields, ...(account !== undefined && { account }) } },
        context,
        options
      );
    }

    test('uses a captured stable account ID even when sync_accounts captured a natural key', () => {
      assert.deepEqual(request({ account_id: '$context.acct' }).account, { account_id: 'stable-account' });
    });

    test('preserves an authored account ID over both context and harness accounts', () => {
      const authored = { account_id: 'other-account' };
      for (const context of [SYNC_CONTEXT, {}]) {
        assert.deepEqual(request(authored, context).account, authored);
      }
    });

    test('preserves all natural-key qualifiers and carries over context sandbox routing', () => {
      const authored = {
        brand: OPTIONS.brand,
        operator: 'authored-buyer.example',
        operator_unit: 'buying-desk',
        currency: 'USD',
        timezone: 'America/New_York',
        sandbox: false,
      };
      assert.deepEqual(request(authored).account, { ...authored, sandbox: true });
      assert.deepEqual(authored.sandbox, false, 'enrichment must not mutate the authored account');
      assert.deepEqual(request(authored, { account: { ...SYNC_CONTEXT.account, sandbox: false } }).account, authored);
    });

    test('carries over harness sandbox routing for an authored natural key without context', () => {
      const authored = { brand: OPTIONS.brand, operator: 'authored-buyer.example', sandbox: false };
      assert.deepEqual(request(authored, {}).account, { ...authored, sandbox: true });
    });

    test('uses harness sandbox routing when a captured account omits sandbox', () => {
      const authored = { brand: OPTIONS.brand, operator: 'authored-buyer.example', sandbox: false };
      for (const account of [
        { account_id: 'captured-account' },
        { brand: OPTIONS.brand, operator: 'synced-buyer.example' },
      ]) {
        assert.deepEqual(request(authored, { account }).account, { ...authored, sandbox: true });
      }
    });

    test('uses context when no account identity is authored', () => {
      for (const account of [undefined, {}, { sandbox: false }]) {
        assert.deepEqual(request(account).account, SYNC_CONTEXT.account);
      }
    });

    test('retains unresolved authored identities for the runner guard, except discovery fallback', () => {
      const authored = { account_id: '$context.missing' };
      assert.deepEqual(request(authored).account, task === 'get_products' ? SYNC_CONTEXT.account : authored);
    });

    test('preserves deliberately malformed authored account ID fixtures', () => {
      const authored = { account_id: 'other-account', sandbox: false };
      const result = buildRequest(
        { id: 'invalid-account-probe', task, expect_error: true, sample_request: { ...fields, account: authored } },
        SYNC_CONTEXT,
        OPTIONS
      );
      assert.deepEqual(result.account, authored);
    });

    test('keeps the existing account default when both fixture and context omit an account', () => {
      assert.deepEqual(
        request(undefined, {}).account,
        task === 'get_products' ? undefined : { brand: OPTIONS.brand, operator: OPTIONS.brand.domain, sandbox: true }
      );
    });
  });
}

async function runAccountStoryboard(t, response, hasId) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { z } = require('zod');
  const { AgentClient } = require('../../dist/lib/index.js');
  const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
  const { parseStoryboard } = require('../../dist/lib/testing/storyboard/loader.js');
  const seen = [];
  const server = new McpServer({ name: 'account-probe', version: '1' });
  server.registerTool('get_adcp_capabilities', { inputSchema: z.object({}).passthrough() }, async () => {
    const data = {
      adcp_version: '3.2',
      adcp: {
        major_versions: [3],
        supported_versions: ['3.2'],
        idempotency: { supported: true, replay_ttl_seconds: 3600 },
      },
      supported_protocols: ['media_buy'],
    };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  });
  for (const [task, data] of [
    ['sync_accounts', response],
    ['get_media_buys', { media_buys: [] }],
  ]) {
    server.registerTool(task, { inputSchema: z.object({}).passthrough() }, async params => {
      seen.push({ task, params });
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'storyboard-runner', version: '1' });
  await mcp.connect(clientTransport);
  t.after(async () => {
    await mcp.close();
    await server.close();
  });
  const buyer = AgentClient.fromMCPClient(mcp, {
    validateFeatures: false,
    validation: { requests: 'off', responses: 'off' },
  });
  const storyboard = parseStoryboard(`
id: stable_account_id_probe
version: "1"
title: Stable account ID
category: compliance
summary: ""
narrative: ""
agent:
  interaction_model: "*"
  capabilities: []
caller:
  role: buyer_agent
phases:
  - id: accounts
    title: Accounts
    steps:
      - id: provision
        title: Provision account
        task: sync_accounts
        sample_request:
          accounts:
            - brand: { domain: advertiser.example }
              operator: synced-buyer.example
              operator_unit: { id: buying-desk }
              sandbox: true
        ${hasId ? 'context_outputs: [{ name: acct, path: "accounts[0].account_id" }]' : ''}
        validations: []
      - id: read_by_id
        title: Read by stable ID
        task: get_media_buys
        sample_request:
          account: { account_id: "$context.${hasId ? 'acct' : 'account_id'}" }
        validations: []
`);
  const tools = ['sync_accounts', 'get_media_buys'];
  const result = await runStoryboard('https://account-probe.example/mcp', storyboard, {
    // Provisioning explicitly selects a sandbox account. The in-memory MCP
    // transport does not use the runner's HTTP signing configuration.
    brand: OPTIONS.brand,
    agentTools: tools,
    _profile: { name: 'account-probe', tools },
    _client: {
      syncAccounts: (...args) => buyer.syncAccounts(...args),
      getMediaBuys: (...args) => buyer.getMediaBuys(...args),
      executeTask: (task, params, inputHandler, taskOptions) =>
        buyer.executeTask(task, params, inputHandler, taskOptions),
      resetContext: () => buyer.resetContext(),
    },
  });
  return { result, seen };
}

test('sync_accounts → get_media_buys sends the authored stable ID over official MCP (#3195)', async t => {
  const { result, seen } = await runAccountStoryboard(t, SYNC_RESPONSE, true);
  assert.equal(result.overall_passed, true, JSON.stringify(result));
  assert.deepEqual(seen[0].params.accounts[0].operator_unit, { id: 'buying-desk' });
  assert.equal(SYNC_RESPONSE.accounts[0].operator_unit, undefined);
  assert.deepEqual(
    seen.map(call => call.task),
    ['sync_accounts', 'get_media_buys']
  );
  assert.deepEqual(seen[1].params.account, { account_id: 'stable-account' });
});

test('a missing stable ID skips the domain step instead of sending the captured natural key (#3195)', async t => {
  const { account_id: _omitted, ...row } = SYNC_RESPONSE.accounts[0];
  const { result, seen } = await runAccountStoryboard(t, { accounts: [row] }, false);
  assert.deepEqual(
    seen.map(call => call.task),
    ['sync_accounts']
  );
  const read = result.phases.flatMap(phase => phase.steps).find(step => step.step_id === 'read_by_id');
  assert.equal(read.skipped, true);
  assert.equal(read.skip_reason, 'prerequisite_failed');
  assert.match(read.error, /unresolved context variables from prior steps: account_id/);
});
