/** Regression coverage for the shared AdCP 3.3 agent-resolution trust chain. */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { generateKeyPairSync } = require('node:crypto');
const {
  resolveAgent,
  ResolvedAgentJwksResolver,
  BrandJsonJwksResolver,
  BrandJsonResolverError,
  AgentResolverError,
  createWebhookVerifier,
  StaticJwksResolver,
  verifyRequestSignature,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  createAgentJwksSet,
} = require('../dist/lib/signing/server.js');
const { selectAgentByUrl } = require('../dist/lib/signing/agent-resolver/select-agent.js');
const { signRequest } = require('../dist/lib/signing/signer.js');
const { createGovernanceAgentJwksResolver } = require('../dist/lib/governance/authorization.js');

process.env.NODE_ENV = 'test';
const keys = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/webhook-signing-vectors/keys.json'), 'utf8'));
const vector = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/webhook-signing-vectors/positive/001-basic-post.json'), 'utf8')
);
const fixtureKey = keys.keys.find(key => key.kid === vector.jwks_ref[0]);
const { _private_d_for_test_only, ...publicKey } = fixtureKey;
const wrongKey = { ...generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }), kid: publicKey.kid };

let server, origin, routes, hits;
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(route.status ?? 200, { 'content-type': 'application/json', ...route.headers });
    res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  routes = {};
  hits = [];
});
function stage(agent = `${origin}/mcp`, entries) {
  routes['/operator.json'] = {
    body: { agents: entries ?? [{ type: 'sales', id: 'seller', url: agent, jwks_uri: `${origin}/keys.json` }] },
    headers: { 'cache-control': 'max-age=60' },
  };
  routes['/keys.json'] = { body: { keys: [publicKey] }, headers: { 'cache-control': 'max-age=120' } };
  return {
    allowPrivateIp: true,
    fetchCapabilities: async () => ({
      identity: { brand_json_url: `${origin}/operator.json`, key_origins: { webhook_signing: origin } },
      webhook_signing: { supported: true },
    }),
  };
}
function pin(signingKeys, refreshed = signingKeys) {
  let refreshes = 0;
  return {
    publisher: 'publisher.example',
    signingKeys,
    refresh: async () => {
      refreshes++;
      return refreshed;
    },
    get refreshes() {
      return refreshes;
    },
  };
}
function verifier(jwks, pins, extras = {}) {
  return createWebhookVerifier({ jwks, publisherPins: pins, now: () => vector.reference_now, ...extras });
}
const unknown = error => error.code === 'webhook_signature_key_unknown';

