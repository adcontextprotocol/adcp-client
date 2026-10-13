/**
 * Experimental AdCP 3.3 Web Bot Auth through createAdcpServer +
 * serve(): profile selection, WBA statuses, identity-established callers,
 * explicit binding with operator re-evaluation, no downgrade, and the
 * registry's unknown-signer hook.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const {
  serve,
  createAdcpServer,
  InMemoryStateStore,
  BuyerAgentRegistry,
} = require('../dist/lib/server/legacy/v5/index.js');
const {
  StaticJwksResolver,
  StaticWebBotAuthKeys,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  OriginBindings,
  TrustRecordEvaluator,
  publicDirectoryKey,
} = require('../dist/lib/signing/server.js');
const { signWebBotAuthRequest } = require('../dist/lib/signing/client.js');
const { signRequest } = require('../dist/lib/signing/signer.js');

process.env.NODE_ENV = 'test';
const ORIGIN = 'https://buyer.platform.com';
const legacyKeys = JSON.parse(
  readFileSync(
    path.join(__dirname, '..', 'compliance', 'cache', 'latest', 'test-vectors', 'request-signing', 'keys.json'),
    'utf8'
  )
).keys;
const legacyRaw = legacyKeys.find(k => k.kid === 'test-ed25519-2026');
const legacyPublic = { ...legacyRaw };
delete legacyPublic._private_d_for_test_only;
const legacyPrivate = { ...legacyRaw, d: legacyRaw._private_d_for_test_only };
delete legacyPrivate._private_d_for_test_only;

const wbaKey = generateKeyPairSync('ed25519').privateKey;
let trustDocument;
let established;
let seen;

function seller({ bindings, revoked = false } = {}) {
  return {
    name: 'WBA Seller',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    agentRegistry: BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async agentUrl => ({
        agent_url: agentUrl,
        display_name: 'Buyer',
        status: 'active',
        billing_capabilities: new Set(['operator']),
      }),
      onIdentityEstablished: identity => established.push(identity),
    }),
    mediaBuy: {
      getProducts: async (_params, ctx) => {
        seen.push({ authInfo: ctx.authInfo, agent: ctx.agent });
        return { products: [] };
      },
    },
    capabilities: {
      features: { inlineCreativeManagement: false },
      request_signing: { supported: true, covers_content_digest: 'required', required_for: [] },
    },
    signedRequests: {
      jwks: new StaticJwksResolver([legacyPublic]),
      agentUrlForKeyid: () => `${ORIGIN}/mcp`,
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      required_for: [],
      webBotAuth: {
        keys: new StaticWebBotAuthKeys({ [ORIGIN]: [publicDirectoryKey(wbaKey)] }),
        revocation: async () => revoked,
        bindings,
        trustRecords: new TrustRecordEvaluator({
          fetch: async () => ({ status: 200, body: JSON.stringify(trustDocument) }),
        }),
      },
    },
  };
}

function start(factory) {
  return new Promise(resolve => {
    const server = serve(factory, { port: 0, onListening: url => resolve({ server, url }) });
  });
}

const tool = (name, args = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

async function post(url, body, { wba = true, legacy = false, mutate } = {}) {
  let headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (wba) {
    headers = signWebBotAuthRequest(
      { method: 'POST', url, headers, body },
      { privateKey: wbaKey },
      { agentOrigin: ORIGIN }
    ).headers;
  } else if (legacy) {
    headers = signRequest(
      { method: 'POST', url, headers, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: legacyPrivate },
      { binaryEncoding: 'rfc8941-base64', coverContentDigest: true }
    ).headers;
  }
  mutate?.(headers);
  return fetch(url, { method: 'POST', headers, body });
}

describe('createAdcpServer signedRequests.webBotAuth', () => {
  let started;
  const bindings = new OriginBindings();
  before(async () => {
    started = await start(() => createAdcpServer(seller({ bindings })));
  });
  after(() => new Promise(resolve => started.server.close(resolve)));
  beforeEach(() => {
    trustDocument = { agents: [{ url: `${ORIGIN}/mcp`, roles: ['adcp:buying'] }] };
    established = [];
    seen = [];
  });

  it('advertises both request-signing profiles', async () => {
    const res = await post(started.url, tool('get_adcp_capabilities'), { wba: false });
    const text = await res.text();
    assert.match(text, /\\"profiles\\":\[\\"adcp\/request-signing\/v1\\",\\"web-bot-auth\\"\]/);
  });

  it('gives an unbound origin the anonymous surface only, and calls the unknown-signer hook', async () => {
    const capabilities = await post(started.url, tool('get_adcp_capabilities'));
    assert.equal(capabilities.status, 200);
    assert.deepEqual(
      established.map(identity => [identity.origin, identity.operation]),
      [[ORIGIN, 'get_adcp_capabilities']]
    );
    const denied = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('accept-signature'), null, 'authorization errors carry no Accept-Signature');
    assert.equal((await denied.json()).errors[0].code, 'PERMISSION_DENIED');
    assert.equal(seen.length, 0, 'the handler never ran');
  });

  it('answers WBA statuses instead of request_signature_* codes', async () => {
    const malformed = await post(started.url, tool('get_adcp_capabilities'), {
      mutate: headers => {
        headers['Signature-Agent'] = 'sig1=(';
      },
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get('www-authenticate'), null);
    const tampered = await post(started.url, tool('get_adcp_capabilities'), {
      mutate: headers => {
        headers['Signature'] = headers['Signature'].replace(/[A-Z]/, c => (c === 'A' ? 'B' : 'A'));
      },
    });
    assert.equal(tampered.status, 403);
    assert.match(tampered.headers.get('accept-signature'), /tag="web-bot-auth"/);
    const body = await tampered.json();
    assert.deepEqual(body, { errors: [{ code: 'AUTH_INVALID', message: 'Request authentication failed' }] });
  });

  it('authenticates a bound origin as its principal while the operator lists it', async () => {
    bindings.bindSync(ORIGIN, 'principal-1');
    const res = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }));
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authInfo.clientId, 'principal-1');
    assert.equal(seen[0].authInfo.credential.kind, 'http_sig');
    assert.equal(seen[0].authInfo.credential.profile, 'web-bot-auth');
    assert.equal(seen[0].authInfo.credential.agent_url, ORIGIN);
    assert.equal(seen[0].authInfo.credential.principal_id, 'principal-1');
    assert.equal(seen[0].agent.agent_url, ORIGIN);
  });

  it('removes authority when the operator delists the origin, without a legacy downgrade', async () => {
    trustDocument = { agents: [] };
    const delisted = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }));
    assert.equal(delisted.status, 403);
    const legacy = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }), {
      wba: false,
      legacy: true,
    });
    assert.equal(legacy.status, 403, 'a bound origin is refused on the RFC 9421 profile');
    assert.equal((await legacy.json()).errors[0].code, 'PERMISSION_DENIED');
    assert.equal(seen.length, 0);
  });
});

describe('createAdcpServer without webBotAuth keeps RFC 9421 behavior', () => {
  let started;
  before(async () => {
    const config = seller();
    delete config.signedRequests.webBotAuth;
    started = await start(() => createAdcpServer(config));
  });
  after(() => new Promise(resolve => started.server.close(resolve)));
  beforeEach(() => {
    seen = [];
  });

  it('rejects a WBA signature with the RFC 9421 tag code and does not advertise the profile', async () => {
    const res = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'request_signature_tag_invalid');
    const caps = await (await post(started.url, tool('get_adcp_capabilities'), { wba: false })).text();
    assert.doesNotMatch(caps, /web-bot-auth/);
  });

  it('still accepts RFC 9421 signatures', async () => {
    const res = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }), {
      wba: false,
      legacy: true,
    });
    assert.equal(res.status, 200);
    assert.equal(seen[0].authInfo.credential.agent_url, `${ORIGIN}/mcp`);
    assert.equal(seen[0].authInfo.credential.profile, undefined);
  });
});

describe('revoked WBA keys', () => {
  let started;
  before(async () => {
    const bindings = new OriginBindings();
    bindings.bindSync(ORIGIN, 'principal-1');
    started = await start(() => createAdcpServer(seller({ bindings, revoked: true })));
  });
  after(() => new Promise(resolve => started.server.close(resolve)));

  it('get an authorization error without Accept-Signature', async () => {
    trustDocument = { agents: [{ url: ORIGIN, roles: ['adcp:buying'] }] };
    const res = await post(started.url, tool('get_adcp_capabilities'));
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('accept-signature'), null);
    assert.equal((await res.json()).errors[0].code, 'PERMISSION_DENIED');
  });
});

describe('identity-established callers on an allowed operation', () => {
  let started;
  before(async () => {
    const config = seller();
    // A legacy mapper keyed by agent URL must never name a WBA principal.
    config.signedRequests.makePrincipal = () => ({ principal: 'legacy-principal' });
    config.signedRequests.webBotAuth.unboundFor = ['get_products'];
    started = await start(() => createAdcpServer(config));
  });
  after(() => new Promise(resolve => started.server.close(resolve)));
  beforeEach(() => {
    seen = [];
    established = [];
  });

  it('reach the handler as the origin with no credential and no agent', async () => {
    const res = await post(started.url, tool('get_products', { buying_mode: 'brief', brief: 'x' }));
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].authInfo.clientId, `web-bot-auth:${ORIGIN}`);
    assert.equal(seen[0].authInfo.credential, undefined);
    assert.equal(seen[0].agent, undefined);
    assert.equal(seen[0].authInfo.extra.signature.profile, 'web-bot-auth');
    assert.deepEqual(
      established.map(identity => identity.operation),
      ['get_products']
    );
  });
});
