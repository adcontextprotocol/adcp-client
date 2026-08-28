/**
 * Integration tests for the brand_json_url discovery chain. Stand up an
 * in-process HTTP server serving brand.json + JWKS routes, mock the
 * protocol-level `get_adcp_capabilities` call via the resolver's
 * `fetchCapabilities` option, and assert every `request_signature_*`
 * rejection code defined in security.mdx §"Discovering an agent's
 * signing keys via `brand_json_url`".
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { generateKeyPair, exportJWK, SignJWT, jwtVerify } = require('jose');

const {
  resolveAgent,
  AgentResolverError,
  getAgentJwks,
  createAgentJwksSet,
  ResolvedAgentJwksResolver,
  attackerInfluencedFields,
} = require('../dist/lib/signing/server');

let server;
let routes;
let baseUrl;
let publicJwk;
let privateKey;

before(async () => {
  ({ publicKey: publicJwk, privateKey } = await mintEd25519());
  routes = {};
  server = http.createServer((req, res) => {
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (typeof route === 'function') {
      route(req, res);
      return;
    }
    const headers = { 'content-type': route.contentType ?? 'application/json' };
    if (route.cacheControl) headers['cache-control'] = route.cacheControl;
    res.writeHead(route.status ?? 200, headers);
    res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(() => r()));
});

beforeEach(() => {
  // Clear shared HTTP route state between tests so failures in one suite
  // don't leak fixture data into the next.
  for (const k of Object.keys(routes)) delete routes[k];
});

async function mintEd25519() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-resolver-key';
  jwk.alg = 'EdDSA';
  jwk.use = 'sig';
  return { publicKey: jwk, privateKey };
}

function fakeCapabilities(payload) {
  return async () => ({ structuredContent: payload });
}

function happyPathRoutes(agentUrl) {
  routes[`/.well-known/brand.json`] = {
    body: {
      agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
    },
    cacheControl: 'max-age=60',
  };
  routes[`/jwks.json`] = {
    body: { keys: [publicJwk] },
    cacheControl: 'max-age=300',
  };
}

describe('resolveAgent — happy path', () => {
  it('walks all 8 steps and returns the resolved chain + trace', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    happyPathRoutes(agentUrl);
    const result = await resolveAgent(agentUrl, {
      allowPrivateIp: true,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    assert.equal(result.agentUrl, agentUrl);
    assert.equal(result.brandJsonUrl, `${baseUrl}/.well-known/brand.json`);
    assert.equal(result.jwksUri, `${baseUrl}/jwks.json`);
    assert.equal(result.jwks.keys.length, 1);
    assert.equal(result.jwks.keys[0].kid, 'test-resolver-key');
    assert.deepEqual(result.consistency, { ok: true });
    assert.equal(result.jwksCacheControl, 'max-age=300');
    assert.ok(result.trace.length >= 7, 'trace covers every step');
    for (const step of result.trace) {
      if (step.fetchedAt !== undefined) {
        assert.ok(typeof step.ageSeconds === 'number');
      }
    }
  });
});

describe('resolveAgent — rejection codes', () => {
  it('request_signature_capabilities_unreachable when fetchCapabilities throws', async () => {
    await assertCode(
      () =>
        resolveAgent(`${baseUrl}/mcp`, {
          allowPrivateIp: true,
          fetchCapabilities: async () => {
            throw new Error('boom');
          },
        }),
      'request_signature_capabilities_unreachable'
    );
  });

  it('request_signature_brand_json_url_missing when identity.brand_json_url is absent', async () => {
    await assertCode(
      () =>
        resolveAgent(`${baseUrl}/mcp`, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({}),
        }),
      'request_signature_brand_json_url_missing'
    );
  });

  it('request_signature_brand_json_url_missing when value is non-https (no allowPrivateIp)', async () => {
    // Without allowPrivateIp, the resolver enforces the spec's strict
    // `^https://` rule on identity.brand_json_url. allowPrivateIp lifts the
    // gate for loopback testing and is only ever set in dev/test contexts.
    await assertCode(
      () =>
        resolveAgent('https://buyer.example.com/mcp', {
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: 'http://example.com/brand.json' },
          }),
        }),
      'request_signature_brand_json_url_missing'
    );
  });

  it('request_signature_brand_json_unreachable on 404', async () => {
    routes['/.well-known/brand.json'] = { status: 404, body: {} };
    await assertCode(
      () =>
        resolveAgent(`${baseUrl}/mcp`, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
          }),
        }),
      'request_signature_brand_json_unreachable'
    );
  });

  it('request_signature_brand_json_malformed on duplicate-key brand.json', async () => {
    // Hand-rolled JSON to smuggle a duplicate key past JSON.parse. The strict
    // parser MUST flag this — same `agents` key declared twice.
    routes['/.well-known/brand.json'] = {
      body: '{"agents":[{"type":"sales"}],"agents":[{"type":"creative"}]}',
      contentType: 'application/json',
    };
    await assertCode(
      () =>
        resolveAgent(`${baseUrl}/mcp`, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
          }),
        }),
      'request_signature_brand_json_malformed'
    );
  });

  it('request_signature_brand_origin_mismatch when eTLD+1 differs and no authorized_operators delegation', async () => {
    // Use real public hostnames so eTLD+1 actually differs (loopback all-share-one
    // pseudo-eTLD). Bypass the network with fetchCapabilities + a mock body
    // route delivered against our 127.0.0.1 server.
    const agentUrl = 'https://attacker.example/mcp';
    routes['/.well-known/brand.json'] = {
      body: { agents: [{ type: 'sales', url: agentUrl }] },
    };
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
          }),
        }),
      'request_signature_brand_origin_mismatch'
    );
  });

  it('accepts only active, schema-shaped broad operator delegations', async () => {
    const agentUrl = 'https://operator.example/mcp';
    const now = 1_700_000_000;
    const validUntil = now + 60;
    routes['/.well-known/brand.json'] = {
      body: {
        authorized_operators: [
          {
            domain: 'operator.example',
            brands: ['*'],
            scopes: ['all'],
            valid_from: new Date(now * 1000).toISOString(),
            valid_until: new Date(validUntil * 1000).toISOString(),
          },
        ],
        agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
      },
    };
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };
    const result = await resolveAgent(agentUrl, {
      allowPrivateIp: true,
      now: () => now,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    assert.equal(result.agentUrl, agentUrl);
    assert.equal(result.operatorAuthorizationValidUntil, validUntil);
  });

  it('accepts RFC 3339 lower-case date/time separators', async () => {
    const agentUrl = 'https://operator.example/mcp';
    const now = 1_700_000_000;
    const validUntil = now + 60;
    routes['/.well-known/brand.json'] = {
      body: {
        authorized_operators: [
          {
            domain: 'operator.example',
            brands: ['*'],
            valid_from: new Date((now - 60) * 1000).toISOString().replace('T', 't').replace('Z', 'z'),
            valid_until: new Date(validUntil * 1000).toISOString().replace('T', 't').replace('Z', 'z'),
          },
        ],
        agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
      },
    };
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };

    const result = await resolveAgent(agentUrl, {
      allowPrivateIp: true,
      now: () => now,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    assert.equal(result.operatorAuthorizationValidUntil, validUntil);
  });

  it('rejects expired, future, malformed, and schema-invalid operator delegations', async () => {
    const agentUrl = 'https://operator.example/mcp';
    const now = 1_700_000_000;
    const inactiveEntries = [
      'operator.example',
      { domain: 'operator.example' },
      { domain: 'operator.example', brands: [] },
      { domain: 'evil.invalid@operator.example', brands: ['*'] },
      { domain: 'operator.example', brands: ['*'], valid_until: new Date(now * 1000).toISOString() },
      { domain: 'operator.example', brands: ['*'], valid_until: 'tomorrow' },
      { domain: 'operator.example', brands: ['*'], valid_from: new Date((now + 1) * 1000).toISOString() },
    ];
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };

    for (const entry of inactiveEntries) {
      routes['/.well-known/brand.json'] = {
        body: {
          authorized_operators: [entry],
          agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
        },
      };
      await assertCode(
        () =>
          resolveAgent(agentUrl, {
            allowPrivateIp: true,
            now: () => now,
            fetchCapabilities: fakeCapabilities({
              identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
            }),
          }),
        'request_signature_brand_origin_mismatch'
      );
    }
  });

  it('binds constrained operator delegations to explicit brand, scope, and country context', async () => {
    const agentUrl = 'https://operator.example/mcp';
    routes['/.well-known/brand.json'] = {
      body: {
        authorized_operators: [
          {
            domain: 'operator.example',
            brands: ['brand_a'],
            scopes: ['media_buying'],
            countries: ['GB'],
          },
        ],
        agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
      },
    };
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };
    const baseOptions = {
      allowPrivateIp: true,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    };

    await assertCode(() => resolveAgent(agentUrl, baseOptions), 'request_signature_brand_origin_mismatch');
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          ...baseOptions,
          requiredOperatorBrand: 'brand_b',
          requiredOperatorScope: 'media_buying',
          requiredOperatorCountry: 'GB',
        }),
      'request_signature_brand_origin_mismatch'
    );
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          ...baseOptions,
          requiredOperatorBrand: 'brand_a',
          requiredOperatorScope: 'creative_generation',
          requiredOperatorCountry: 'GB',
        }),
      'request_signature_brand_origin_mismatch'
    );
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          ...baseOptions,
          requiredOperatorBrand: 'brand_a',
          requiredOperatorScope: 'media_buying',
          requiredOperatorCountry: 'US',
        }),
      'request_signature_brand_origin_mismatch'
    );

    const result = await resolveAgent(agentUrl, {
      ...baseOptions,
      requiredOperatorBrand: 'brand_a',
      requiredOperatorScope: 'media_buying',
      requiredOperatorCountry: 'GB',
    });
    assert.equal(result.agentUrl, agentUrl);
  });

  it('keeps authorization while an active sibling delegation remains', async () => {
    const agentUrl = 'https://operator.example/mcp';
    const now = 1_700_000_000;
    const earlierValidUntil = now + 30;
    const validUntil = now + 60;
    routes['/.well-known/brand.json'] = {
      body: {
        authorized_operators: [
          {
            domain: 'operator.example',
            brands: ['*'],
            valid_until: new Date(earlierValidUntil * 1000).toISOString(),
          },
          { domain: 'operator.example', brands: ['*'], valid_until: new Date(validUntil * 1000).toISOString() },
        ],
        agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
      },
    };
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };
    const result = await resolveAgent(agentUrl, {
      allowPrivateIp: true,
      now: () => now,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    assert.equal(result.operatorAuthorizationValidUntil, validUntil);
  });

  it('rejects a delegation that expires while JWKS discovery is in flight', async () => {
    const agentUrl = 'https://operator.example/mcp';
    let now = 1_700_000_000;
    const validUntil = now + 1;
    routes['/.well-known/brand.json'] = {
      body: {
        authorized_operators: [
          {
            domain: 'operator.example',
            brands: ['*'],
            valid_until: new Date(validUntil * 1000).toISOString(),
          },
        ],
        agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
      },
    };
    routes['/jwks.json'] = (_req, res) => {
      now = validUntil;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
    };

    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          allowPrivateIp: true,
          now: () => now,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
          }),
        }),
      'request_signature_brand_origin_mismatch'
    );
  });

  it('treats fractional valid_until as inactive at the exact real-time boundary', async () => {
    const agentUrl = 'https://operator.example/mcp';
    const originalDateNow = Date.now;
    const boundaryMs = 1_700_000_000_500;
    Date.now = () => boundaryMs + 400;
    try {
      routes['/.well-known/brand.json'] = {
        body: {
          authorized_operators: [
            {
              domain: 'operator.example',
              brands: ['*'],
              valid_until: new Date(boundaryMs).toISOString(),
            },
          ],
          agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
        },
      };
      routes['/jwks.json'] = { body: { keys: [publicJwk] } };
      await assertCode(
        () =>
          resolveAgent(agentUrl, {
            allowPrivateIp: true,
            fetchCapabilities: fakeCapabilities({
              identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
            }),
          }),
        'request_signature_brand_origin_mismatch'
      );
    } finally {
      Date.now = originalDateNow;
    }
  });

  it('request_signature_agent_not_in_brand_json on byte-equal miss (trailing slash)', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    routes['/.well-known/brand.json'] = {
      body: { agents: [{ type: 'sales', url: `${agentUrl}/` }] }, // trailing slash
    };
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
          }),
        }),
      'request_signature_agent_not_in_brand_json'
    );
  });

  it('request_signature_brand_json_ambiguous on multiple matches with attacker-influenced detail', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    routes['/.well-known/brand.json'] = {
      body: {
        agents: [
          { type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/a.json` },
          { type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/b.json` },
        ],
      },
    };
    let caught;
    try {
      await resolveAgent(agentUrl, {
        allowPrivateIp: true,
        fetchCapabilities: fakeCapabilities({
          identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
        }),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AgentResolverError);
    assert.equal(caught.code, 'request_signature_brand_json_ambiguous');
    assert.equal(caught.detail.matched_count, 2);
    assert.equal(caught.detail.matched_entries.length, 2);
    const attacker = attackerInfluencedFields(caught);
    assert.ok(attacker.includes('matched_entries'));
    assert.ok(attacker.includes('agent_url'));
  });

  it('request_signature_key_origin_mismatch when jwks_uri host differs from declared origin', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    happyPathRoutes(agentUrl);
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: {
              brand_json_url: `${baseUrl}/.well-known/brand.json`,
              key_origins: { request_signing: 'https://different.example' },
            },
            request_signing: { supported_for: ['create_media_buy'] },
          }),
        }),
      'request_signature_key_origin_mismatch'
    );
  });

  it('request_signature_key_origin_missing when posture is declared but no origin is set', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    happyPathRoutes(agentUrl);
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
            request_signing: { supported_for: ['create_media_buy'] },
          }),
        }),
      'request_signature_key_origin_missing'
    );
  });

  it('request_signature_jwks_unreachable when JWKS endpoint 404s with detail.jwks_uri', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    routes['/.well-known/brand.json'] = {
      body: { agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }] },
    };
    // /jwks.json deliberately not declared — server responds 404.
    let caught;
    try {
      await resolveAgent(agentUrl, {
        allowPrivateIp: true,
        fetchCapabilities: fakeCapabilities({
          identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
        }),
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AgentResolverError);
    assert.equal(caught.code, 'request_signature_jwks_unreachable');
    assert.equal(caught.detail.jwks_uri, `${baseUrl}/jwks.json`);
    assert.equal(caught.detail.brand_json_url, undefined);
    assert.ok(attackerInfluencedFields(caught).includes('jwks_uri'));
  });

  it('request_signature_jwks_unreachable when JWKS body has no keys[] array', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    routes['/.well-known/brand.json'] = {
      body: { agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }] },
    };
    routes['/jwks.json'] = { body: { keys: 'not-an-array' } };
    await assertCode(
      () =>
        resolveAgent(agentUrl, {
          allowPrivateIp: true,
          fetchCapabilities: fakeCapabilities({
            identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
          }),
        }),
      'request_signature_jwks_unreachable'
    );
  });

  it('publisher pin carve-out skips webhook_signing origin check only', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    happyPathRoutes(agentUrl);
    // Webhook signing declared with mismatching origin — the carve-out must
    // suppress the rejection ONLY when publisherPinned is set.
    const result = await resolveAgent(agentUrl, {
      allowPrivateIp: true,
      publisherPinned: { webhook_signing: true },
      fetchCapabilities: fakeCapabilities({
        identity: {
          brand_json_url: `${baseUrl}/.well-known/brand.json`,
          key_origins: { webhook_signing: 'https://different.example' },
        },
        webhook_signing: { supported: true },
      }),
    });
    assert.deepEqual(result.consistency, { ok: true });
  });
});

describe('getAgentJwks fast path', () => {
  it('returns the JWKS subset without trace', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    happyPathRoutes(agentUrl);
    const result = await getAgentJwks(agentUrl, {
      allowPrivateIp: true,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    assert.equal(result.jwks.keys.length, 1);
    assert.equal(result.jwksUri, `${baseUrl}/jwks.json`);
    assert.equal(result.cacheControl, 'max-age=300');
    assert.ok(typeof result.fetchedAt === 'number');
    assert.ok(!('trace' in result));
  });

  it('returns the accepted operator-delegation cache boundary', async () => {
    const agentUrl = 'https://operator.example/mcp';
    const now = 1_700_000_000;
    const validUntil = now + 60;
    routes['/.well-known/brand.json'] = {
      body: {
        authorized_operators: [
          {
            domain: 'operator.example',
            brands: ['*'],
            valid_until: new Date(validUntil * 1000).toISOString(),
          },
        ],
        agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
      },
    };
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };

    const result = await getAgentJwks(agentUrl, {
      allowPrivateIp: true,
      now: () => now,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    assert.equal(result.operatorAuthorizationValidUntil, validUntil);
  });
});

describe('createAgentJwksSet — JOSE adapter', () => {
  it('verifies a JWT signed by a key in the resolved JWKS', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    happyPathRoutes(agentUrl);
    const getKey = createAgentJwksSet(agentUrl, {
      allowPrivateIp: true,
      allowedAlgs: ['EdDSA'],
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    const jwt = await new SignJWT({ scope: 'test' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-resolver-key' })
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(privateKey);
    const verified = await jwtVerify(jwt, getKey, { algorithms: ['EdDSA'] });
    assert.equal(verified.payload.scope, 'test');
  });

  it('throws TypeError when allowedAlgs is empty', () => {
    assert.throws(
      () =>
        createAgentJwksSet(`${baseUrl}/mcp`, {
          allowPrivateIp: true,
          allowedAlgs: [],
        }),
      TypeError
    );
  });

  it('rejects JWKS keys whose alg is outside allowedAlgs with request_signature_jwks_alg_disallowed', async () => {
    const agentUrl = `${baseUrl}/mcp`;
    routes['/.well-known/brand.json'] = {
      body: { agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }] },
    };
    routes['/jwks.json'] = { body: { keys: [{ ...publicJwk, alg: 'RS256' }] } };
    const getKey = createAgentJwksSet(agentUrl, {
      allowPrivateIp: true,
      allowedAlgs: ['EdDSA'],
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    let caught;
    try {
      await getKey({ alg: 'EdDSA', kid: 'test-resolver-key' });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof AgentResolverError);
    assert.equal(caught.code, 'request_signature_jwks_alg_disallowed');
  });

  it('does not cache a delegated JWKS past valid_until', async () => {
    const agentUrl = 'https://operator.example/mcp';
    let now = 1_700_000_000;
    let brandFetches = 0;
    const validUntil = now + 10;
    routes['/.well-known/brand.json'] = (_req, res) => {
      brandFetches += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          authorized_operators: [
            {
              domain: 'operator.example',
              brands: ['*'],
              valid_until: new Date(validUntil * 1000).toISOString(),
            },
          ],
          agents: [{ type: 'sales', url: agentUrl, jwks_uri: `${baseUrl}/jwks.json` }],
        })
      );
    };
    routes['/jwks.json'] = { body: { keys: [publicJwk] } };
    const getKey = createAgentJwksSet(agentUrl, {
      allowPrivateIp: true,
      allowedAlgs: ['EdDSA'],
      cacheMaxAgeSeconds: 300,
      now: () => now,
      fetchCapabilities: fakeCapabilities({
        identity: { brand_json_url: `${baseUrl}/.well-known/brand.json` },
      }),
    });
    const jwt = await new SignJWT({ scope: 'test' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-resolver-key' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    await jwtVerify(jwt, getKey, { algorithms: ['EdDSA'] });
    now = validUntil;
    await assert.rejects(
      () => jwtVerify(jwt, getKey, { algorithms: ['EdDSA'] }),
      error => error instanceof AgentResolverError && error.code === 'request_signature_brand_origin_mismatch'
    );
    assert.equal(brandFetches, 2);
  });
});

describe('ResolvedAgentJwksResolver cache', () => {
  it('does not cache a delegated JWKS past valid_until', async () => {
    let now = 1_700_000_000;
    let resolutions = 0;
    const validUntil = now + 10;
    const resolver = new ResolvedAgentJwksResolver('https://operator.example/mcp', 'mcp', {
      now: () => now,
      cacheTtlSeconds: 300,
      resolve: async () => {
        resolutions += 1;
        if (now >= validUntil) {
          throw new AgentResolverError('request_signature_brand_origin_mismatch', 'delegation expired', {});
        }
        return {
          jwks: { keys: [{ ...publicJwk, kid: 'known-key' }] },
          operatorAuthorizationValidUntil: validUntil,
        };
      },
    });

    assert.equal((await resolver.resolve('known-key')).kid, 'known-key');
    now = validUntil;
    await assert.rejects(
      () => resolver.resolve('known-key'),
      error => error instanceof AgentResolverError && error.code === 'request_signature_brand_origin_mismatch'
    );
    assert.equal(resolutions, 2);
  });

  it('rejects a resolution whose delegation expires before cache installation', async () => {
    let now = 1_700_000_000;
    const validUntil = now + 0.5;
    const resolver = new ResolvedAgentJwksResolver('https://operator.example/mcp', 'mcp', {
      now: () => now,
      resolve: async () => {
        now = validUntil;
        return {
          jwks: { keys: [{ ...publicJwk, kid: 'known-key' }] },
          operatorAuthorizationValidUntil: validUntil,
        };
      },
    });

    await assert.rejects(
      () => resolver.resolve('known-key'),
      error => error instanceof AgentResolverError && error.code === 'request_signature_brand_origin_mismatch'
    );
  });
});

async function assertCode(fn, expected) {
  try {
    await fn();
    assert.fail(`expected ${expected}`);
  } catch (err) {
    assert.ok(err instanceof AgentResolverError, `expected AgentResolverError, got ${err?.constructor?.name}`);
    assert.equal(err.code, expected, `expected code ${expected}, got ${err.code}`);
  }
}
