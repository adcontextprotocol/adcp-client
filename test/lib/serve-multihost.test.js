const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const http = require('http');

/**
 * Exercises the multi-host `serve()` surface: function-form `publicUrl`
 * and `protectedResource`, `ServeContext.host` threading, per-host PRM
 * caching, and the `trustForwardedHost` opt-in for `X-Forwarded-Host`.
 *
 * Tests cover the wire shape operators will actually see under a
 * reverse-proxy in front of a multi-tenant Node process.
 */

function request(port, { path = '/mcp', method = 'POST', host, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== undefined) h.host = host;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: h }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForListening(server) {
  return new Promise(resolve => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

describe('serve() multi-host', () => {
  let serve;
  let McpServer;

  before(() => {
    const lib = require('../../dist/lib/index.js');
    serve = lib.serve;
    const mcp = require('@modelcontextprotocol/sdk/server/mcp.js');
    McpServer = mcp.McpServer;
  });

  test('passes resolved host to factory ctx', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };

    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `seller-a.example.com:${port}` });
    await request(port, { host: `seller-b.example.com:${port}` });
    await request(port, { host: `SELLER-A.EXAMPLE.COM:${port}` });

    // Host header is lowercased, port preserved.
    assert.deepStrictEqual(seen.sort(), [
      `seller-a.example.com:${port}`,
      `seller-a.example.com:${port}`,
      `seller-b.example.com:${port}`,
    ]);

    server.close();
  });

  test('function-form publicUrl advertises per-host resource', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const resA = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    const resB = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `meta.example.com:${port}`,
    });

    assert.strictEqual(resA.status, 200);
    assert.strictEqual(resB.status, 200);
    const bodyA = JSON.parse(resA.body);
    const bodyB = JSON.parse(resB.body);
    assert.strictEqual(bodyA.resource, 'https://snap.example.com/mcp');
    assert.strictEqual(bodyB.resource, 'https://meta.example.com/mcp');
    // authorization_servers still comes from the static PRM object.
    assert.deepStrictEqual(bodyA.authorization_servers, ['https://auth.example.com']);
    assert.deepStrictEqual(bodyB.authorization_servers, ['https://auth.example.com']);

    server.close();
  });

  test('function-form protectedResource returns per-host PRM', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      protectedResource: host => ({
        authorization_servers: [`https://${host.split(':')[0]}/oauth`],
        scopes_supported: ['read', 'write'],
      }),
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });

    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepStrictEqual(body.authorization_servers, ['https://snap.example.com/oauth']);
    assert.deepStrictEqual(body.scopes_supported, ['read', 'write']);

    server.close();
  });

  test('caches resolvers per host (called once per unique host)', async () => {
    const publicUrlCalls = [];
    const prmCalls = [];
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => {
        publicUrlCalls.push(host);
        return `https://${host.split(':')[0]}/mcp`;
      },
      protectedResource: host => {
        prmCalls.push(host);
        return { authorization_servers: [`https://${host.split(':')[0]}/oauth`] };
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `meta.example.com:${port}`,
    });

    // Each resolver called exactly once per unique host — the 2x snap
    // request shares the cache entry from the first.
    assert.deepStrictEqual(publicUrlCalls.sort(), [`meta.example.com:${port}`, `snap.example.com:${port}`]);
    assert.deepStrictEqual(prmCalls.sort(), [`meta.example.com:${port}`, `snap.example.com:${port}`]);

    server.close();
  });

  test('invalid publicUrl path per host surfaces as 500', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      // Returns a publicUrl whose path does NOT match the mount path.
      // The framework fails closed rather than advertising a mismatched
      // `resource` URL that would mint audience-mismatched tokens.
      publicUrl: host => `https://${host.split(':')[0]}/wrong-path`,
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });

    assert.strictEqual(res.status, 500);

    server.close();
  });

  test('ignores X-Forwarded-Host without trustForwardedHost', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `real.example.com:${port}`,
      headers: { 'x-forwarded-host': 'attacker.example.com' },
    });

    assert.strictEqual(seen[0], `real.example.com:${port}`);

    server.close();
  });

  test('honors X-Forwarded-Host when trustForwardedHost: true', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: { 'x-forwarded-host': 'snap.example.com' },
    });

    assert.strictEqual(seen[0], 'snap.example.com');

    server.close();
  });

  test('X-Forwarded-Host chain picks first entry (client-reported origin)', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: { 'x-forwarded-host': 'snap.example.com, cdn.example.com, edge.example.com' },
    });

    assert.strictEqual(seen[0], 'snap.example.com');

    server.close();
  });

  test('generic resolver throw (not UnknownHostError) surfaces as 500 on PRM probe', async () => {
    // For UnknownHostError → 404 routing, see the dedicated tests that
    // throw `UnknownHostError`. This test pins the OTHER branch: a
    // resolver that throws a plain `Error` is a real bug, so the
    // framework surfaces it loudly as 500 rather than hiding it behind
    // a 404.
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => {
        if (host.startsWith('snap.')) return `https://snap.example.com/mcp`;
        throw new Error(`unknown host: ${host}`); // plain Error, NOT UnknownHostError
      },
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `unknown.example.com:${port}`,
    });

    assert.strictEqual(res.status, 500);

    server.close();
  });

  test('static publicUrl still works (backward compat)', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: 'https://my-agent.example.com/mcp',
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const resA = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    const resB = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `meta.example.com:${port}`,
    });

    // Both hosts see the same static `resource` — that's the pre-multi-host
    // behavior, preserved when the caller doesn't opt in to per-host.
    assert.strictEqual(JSON.parse(resA.body).resource, 'https://my-agent.example.com/mcp');
    assert.strictEqual(JSON.parse(resB.body).resource, 'https://my-agent.example.com/mcp');

    server.close();
  });

  test('UnknownHostError from factory maps to 404 (not 500)', async () => {
    const { UnknownHostError } = require('../../dist/lib/index.js');
    const factory = ctx => {
      if (ctx.host.startsWith('known.')) return new McpServer({ name: 'Test', version: '1.0.0' });
      throw new UnknownHostError(`no adapter for ${ctx.host}`);
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, { host: `unknown.example.com:${port}` });
    assert.strictEqual(res.status, 404, 'UnknownHostError must map to 404');
    // Body is a generic "Not found" — the routing table never crosses the wire.
    assert.ok(!res.body.includes('unknown.example.com'), 'host must not appear in 404 body');

    server.close();
  });

  test('UnknownHostError from publicUrl resolver maps to 404 on PRM probe', async () => {
    const { UnknownHostError } = require('../../dist/lib/index.js');
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => {
        if (host.startsWith('known.')) return `https://${host.split(':')[0]}/mcp`;
        throw new UnknownHostError(host);
      },
      protectedResource: { authorization_servers: ['https://auth.example.com'] },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const res = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `unknown.example.com:${port}`,
    });
    assert.strictEqual(res.status, 404);

    server.close();
  });

  test('ServeRequestContext stamped on req before authenticate runs', async () => {
    const { getServeRequestContext } = require('../../dist/lib/index.js');
    const seen = [];
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      authenticate: req => {
        seen.push(getServeRequestContext(req));
        return { principal: 'test' };
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `snap.example.com:${port}` });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].host, `snap.example.com:${port}`);
    assert.strictEqual(seen[0].publicUrl, 'https://snap.example.com/mcp');

    server.close();
  });

  test('resolveHost() export matches serve()s internal resolution', () => {
    const { resolveHost } = require('../../dist/lib/index.js');

    // Default (no options) ignores X-Forwarded-Host.
    assert.strictEqual(
      resolveHost({ headers: { host: 'real.example.com', 'x-forwarded-host': 'attacker.example.com' } }),
      'real.example.com'
    );

    // Options-bag, trustForwardedHost: false — same as default.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'real.example.com', 'x-forwarded-host': 'attacker.example.com' } },
        { trustForwardedHost: false }
      ),
      'real.example.com'
    );

    // Trust on: X-Forwarded-Host wins.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'internal.fly', 'x-forwarded-host': 'snap.example.com' } },
        { trustForwardedHost: true }
      ),
      'snap.example.com'
    );

    // Trust on: X-Forwarded-Host first-entry wins, lowercase, port preserved.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'internal.fly', 'x-forwarded-host': 'SNAP.example.com:8443, cdn.example.com' } },
        { trustForwardedHost: true }
      ),
      'snap.example.com:8443'
    );

    // Trust on: RFC 7239 Forwarded fallback.
    assert.strictEqual(
      resolveHost(
        { headers: { host: 'internal.fly', forwarded: 'host=snap.example.com' } },
        { trustForwardedHost: true }
      ),
      'snap.example.com'
    );

    // Empty on no Host header at all.
    assert.strictEqual(resolveHost({ headers: {} }, { trustForwardedHost: true }), '');
  });

  test('hostname() helper strips port (including IPv6 brackets)', () => {
    const { hostname } = require('../../dist/lib/index.js');
    assert.strictEqual(hostname('snap.example.com'), 'snap.example.com');
    assert.strictEqual(hostname('snap.example.com:3001'), 'snap.example.com');
    assert.strictEqual(hostname('[::1]'), '[::1]');
    assert.strictEqual(hostname('[::1]:3001'), '[::1]');
    assert.strictEqual(hostname('[2001:db8::1]:8080'), '[2001:db8::1]');
  });

  test('honors RFC 7239 Forwarded: host= when trustForwardedHost: true', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: { forwarded: 'for=1.2.3.4;host=snap.example.com;proto=https' },
    });

    assert.strictEqual(seen[0], 'snap.example.com');

    server.close();
  });

  test('RFC 7239 Forwarded: picks first hop, strips quotes, handles IPv6', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    // Quoted host (RFC 7239 §4 — IPv6 and hosts-with-ports must be quoted).
    await request(port, {
      host: `internal.fly:${port}`,
      headers: { forwarded: 'host="snap.example.com:8443"' },
    });
    assert.strictEqual(seen[0], 'snap.example.com:8443');

    // Multi-hop — first entry is the client-facing proxy.
    await request(port, {
      host: `internal.fly:${port}`,
      headers: { forwarded: 'for=1;host=first.example, for=2;host=second.example' },
    });
    assert.strictEqual(seen[1], 'first.example');

    server.close();
  });

  test('X-Forwarded-Host takes precedence over Forwarded: when both set', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      trustForwardedHost: true,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `internal.fly:${port}`,
      headers: {
        'x-forwarded-host': 'xfh.example.com',
        forwarded: 'host=forwarded.example.com',
      },
    });
    assert.strictEqual(seen[0], 'xfh.example.com');

    server.close();
  });

  test('RFC 7239 ignored when trustForwardedHost: false', async () => {
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, {
      host: `real.example.com:${port}`,
      headers: { forwarded: 'host=attacker.example.com' },
    });
    assert.strictEqual(seen[0], `real.example.com:${port}`);

    server.close();
  });

  test('reuseAgent: true lets the factory cache per-host servers across requests', async () => {
    const constructed = [];
    const returned = [];
    const cache = new Map();
    const factory = ctx => {
      let agent = cache.get(ctx.host);
      if (!agent) {
        constructed.push(ctx.host);
        agent = new McpServer({ name: `Agent for ${ctx.host}`, version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      returned.push(ctx.host);
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    // 4 requests across 2 hosts. Factory called 4 times (still per-request),
    // but constructAdcpServer runs only 2 times (one per unique host).
    await request(port, { host: `snap.example.com:${port}` });
    await request(port, { host: `meta.example.com:${port}` });
    await request(port, { host: `snap.example.com:${port}` });
    await request(port, { host: `meta.example.com:${port}` });

    assert.strictEqual(returned.length, 4, 'factory called once per request');
    assert.deepStrictEqual(
      constructed.sort(),
      [`meta.example.com:${port}`, `snap.example.com:${port}`],
      'server constructed exactly once per unique host'
    );

    server.close();
  });

  test('reuseAgent: true serializes concurrent requests on the same cached server', async () => {
    // Two concurrent requests to the same host. Without the mutex,
    // MCP SDK's Protocol.connect() throws "Already connected to a
    // transport" on the second. With the mutex, they serialize and
    // both succeed.
    const cache = new Map();
    const factory = ctx => {
      let agent = cache.get(ctx.host);
      if (!agent) {
        agent = new McpServer({ name: `Agent for ${ctx.host}`, version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    // 4 concurrent requests on the same host — must all complete without
    // "Already connected" errors crashing the handler.
    const results = await Promise.all([
      request(port, { host: `snap.example.com:${port}` }),
      request(port, { host: `snap.example.com:${port}` }),
      request(port, { host: `snap.example.com:${port}` }),
      request(port, { host: `snap.example.com:${port}` }),
    ]);
    for (const res of results) {
      // All 4 should be status 2xx/4xx from MCP (depending on body), not
      // 500 from the framework. 500 would mean the mutex broke.
      assert.notStrictEqual(res.status, 500, `unexpected 500 — response body: ${res.body}`);
    }

    server.close();
  });

  test('reuseAgent: true concurrent requests on DIFFERENT cached servers run in parallel', async () => {
    // Mutex is keyed on server INSTANCE. Two requests on different hosts
    // (different cached servers) should NOT serialize against each other.
    // Verified by checking that the framework invokes each factory twice
    // across the two hosts — a global mutex would still serialize but
    // would still produce the same count, so this test is by shape
    // (cache-one-per-host) not by wall-clock timing.
    const cache = new Map();
    const entryLog = [];
    const factory = ctx => {
      let agent = cache.get(ctx.host);
      if (!agent) {
        agent = new McpServer({ name: `Agent for ${ctx.host}`, version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      entryLog.push(ctx.host);
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await Promise.all([
      request(port, { host: `a.example.com:${port}` }),
      request(port, { host: `a.example.com:${port}` }),
      request(port, { host: `b.example.com:${port}` }),
      request(port, { host: `b.example.com:${port}` }),
    ]);

    assert.strictEqual(entryLog.length, 4);
    assert.strictEqual(entryLog.filter(h => h.startsWith('a.')).length, 2);
    assert.strictEqual(entryLog.filter(h => h.startsWith('b.')).length, 2);
    // Only 2 UNIQUE servers were ever constructed — one per host.
    assert.strictEqual(cache.size, 2);

    server.close();
  });

  test('reuseAgent: true — same cached server instance handles sequential requests', async () => {
    // Pin the reuse contract explicitly: across multiple sequential
    // requests on the same host, the factory returns the SAME server
    // reference every time. If the framework's internal close() ever
    // rendered the cached instance dead (it does not, per MCP SDK's
    // Protocol._onclose only clearing `_transport`), this assertion
    // catches the regression.
    const returned = new Set();
    const mcp = new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(
      () => {
        returned.add(mcp);
        return mcp;
      },
      { port: 0, reuseAgent: true, onListening: () => {} }
    );
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `host.example.com:${port}` });
    await request(port, { host: `host.example.com:${port}` });
    await request(port, { host: `host.example.com:${port}` });

    // One reference across three requests — not a fresh instance each time.
    assert.strictEqual(returned.size, 1);

    server.close();
  });

  test('reuseAgent: false (default) still creates fresh server per request', async () => {
    const constructed = [];
    const factory = ctx => {
      constructed.push(ctx.host);
      return new McpServer({ name: 'fresh', version: '1.0.0' });
    };
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await request(port, { host: `a.example.com:${port}` });
    await request(port, { host: `a.example.com:${port}` });

    // Two requests → two constructions. Default behavior preserved.
    assert.strictEqual(constructed.length, 2);

    server.close();
  });

  test('reuseAgent: true isolates auth context across requests on the shared server', async () => {
    // Critical safety check: when an AdcpServer is shared across
    // requests, per-request `authInfo` MUST come from the MCP
    // transport per invocation (via RequestHandlerExtra.authInfo) and
    // NEVER be captured on the server instance. If it bled, request
    // 1's token would authorize request 2's tool call. The MCP SDK's
    // contract is that `extra.authInfo` is populated from `req.auth`
    // per-invocation — this test holds that guarantee for our reuse
    // mode.
    //
    // Uses a bare McpServer with a tool that has no input schema so we
    // can observe `extra.authInfo` directly, avoiding AdCP's
    // schema-validated dispatch path.
    const seenAuth = [];
    const mcp = new McpServer({ name: 'Test', version: '1.0.0' });
    // inputSchema MUST be present — without it, the MCP SDK calls the
    // handler as `(extra)` rather than `(args, extra)` (mcp.js:238),
    // and our observation would see `authInfo: undefined` in what we
    // thought was `extra`.
    mcp.registerTool(
      'observe_auth',
      { description: 'returns authInfo seen', inputSchema: {} },
      async (_args, extra) => {
        seenAuth.push({
          clientId: extra?.authInfo?.clientId ?? null,
          token: extra?.authInfo?.token ?? null,
        });
        return { content: [{ type: 'text', text: 'ok' }] };
      }
    );

    let callNum = 0;
    const server = serve(() => mcp, {
      port: 0,
      reuseAgent: true,
      // Mint a distinct principal per request. Request 1 → principal_1,
      // request 2 → principal_2. If the dispatcher captured request 1's
      // authInfo on the instance, request 2 would see principal_1.
      authenticate: () => {
        callNum++;
        return { principal: `principal_${callNum}`, token: `token_${callNum}` };
      },
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    const callObserve = () =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'observe_auth', arguments: {} },
        });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'content-length': Buffer.byteLength(body),
              host: `test.example.com:${port}`,
            },
          },
          res => {
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          }
        );
        req.on('error', reject);
        req.end(body);
      });

    await callObserve();
    await callObserve();

    assert.strictEqual(seenAuth.length, 2, `expected 2 handler invocations, got ${seenAuth.length}`);
    assert.strictEqual(seenAuth[0].clientId, 'principal_1', 'request 1 must see principal 1');
    assert.strictEqual(
      seenAuth[1].clientId,
      'principal_2',
      'request 2 must see principal 2 (not the leaked principal 1 from the prior call)'
    );
    assert.strictEqual(seenAuth[0].token, 'token_1');
    assert.strictEqual(seenAuth[1].token, 'token_2');

    server.close();
  });

  test('reuseAgent: true, factory throw in one request does not poison subsequent requests', async () => {
    // If the first request rejects somewhere in the chain, the mutex
    // must not leave the cached server in a locked state — subsequent
    // requests should still acquire and proceed.
    const cache = new Map();
    let failNext = true;
    const factory = ctx => {
      if (failNext) {
        failNext = false;
        throw new Error('synthetic factory failure');
      }
      let agent = cache.get(ctx.host);
      if (!agent) {
        agent = new McpServer({ name: 'Test', version: '1.0.0' });
        cache.set(ctx.host, agent);
      }
      return agent;
    };
    const server = serve(factory, { port: 0, reuseAgent: true, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    // First request — factory throws, server 500s.
    const r1 = await request(port, { host: `snap.example.com:${port}` });
    assert.strictEqual(r1.status, 500);

    // Second request — factory succeeds, mutex chain should be healthy.
    const r2 = await request(port, { host: `snap.example.com:${port}` });
    assert.notStrictEqual(r2.status, 500, 'subsequent request must not be blocked by the prior failure');

    server.close();
  });

  test('function-form publicUrl with no protectedResource is allowed', async () => {
    // publicUrl-only mode (no PRM advertising). Factory sees the host so
    // an adapter can pick a handler set without ever publishing OAuth.
    const seen = [];
    const factory = ctx => {
      seen.push(ctx.host);
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };
    const server = serve(factory, {
      port: 0,
      publicUrl: host => `https://${host.split(':')[0]}/mcp`,
      onListening: () => {},
    });
    await waitForListening(server);
    const port = server.address().port;

    // No PRM route served.
    const prmRes = await request(port, {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/mcp',
      host: `snap.example.com:${port}`,
    });
    assert.strictEqual(prmRes.status, 404);

    // MCP mount still routes and threads host.
    await request(port, { host: `snap.example.com:${port}` });
    assert.strictEqual(seen[0], `snap.example.com:${port}`);

    server.close();
  });
});
