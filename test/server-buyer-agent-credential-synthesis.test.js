'use strict';

// Stage 3 of #1269 — kind-discriminated `credential` synthesis +
// `ResolvedAuthInfo` migration shim.
//
// Two layers:
//   1. Authenticators stamp `credential` on the returned `AuthPrincipal`.
//   2. Framework dispatcher hoists `extra.credential` from MCP's auth
//      shape onto top-level `ctx.authInfo.credential`, then passes it to
//      `BuyerAgentRegistry.resolve` so factory functions actually route.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAdcpServerFromPlatform } = require('../dist/lib/server/decisioning/runtime/from-platform');
const { BuyerAgentRegistry } = require('../dist/lib/server/decisioning/buyer-agent');
const { verifyApiKey } = require('../dist/lib/server/auth');

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
      resolve: async (ref, ctx) => ({
        id: ref?.account_id ?? 'acc_1',
        metadata: {},
        authInfo: { kind: 'api_key' },
        _resolveAgent: ctx?.agent,
      }),
      upsert: async () => [],
      list: async () => ({ items: [], nextCursor: null }),
    },
    statusMappers: {},
    sales: {
      getProducts: async (_req, ctx) => ({
        products: [],
        _ctxAgent: ctx?.agent,
      }),
      createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
      syncCreatives: async () => [],
      getMediaBuyDelivery: async () => ({ media_buys: [] }),
    },
    ...overrides,
  };
}

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

describe('Stage 3 — verifyApiKey stamps `credential: { kind: "api_key" }`', () => {
  it('static-key match populates credential.key_id from the bearer token', async () => {
    const auth = verifyApiKey({
      keys: { sk_live_abc: { principal: 'acct_42' } },
    });
    const result = await auth({
      headers: { authorization: 'Bearer sk_live_abc' },
      method: 'POST',
      url: '/mcp',
    });
    assert.ok(result, 'authenticator must return a principal');
    assert.equal(result.principal, 'acct_42');
    assert.deepEqual(result.credential, { kind: 'api_key', key_id: 'sk_live_abc' });
  });

  it('does not overwrite an adopter-provided credential on the matched principal', async () => {
    const customCred = { kind: 'oauth', client_id: 'custom', scopes: ['read'] };
    const auth = verifyApiKey({
      keys: { tok: { principal: 'acct', credential: customCred } },
    });
    const result = await auth({ headers: { authorization: 'Bearer tok' }, method: 'POST', url: '/mcp' });
    assert.deepEqual(result.credential, customCred);
  });

  it('dynamic verify path stamps credential when the verifier did not', async () => {
    const auth = verifyApiKey({
      verify: async token => (token === 'tok_dynamic' ? { principal: 'acct' } : null),
    });
    const result = await auth({
      headers: { authorization: 'Bearer tok_dynamic' },
      method: 'POST',
      url: '/mcp',
    });
    assert.deepEqual(result.credential, { kind: 'api_key', key_id: 'tok_dynamic' });
  });
});