describe('canonical agent selection', () => {
  it('normalizes host/scheme case, port, dot segments and unreserved escapes', () => {
    const entry = { type: 'sales', url: 'HTTPS://Seller.Example:443/a/../m%63p#fragment' };
    assert.equal(selectAgentByUrl({ agents: [entry] }, 'https://seller.example/mcp'), entry);
  });
  it('strips userinfo and root dots and normalizes query escapes without re-encoding', () => {
    const entry = { url: "https://user:password@Seller.Example.:443/mcp?x=%7e%2f'" };
    assert.equal(selectAgentByUrl({ agents: [entry] }, "https://seller.example/mcp?x=~%2F'"), entry);
  });
  it('rejects malformed authorities and non-normalized IDN hosts', () => {
    for (const url of ['https:///seller.example/mcp', 'https://seller.example../mcp', 'https://bücher.example/mcp']) {
      assert.throws(() => selectAgentByUrl({ agents: [{ url }] }, url));
    }
  });
  it('keeps slash, path and query distinctions', () => {
    for (const url of [
      'https://seller.example/mcp/',
      'https://seller.example//mcp',
      'http://seller.example/mcp',
      'https://seller.example/mcp?',
      'https://seller.example/mcp?a=2&b=1',
    ]) {
      assert.throws(
        () => selectAgentByUrl({ agents: [{ url }] }, 'https://seller.example/mcp'),
        error => error.code === 'agent_not_in_brand_json'
      );
    }
  });
  it('rejects duplicate entries whose URLs differ only in case/default port', () => {
    assert.throws(
      () =>
        selectAgentByUrl(
          {
            agents: [
              { type: 'sales', url: 'https://Seller.Example:443/mcp' },
              { type: 'sales', url: 'https://seller.example/mcp' },
            ],
          },
          'https://seller.example/mcp'
        ),
      error => error.code === 'brand_json_ambiguous'
    );
  });
  it('deduplicates shared portfolio agents only when type and JWKS agree', () => {
    const shared = { type: 'sales', url: 'https://seller.example/mcp', jwks_uri: 'https://keys.example/jwks' };
    const record = {
      house: { agents: [shared] },
      brands: [
        { agents: [{ ...shared, url: 'https://SELLER.example:443/mcp', jwks_uri: 'https://KEYS.example:443/jwks' }] },
      ],
    };
    assert.equal(selectAgentByUrl(record, shared.url), shared);
    record.brands[0].agents[0].jwks_uri = 'https://keys.example/other';
    assert.throws(
      () => selectAgentByUrl(record, shared.url),
      error => error.code === 'brand_json_ambiguous'
    );
    record.brands[0].agents[0] = { ...shared, type: 'governance' };
    assert.throws(
      () => selectAgentByUrl(record, shared.url),
      error => error.code === 'brand_json_ambiguous'
    );
  });
  it('counts an implicit and an explicit default JWKS as the same source', () => {
    const shared = { type: 'sales', url: 'https://seller.example/mcp' };
    assert.equal(
      selectAgentByUrl(
        {
          house: { agents: [shared] },
          brands: [{ agents: [{ ...shared, jwks_uri: 'https://seller.example/.well-known/jwks.json' }] }],
        },
        shared.url
      ),
      shared
    );
  });
  it('never substitutes type/id for URL matching', () => {
    assert.throws(() =>
      selectAgentByUrl(
        { agents: [{ type: 'sales', id: 'seller', url: 'https://other.example/mcp' }] },
        'https://seller.example/mcp',
        { agentType: 'sales', agentId: 'seller' }
      )
    );
  });
});

