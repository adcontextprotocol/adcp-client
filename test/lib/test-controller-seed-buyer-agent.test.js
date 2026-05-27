const { describe, test } = require('node:test');
const assert = require('node:assert');

const { createComplyController } = require('../../dist/lib/testing/index.js');

const {
  createSeedFixtureCache,
  handleTestControllerRequest,
  SEED_MESSAGES,
} = require('../../dist/lib/server/index.js');

describe('seed_buyer_agent controller scenario', () => {
  test('flat store dispatches seed_buyer_agent with commercial fields as fixture', async () => {
    const seen = [];
    const store = {
      async seedBuyerAgent(agentUrl, fixture) {
        seen.push({ agentUrl, fixture });
      },
    };

    const result = await handleTestControllerRequest(store, {
      scenario: 'seed_buyer_agent',
      params: {
        agent_url: 'https://test-runner.aao.example/probe',
        billing_capabilities: ['operator'],
        status: 'active',
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.message, SEED_MESSAGES.fresh);
    assert.deepStrictEqual(seen, [
      {
        agentUrl: 'https://test-runner.aao.example/probe',
        fixture: {
          billing_capabilities: ['operator'],
          status: 'active',
        },
      },
    ]);
  });

  test('createComplyController exposes a typed buyer_agent seed adapter', async () => {
    const seen = [];
    const controller = createComplyController({
      seed: {
        buyer_agent: (params, ctx) => {
          seen.push({ params, scenario: ctx.input.scenario });
        },
      },
    });

    const result = await controller.handleRaw({
      scenario: 'seed_buyer_agent',
      params: {
        agent_url: 'https://buyer.example/agent',
        display_name: 'Buyer Test Agent',
        billing_capabilities: ['operator'],
        status: 'active',
      },
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(seen, [
      {
        scenario: 'seed_buyer_agent',
        params: {
          agent_url: 'https://buyer.example/agent',
          display_name: 'Buyer Test Agent',
          billing_capabilities: ['operator'],
          status: 'active',
        },
      },
    ]);
  });

  test('replay idempotency compares buyer-agent commercial fields', async () => {
    const store = {
      async seedBuyerAgent() {},
    };
    const options = { seedCache: createSeedFixtureCache() };
    const first = await handleTestControllerRequest(
      store,
      {
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['operator'] },
      },
      options
    );
    const replay = await handleTestControllerRequest(
      store,
      {
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['operator'] },
      },
      options
    );
    const divergent = await handleTestControllerRequest(
      store,
      {
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['agent'] },
      },
      options
    );

    assert.strictEqual(first.success, true);
    assert.strictEqual(replay.success, true);
    assert.strictEqual(replay.message, SEED_MESSAGES.replay);
    assert.strictEqual(divergent.success, false);
    assert.strictEqual(divergent.error, 'INVALID_PARAMS');
  });

  test('replay idempotency treats set-like buyer-agent fields as order-insensitive', async () => {
    const store = {
      async seedBuyerAgent() {},
    };
    const options = { seedCache: createSeedFixtureCache() };
    const first = await handleTestControllerRequest(
      store,
      {
        scenario: 'seed_buyer_agent',
        params: {
          agent_url: 'https://buyer.example/agent',
          billing_capabilities: ['operator', 'agent'],
          aliases: ['https://alias-b.example', 'https://alias-a.example'],
          allowed_brands: ['zeta.example', 'acme.example'],
        },
      },
      options
    );
    const replay = await handleTestControllerRequest(
      store,
      {
        scenario: 'seed_buyer_agent',
        params: {
          agent_url: 'https://buyer.example/agent',
          billing_capabilities: ['agent', 'operator'],
          aliases: ['https://alias-a.example', 'https://alias-b.example'],
          allowed_brands: ['acme.example', 'zeta.example'],
        },
      },
      options
    );

    assert.strictEqual(first.success, true);
    assert.strictEqual(replay.success, true);
    assert.strictEqual(replay.message, SEED_MESSAGES.replay);
  });

  test('natural-key sandbox accounts scope seed_buyer_agent idempotency', async () => {
    const store = {
      async seedBuyerAgent() {},
    };
    const options = { seedCache: createSeedFixtureCache() };
    const first = await handleTestControllerRequest(
      store,
      {
        account: { brand: { domain: 'alpha.example' }, operator: 'seller.example', sandbox: true },
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['operator'] },
      },
      options
    );
    const second = await handleTestControllerRequest(
      store,
      {
        account: { brand: { domain: 'beta.example' }, operator: 'seller.example', sandbox: true },
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['agent'] },
      },
      options
    );

    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
  });

  test('context.account scopes seed_buyer_agent idempotency like top-level account', async () => {
    const store = {
      async seedBuyerAgent() {},
    };
    const options = { seedCache: createSeedFixtureCache() };
    const first = await handleTestControllerRequest(
      store,
      {
        context: { account: { account_id: 'acc_alpha' } },
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['operator'] },
      },
      options
    );
    const second = await handleTestControllerRequest(
      store,
      {
        context: { account: { account_id: 'acc_beta' } },
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', billing_capabilities: ['agent'] },
      },
      options
    );

    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
  });

  test('session plus account scopes seed_buyer_agent idempotency together', async () => {
    const calls = [];
    const store = {
      async seedBuyerAgent(agentUrl, fixture) {
        calls.push({ agentUrl, fixture });
      },
    };
    const options = { seedCache: createSeedFixtureCache() };
    const first = await handleTestControllerRequest(
      store,
      {
        context: { session_id: 'session-a' },
        account: { brand: { domain: 'alpha.example' }, operator: 'seller.example', sandbox: true },
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', status: 'suspended' },
      },
      options
    );
    const second = await handleTestControllerRequest(
      store,
      {
        context: { session_id: 'session-a' },
        account: { brand: { domain: 'beta.example' }, operator: 'seller.example', sandbox: true },
        scenario: 'seed_buyer_agent',
        params: { agent_url: 'https://buyer.example/agent', status: 'active' },
      },
      options
    );

    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
    assert.equal(calls.length, 2);
  });

  test('supports nested fixture form for generic seed callers', async () => {
    const seen = [];
    const store = {
      async seedBuyerAgent(agentUrl, fixture) {
        seen.push({ agentUrl, fixture });
      },
    };

    const result = await handleTestControllerRequest(store, {
      scenario: 'seed_buyer_agent',
      params: {
        agent_url: 'https://buyer.example/agent',
        fixture: { billing_capabilities: ['operator'], status: 'active' },
      },
    });

    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(seen, [
      {
        agentUrl: 'https://buyer.example/agent',
        fixture: { billing_capabilities: ['operator'], status: 'active' },
      },
    ]);
  });

  test('rejects nested fixture.agent_url so it cannot override the seed key', async () => {
    const seen = [];
    const result = await handleTestControllerRequest(
      {
        async seedBuyerAgent(agentUrl, fixture) {
          seen.push({ agentUrl, fixture });
        },
      },
      {
        scenario: 'seed_buyer_agent',
        params: {
          agent_url: 'https://outer.example/agent',
          fixture: {
            agent_url: 'https://inner.example/agent',
            billing_capabilities: ['operator'],
          },
        },
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'INVALID_PARAMS');
    assert.match(result.error_detail, /agent_url inside params\.fixture/);
    assert.deepStrictEqual(seen, []);
  });

  test('rejects ambiguous direct fields plus nested fixture', async () => {
    const result = await handleTestControllerRequest(
      {
        async seedBuyerAgent() {},
      },
      {
        scenario: 'seed_buyer_agent',
        params: {
          agent_url: 'https://buyer.example/agent',
          status: 'active',
          fixture: { billing_capabilities: ['operator'] },
        },
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'INVALID_PARAMS');
    assert.match(result.error_detail, /either direct params fields or params.fixture/);
  });
});
