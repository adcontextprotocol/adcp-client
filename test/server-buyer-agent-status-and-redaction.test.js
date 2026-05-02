'use strict';

// Stage 4 of #1269 — status enforcement + credential pattern redaction.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { BuyerAgentRegistry, markVerifiedHttpSig } = require('../dist/lib/server/decisioning/buyer-agent');
const { redactCredentialPatterns } = require('../dist/lib/server/redact');

const sampleAgent = (overrides = {}) => ({
  agent_url: 'https://agent.scope3.com',
  display_name: 'Scope3',
  status: 'active',
  billing_capabilities: new Set(['operator']),
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
        return {
          id: ref?.account_id ?? 'acc_1',
          metadata: {},
          authInfo: { kind: 'api_key' },
          _resolveAgent: ctx?.agent,
        };
      },
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async (_req, ctx) => ({ products: [], _ctxAgent: ctx?.agent }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

const sigCredential = (overrides = {}) =>
  markVerifiedHttpSig({
    kind: 'http_sig',
    keyid: 'kid',
    agent_url: 'https://agent.scope3.com',
    verified_at: 1714660000,
    ...overrides,
  });

const dispatchWithAuthInfo = (server, authInfo) =>
  server.dispatchTestRequest(
    {
      method: 'tools/call',
      params: {
        name: 'get_products',
        arguments: {
          brief: 'premium',
          promoted_offering: 'cars',
          account: { account_id: 'acc_test' },
        },
      },
    },
    { authInfo }
  );

describe('Stage 4 — status enforcement', () => {
  it('active agent → request dispatches normally', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ status: 'active' }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent._ctxAgent.status, 'active');
  });

  it('suspended agent → 403 PERMISSION_DENIED with details.scope=agent', async () => {
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
      },
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ status: 'suspended' }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.equal(result.structuredContent.adcp_error.details.scope, 'agent');
    assert.equal(result.structuredContent.adcp_error.details.status, 'suspended');
    assert.equal(handlerInvoked, false, 'handler MUST NOT run for suspended agent');
  });

  it('blocked agent → 403 PERMISSION_DENIED with details.status=blocked AND recovery=terminal', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ status: 'blocked' }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'PERMISSION_DENIED');
    assert.equal(result.structuredContent.adcp_error.details.status, 'blocked');
    // Blocked is terminal — buyers MUST NOT auto-retry; recovery dispatches
    // correctly without parsing details.status.
    assert.equal(result.structuredContent.adcp_error.recovery, 'terminal');
  });

  it('suspended agent → recovery=transient (re-onboarding may resolve)', async () => {
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ status: 'suspended' }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(result.structuredContent.adcp_error.recovery, 'transient');
  });

  it('status enforcement runs BEFORE accounts.resolve (no tenant lookup wasted)', async () => {
    let accountResolveInvoked = false;
    const platform = buildPlatform({
      accounts: {
        resolve: async () => {
          accountResolveInvoked = true;
          return { id: 'acc_1', metadata: {}, authInfo: { kind: 'api_key' } };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ status: 'suspended' }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(accountResolveInvoked, false, 'accounts.resolve MUST NOT run when agent is suspended');
  });

  it('handler that started under an active agent completes even if registry flips to suspended mid-flight', async () => {
    // The seam runs once per dispatch. A long-running handler that
    // started while the agent was active completes successfully — the
    // status enforcement is at request entry, not retroactive.
    let registryStatus = 'active';
    let handlerCompleted = false;
    const platform = buildPlatform({
      sales: {
        getProducts: async () => {
          // Simulate the agent flipping to suspended while the handler
          // is mid-flight. On a real adopter this would be a separate
          // request mutating the agent record in the seller's DB.
          registryStatus = 'suspended';
          handlerCompleted = true;
          return { products: [] };
        },
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => sampleAgent({ status: registryStatus }),
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(handlerCompleted, true, 'handler MUST complete despite mid-flight status flip');
    // The NEXT request — fired after the flip — sees suspended and is rejected.
    const nextResult = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(nextResult.isError, true);
    assert.equal(nextResult.structuredContent.adcp_error.details.status, 'suspended');
  });

  it('null registry result (no recognized agent) does NOT trigger status enforcement', async () => {
    // Defense-in-depth: null returns from the registry shouldn't be
    // confused with status rejection. The framework continues dispatch
    // (Phase 1's design; Stage 4 / Phase 2 enforcement is per-agent
    // billing capability, not "no agent at all").
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
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
  });
});

describe('Stage 4 — credential pattern redaction (redactCredentialPatterns)', () => {
  it('redacts Bearer tokens', () => {
    const out = redactCredentialPatterns('Authorization failed: Bearer sk_live_a1b2c3d4e5');
    assert.match(out, /Bearer <redacted>/);
    assert.equal(out.includes('sk_live_a1b2c3d4e5'), false);
  });

  it('redacts labeled credential patterns (token=, key=, secret=, etc.)', () => {
    const cases = [
      'lookup failed for token=sk_live_a1b2c3d4e5',
      'API call rejected: api_key=abc123def456ghi789',
      'auth error: client_id=oauth_client_xyz client_secret=very-secret-value',
      'request body: {"password":"mySecret123"}',
      'header: key_id=signing-2026-01',
    ];
    for (const input of cases) {
      const out = redactCredentialPatterns(input);
      assert.equal(/<redacted>/.test(out), true, `expected redaction in: ${input} → ${out}`);
    }
  });

  it('redacts long token-shaped strings even without a labeling prefix', () => {
    const longToken = 'a'.repeat(40);
    const out = redactCredentialPatterns(`upstream rejected ${longToken}`);
    assert.match(out, /<redacted-token>/);
    assert.equal(out.includes(longToken), false);
  });

  it('does NOT redact normal English prose / short identifiers', () => {
    const inputs = [
      'Account not found',
      'Invalid request: missing field "brief"',
      'Database connection timeout after 30 seconds',
      'Rate limited; retry after 60s',
      'Account acc_1 has no permissions',
    ];
    for (const input of inputs) {
      const out = redactCredentialPatterns(input);
      assert.equal(out, input, `unexpected redaction in: ${input} → ${out}`);
    }
  });

  it('handles empty / non-string inputs cleanly', () => {
    assert.equal(redactCredentialPatterns(''), '');
    assert.equal(redactCredentialPatterns(undefined), undefined);
    assert.equal(redactCredentialPatterns(null), null);
    assert.equal(redactCredentialPatterns(42), 42);
  });

  it('redacts in JSON-shaped error messages (common adopter format)', () => {
    const out = redactCredentialPatterns('upstream API: {"error":"unauthorized","token":"abc123def456ghijkl"}');
    assert.equal(out.includes('abc123def456ghijkl'), false, `secret not redacted: ${out}`);
  });

  it('redacts the bare `key=...` form (most common credential shape in upstream errors)', () => {
    // Code-reviewer flagged: previous `CREDENTIAL_LABEL` had `api_key` /
    // `key_id` / `signing_key` but missed bare `key=value`. Added `key`
    // to the alternation.
    const out = redactCredentialPatterns('upstream rejected: key=mySecretValue');
    assert.match(out, /key=<redacted>/);
    assert.equal(out.includes('mySecretValue'), false);
  });

  it('redacts URL-embedded basic-auth credentials', () => {
    // Security-reviewer flagged: `https://user:pass@host/` shape was
    // not covered by any of the 4 original patterns. Added URL pattern.
    const out = redactCredentialPatterns('failed to GET https://service:s3cr3tValue@vendor.example/lookup');
    assert.match(out, /https:\/\/service:<redacted>@vendor\.example/);
    assert.equal(out.includes('s3cr3tValue'), false);
  });

  it('redacts multiple credentials on the same line', () => {
    const out = redactCredentialPatterns('auth: token=foo123bar secret=baz456qux');
    assert.equal(out.includes('foo123bar'), false);
    assert.equal(out.includes('baz456qux'), false);
  });
});

describe('Stage 4 — registry-throw redaction end-to-end', () => {
  it('SERVICE_UNAVAILABLE details.reason is sanitized when adopter throws with credential bytes', async () => {
    const platform = buildPlatform({
      agentRegistry: {
        async resolve() {
          throw new Error('lookup failed for token=sk_live_secret123def456ghi789');
        },
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
      // exposeErrorDetails defaults to non-production (i.e., true) here.
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.adcp_error.code, 'SERVICE_UNAVAILABLE');
    const reason = result.structuredContent.adcp_error.details?.reason;
    assert.ok(reason, 'details.reason should be present in non-prod');
    assert.equal(reason.includes('sk_live_secret123def456ghi789'), false, `secret leaked on the wire: ${reason}`);
    assert.match(reason, /<redacted/);
  });

  it('handler-throw details.reason is also sanitized', async () => {
    const platform = buildPlatform({
      sales: {
        getProducts: async () => {
          throw new Error('upstream auth: Bearer sk_live_handler_secret_abc123def456');
        },
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: sigCredential() },
    });
    assert.equal(result.isError, true);
    const errorEnvelope = JSON.stringify(result.structuredContent.adcp_error);
    assert.equal(errorEnvelope.includes('sk_live_handler_secret_abc123def456'), false);
  });
});