describe('capability-bound discovery and cache freshness', () => {
  it('infers one legacy onboarding URL and confirms it before accepting any key', async () => {
    const options = stage();
    const resolver = new BrandJsonJwksResolver(`${origin}/operator.json`, {
      ...options,
      agentType: 'sales',
      agentId: 'seller',
    });
    const [first, second] = await Promise.all([
      resolver.resolve(publicKey.kid),
      resolver.resolveWithMetadata(publicKey.kid),
    ]);
    assert.equal(first.kid, publicKey.kid);
    assert.equal(second.agentUrl, `${origin}/mcp`);
    assert.deepEqual(second.operatorRecord.document, routes['/operator.json'].body);
    assert.equal(
      hits.filter(url => url === '/operator.json').length,
      2,
      'one coalesced bootstrap plus confirmed discovery'
    );
  });
  it('retains the legacy brandId onboarding scope without limiting canonical verification', async () => {
    const agent = `${origin}/brand-seller`;
    const options = stage(agent);
    const child = routes['/operator.json'].body.agents[0];
    routes['/operator.json'].body = {
      house: { agents: [{ ...child, url: `${origin}/house-seller` }] },
      brands: [{ id: 'brand-a', agents: [child] }],
    };
    const resolver = new BrandJsonJwksResolver(`${origin}/operator.json`, {
      ...options,
      agentType: 'sales',
      brandId: 'brand-a',
    });
    assert.equal((await resolver.resolve(publicKey.kid)).kid, publicKey.kid);
    assert.equal(resolver.agentUrl, agent);
  });
  it('keeps an inferred identity pinned when the onboarding record changes later', async () => {
    let now = 1000;
    const options = stage();
    const resolver = new BrandJsonJwksResolver(`${origin}/operator.json`, {
      ...options,
      agentType: 'sales',
      now: () => now,
    });
    await resolver.resolve(publicKey.kid);
    routes['/operator.json'].body.agents[0].url = `${origin}/replacement-seller`;
    now += 60;
    await assert.rejects(
      () => resolver.resolve(publicKey.kid),
      error => error.code === 'request_signature_agent_not_in_brand_json'
    );
    assert.equal(resolver.agentUrl, `${origin}/mcp`);
  });
  it('refuses ambiguous onboarding and mappings not confirmed by the inferred agent', async () => {
    const options = stage();
    const other = { ...routes['/operator.json'].body.agents[0], url: `${origin}/other-seller` };
    routes['/operator.json'].body.agents.push(other);
    await assert.rejects(
      () =>
        new BrandJsonJwksResolver(`${origin}/operator.json`, {
          ...options,
          agentType: 'sales',
        }).resolve(publicKey.kid),
      error => error.code === 'agent_ambiguous'
    );
    routes['/operator.json'].body.agents.pop();
    options.fetchCapabilities = async () => ({
      identity: { brand_json_url: `${origin}/different-operator.json`, key_origins: { webhook_signing: origin } },
      webhook_signing: { supported: true },
    });
    await assert.rejects(
      () =>
        new BrandJsonJwksResolver(`${origin}/operator.json`, {
          ...options,
          agentType: 'sales',
        }).resolve(publicKey.kid),
      error => error.code === 'request_signature_brand_origin_mismatch'
    );
    assert.ok(!hits.includes('/keys.json'));
  });
  it('returns the exact operator record and canonical identity', async () => {
    const agent = `${origin}/mcp`;
    const options = stage(agent);
    routes['/operator.json'].body.agents[0].url = `${origin}/a/../m%63p`;
    const result = await resolveAgent(agent, options);
    assert.equal(result.agentUrl, agent);
    assert.deepEqual(result.brandJson, routes['/operator.json'].body);
    assert.equal(result.brandJsonCacheControl, 'max-age=60');
  });
  it('rejects an invalid explicit JWKS source instead of falling back', async () => {
    const options = stage();
    routes['/operator.json'].body.agents[0].jwks_uri = '';
    await assert.rejects(() => resolveAgent(`${origin}/mcp`, options));
    assert.deepEqual(hits, ['/operator.json']);
  });
  it('accepts cross-origin binding only from a portfolio and ignores account scopes', async () => {
    const agent = 'https://seller.example/mcp';
    const options = stage(agent);
    const record = routes['/operator.json'].body;
    record.authorized_operators = [
      { domain: 'seller.example', brands: ['other'], countries: ['NZ'], scopes: ['measurement'] },
    ];
    await assert.rejects(
      () => resolveAgent(agent, options),
      error => error.code === 'request_signature_brand_origin_mismatch'
    );
    record.house = { domain: 'holding.example', agents: record.agents };
    record.brands = [];
    delete record.agents;
    assert.equal((await resolveAgent(agent, options)).agentUrl, agent);
    record.authorized_operators[0].domain = 'sub.seller.example';
    await assert.rejects(
      () => resolveAgent(agent, options),
      error => error.code === 'request_signature_brand_origin_mismatch'
    );
  });
  it('re-confirms a cached mapping at the brand.json lifetime and fails closed on a change', async () => {
    let now = 1000,
      caps = 0;
    const options = stage();
    const original = options.fetchCapabilities;
    options.fetchCapabilities = async () => {
      caps++;
      return original();
    };
    const resolver = new BrandJsonJwksResolver(`${origin}/operator.json`, {
      ...options,
      agentUrl: `${origin}/mcp`,
      agentType: 'sales',
      now: () => now,
      maxAgeSeconds: 600,
    });
    await resolver.resolve(publicKey.kid);
    now += 59;
    await resolver.resolve(publicKey.kid);
    assert.equal(caps, 1);
    now++;
    routes['/operator.json'].body.agents = [];
    await assert.rejects(
      () => resolver.resolve(publicKey.kid),
      error => error.code === 'request_signature_agent_not_in_brand_json'
    );
    assert.equal(caps, 2);
  });
  it('bounds polling for short operator lifetimes without interrupting valid cached verification', async () => {
    let now = 1000,
      confirmations = 0;
    const options = stage();
    routes['/operator.json'].headers['cache-control'] = 'max-age=10';
    const original = options.fetchCapabilities;
    const resolver = new ResolvedAgentJwksResolver(`${origin}/mcp`, 'mcp', {
      ...options,
      now: () => now,
      cacheTtlSeconds: 300,
      fetchCapabilities: async () => {
        confirmations++;
        return original();
      },
    });
    await resolver.resolve(publicKey.kid);
    now += 11;
    for (let i = 0; i < 5; i++) assert.equal((await resolver.resolve(publicKey.kid)).kid, publicKey.kid);
    assert.equal(confirmations, 1);
    now += 20;
    await resolver.resolve(publicKey.kid);
    assert.equal(confirmations, 2);
  });
  it('uses a bounded polling interval for no-store operator records', async () => {
    let now = 1000;
    const options = stage();
    routes['/operator.json'].headers['cache-control'] = 'no-store';
    const resolver = new ResolvedAgentJwksResolver(`${origin}/mcp`, 'mcp', { ...options, now: () => now });
    await resolver.resolve(publicKey.kid);
    assert.equal((await resolver.resolve(publicKey.kid)).kid, publicKey.kid);
    assert.equal(hits.filter(url => url === '/operator.json').length, 1);
    now += 31;
    await resolver.resolve(publicKey.kid);
    assert.equal(hits.filter(url => url === '/operator.json').length, 2);
  });
  it('refuses onboarding mappings that disagree with capabilities before fetching them', async () => {
    const options = stage();
    const resolver = new BrandJsonJwksResolver(`${origin}/untrusted.json`, {
      ...options,
      agentUrl: `${origin}/mcp`,
      agentType: 'sales',
    });
    await assert.rejects(
      () => resolver.resolve(publicKey.kid),
      error => error.code === 'request_signature_brand_origin_mismatch'
    );
    assert.deepEqual(hits, []);
  });
  it('rejects duplicate JWKS kids', async () => {
    const options = stage();
    routes['/keys.json'].body.keys.push(wrongKey);
    const resolver = new ResolvedAgentJwksResolver(`${origin}/mcp`, 'mcp', options);
    await assert.rejects(
      () => resolver.resolve(publicKey.kid),
      error => error.code === 'request_signature_key_unknown'
    );
  });
  it('refuses duplicate JSON properties in operator records', async () => {
    const options = stage();
    routes['/operator.json'].body = '{"agents":[],"agents":[]}';
    await assert.rejects(
      () => resolveAgent(`${origin}/mcp`, options),
      error => error.code === 'request_signature_brand_json_malformed'
    );
  });
});

