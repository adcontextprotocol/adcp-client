/** Capability-confirmed URL binding and low-level SSRF-safe brand.json fetching.
 * Canonical selection, rotation, pinning and fallback regressions live in
 * agent-resolution-3.3.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { BrandJsonJwksResolver, BrandJsonResolverError, fetchBrandJson } = require('../dist/lib/signing');

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
    const h = { 'content-type': route.contentType ?? 'application/json', ...route.headers };
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
  it('keeps existing constructor configurations source-compatible', () => {
    assert.doesNotThrow(
      () =>
        new BrandJsonJwksResolver('https://seller.example/brand.json', {
          agentType: 'sales',
          agentId: 'sales-1',
          brandId: 'legacy-brand',
          jwksOptions: { failClosed: true, minCacheAgeSeconds: 60 },
        })
    );
  });

  it('exports the bounded brand.json fetcher with the protocol body allowance', async () => {
    const payload = JSON.stringify({ agents: [], padding: 'x'.repeat(70 * 1024) });
    const server = await startServer({
      '/.well-known/brand.json': { body: payload },
    });
    try {
      const fetched = await fetchBrandJson({
        startUrl: `${server.origin}/.well-known/brand.json`,
        allowPrivateIp: true,
      });
      assert.strictEqual(fetched.status, 'ok');
      assert.strictEqual(fetched.finalUrl, `${server.origin}/.well-known/brand.json`);
      assert.strictEqual(fetched.data.padding.length, 70 * 1024);
    } finally {
      await server.stop();
    }
  });

  it('surfaces HTTP status without message parsing', async () => {
    const server = await startServer({
      '/.well-known/brand.json': { status: 404, body: { error: 'missing' } },
    });
    try {
      await assert.rejects(
        () =>
          fetchBrandJson({
            startUrl: `${server.origin}/.well-known/brand.json`,
            allowPrivateIp: true,
          }),
        err => {
          assert.ok(err instanceof BrandJsonResolverError);
          assert.strictEqual(err.code, 'fetch_failed');
          assert.strictEqual(err.httpStatus, 404);
          return true;
        }
      );
    } finally {
      await server.stop();
    }
  });

  it('refuses transport redirects instead of following them', async () => {
    const server = await startServer({
      '/.well-known/brand.json': { status: 302, headers: { location: '/redirected.json' }, body: '' },
      '/redirected.json': { body: { agents: [] } },
    });
    try {
      await assert.rejects(
        () =>
          fetchBrandJson({
            startUrl: `${server.origin}/.well-known/brand.json`,
            allowPrivateIp: true,
          }),
        err => err instanceof BrandJsonResolverError && err.httpStatus === 302
      );
      assert.strictEqual(server.state.hits['/redirected.json'], 0);
    } finally {
      await server.stop();
    }
  });

  it('normalizes transport failures to the typed public error', async () => {
    const server = await startServer({ '/.well-known/brand.json': { body: { agents: [] } } });
    const url = `${server.origin}/.well-known/brand.json`;
    await server.stop();
    await assert.rejects(
      () => fetchBrandJson({ startUrl: url, allowPrivateIp: true }),
      err => {
        assert.ok(err instanceof BrandJsonResolverError);
        assert.strictEqual(err.code, 'fetch_failed');
        assert.strictEqual(err.message, 'Unable to fetch brand.json');
        assert.ok(err.cause instanceof Error);
        return true;
      }
    );
  });

  it('enforces hard ceilings on public fetch overrides', async () => {
    await assert.rejects(
      () => fetchBrandJson({ startUrl: 'https://example.com/brand.json', timeoutMs: 10_001 }),
      /timeoutMs must be an integer between 1 and 10000/
    );
    await assert.rejects(
      () => fetchBrandJson({ startUrl: 'https://example.com/brand.json', maxBodyBytes: 262_145 }),
      /maxBodyBytes must be an integer between 1 and 262144/
    );
  });
});
