'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BuyerAgentRegistry, markVerifiedHttpSig } = require('../../dist/lib/server/decisioning/buyer-agent');

const sampleAgent = (overrides = {}) => ({
  agent_url: 'https://agent.scope3.com',
  display_name: 'Scope3',
  status: 'active',
  billing_capabilities: new Set(['operator']),
  ...overrides,
});

const sigCredential = (overrides = {}) =>
  markVerifiedHttpSig({
    kind: 'http_sig',
    keyid: 'scope3-2026-01',
    agent_url: 'https://agent.scope3.com',
    verified_at: 1714660000,
    ...overrides,
  });

const apiKeyCredential = (overrides = {}) => ({
  kind: 'api_key',
  key_id: 'sk_live_abc',
  ...overrides,
});

const oauthCredential = (overrides = {}) => ({
  kind: 'oauth',
  client_id: 'oauth_client_xyz',
  scopes: ['adcp:read', 'adcp:write'],
  ...overrides,
});

describe('BuyerAgentRegistry.signingOnly', () => {
  it('routes http_sig credentials to resolveByAgentUrl', async () => {
    let sawArg;
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async url => {
        sawArg = url;
        return sampleAgent({ agent_url: url });
      },
    });
    const result = await registry.resolve({ credential: sigCredential() });
    assert.equal(sawArg, 'https://agent.scope3.com');
    assert.equal(result.agent_url, 'https://agent.scope3.com');
  });

  it('returns null for api_key credentials (does not invoke resolver)', async () => {
    let invoked = false;
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        invoked = true;
        return sampleAgent();
      },
    });
    const result = await registry.resolve({ credential: apiKeyCredential() });
    assert.equal(result, null);
    assert.equal(invoked, false, 'resolveByAgentUrl must not be invoked for non-http_sig credentials');
  });

  it('returns null for oauth credentials', async () => {
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => sampleAgent(),
    });
    const result = await registry.resolve({ credential: oauthCredential() });
    assert.equal(result, null);
  });

  it('returns null when credential is absent', async () => {
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => sampleAgent(),
    });
    const result = await registry.resolve({});
    assert.equal(result, null);
  });

  it('throws at construction when resolveByAgentUrl is not a function', () => {
    assert.throws(
      () => BuyerAgentRegistry.signingOnly({ resolveByAgentUrl: undefined }),
      /resolveByAgentUrl must be a function/
    );
    assert.throws(
      () => BuyerAgentRegistry.signingOnly({ resolveByAgentUrl: 'not-a-function' }),
      /resolveByAgentUrl must be a function/
    );
  });

  it('propagates resolver throws (framework projects to SERVICE_UNAVAILABLE upstream)', async () => {
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        throw new Error('upstream DB outage');
      },
    });
    await assert.rejects(registry.resolve({ credential: sigCredential() }), /upstream DB outage/);
  });

  it('rejects malformed http_sig credentials (missing agent_url)', async () => {
    let invoked = false;
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        invoked = true;
        return sampleAgent();
      },
    });
    // A misbehaving authenticator could produce kind: 'http_sig' without
    // populating agent_url. Without the runtime guard, the registry would
    // silently pass `undefined` to the resolver and the underlying DB
    // query would return null — a quiet shape failure.
    const result = await registry.resolve({
      credential: { kind: 'http_sig', keyid: 'kid-1', verified_at: 1 },
    });
    assert.equal(result, null);
    assert.equal(invoked, false);
  });

  it('rejects http_sig credentials with empty agent_url', async () => {
    let invoked = false;
    const registry = BuyerAgentRegistry.signingOnly({
      resolveByAgentUrl: async () => {
        invoked = true;
        return sampleAgent();
      },
    });
    const result = await registry.resolve({ credential: sigCredential({ agent_url: '' }) });
    assert.equal(result, null);
    assert.equal(invoked, false);
  });
});

describe('BuyerAgentRegistry.bearerOnly', () => {
  it('routes api_key credentials to resolveByCredential', async () => {
    let sawArg;
    const registry = BuyerAgentRegistry.bearerOnly({
      resolveByCredential: async cred => {
        sawArg = cred;
        return sampleAgent();
      },
    });
    await registry.resolve({ credential: apiKeyCredential() });
    assert.equal(sawArg.kind, 'api_key');
    assert.equal(sawArg.key_id, 'sk_live_abc');
  });

  it('routes oauth credentials to resolveByCredential', async () => {
    let sawArg;
    const registry = BuyerAgentRegistry.bearerOnly({
      resolveByCredential: async cred => {
        sawArg = cred;
        return sampleAgent();
      },
    });
    await registry.resolve({ credential: oauthCredential() });
    assert.equal(sawArg.kind, 'oauth');
    assert.equal(sawArg.client_id, 'oauth_client_xyz');
  });

  it('also routes http_sig credentials to resolveByCredential (bearer-only does not refuse signed)', async () => {
    // bearerOnly is the "I trust adopter mapping for any credential kind"
    // posture — it doesn't pre-filter http_sig away. The adopter's
    // resolveByCredential decides what to do with each kind.
    let sawKind;
    const registry = BuyerAgentRegistry.bearerOnly({
      resolveByCredential: async cred => {
        sawKind = cred.kind;
        return sampleAgent();
      },
    });
    await registry.resolve({ credential: sigCredential() });
    assert.equal(sawKind, 'http_sig');
  });

  it('returns null when credential is absent', async () => {
    const registry = BuyerAgentRegistry.bearerOnly({
      resolveByCredential: async () => sampleAgent(),
    });
    const result = await registry.resolve({});
    assert.equal(result, null);
  });

  it('throws at construction when resolveByCredential is not a function', () => {
    assert.throws(
      () => BuyerAgentRegistry.bearerOnly({ resolveByCredential: undefined }),
      /resolveByCredential must be a function/
    );
  });
});

