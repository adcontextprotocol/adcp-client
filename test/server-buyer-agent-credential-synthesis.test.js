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
const { BuyerAgentRegistry, markVerifiedHttpSig } = require('../dist/lib/server/decisioning/buyer-agent');
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
  it('static-key match populates credential.key_id with a hash, not the raw token', async () => {
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
    assert.equal(result.credential.kind, 'api_key');
    // M1 (security): key_id MUST NOT be the raw token; it should be a
    // stable opaque correlator (sha256 prefix). The raw token still flows
    // through `principal.token` for backwards-compat.
    assert.notEqual(result.credential.key_id, 'sk_live_abc');
    assert.match(result.credential.key_id, /^[0-9a-f]+$/);
    assert.equal(result.credential.key_id.length, 32);
    assert.equal(result.token, 'sk_live_abc');
  });

  it('returns the same key_id hash for the same token across calls (stable correlator)', async () => {
    const auth = verifyApiKey({ keys: { stable_tok: { principal: 'a' } } });
    const a = await auth({ headers: { authorization: 'Bearer stable_tok' }, method: 'POST', url: '/mcp' });
    const b = await auth({ headers: { authorization: 'Bearer stable_tok' }, method: 'POST', url: '/mcp' });
    assert.equal(a.credential.key_id, b.credential.key_id);
  });

  it('overwrites an adopter-provided non-api_key credential (H2: forgery clamp)', async () => {
    // Security blocker H2: previously, `verifyApiKey` preserved a
    // `matched.credential` with arbitrary kind, letting an adopter pin
    // `credential: { kind: 'http_sig', agent_url: 'attacker.com' }` to a
    // static key entry and route it through `signingOnly` as if signed.
    // Stage 3 review fix: api-key path ALWAYS stamps `kind: 'api_key'`.
    const forgedCred = { kind: 'http_sig', keyid: 'fake', agent_url: 'attacker.com', verified_at: 0 };
    const auth = verifyApiKey({
      keys: { tok: { principal: 'acct', credential: forgedCred } },
    });
    const result = await auth({ headers: { authorization: 'Bearer tok' }, method: 'POST', url: '/mcp' });
    assert.equal(result.credential.kind, 'api_key', 'matched.credential MUST be overwritten with api_key kind');
    assert.notEqual(result.credential.key_id, 'fake');
  });

  it('dynamic verify path also stamps api_key credential (overwrites verifier output)', async () => {
    const auth = verifyApiKey({
      verify: async token =>
        token === 'tok_dynamic'
          ? {
              principal: 'acct',
              credential: { kind: 'http_sig', keyid: 'forged', agent_url: 'attacker.com', verified_at: 0 },
            }
          : null,
    });
    const result = await auth({
      headers: { authorization: 'Bearer tok_dynamic' },
      method: 'POST',
      url: '/mcp',
    });
    assert.equal(result.credential.kind, 'api_key');
  });
});

