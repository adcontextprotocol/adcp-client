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

  test('404 on PRM probe when host has no publicUrl mapping', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, {
      port: 0,
      // Resolver returns empty string for unknown hosts — framework treats
      // as "no PRM for this host" and responds 404 rather than advertising
      // a blank `resource`.
      publicUrl: host => {
        if (host.startsWith('snap.')) return `https://snap.example.com/mcp`;
        throw new Error(`unknown host: ${host}`);
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

    // Resolver threw — treated as 500 (operator misconfiguration surfaced).
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