describe('Stage 3 — dispatcher hoists extra.credential to ctx.authInfo.credential', () => {
  it('credential reaches accounts.resolve via ctx.authInfo.credential', async () => {
    let resolveCredential;
    const platform = buildPlatform({
      accounts: {
        resolve: async (ref, ctx) => {
          resolveCredential = ctx?.authInfo?.credential;
          return {
            id: ref?.account_id ?? 'acc_1',
            metadata: {},
            authInfo: { kind: 'api_key' },
          };
        },
        upsert: async () => [],
        list: async () => ({ items: [], nextCursor: null }),
      },
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const credential = {
      kind: 'http_sig',
      keyid: 'scope3-2026-01',
      agent_url: 'https://agent.scope3.com',
      verified_at: 1714660000,
    };
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:scope3-2026-01',
      scopes: [],
      extra: { credential },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.deepEqual(resolveCredential, credential, 'accounts.resolve must see ctx.authInfo.credential populated');
  });
});

describe('Stage 3 — BuyerAgentRegistry routes on the credential', () => {
  it('signingOnly resolves an http_sig credential via resolveByAgentUrl', async () => {
    let lookupArg;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async url => {
          lookupArg = url;
          return sampleAgent({ agent_url: url });
        },
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
      extra: {
        credential: {
          kind: 'http_sig',
          keyid: 'kid',
          agent_url: 'https://agent.scope3.com',
          verified_at: 1714660000,
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(lookupArg, 'https://agent.scope3.com');
    assert.equal(result.structuredContent._ctxAgent.agent_url, 'https://agent.scope3.com');
  });

  it('signingOnly returns null for an api_key credential — bearer traffic refused', async () => {
    let invoked = false;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async () => {
          invoked = true;
          return sampleAgent();
        },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sk_live_abc',
      clientId: 'acct_42',
      scopes: [],
      extra: { credential: { kind: 'api_key', key_id: 'sk_live_abc' } },
    });
    assert.notStrictEqual(result.isError, true);
    assert.equal(result.structuredContent._ctxAgent, undefined, 'bearer credential must not resolve under signingOnly');
    assert.equal(invoked, false);
  });

  it('mixed routes http_sig → resolveByAgentUrl, api_key → resolveByCredential', async () => {
    let signedUrl;
    let bearerCred;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.mixed({
        resolveByAgentUrl: async url => {
          signedUrl = url;
          return sampleAgent({ agent_url: url, display_name: 'signed' });
        },
        resolveByCredential: async cred => {
          bearerCred = cred;
          return sampleAgent({ display_name: 'bearer' });
        },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });

    const signedResult = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: {
        credential: {
          kind: 'http_sig',
          keyid: 'kid',
          agent_url: 'https://agent.scope3.com',
          verified_at: 1714660000,
        },
      },
    });
    assert.equal(signedUrl, 'https://agent.scope3.com');
    assert.equal(signedResult.structuredContent._ctxAgent.display_name, 'signed');

    const bearerResult = await dispatchWithAuthInfo(server, {
      token: 'sk_live_abc',
      clientId: 'acct_42',
      scopes: [],
      extra: { credential: { kind: 'api_key', key_id: 'sk_live_abc' } },
    });
    assert.equal(bearerCred?.kind, 'api_key');
    assert.equal(bearerResult.structuredContent._ctxAgent.display_name, 'bearer');
  });

  it('legacy authInfo with no credential → registry returns null, dispatch continues', async () => {
    let invoked = false;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.bearerOnly({
        resolveByCredential: async () => {
          invoked = true;
          return sampleAgent();
        },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'legacy-tok',
      clientId: 'legacy-client',
      scopes: [],
      // No `extra.credential` — adopters not yet migrated.
    });
    assert.notStrictEqual(result.isError, true);
    assert.equal(invoked, false, 'no credential synthesized → resolver not invoked → ctx.agent undefined');
    assert.equal(result.structuredContent._ctxAgent, undefined);
  });

  it('signingOnly resolves and stamps informational ctx.authInfo.agent_url', async () => {
    const platform = buildPlatform({
      sales: {
        getProducts: async (_req, ctx) => ({
          products: [],
          _ctxAgent: ctx?.agent,
          _topLevelAgentUrl: ctx?.account?.authInfo?.agent_url,
        }),
        createMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        updateMediaBuy: async () => ({ media_buy_id: 'mb_1' }),
        syncCreatives: async () => [],
        getMediaBuyDelivery: async () => ({ media_buys: [] }),
      },
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async url => sampleAgent({ agent_url: url }),
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
      extra: {
        credential: {
          kind: 'http_sig',
          keyid: 'kid',
          agent_url: 'https://agent.scope3.com',
          verified_at: 1714660000,
        },
      },
    });
    assert.equal(result.structuredContent._ctxAgent.agent_url, 'https://agent.scope3.com');
  });
});
