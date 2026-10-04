const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateKeyPairSync } = require('node:crypto');
const {
  resolveAgent,
  AgentResolverError,
  verifyWebhookSignature,
  signWebhook,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../dist/lib/signing');
const { SafeFetchError } = require('../dist/lib/signing/agent-resolver/fetch-helpers');
const { AgentTransportPolicyError } = require('../dist/lib/net/agent-transport-fetch');

const cases = [
  [new SafeFetchError('capabilities', 'ssrf_refused', 'private'), 'ssrf_refused', undefined, false],
  [new SafeFetchError('capabilities', 'fetch_failed', 'no', 401), 'fetch_failed', 401, false],
  [new SafeFetchError('capabilities', 'fetch_failed', 'no', 404), 'fetch_failed', 404, false],
  [new SafeFetchError('capabilities', 'fetch_failed', 'no', 503), 'fetch_failed', 503, true],
  [Object.assign(new Error('dns'), { code: 'ENOTFOUND' }), 'dns_error', undefined, true],
  [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'timeout', undefined, true],
  [new AgentTransportPolicyError('private topology must not leak'), 'ssrf_refused', undefined, false],
];
test('capabilities failures retain coarse structured causes and recovery', async () => {
  for (const [cause, transport, status, retryable] of cases) {
    await assert.rejects(
      resolveAgent('https://agent.example/mcp', {
        fetchCapabilities: async () => {
          throw cause;
        },
      }),
      error => {
        assert.equal(error.code, 'request_signature_capabilities_unreachable');
        assert.equal(error.detail.dns_error, transport);
        assert.equal(error.detail.http_status, status);
        assert.equal(error.recovery, retryable ? 'transient' : 'terminal');
        assert.equal(JSON.stringify(error.detail).includes('topology'), false);
        return true;
      }
    );
  }
});
test('default capability transport rejects non-HTTPS and always-blocked origins permanently', async () => {
  for (const agent of ['http://agent.example/mcp', 'https://169.254.169.254/mcp']) {
    await assert.rejects(resolveAgent(agent), error => {
      assert.equal(error.code, 'request_signature_capabilities_unreachable');
      assert.equal(error.detail.dns_error, 'ssrf_refused');
      assert.equal(error.recovery, 'terminal');
      return true;
    });
  }
});
test('real brand.json HTTP 4xx are terminal while 5xx remains transient', async t => {
  let status = 404;
  const server = http.createServer((req, res) => {
    res.writeHead(status);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const agent = `http://127.0.0.1:${server.address().port}/mcp`;
  for (status of [401, 403, 404, 408, 410, 429, 500, 503]) {
    await assert.rejects(
      resolveAgent(agent, {
        allowPrivateIp: true,
        fetchCapabilities: async () => ({
          identity: { brand_json_url: new URL('/.well-known/brand.json', agent).href },
        }),
      }),
      error => {
        assert.equal(error.code, 'request_signature_brand_json_unreachable');
        assert.equal(error.detail.http_status, status);
        assert.equal(error.recovery, status < 500 ? 'terminal' : 'transient');
        return true;
      }
    );
  }
});
test('default official MCP capability discovery preserves HTTP rejection status', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(403);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const agent = `http://127.0.0.1:${server.address().port}/mcp`;
  await assert.rejects(resolveAgent(agent, { allowPrivateIp: true }), error => {
    assert.equal(error.detail.http_status, 403);
    assert.equal(error.recovery, 'terminal');
    return true;
  });
});
test('webhook retryability uses the discovery cause rather than unconditional code metadata', async () => {
  const now = Math.floor(Date.now() / 1000);
  const { privateKey } = generateKeyPairSync('ed25519');
  const key = privateKey.export({ format: 'jwk' });
  const request = {
    method: 'POST',
    url: 'https://buyer.example/webhook',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  };
  const signed = signWebhook(
    request,
    { keyid: 'key', alg: 'ed25519', privateKey: { ...key, adcp_use: 'request-signing' } },
    { now: () => now }
  );
  for (const code of ['request_signature_capabilities_unreachable', 'request_signature_brand_json_unreachable']) {
    for (const [detail, retryable] of [
      [{ dns_error: 'ssrf_refused' }, false],
      [{ http_status: 404 }, false],
      [{ http_status: 503 }, true],
      [{ dns_error: 'dns_error' }, true],
    ]) {
      await assert.rejects(
        verifyWebhookSignature(
          { ...request, headers: { ...request.headers, ...signed.headers } },
          {
            jwks: {
              resolve: async () => {
                throw new AgentResolverError(code, 'discovery failed', detail);
              },
            },
            replayStore: new InMemoryReplayStore(),
            revocationStore: new InMemoryRevocationStore(),
            now: () => now,
          }
        ),
        error => {
          assert.equal(error.code, 'webhook_signature_key_unknown');
          assert.equal(error.retryable, retryable);
          return true;
        }
      );
    }
  }
});

test('legacy brand lookup preserves policy refusal while DNS failure remains transient', async () => {
  for (const [lookup, recovery, cause] of [
    [async () => [{ address: '127.0.0.1', family: 4 }], 'terminal', 'ssrf_refused'],
    [
      async () => {
        throw Object.assign(new Error('dns failed'), { code: 'ENOTFOUND' });
      },
      'transient',
      'dns_error',
    ],
  ]) {
    await assert.rejects(
      resolveAgent('https://seller.example.com/mcp', {
        legacyWebhookFallback: true,
        fetchCapabilities: async () => ({ adcp_version: '3.1.0' }),
        lookup,
      }),
      error => {
        assert.equal(error.code, 'request_signature_brand_json_unreachable');
        assert.equal(error.recovery, recovery);
        assert.equal(error.detail.dns_error, cause);
        return true;
      }
    );
  }
});

test('MCP legacy fallback cannot replace a POST 503 with a GET 404', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.method === 'POST' ? 503 : 404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(
    resolveAgent(`http://127.0.0.1:${server.address().port}/mcp`, { allowPrivateIp: true }),
    error => {
      assert.equal(error.recovery, 'transient');
      assert.equal(error.detail.http_status, 503);
      return true;
    }
  );
});

test('permanent onboarding errors stay permanent throughout the resolver cooldown', async t => {
  const { BrandJsonJwksResolver } = require('../dist/lib/signing');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const resolver = new BrandJsonJwksResolver(`http://127.0.0.1:${server.address().port}/brand.json`, {
    agentType: 'sales',
    allowPrivateIp: true,
    now: () => 1000,
  });
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(resolver.resolve('key'), error => {
      assert.equal(error.recovery, 'terminal');
      assert.equal(error.httpStatus, 404);
      return true;
    });
  assert.equal(requests, 1);
});