describe('3.x webhook legacy discovery', () => {
  it('preserves standalone legacy webhook discovery by default and allows opting out', async () => {
    stage();
    routes['/.well-known/brand.json'] = routes['/operator.json'];
    const options = {
      agentType: 'sales',
      allowPrivateIp: true,
      fetchCapabilities: async () => ({ webhook_signing: { supported: true } }),
    };
    const url = `${origin}/.well-known/brand.json`;
    const result = await new BrandJsonJwksResolver(url, options).resolveWithMetadata(publicKey.kid);
    assert.equal(result.jwk.kid, publicKey.kid);
    assert.equal(result.legacyWebhookFallback, true);
    await assert.rejects(
      () => new BrandJsonJwksResolver(url, { ...options, legacyWebhookFallback: false }).resolve(publicKey.kid),
      error => error.code === 'request_signature_brand_json_url_missing'
    );
  });
  it('uses the agent-host record when the capability field is absent', async () => {
    stage();
    routes['/.well-known/brand.json'] = routes['/operator.json'];
    const result = await resolveAgent(`${origin}/mcp`, {
      allowPrivateIp: true,
      legacyWebhookFallback: true,
      fetchCapabilities: async () => ({ webhook_signing: { supported: true } }),
    });
    assert.equal(result.brandJsonUrl, `${origin}/.well-known/brand.json`);
    assert.equal(result.jwksUri, `${origin}/keys.json`);
  });
  it('never enables the legacy exception for advertised 4.x agents', async () => {
    stage();
    routes['/.well-known/brand.json'] = routes['/operator.json'];
    for (const capabilities of [
      { adcp_version: '4.0.0' },
      { adcp: { supported_versions: ['4.0.0'] } },
      { adcp: { major_versions: [4] } },
      { adcp_version: '3.3.0', adcp: { supported_versions: ['3.3.0', '4.0.0'] } },
      { adcp_version: '3.3.0', adcp: { major_versions: [3, 4] } },
      { adcp: { supported_versions: ['3.3.0', '4.0.0'] } },
      { adcp: { major_versions: [3, 4] } },
    ]) {
      await assert.rejects(
        () =>
          resolveAgent(`${origin}/mcp`, {
            allowPrivateIp: true,
            legacyWebhookFallback: true,
            fetchCapabilities: async () => capabilities,
          }),
        error => error.code === 'request_signature_brand_json_url_missing'
      );
    }
    assert.deepEqual(hits, []);
  });
  it('follows at most one document indirection', async () => {
    stage();
    routes['/.well-known/brand.json'] = { body: { authoritative_location: `${origin}/operator.json` } };
    const options = { allowPrivateIp: true, legacyWebhookFallback: true, fetchCapabilities: async () => ({}) };
    assert.equal((await resolveAgent(`${origin}/mcp`, options)).brandJsonUrl, `${origin}/operator.json`);
    routes['/operator.json'].body = { authoritative_location: `${origin}/third.json` };
    await assert.rejects(() => resolveAgent(`${origin}/mcp`, options));
    assert.ok(!hits.includes('/third.json'));
  });
  it('never falls back from a present invalid or unreachable brand_json_url', async () => {
    stage();
    routes['/.well-known/brand.json'] = routes['/operator.json'];
    for (const field of [null, '', 'ftp://bad.example/brand.json', `${origin}/missing.json`]) {
      await assert.rejects(() =>
        resolveAgent(`${origin}/mcp`, {
          allowPrivateIp: true,
          legacyWebhookFallback: true,
          fetchCapabilities: async () => ({ identity: { brand_json_url: field } }),
        })
      );
    }
    assert.ok(!hits.includes('/.well-known/brand.json'));
  });
  it('rejects redirects from explicit capability URLs', async () => {
    const options = stage();
    routes['/operator.json'] = { status: 302, headers: { location: `${origin}/other.json` } };
    await assert.rejects(() => resolveAgent(`${origin}/mcp`, options));
    assert.ok(!hits.includes('/other.json'));
  });
});

