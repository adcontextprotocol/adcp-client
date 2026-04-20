/**
 * BrandJsonJwksResolver — resolves a sender's JWKS by fetching brand.json,
 * extracting the `jwks_uri` from the agent entry matching the configured
 * (type, id, brand) selector, and delegating to an inner HttpsJwksResolver.
 *
 * Tests cover:
 *   - Flat brand shape (`agents[]` at top level)
 *   - House portfolio shape (`house.agents[]` + `brands[].agents[]`)
 *   - `authoritative_location` redirect chain
 *   - `house` string redirect (to `https://{house}/.well-known/brand.json`)
 *   - jwks_uri fallback to `/.well-known/jwks.json` on agent origin when absent
 *   - Selector ambiguity (multiple agents of the same type without `agentId`)
 *   - Cache honoring + cooldown
 *   - End-to-end webhook verification using the resolver
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  BrandJsonJwksResolver,
  BrandJsonResolverError,
  verifyWebhookSignature,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  WebhookSignatureError,
} = require('../dist/lib/signing');
const { SsrfRefusedError } = require('../dist/lib/net');

const keysPath = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);
const { keys } = JSON.parse(readFileSync(keysPath, 'utf8'));
const primary = keys.find(k => k.kid === 'test-ed25519-2026');
if (!primary) throw new Error('Expected test-ed25519-2026 in compliance key fixtures');
const primaryPublic = stripPrivate({ ...primary, adcp_use: 'webhook-signing' });

function stripPrivate(k) {
  const copy = { ...k };
  delete copy._private_d_for_test_only;
  delete copy.d;
  return copy;
}

/**
 * Mini HTTP server that lets each test stage mutate responses per-path.
 * `routes[path] = { status, body?, headers?, etag?, cacheControl? }`.
 */
