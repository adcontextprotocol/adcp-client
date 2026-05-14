/**
 * Tests for `probeAuthChallenge` — the scheme-detector that powers the
 * Basic-aware `AuthenticationRequiredError` envelope.
 *
 * Verifies:
 *   - 401 with `WWW-Authenticate: Basic` → returns parsed challenge with
 *     `scheme: 'basic'` (the gateway-fronted-agent case)
 *   - 401 with `WWW-Authenticate: Bearer` → returns parsed Bearer challenge
 *     (so the OAuth path can also branch on it if needed)
 *   - 200 OK → returns null (no 401, nothing to surface)
 *   - 401 with no `WWW-Authenticate` header → returns null (nothing parseable)
 *   - Server unreachable → returns null (handled gracefully)
 *
 * Spins up a local HTTP server per test (port 0, 127.0.0.1) so the SSRF gate
 * accepts the request with `allowPrivateIp: true`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { probeAuthChallenge } = require('../../dist/lib/auth/oauth');

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    await fn(url);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
  }
}

describe('probeAuthChallenge', () => {
  test('401 with WWW-Authenticate: Basic returns parsed Basic challenge', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Apigee API"' });
        res.end('Unauthorized');
      },
      async url => {
        const challenge = await probeAuthChallenge(url, { allowPrivateIp: true });
        assert.ok(challenge, 'expected a parsed challenge');
        assert.strictEqual(challenge.scheme, 'basic');
        assert.strictEqual(challenge.realm, 'Apigee API');
      }
    );
  });

  test('401 with WWW-Authenticate: Bearer returns parsed Bearer challenge', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(401, {
          'WWW-Authenticate':
            'Bearer realm="example", error="invalid_token", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
        });
        res.end('Unauthorized');
      },
      async url => {
        const challenge = await probeAuthChallenge(url, { allowPrivateIp: true });
        assert.ok(challenge);
        assert.strictEqual(challenge.scheme, 'bearer');
        assert.strictEqual(challenge.error, 'invalid_token');
        assert.strictEqual(challenge.resource_metadata, 'https://api.example.com/.well-known/oauth-protected-resource');
      }
    );
  });

  test('200 OK returns null (not a 401, nothing to surface)', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
      },
      async url => {
        const challenge = await probeAuthChallenge(url, { allowPrivateIp: true });
        assert.strictEqual(challenge, null);
      }
    );
  });

  test('401 with no WWW-Authenticate header returns null (nothing parseable)', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(401);
        res.end('Unauthorized');
      },
      async url => {
        const challenge = await probeAuthChallenge(url, { allowPrivateIp: true });
        assert.strictEqual(challenge, null);
      }
    );
  });

  test('unreachable server returns null gracefully', async () => {
    // Pick a likely-closed port on localhost. The SSRF-safe fetch handles the
    // connection error and `probeAgent401` swallows it, so we should get null.
    const challenge = await probeAuthChallenge('http://127.0.0.1:1/mcp', {
      allowPrivateIp: true,
      timeoutMs: 1000,
    });
    assert.strictEqual(challenge, null);
  });
});