describe('JWT discovery failure cooldown', () => {
  it('throttles sequential cold-cache failures without extending the negative cache beyond 60 seconds', async () => {
    let now = 1000,
      attempts = 0;
    const getKey = createAgentJwksSet(`${origin}/mcp`, {
      allowPrivateIp: true,
      allowedAlgs: ['EdDSA'],
      kidMissCooldownSeconds: 120,
      now: () => now,
      fetchCapabilities: async () => {
        attempts++;
        throw new Error('offline');
      },
    });
    const lookup = () => getKey({ kid: publicKey.kid, alg: 'EdDSA' }, {});
    await assert.rejects(lookup);
    await assert.rejects(lookup);
    assert.equal(attempts, 1);
    now += 60;
    await assert.rejects(lookup);
    assert.equal(attempts, 2);
  });
});

describe('webhook publisher pins', () => {
  it('accepts full public parameters even when the pin kid differs', async () => {
    const publisher = pin([{ ...publicKey, kid: 'publisher-local-alias' }]);
    assert.equal((await verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request)).status, 'verified');
    assert.equal(publisher.refreshes, 0);
  });
  it('rejects a pinned key absent from the agent JWKS', async () => {
    const options = stage();
    routes['/keys.json'].body.keys = [];
    const resolver = new ResolvedAgentJwksResolver(`${origin}/mcp`, 'mcp', options);
    await assert.rejects(() => verifier(resolver, [pin([publicKey])])(vector.request), unknown);
  });
  it('rejects kid-only, mismatching-material, empty, and revoked pins after refreshing', async () => {
    for (const signingKeys of [
      [{ kid: publicKey.kid }],
      [wrongKey],
      [],
      [{ ...publicKey, revoked_at: new Date((vector.reference_now - 1) * 1000).toISOString() }],
      [publicKey, { ...publicKey, kid: 'alias', revoked_at: new Date(vector.reference_now * 1000).toISOString() }],
      [publicKey, { ...publicKey, revoked_at: 'invalid' }],
    ]) {
      const publisher = pin(signingKeys);
      await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request), unknown);
      assert.equal(publisher.refreshes, 1);
    }
  });
  it('accepts a legitimately rotated key after force-refreshing adagents.json', async () => {
    const publisher = pin([wrongKey], [publicKey]);
    assert.equal((await verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request)).status, 'verified');
    assert.equal(publisher.refreshes, 1);
  });
  it('coalesces publisher refreshes and bounds retries of captured rejected deliveries', async () => {
    let now = vector.reference_now;
    const publisher = pin([wrongKey]);
    const verify = verifier(new StaticJwksResolver([publicKey]), [publisher], { now: () => now });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => verify(vector.request)));
    assert.ok(results.every(result => result.status === 'rejected' && unknown(result.reason)));
    assert.equal(publisher.refreshes, 1);
    now += 29;
    await assert.rejects(() => verify(vector.request), unknown);
    assert.equal(publisher.refreshes, 1);
    now += 1;
    await assert.rejects(() => verify(vector.request), unknown);
    assert.equal(publisher.refreshes, 2);
  });
  it('requires every applicable publisher pin and fails closed on refresh failure', async () => {
    const first = pin([publicKey]),
      second = pin([wrongKey]);
    await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [first, second])(vector.request), unknown);
    second.refresh = async () => {
      throw new Error('offline');
    };
    await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [first, second])(vector.request), unknown);
  });
  it('never lets a recent refresh override newer caller-supplied pin revocations', async () => {
    const publisher = pin([wrongKey], [publicKey]);
    assert.equal((await verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request)).status, 'verified');
    publisher.signingKeys = [{ ...publicKey, revoked_at: new Date(vector.reference_now * 1000).toISOString() }];
    await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request), unknown);
    assert.equal(publisher.refreshes, 1);
  });
  it('rechecks caller pin updates made during an asynchronous publisher refresh', async () => {
    const publisher = pin([wrongKey]);
    publisher.refresh = async () => {
      publisher.signingKeys = [{ ...publicKey, revoked_at: new Date(vector.reference_now * 1000).toISOString() }];
      return [publicKey];
    };
    await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request), unknown);
  });
  it('never shares an in-flight refresh with a newly restrictive caller pin', async () => {
    let release, began;
    const started = new Promise(resolve => {
      began = resolve;
    });
    const pending = new Promise(resolve => {
      release = resolve;
    });
    const publisher = pin([wrongKey]);
    publisher.refresh = async () => {
      began();
      return pending;
    };
    const first = verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request);
    await started;
    try {
      const updated = { ...publisher, signingKeys: [] };
      await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [updated])(vector.request), unknown);
    } finally {
      release(null);
    }
    assert.equal((await first).status, 'verified');
  });
  it('still enforces key_origins for pinned keys, logging the specific discovery cause', async () => {
    const options = stage();
    options.fetchCapabilities = async () => ({
      identity: {
        brand_json_url: `${origin}/operator.json`,
        key_origins: { webhook_signing: 'https://other.example' },
      },
      webhook_signing: { supported: true },
    });
    let cause;
    const resolver = new ResolvedAgentJwksResolver(`${origin}/mcp`, 'mcp', options);
    await assert.rejects(
      () =>
        verifier(resolver, [pin([publicKey])], {
          onKeyResolutionError: error => {
            cause = error;
          },
        })(vector.request),
      unknown
    );
    assert.equal(cause.code, 'request_signature_key_origin_mismatch');
  });
  it('checks every publisher again when another publisher refresh crosses revoked_at', async () => {
    let now = vector.reference_now;
    const first = pin([{ ...publicKey, revoked_at: new Date((now + 1) * 1000).toISOString() }]);
    const second = pin([wrongKey]);
    second.refresh = async () => {
      now += 2;
      return [publicKey];
    };
    await assert.rejects(
      () => verifier(new StaticJwksResolver([publicKey]), [first, second], { now: () => now })(vector.request),
      unknown
    );
  });
  it('fails closed if a pin refresh accidentally returns undefined', async () => {
    const publisher = pin([wrongKey]);
    publisher.refresh = async () => undefined;
    await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [publisher])(vector.request), unknown);
  });
  it('never refreshes publisher documents for a forged signature', async () => {
    const publisher = pin([wrongKey]);
    const request = { ...vector.request, body: 'tampered body' };
    await assert.rejects(() => verifier(new StaticJwksResolver([publicKey]), [publisher])(request));
    assert.equal(publisher.refreshes, 0);
  });
  it('attributes a verified webhook to its canonically matched agent', async () => {
    const options = stage();
    const resolver = new ResolvedAgentJwksResolver(`${origin}/mcp`, 'mcp', options);
    assert.equal((await verifier(resolver, [pin([publicKey])])(vector.request)).agent_url, `${origin}/mcp`);
  });
});