async function startServer(routes) {
  const state = {
    routes,
    hits: Object.fromEntries(Object.keys(routes).map(k => [k, 0])),
    ifNoneMatchSeen: {},
  };
  const server = http.createServer((req, res) => {
    const route = state.routes[req.url];
    state.hits[req.url] = (state.hits[req.url] ?? 0) + 1;
    if (!route) {
      res.writeHead(404);
      res.end();
      return;
    }
    state.ifNoneMatchSeen[req.url] = state.ifNoneMatchSeen[req.url] ?? [];
    state.ifNoneMatchSeen[req.url].push(req.headers['if-none-match'] ?? null);
    if (route.etag && req.headers['if-none-match'] === route.etag) {
      const h = { etag: route.etag };
      if (route.cacheControl) h['cache-control'] = route.cacheControl;
      res.writeHead(304, h);
      res.end();
      return;
    }
    const h = { 'content-type': route.contentType ?? 'application/json' };
    if (route.etag) h['etag'] = route.etag;
    if (route.cacheControl) h['cache-control'] = route.cacheControl;
    res.writeHead(route.status ?? 200, h);
    res.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    stop: () => new Promise(r => server.close(() => r())),
  };
}

describe('BrandJsonJwksResolver', () => {
  it('resolves a JWK by following agents[].jwks_uri on a flat brand.json', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: {
          agents: [
            {
              type: 'sales',
              url: 'http://127.0.0.1:REPLACE/',
              id: 'sales_1',
              jwks_uri: 'http://127.0.0.1:REPLACE/custom-jwks.json',
            },
          ],
        },
      },
      '/custom-jwks.json': {
        body: { keys: [primaryPublic] },
        cacheControl: 'max-age=60',
      },
    });
    try {
      // Replace the placeholder port now that we know it.
      const port = server.origin.split(':').pop();
      server.state.routes['/.well-known/brand.json'].body.agents[0].url = `${server.origin}/`;
      server.state.routes['/.well-known/brand.json'].body.agents[0].jwks_uri = `${server.origin}/custom-jwks.json`;

      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      const jwk = await resolver.resolve('test-ed25519-2026');
      assert.ok(jwk, 'resolved a JWK');
      assert.strictEqual(jwk.kid, 'test-ed25519-2026');
      assert.strictEqual(resolver.agentUrl, `${server.origin}/`);
      assert.strictEqual(server.state.hits['/.well-known/brand.json'], 1);
      assert.strictEqual(server.state.hits['/custom-jwks.json'], 1);

      // Second resolve hits neither — both caches are warm.
      const again = await resolver.resolve('test-ed25519-2026');
      assert.strictEqual(again.kid, 'test-ed25519-2026');
      assert.strictEqual(server.state.hits['/.well-known/brand.json'], 1);
      assert.strictEqual(server.state.hits['/custom-jwks.json'], 1);
    } finally {
      await server.stop();
    }
  });

  it('falls back to /.well-known/jwks.json on the agent origin when jwks_uri is absent', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { agents: [{ type: 'sales', url: 'PLACEHOLDER', id: 'sales_1' }] },
      },
      '/.well-known/jwks.json': {
        body: { keys: [primaryPublic] },
      },
    });
    try {
      server.state.routes['/.well-known/brand.json'].body.agents[0].url = `${server.origin}/`;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      const jwk = await resolver.resolve('test-ed25519-2026');
      assert.ok(jwk);
      assert.strictEqual(server.state.hits['/.well-known/jwks.json'], 1, 'hit the fallback path');
    } finally {
      await server.stop();
    }
  });

  it('selects an agent from house.agents in a portfolio brand.json', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: {
          house: {
            domain: 'portfolio.example',
            name: 'Portfolio House',
            agents: [{ type: 'governance', url: 'PLACEHOLDER', id: 'gov_root' }],
          },
          brands: [{ id: 'brand_a', names: [{ en: 'A' }] }],
        },
      },
      '/.well-known/jwks.json': { body: { keys: [primaryPublic] } },
    });
    try {
      server.state.routes['/.well-known/brand.json'].body.house.agents[0].url = `${server.origin}/`;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'governance',
        allowPrivateIp: true,
      });
      const jwk = await resolver.resolve('test-ed25519-2026');
      assert.ok(jwk);
    } finally {
      await server.stop();
    }
  });

  it('prefers a brand-level agent over house-level when brandId is supplied', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: {
          house: {
            domain: 'portfolio.example',
            name: 'Portfolio',
            agents: [{ type: 'sales', url: 'HOUSE', id: 'house_sales' }],
          },
          brands: [
            {
              id: 'brand_a',
              names: [{ en: 'A' }],
              agents: [{ type: 'sales', url: 'BRAND', id: 'brand_a_sales' }],
            },
          ],
        },
      },
      '/brand-jwks.json': { body: { keys: [primaryPublic] } },
      '/house-jwks.json': { body: { keys: [] } },
    });
    try {
      const brandRoute = server.state.routes['/.well-known/brand.json'];
      brandRoute.body.house.agents[0].url = `${server.origin}/`;
      brandRoute.body.house.agents[0].jwks_uri = `${server.origin}/house-jwks.json`;
      brandRoute.body.brands[0].agents[0].url = `${server.origin}/`;
      brandRoute.body.brands[0].agents[0].jwks_uri = `${server.origin}/brand-jwks.json`;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        brandId: 'brand_a',
        allowPrivateIp: true,
      });
      const jwk = await resolver.resolve('test-ed25519-2026');
      assert.ok(jwk);
      assert.strictEqual(server.state.hits['/brand-jwks.json'], 1);
      assert.strictEqual(server.state.hits['/house-jwks.json'], 0);
    } finally {
      await server.stop();
    }
  });

  it('follows an authoritative_location redirect to the real brand.json', async () => {
    // Entry redirects to /primary/brand.json; agents live there.
    const server = await startServer({
      '/entry.json': {
        body: { authoritative_location: 'PLACEHOLDER' },
      },
      '/primary/brand.json': {
        body: { agents: [{ type: 'sales', url: 'PLACEHOLDER', id: 'sales_1' }] },
      },
      '/.well-known/jwks.json': { body: { keys: [primaryPublic] } },
    });
    try {
      server.state.routes['/entry.json'].body.authoritative_location = `${server.origin}/primary/brand.json`;
      server.state.routes['/primary/brand.json'].body.agents[0].url = `${server.origin}/`;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/entry.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      const jwk = await resolver.resolve('test-ed25519-2026');
      assert.ok(jwk);
      assert.strictEqual(server.state.hits['/entry.json'], 1);
      assert.strictEqual(server.state.hits['/primary/brand.json'], 1);
    } finally {
      await server.stop();
    }
  });

  it('throws agent_ambiguous when multiple agents of same type exist without agentId', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: {
          agents: [
            { type: 'sales', url: 'https://a.example/', id: 'sales_a' },
            { type: 'sales', url: 'https://b.example/', id: 'sales_b' },
          ],
        },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('test-ed25519-2026'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'agent_ambiguous');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('throws agent_not_found when no agent of the requested type exists', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { agents: [{ type: 'governance', url: 'https://g.example/', id: 'gov' }] },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('test-ed25519-2026'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'agent_not_found');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('refetches brand.json after maxAgeSeconds and picks up a rotated jwks_uri', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: {
          agents: [{ type: 'sales', url: 'PLACEHOLDER', id: 'sales_1', jwks_uri: 'PLACEHOLDER' }],
        },
        cacheControl: 'max-age=60',
      },
      '/old-jwks.json': { body: { keys: [primaryPublic] }, cacheControl: 'max-age=0' },
      '/new-jwks.json': {
        body: { keys: [{ ...primaryPublic, kid: 'test-ed25519-rotated' }] },
        cacheControl: 'max-age=60',
      },
    });
    try {
      const brandRoute = server.state.routes['/.well-known/brand.json'];
      brandRoute.body.agents[0].url = `${server.origin}/`;
      brandRoute.body.agents[0].jwks_uri = `${server.origin}/old-jwks.json`;

      let clock = 1_000;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
        minCooldownSeconds: 0,
        maxAgeSeconds: 60,
        now: () => clock,
      });
      const first = await resolver.resolve('test-ed25519-2026');
      assert.ok(first, 'primed with original key');

      // Publisher rotates jwks_uri (serve new body at entry URL). ETag changes
      // so the next fetch returns 200 instead of 304.
      brandRoute.body = {
        agents: [
          {
            type: 'sales',
            url: `${server.origin}/`,
            id: 'sales_1',
            jwks_uri: `${server.origin}/new-jwks.json`,
          },
        ],
      };

      // Advance past cooldown and past max-age=60 so both caches may refresh.
      clock += 120;
      const rotated = await resolver.resolve('test-ed25519-rotated');
      assert.ok(rotated, 'picked up rotated kid after brand.json refresh');
      assert.strictEqual(rotated.kid, 'test-ed25519-rotated');
    } finally {
      await server.stop();
    }
  });

  it('end-to-end: verifies an inbound webhook using keys discovered via brand.json', async () => {
    const { signWebhook } = require('../dist/lib/signing/client.js');
    const primaryPrivate = {
      ...stripPrivate(primary),
      d: primary._private_d_for_test_only,
      adcp_use: 'webhook-signing',
    };

    const server = await startServer({
      '/.well-known/brand.json': {
        body: { agents: [{ type: 'sales', url: 'PLACEHOLDER', id: 'sales_1' }] },
      },
      '/.well-known/jwks.json': { body: { keys: [primaryPublic] } },
    });
    try {
      server.state.routes['/.well-known/brand.json'].body.agents[0].url = `${server.origin}/`;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });

      const url = 'https://buyer.example.com/webhooks/delivery';
      const body = '{"task_id":"task_123","status":"completed"}';
      const signed = signWebhook(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: primary.kid, alg: 'ed25519', privateKey: primaryPrivate },
        { windowSeconds: 60, nonce: 'brand-jwks-e2e-nonce' }
      );

      const result = await verifyWebhookSignature(
        { method: 'POST', url, headers: signed.headers, body },
        {
          jwks: resolver,
          replayStore: new InMemoryReplayStore(),
          revocationStore: new InMemoryRevocationStore(),
        }
      );
      assert.strictEqual(result.status, 'verified');
      assert.strictEqual(result.keyid, primary.kid);
    } finally {
      await server.stop();
    }
  });

  it('rejects an agent.url cross-origin fallback when jwks_uri is absent', async () => {
    // Publisher's brand.json declares an agent whose URL lives on a different
    // origin than the brand.json itself and omits `jwks_uri`. Using
    // `/.well-known/jwks.json` on that agent's origin would let an attacker
    // pivot the trust anchor — must reject with `jwks_origin_mismatch`.
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { agents: [{ type: 'sales', url: 'https://victim-internal.example/', id: 'sales_1' }] },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('test-ed25519-2026'),
        err => {
          assert.ok(
            err instanceof BrandJsonResolverError,
            `expected BrandJsonResolverError, got ${err?.constructor?.name}`
          );
          assert.strictEqual(err.code, 'jwks_origin_mismatch');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('rejects a malformed "house" string redirect target', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { house: 'evil.com\\@victim.com' },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('any'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'invalid_house');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('rejects a malformed authoritative_location URL', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { authoritative_location: 'not a url' },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('any'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'invalid_url');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('rejects an authoritative_location with embedded userinfo', async () => {
    // Build the URL from parts so the checked-in source doesn't contain a
    // `user:pass@host` pattern that secret scanners flag as Basic Auth.
    const userinfoUrl = ['https://', 'u1', ':', 'p1', '@', 'victim.example/brand.json'].join('');
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { authoritative_location: userinfoUrl },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('any'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'invalid_url');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('refuses a private-IP JWKS URL when allowPrivateIp is false (default)', async () => {
    // Receiver running in production: no allowPrivateIp. Even if the
    // publisher's brand.json points at 127.0.0.1, ssrfSafeFetch must refuse.
    const resolver = new BrandJsonJwksResolver('http://127.0.0.1/.well-known/brand.json', {
      agentType: 'sales',
      // allowPrivateIp defaults to false
    });
    await assert.rejects(
      () => resolver.resolve('any'),
      err => {
        // canonicalizeUrl catches the scheme first — http is refused before
        // the DNS lookup, which is the defense-in-depth behavior we want.
        assert.ok(
          err instanceof BrandJsonResolverError || err instanceof SsrfRefusedError,
          `unexpected error class: ${err?.constructor?.name}`
        );
        return true;
      }
    );
  });

  it('throws redirect_depth_exceeded when a chain exceeds maxRedirects', async () => {
    const server = await startServer({
      '/entry.json': { body: { authoritative_location: 'PLACEHOLDER' } },
      '/hop1.json': { body: { authoritative_location: 'PLACEHOLDER' } },
      '/hop2.json': { body: { authoritative_location: 'PLACEHOLDER' } },
    });
    try {
      server.state.routes['/entry.json'].body.authoritative_location = `${server.origin}/hop1.json`;
      server.state.routes['/hop1.json'].body.authoritative_location = `${server.origin}/hop2.json`;
      server.state.routes['/hop2.json'].body.authoritative_location = `${server.origin}/entry.json`;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/entry.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
        maxRedirects: 2,
      });
      await assert.rejects(
        () => resolver.resolve('any'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.ok(
            err.code === 'redirect_depth_exceeded' || err.code === 'redirect_loop',
            `expected depth_exceeded or loop, got ${err.code}`
          );
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('rejects a schema-invalid brand.json where agent.url is not a string', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { agents: [{ type: 'sales', url: 12345, id: 'sales_1' }] },
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('any'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'schema_invalid');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('rejects a non-JSON brand.json body', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: 'not-json-at-all',
        contentType: 'text/plain',
      },
    });
    try {
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
      });
      await assert.rejects(
        () => resolver.resolve('any'),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'invalid_body');
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('returns 304 cache-hit path without reconstructing the inner resolver', async () => {
    const server = await startServer({
      '/.well-known/brand.json': {
        body: { agents: [{ type: 'sales', url: 'PLACEHOLDER', id: 'sales_1' }] },
        etag: 'stable-v1',
        cacheControl: 'max-age=1',
      },
      '/.well-known/jwks.json': { body: { keys: [primaryPublic] }, cacheControl: 'max-age=60' },
    });
    try {
      server.state.routes['/.well-known/brand.json'].body.agents[0].url = `${server.origin}/`;
      let clock = 1_000;
      const resolver = new BrandJsonJwksResolver(`${server.origin}/.well-known/brand.json`, {
        agentType: 'sales',
        allowPrivateIp: true,
        minCooldownSeconds: 0,
        now: () => clock,
      });
      await resolver.resolve('test-ed25519-2026');
      assert.strictEqual(server.state.hits['/.well-known/brand.json'], 1);

      clock += 5; // past max-age=1
      await resolver.resolve('test-ed25519-2026');
      // Second fetch hit the origin but got 304.
      assert.strictEqual(server.state.hits['/.well-known/brand.json'], 2);
      assert.strictEqual(server.state.ifNoneMatchSeen['/.well-known/brand.json'][1], 'stable-v1');
      // JWKS endpoint was never refetched.
      assert.strictEqual(server.state.hits['/.well-known/jwks.json'], 1);
    } finally {
      await server.stop();
    }
  });
});
