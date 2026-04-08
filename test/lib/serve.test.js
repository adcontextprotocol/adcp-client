const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

function makeRequest(port, path = '/mcp', method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function waitForListening(server) {
  return new Promise((resolve) => {
    if (server.listening) return resolve();
    server.on('listening', resolve);
  });
}

describe('serve()', () => {
  let serve;
  let McpServer;

  before(() => {
    const lib = require('../../dist/lib/index.js');
    serve = lib.serve;
    const mcp = require('@modelcontextprotocol/sdk/server/mcp.js');
    McpServer = mcp.McpServer;
  });

  test('calls factory function per request', async () => {
    let callCount = 0;
    const factory = () => {
      callCount++;
      return new McpServer({ name: 'Test', version: '1.0.0' });
    };

    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    await makeRequest(port, '/mcp');
    await makeRequest(port, '/mcp');
    assert.strictEqual(callCount, 2, 'factory should be called once per request');

    server.close();
  });

  test('matches path with trailing slash', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const res = await makeRequest(port, '/mcp/');
    // Should not be 404 — it reached the MCP handler (may error, but not 404)
    assert.notStrictEqual(res.status, 404, '/mcp/ should match the mount path');

    server.close();
  });

  test('matches path with query string', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const res = await makeRequest(port, '/mcp?foo=bar');
    assert.notStrictEqual(res.status, 404, '/mcp?foo=bar should match the mount path');

    server.close();
  });

  test('returns 404 for non-matching paths', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const res = await makeRequest(port, '/other');
    assert.strictEqual(res.status, 404);

    server.close();
  });

  test('custom path option', async () => {
    const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
    const server = serve(factory, { port: 0, path: '/v1/agent', onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const notFound = await makeRequest(port, '/mcp');
    assert.strictEqual(notFound.status, 404, 'default /mcp should 404 with custom path');

    const found = await makeRequest(port, '/v1/agent');
    assert.notStrictEqual(found.status, 404, 'custom path should match');

    server.close();
  });

  test('onListening callback receives URL', async () => {
    const received = new Promise((resolve) => {
      const factory = () => new McpServer({ name: 'Test', version: '1.0.0' });
      const server = serve(factory, {
        port: 0,
        onListening: (url) => { resolve({ url, server }); },
      });
    });
    const { url, server } = await received;
    const port = server.address().port;
    assert.strictEqual(url, `http://localhost:${port}/mcp`);

    server.close();
  });

  test('invalid PORT env var throws', () => {
    const original = process.env.PORT;
    try {
      process.env.PORT = 'not-a-number';
      assert.throws(
        () => serve(() => new McpServer({ name: 'Test', version: '1.0.0' })),
        /Invalid PORT/,
      );
    } finally {
      if (original !== undefined) {
        process.env.PORT = original;
      } else {
        delete process.env.PORT;
      }
    }
  });

  test('server error returns 500 not crash', async () => {
    const factory = () => {
      const s = new McpServer({ name: 'Test', version: '1.0.0' });
      // Override connect to throw
      s.connect = async () => { throw new Error('boom'); };
      return s;
    };

    const server = serve(factory, { port: 0, onListening: () => {} });
    await waitForListening(server);
    const port = server.address().port;

    const res = await makeRequest(port, '/mcp');
    assert.strictEqual(res.status, 500);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, 'Internal server error');

    server.close();
  });
});