describe('Stage 3 — http_sig credential forgery clamp (H1)', () => {
  it('signingOnly rejects a literal-shape http_sig credential without the verifier brand', async () => {
    // Security blocker H1: a custom `authenticate` callback that
    // synthesizes `{ kind: 'http_sig', agent_url: 'attacker.com', ... }`
    // from arbitrary code MUST NOT be routed through `signingOnly` as if
    // verifier-attested. Stage 3 review fix: factories check a module-
    // private brand stamped only by the framework's signature verifier.
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
      token: 'forged',
      clientId: 'attacker',
      scopes: [],
      // Plain literal — no verifier brand. Registry MUST refuse.
      extra: {
        credential: {
          kind: 'http_sig',
          keyid: 'forged-kid',
          agent_url: 'https://attacker.com',
          verified_at: 0,
        },
      },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(invoked, false, 'literal-shape http_sig MUST NOT route through signingOnly');
    assert.equal(result.structuredContent._ctxAgent, undefined);
  });

  it('signingOnly accepts a markVerifiedHttpSig-branded http_sig credential', async () => {
    let invoked = false;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.signingOnly({
        resolveByAgentUrl: async url => {
          invoked = true;
          return sampleAgent({ agent_url: url });
        },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    const branded = markVerifiedHttpSig({
      kind: 'http_sig',
      keyid: 'verified-kid',
      agent_url: 'https://agent.scope3.com',
      verified_at: 1714660000,
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:verified-kid',
      scopes: [],
      extra: { credential: branded },
    });
    assert.notStrictEqual(result.isError, true);
    assert.equal(invoked, true);
    assert.equal(result.structuredContent._ctxAgent.agent_url, 'https://agent.scope3.com');
  });

  it('mixed also rejects literal-shape http_sig (no fall-through to bearer path)', async () => {
    let signedInvoked = false;
    let bearerInvoked = false;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.mixed({
        resolveByAgentUrl: async () => {
          signedInvoked = true;
          return sampleAgent();
        },
        resolveByCredential: async () => {
          bearerInvoked = true;
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
      token: 'forged',
      clientId: 'attacker',
      scopes: [],
      extra: {
        credential: { kind: 'http_sig', keyid: 'forged', agent_url: 'https://attacker.com', verified_at: 0 },
      },
    });
    assert.notStrictEqual(result.isError, true);
    assert.equal(signedInvoked, false);
    assert.equal(bearerInvoked, false, 'unbranded http_sig MUST NOT route to either path');
    assert.equal(result.structuredContent._ctxAgent, undefined);
  });

  it('JSON round-trip strips the brand (defense against serialization replay)', async () => {
    // Documents the security model: brands are non-enumerable and don't
    // survive `JSON.stringify` / `structuredClone`. A relay that
    // serializes the credential and re-presents it loses the brand and
    // the registry refuses the credential.
    const branded = markVerifiedHttpSig({
      kind: 'http_sig',
      keyid: 'kid',
      agent_url: 'https://agent.scope3.com',
      verified_at: 1714660000,
    });
    const replayed = JSON.parse(JSON.stringify(branded));

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
      token: 'sig-tok',
      clientId: 'signing:kid',
      scopes: [],
      extra: { credential: replayed },
    });
    assert.equal(invoked, false, 'serialized-and-replayed http_sig MUST be refused');
    assert.equal(result.structuredContent._ctxAgent, undefined);
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
    const credential = markVerifiedHttpSig({
      kind: 'http_sig',
      keyid: 'scope3-2026-01',
      agent_url: 'https://agent.scope3.com',
      verified_at: 1714660000,
    });
    const result = await dispatchWithAuthInfo(server, {
      token: 'sig-tok',
      clientId: 'signing:scope3-2026-01',
      scopes: [],
      extra: { credential },
    });
    assert.notStrictEqual(result.isError, true, JSON.stringify(result.structuredContent));
    // Compare visible fields (the brand is non-enumerable so deepEqual
    // ignores it; checking visible fields proves the credential round-tripped).
    assert.equal(resolveCredential?.kind, 'http_sig');
    assert.equal(resolveCredential?.agent_url, 'https://agent.scope3.com');
    assert.equal(resolveCredential?.keyid, 'scope3-2026-01');
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
        credential: markVerifiedHttpSig({
          kind: 'http_sig',
          keyid: 'kid',
          agent_url: 'https://agent.scope3.com',
          verified_at: 1714660000,
        }),
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
        credential: markVerifiedHttpSig({
          kind: 'http_sig',
          keyid: 'kid',
          agent_url: 'https://agent.scope3.com',
          verified_at: 1714660000,
        }),
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

  it('registry-derived agent_url is on ctx.agent.agent_url, not on ctx.authInfo (M2)', async () => {
    // Stage 3 review fix M2: framework does NOT stamp a top-level
    // `ctx.authInfo.agent_url` post-resolution. Adopters reading the
    // registry's view get it from `ctx.agent.agent_url`. Verified
    // (`http_sig`-cryptographic) `agent_url` is on `credential.agent_url`.
    let observedAuthInfo;
    const platform = buildPlatform({
      accounts: {
        resolve: async (ref, ctx) => {
          observedAuthInfo = ctx?.authInfo;
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
      sales: {
        getProducts: async (_req, ctx) => ({ products: [], _ctxAgent: ctx?.agent }),
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
        credential: markVerifiedHttpSig({
          kind: 'http_sig',
          keyid: 'kid',
          agent_url: 'https://agent.scope3.com',
          verified_at: 1714660000,
        }),
      },
    });
    assert.equal(result.structuredContent._ctxAgent.agent_url, 'https://agent.scope3.com');
    // Critical: the framework does NOT add a top-level `agent_url` to
    // ctx.authInfo. Verified URL is on credential.agent_url; registry
    // URL is on ctx.agent.agent_url.
    assert.equal('agent_url' in observedAuthInfo, false, 'ctx.authInfo MUST NOT carry a top-level agent_url');
    assert.equal(observedAuthInfo.credential.agent_url, 'https://agent.scope3.com');
  });
});

describe('Stage 4 — extra forwarding: authInfo.extra surfaces to resolveByCredential (issue #1484)', () => {
  it('bearerOnly resolver receives authInfo.extra as second argument', async () => {
    // Simulates the output of `attachAuthInfo` when an adopter stamps
    // `extra: { demo_token }` in their `verifyApiKey.verify` callback.
    // `attachAuthInfo` merges principal.extra into info.extra alongside the
    // credential; the dispatcher propagates info.extra → ctx.authInfo.extra →
    // BuyerAgentResolveInput.extra → resolveByCredential second arg.
    let sawExtra;
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.bearerOnly({
        resolveByCredential: async (cred, extra) => {
          sawExtra = extra;
          return sampleAgent();
        },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await dispatchWithAuthInfo(server, {
      token: 'demo-billing-passthrough-v1',
      clientId: 'demo-caller',
      scopes: [],
      extra: {
        credential: { kind: 'api_key', key_id: 'abc123hash' },
        demo_token: 'demo-billing-passthrough-v1',
      },
    });
    assert.ok(sawExtra !== undefined, 'resolveByCredential must receive a second arg');
    assert.equal(sawExtra.demo_token, 'demo-billing-passthrough-v1');
  });

  it('bearerOnly resolver receives undefined extra when no extra in authInfo', async () => {
    let sawExtra = 'sentinel';
    const platform = buildPlatform({
      agentRegistry: BuyerAgentRegistry.bearerOnly({
        resolveByCredential: async (cred, extra) => {
          sawExtra = extra;
          return sampleAgent();
        },
      }),
    });
    const server = createAdcpServerFromPlatform(platform, {
      name: 'spike',
      version: '0.0.1',
      validation: { requests: 'off', responses: 'off' },
    });
    await dispatchWithAuthInfo(server, {
      token: 'plain-tok',
      clientId: 'caller',
      scopes: [],
      extra: { credential: { kind: 'api_key', key_id: 'abc123hash' } },
    });
    // extra only contains `credential`; no adopter-stamped fields
    assert.ok(typeof sawExtra === 'object' && sawExtra !== null);
    assert.equal('demo_token' in sawExtra, false);
  });

  it('verifyApiKey.verify returning extra preserves it on the AuthPrincipal', async () => {
    const auth = verifyApiKey({
      verify: async token =>
        token === 'demo-billing-passthrough-v1'
          ? { principal: 'static:demo:demo-billing-passthrough-v1', extra: { demo_token: token } }
          : null,
    });
    const result = await auth({
      headers: { authorization: 'Bearer demo-billing-passthrough-v1' },
      method: 'POST',
      url: '/mcp',
    });
    assert.ok(result, 'authenticator must return a principal');
    assert.equal(result.principal, 'static:demo:demo-billing-passthrough-v1');
    assert.deepEqual(result.extra, { demo_token: 'demo-billing-passthrough-v1' });
    // credential is still api_key (forgery clamp preserved)
    assert.equal(result.credential.kind, 'api_key');
  });
});