describe('governance relying-party collection', () => {
  const issuer = 'https://governance.example/mcp';
  const entry = { type: 'governance', url: issuer, jwks_uri: 'https://keys.example/brand-a' };
  function buyer(record, domain = 'a.example') {
    const seen = [];
    return {
      brandJson: record,
      brandDomain: domain,
      seen,
      jwksForUri: uri => {
        seen.push(uri);
        return new StaticJwksResolver([publicKey]);
      },
    };
  }
  it('uses the governed brand override and never a sibling brand', async () => {
    const record = {
      house: { domain: 'house.example', agents: [entry] },
      brands: [
        { url: 'https://a.example', agents: [] },
        { url: 'https://b.example', agents: [entry] },
      ],
    };
    const context = buyer(record);
    assert.throws(() => createGovernanceAgentJwksResolver(issuer, context));
    assert.deepEqual(context.seen, []);
    record.brands[0].agents = [{ ...entry, url: 'https://GOVERNANCE.example:443/mcp' }];
    await createGovernanceAgentJwksResolver(issuer, context).resolve(publicKey.kid);
    assert.deepEqual(context.seen, [entry.jwks_uri]);
  });
  it('uses the house collection for its domain and when a matching brand has no override', () => {
    const record = { house: { domain: 'house.example', agents: [entry] }, brands: [{ url: 'https://a.example' }] };
    for (const domain of ['house.example', 'a.example']) {
      const context = buyer(record, domain);
      createGovernanceAgentJwksResolver(issuer, context);
      assert.deepEqual(context.seen, [entry.jwks_uri]);
    }
  });
  it('rejects ambiguous brand domains and duplicate canonical governance URLs', () => {
    const record = {
      house: { domain: 'house.example' },
      brands: [
        { url: 'https://a.example', agents: [entry] },
        { url: 'https://a.example/other', agents: [entry] },
      ],
    };
    assert.throws(() => createGovernanceAgentJwksResolver(issuer, buyer(record)));
    assert.throws(() =>
      createGovernanceAgentJwksResolver(
        issuer,
        buyer({ agents: [entry, { ...entry, url: 'https://GOVERNANCE.example:443/mcp' }] })
      )
    );
  });
});