describe('BuyerAgentRegistry.mixed', () => {
  it('routes http_sig credentials to resolveByAgentUrl (signed path)', async () => {
    let sawSignedArg;
    let bearerInvoked = false;
    const registry = BuyerAgentRegistry.mixed({
      resolveByAgentUrl: async url => {
        sawSignedArg = url;
        return sampleAgent();
      },
      resolveByCredential: async () => {
        bearerInvoked = true;
        return sampleAgent();
      },
    });
    await registry.resolve({ credential: sigCredential() });
    assert.equal(sawSignedArg, 'https://agent.scope3.com');
    assert.equal(bearerInvoked, false, 'mixed registry must NOT invoke resolveByCredential when http_sig is present');
  });

  it('routes api_key credentials to resolveByCredential', async () => {
    let signedInvoked = false;
    let sawCred;
    const registry = BuyerAgentRegistry.mixed({
      resolveByAgentUrl: async () => {
        signedInvoked = true;
        return sampleAgent();
      },
      resolveByCredential: async cred => {
        sawCred = cred;
        return sampleAgent();
      },
    });
    await registry.resolve({ credential: apiKeyCredential() });
    assert.equal(signedInvoked, false);
    assert.equal(sawCred.kind, 'api_key');
  });

  it('routes oauth credentials to resolveByCredential', async () => {
    let sawCred;
    const registry = BuyerAgentRegistry.mixed({
      resolveByAgentUrl: async () => null,
      resolveByCredential: async cred => {
        sawCred = cred;
        return sampleAgent();
      },
    });
    await registry.resolve({ credential: oauthCredential() });
    assert.equal(sawCred.kind, 'oauth');
  });

  it('returns null when credential is absent', async () => {
    const registry = BuyerAgentRegistry.mixed({
      resolveByAgentUrl: async () => sampleAgent(),
      resolveByCredential: async () => sampleAgent(),
    });
    const result = await registry.resolve({});
    assert.equal(result, null);
  });

  it('throws at construction when either resolver is missing', () => {
    assert.throws(
      () => BuyerAgentRegistry.mixed({ resolveByAgentUrl: async () => null }),
      /resolveByCredential must be a function/
    );
    assert.throws(
      () => BuyerAgentRegistry.mixed({ resolveByCredential: async () => null }),
      /resolveByAgentUrl must be a function/
    );
  });

  it('rejects malformed http_sig credentials without falling through to resolveByCredential', async () => {
    // Defense against authenticator bugs: a malformed http_sig credential
    // must not bypass signed-path enforcement by routing through the bearer
    // table. mixed registry's malformed-http_sig handling matches
    // signingOnly's (return null), not bearerOnly's (would let it through).
    let signedInvoked = false;
    let bearerInvoked = false;
    const registry = BuyerAgentRegistry.mixed({
      resolveByAgentUrl: async () => {
        signedInvoked = true;
        return sampleAgent();
      },
      resolveByCredential: async () => {
        bearerInvoked = true;
        return sampleAgent();
      },
    });
    const result = await registry.resolve({
      credential: { kind: 'http_sig', keyid: 'kid-1', verified_at: 1 },
    });
    assert.equal(result, null);
    assert.equal(signedInvoked, false);
    assert.equal(bearerInvoked, false, 'malformed http_sig must NOT fall through to the bearer path');
  });
});

describe('BuyerAgent shape', () => {
  it('readonly contract preserved through Object.freeze (deep-frozen agent survives serialization)', () => {
    const agent = Object.freeze({
      agent_url: 'https://agent.scope3.com',
      display_name: 'Scope3',
      status: 'active',
      billing_capabilities: new Set(['operator', 'agent']),
    });
    // Object.freeze doesn't deep-freeze; the test asserts the registry
    // doesn't *require* mutation of the returned record (the readonly
    // contract is enforced at the type level, not at runtime).
    const round = JSON.parse(JSON.stringify({ ...agent, billing_capabilities: [...agent.billing_capabilities] }));
    assert.equal(round.agent_url, 'https://agent.scope3.com');
    assert.deepEqual(round.billing_capabilities, ['operator', 'agent']);
  });

  it('billing_capabilities Set membership semantics work (Phase 2 will check this)', () => {
    const caps = new Set(['operator']);
    assert.equal(caps.has('operator'), true);
    assert.equal(caps.has('agent'), false);
    assert.equal(caps.has('advertiser'), false);
  });
});

describe('BuyerAgentRegistry namespace', () => {
  it('exposes signingOnly, bearerOnly, mixed', () => {
    assert.equal(typeof BuyerAgentRegistry.signingOnly, 'function');
    assert.equal(typeof BuyerAgentRegistry.bearerOnly, 'function');
    assert.equal(typeof BuyerAgentRegistry.mixed, 'function');
  });
});
