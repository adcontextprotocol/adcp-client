'use strict';

// Phase 1.5 of #1269 — sandbox-only agent enforcement.
//
// Defense-in-depth for test agents: if `BuyerAgent.sandbox_only === true`,
// the framework rejects any request whose resolved Account isn't
// `sandbox: true`. Composes with `Account.sandbox` from #1256.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { BuyerAgentRegistry, markVerifiedHttpSig } = require('../dist/lib/server/decisioning/buyer-agent');

const sampleAgent = (overrides = {}) => ({
  agent_url: 'https://addie.example.com',
  display_name: 'Addie',
  status: 'active',
  billing_capabilities: new Set(['operator']),
  ...overrides,
});

const sigCredential = (overrides = {}) =>
  markVerifiedHttpSig({
    kind: 'http_sig',
    keyid: 'kid',
    agent_url: 'https://addie.example.com',
    verified_at: 1714660000,
    ...overrides,
  });

function buildPlatform(overrides = {}) {
  return {
    capabilities: {
      specialisms: ['sales-non-guaranteed'],
      creative_agents: [],
      channels: ['display'],
      pricingModels: ['cpm'],
      config: {},
    },
    accounts: {
      resolve: async (ref, ctx) => {
        if (ref == null) return null;
        const isSandboxRef = (ref?.account_id ?? '').startsWith('sandbox_');
        return {
          id: ref.account_id,
          metadata: {},
          authInfo: { kind: 'api_key' },
          sandbox: isSandboxRef,
          _resolveAgent: ctx?.agent,
        };
      },
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async (_req, ctx) => ({
        products: [],
        _ctxAgent: ctx?.agent,
        _accountSandbox: ctx?.account?.sandbox,
      }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
      providePerformanceFeedback: async () => ({}),
    },
    ...overrides,
  };
}

const dispatch = (server, accountId) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: accountId },
        },
      },
    },
    {
      authInfo: {
        token: 'sig-tok',
        clientId: 'signing:kid',
        scopes: [],
        extra: { credential: sigCredential() },
      },
    }
  );

describe('Phase 1.5 — sandbox-only buyer agent enforcement', () => {
  it('sandbox-only agent → request to sandbox account succeeds', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ sandbox_only: true }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server, 'sandbox_acc_1');
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent._accountSandbox, true);
    assert.equal(result.structuredContent._ctxAgent.sandbox_only, true);
  });

  it('sandbox-only agent → request to non-sandbox account → PERMISSION_DENIED', async () => {
    let handlerInvoked = false;
    const platform = buildPlatform({
      sales: {
        getProducts: async () => {
          handlerInvoked = true;
          return { products: [] };
        },
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
        providePerformanceFeedback: async () => ({}),
      },
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ sandbox_only: true }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server, 'prod_acc_1');
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.equal(result.structuredContent.adcp_error.recovery, 'terminal');
    assert.equal(result.structuredContent.adcp_error.details.scope, 'agent');
    assert.equal(result.structuredContent.adcp_error.details.reason, 'sandbox-only');
    assert.equal(handlerInvoked, false, 'handler MUST NOT run when sandbox-only agent hits production account');
  });

  it('production agent (sandbox_only undefined) → no gate fires; both account types succeed', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent(), // sandbox_only undefined
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const sandboxResult = await dispatch(server, 'sandbox_acc_1');
    assert.notStrictEqual(sandboxResult.isError, true);

    const prodResult = await dispatch(server, 'prod_acc_1');
    assert.notStrictEqual(prodResult.isError, true);
  });

  it('production agent (sandbox_only: false) → no gate fires (explicit false matches default)', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ sandbox_only: false }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server, 'prod_acc_1');
    assert.notStrictEqual(result.isError, true);
  });

  it('sandbox-only agent → account-less tool (no resolved account) passes through', async () => {
    // Account-less tools (provide_performance_feedback,
    // list_creative_formats, etc.) don't have an account in scope. The
    // sandbox/production axis doesn't apply — gate skips.
    const platform = buildPlatform({
      accounts: {
        resolve: async (ref, ctx) => {
          if (ref == null) {
            // Auth-derived path: return null → ctx.account stays undefined.
            return null;
          }
          return {
            id: ref.account_id,
            metadata: {},
            authInfo: { kind: 'api_key' },
            sandbox: false,
            _resolveAgent: ctx?.agent,
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ sandbox_only: true }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await server.dispatchTestRequest(
      {
        method: 'tools/call',
        params: {
          name: 'provide_performance_feedback',
          arguments: {
            media_buy_id: 'mb_1',
            performance_index: 0.85,
            measurement_period: { start: '2026-04-01T00:00:00Z', end: '2026-04-08T00:00:00Z' },
            idempotency_key: '11111111-1111-1111-1111-111111111111',
          },
        },
      },
      {
        authInfo: {
          token: 'sig-tok',
          clientId: 'signing:kid',
          scopes: [],
          extra: { credential: sigCredential() },
        },
      }
    );
    // Either succeeds (handler runs) OR fails for an unrelated reason —
    // critically, NOT with `sandbox-only` rejection.
    if (result.isError === true) {
      assert.notEqual(result.structuredContent.adcp_error?.details?.reason, 'sandbox-only');
    }
  });

  it('sandbox-only check runs AFTER status enforcement (no double-rejection ambiguity)', async () => {
    // Suspended sandbox-only agent should fail with status, not sandbox.
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ sandbox_only: true, status: 'suspended' }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatch(server, 'prod_acc_1');
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    // Status enforcement fires first — `details.reason` should be absent
    // (status enforcement doesn't set `reason`), and `details.status`
    // should be 'suspended'.
    assert.equal(result.structuredContent.adcp_error.details.status, 'suspended');
  });

  it('null registry result (no agent) → no sandbox-only check; default request flow', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => null,
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    // No agent resolved → no sandbox_only field to check.
    const result = await dispatch(server, 'prod_acc_1');
    assert.notStrictEqual(result.isError, true);
  });
});