describe('governance default JWKS freshness and retry limits', () => {
  function resolver(options) {
    const issuer = `${origin}/governance`;
    return createGovernanceAgentJwksResolver(issuer, {
      brandJson: { agents: [{ type: 'governance', url: issuer, jwks_uri: `${origin}/keys.json` }] },
      brandDomain: 'buyer.example',
      jwksOptions: { allowPrivateIp: true, ...options },
    });
  }
  it('throttles sequential cold failures even with a configured zero cooldown', async () => {
    let clock = 1000;
    const jwks = resolver({ now: () => clock, minCooldownSeconds: 0 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(() => jwks.resolve(publicKey.kid));
    }
    assert.equal(hits.length, 1);
    clock += 29;
    await assert.rejects(() => jwks.resolve(publicKey.kid));
    assert.equal(hits.length, 1);
    clock++;
    await assert.rejects(() => jwks.resolve(publicKey.kid));
    assert.equal(hits.length, 2);
  });
  it('throttles failed unknown-key refreshes from their last attempt', async () => {
    let clock = 1000;
    stage();
    const jwks = resolver({ now: () => clock, minCooldownSeconds: 0 });
    await jwks.resolve(publicKey.kid);
    clock += 30;
    delete routes['/keys.json'];
    await assert.rejects(() => jwks.resolve('rotated'));
    assert.equal(await jwks.resolve('rotated-again'), null);
    clock += 29;
    assert.equal(await jwks.resolve('another-miss'), null);
    assert.equal(hits.length, 2);
    clock++;
    await assert.rejects(() => jwks.resolve('rotated'));
    assert.equal(hits.length, 3);
  });
  it('refreshes at the exact expiry boundary and refuses a removed key', async () => {
    let clock = 1000;
    stage();
    routes['/keys.json'].headers['cache-control'] = 'max-age=0';
    const jwks = resolver({ now: () => clock });
    assert.equal((await jwks.resolve(publicKey.kid)).kid, publicKey.kid);
    routes['/keys.json'].body.keys = [];
    clock += 59;
    assert.equal((await jwks.resolve(publicKey.kid)).kid, publicKey.kid);
    assert.equal(hits.length, 1);
    clock++;
    assert.equal(await jwks.resolve(publicKey.kid), null);
    assert.equal(hits.length, 2);
  });
  it('never serves expired keys during failed-refresh cooldowns', async () => {
    let clock = 1000;
    stage();
    const jwks = resolver({ now: () => clock, maxAgeSeconds: 60 });
    await jwks.resolve(publicKey.kid);
    delete routes['/keys.json'];
    clock += 60;
    await assert.rejects(() => jwks.resolve(publicKey.kid));
    await assert.rejects(() => jwks.resolve(publicKey.kid), /expired/);
    assert.equal(hits.length, 2);
  });
  it('rejects invalid cache and cooldown options before network access', () => {
    for (const maxAgeSeconds of [NaN, Infinity, -1, 0]) {
      assert.throws(() => resolver({ maxAgeSeconds }), TypeError);
    }
    for (const minCooldownSeconds of [NaN, Infinity, -1]) {
      assert.throws(() => resolver({ minCooldownSeconds }), TypeError);
    }
    assert.equal(hits.length, 0);
  });
});

describe('webhook discovery retry classification', () => {
  it('distinguishes permanent onboarding errors from transient fetch failures', async () => {
    for (const code of ['agent_ambiguous', 'agent_not_found', 'invalid_house', 'fetch_failed']) {
      const jwks = {
        resolve: async () => {
          throw new BrandJsonResolverError(code, 'Discovery failed');
        },
      };
      await assert.rejects(
        () => verifier(jwks, [])(vector.request),
        error => unknown(error) && error.retryable === (code === 'fetch_failed')
      );
    }
  });
});

describe('signed buyer identity metadata', () => {
  function signedRequest() {
    const key = { ...publicKey, adcp_use: 'request-signing' };
    const request = {
      method: 'POST',
      url: 'https://seller.example/mcp',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    };
    const signature = signRequest(
      request,
      { keyid: key.kid, alg: 'ed25519', privateKey: { ...key, d: _private_d_for_test_only, key_ops: ['sign'] } },
      { now: () => vector.reference_now, coverContentDigest: true }
    );
    request.headers = signature.headers;
    return { key, request };
  }
  it('returns the exact selected operator record after verifying the signature', async () => {
    const { key, request } = signedRequest();
    const operatorRecord = { url: 'https://buyer.example/custom/operator.json', document: { agents: [] } };
    const result = await verifyRequestSignature(request, {
      capability: { supported: true, required_for: [], covers_content_digest: 'required' },
      jwks: {
        resolve: async () => key,
        resolveWithMetadata: async () => ({ jwk: key, agentUrl: 'https://buyer.example/mcp', operatorRecord }),
      },
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      now: () => vector.reference_now,
    });
    assert.equal(result.operatorRecord, operatorRecord);
  });
  it('rejects webhook-only legacy keys on request verification', async () => {
    const { key, request } = signedRequest();
    await assert.rejects(
      () =>
        verifyRequestSignature(request, {
          capability: { supported: true, required_for: [], covers_content_digest: 'required' },
          jwks: {
            resolve: async () => key,
            resolveWithMetadata: async () => ({ jwk: key, legacyWebhookFallback: true }),
          },
          replayStore: new InMemoryReplayStore(),
          revocationStore: new InMemoryRevocationStore(),
          now: () => vector.reference_now,
        }),
      error => error.code === 'request_signature_brand_json_url_missing'
    );
  });
  it('rechecks delegated authorization after asynchronous verification and before consuming a nonce', async () => {
    const { key, request } = signedRequest();
    let now = vector.reference_now,
      nonceConsumed = false;
    await assert.rejects(
      () =>
        verifyRequestSignature(request, {
          capability: { supported: true, required_for: [], covers_content_digest: 'required' },
          jwks: {
            resolve: async () => key,
            resolveWithMetadata: async () => ({ jwk: key, operatorAuthorizationValidUntil: now + 1 }),
          },
          replayStore: {
            has: async () => false,
            isCapHit: async () => false,
            insert: async () => {
              nonceConsumed = true;
              return 'ok';
            },
          },
          revocationStore: {
            isRevoked: async () => {
              now += 2;
              return false;
            },
          },
          now: () => now,
        }),
      error => error.code === 'request_signature_brand_origin_mismatch'
    );
    assert.equal(nonceConsumed, false);
  });
});
