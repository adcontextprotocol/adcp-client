const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { serve, createAdcpServer, InMemoryStateStore, ADCP_PRE_TRANSPORT } = require('../dist/lib/server/index.js');
const { StaticJwksResolver, InMemoryReplayStore, InMemoryRevocationStore } = require('../dist/lib/signing/server.js');
const { signRequest } = require('../dist/lib/signing/signer.js');

// ---------------------------------------------------------------------------
// Test vector: ed25519 keypair pulled from the shared compliance cache.
// The private half is used to sign a valid MCP tools/call request so the
// verifier inside serve() can be exercised end-to-end.
// ---------------------------------------------------------------------------

const KEYS_PATH = path.join(
  __dirname,
  '..',
  'compliance',
  'cache',
  'latest',
  'test-vectors',
  'request-signing',
  'keys.json'
);

const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys;
const edRaw = keys.find(k => k.kid === 'test-ed25519-2026');
const edPublic = { ...edRaw };
delete edPublic._private_d_for_test_only;
delete edPublic.d;
const edPrivate = { ...edRaw, d: edRaw._private_d_for_test_only };
delete edPrivate._private_d_for_test_only;
delete edPrivate.key_ops;
delete edPrivate.use;

function makeStores() {
  return {
    jwks: new StaticJwksResolver([edPublic]),
    replayStore: new InMemoryReplayStore({ maxEntriesPerKeyid: 100 }),
    revocationStore: new InMemoryRevocationStore({
      issuer: 'http://seller.example.com',
      updated: new Date().toISOString(),
      next_update: new Date(Date.now() + 3600_000).toISOString(),
      revoked_kids: [],
      revoked_jtis: [],
    }),
  };
}

function sellerConfig({
  withSignedRequests = true,
  withSpecialism = true,
  capabilityRequestSigning,
  signedRequestsRequiredFor = ['create_media_buy'],
} = {}) {
  const defaultRequestSigning = {
    supported: true,
    covers_content_digest: 'either',
    required_for: ['create_media_buy'],
  };
  const config = {
    name: 'Auto-Signed Seller',
    version: '1.0.0',
    stateStore: new InMemoryStateStore(),
    mediaBuy: {
      getProducts: async () => ({ products: [] }),
      createMediaBuy: async params => ({
        media_buy_id: 'mb-123',
        status: 'active',
        confirmed_at: new Date().toISOString(),
        revision: 1,
        packages: (params.packages ?? []).map(pkg => ({
          package_id: pkg.package_id,
          status: 'active',
        })),
      }),
      updateMediaBuy: async () => ({
        media_buy_id: 'mb-123',
        status: 'active',
        confirmed_at: new Date().toISOString(),
        revision: 2,
        packages: [],
      }),
    },
    capabilities: {
      features: { inlineCreativeManagement: false },
      request_signing: capabilityRequestSigning === undefined ? defaultRequestSigning : capabilityRequestSigning,
      specialisms: withSpecialism ? ['signed-requests'] : [],
    },
  };
  if (withSignedRequests) {
    config.signedRequests = makeStores();
    if (signedRequestsRequiredFor !== undefined) {
      config.signedRequests.required_for = signedRequestsRequiredFor;
    }
  }
  return config;
}

async function startServer(factory) {
  return new Promise(resolve => {
    const srv = serve(factory, {
      port: 0,
      onListening: url => resolve({ server: srv, url, port: new URL(url).port }),
    });
  });
}

function mcpCreateMediaBuyBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_media_buy',
      arguments: {
        idempotency_key: 'auto-wire-test-ed25519-2026-0001',
        buyer_agent_url: 'https://buyer.example.com',
        packages: [{ package_id: 'pkg-1', products: [{ product_id: 'prod-1' }] }],
      },
    },
  });
}

function mcpGetProductsBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_products',
      arguments: { brief: 'test' },
    },
  });
}

function mcpUpdateMediaBuyBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'update_media_buy',
      arguments: {
        idempotency_key: 'auto-wire-test-ed25519-2026-0002',
        media_buy_id: 'mb-123',
      },
    },
  });
}

async function postSigned({ url, body, sign, nonce }) {
  const parsed = new URL(url);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sign) {
    const signOpts = { coverContentDigest: true };
    if (nonce !== undefined) signOpts.nonce = nonce;
    const signed = signRequest(
      { method: 'POST', url, headers, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: edPrivate },
      signOpts
    );
    Object.assign(headers, signed.headers);
  }
  return fetch(parsed.toString(), { method: 'POST', headers, body });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createAdcpServer: signedRequests auto-wiring', () => {
  describe('startup validation', () => {
    it('throws when signedRequests config is provided without the specialism', () => {
      assert.throws(
        () => createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: false })),
        /specialisms.*does not include "signed-requests"/
      );
    });

    it('logs an error when the specialism is claimed without signedRequests config (legacy manual-wiring path)', () => {
      const errors = [];
      const logger = {
        debug() {},
        info() {},
        warn() {},
        error: msg => errors.push(msg),
      };
      assert.doesNotThrow(() =>
        createAdcpServer({
          ...sellerConfig({ withSignedRequests: false, withSpecialism: true }),
          logger,
        })
      );
      const hit = errors.find(m => /no `signedRequests` config was provided/.test(m));
      assert.ok(hit, `expected a logger.error about missing signedRequests config; got: ${errors.join(' | ')}`);
    });

    it('does not throw when neither is set', () => {
      assert.doesNotThrow(() => createAdcpServer(sellerConfig({ withSignedRequests: false, withSpecialism: false })));
    });

    it('does not throw when both are set', () => {
      assert.doesNotThrow(() => createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: true })));
    });

    it('attaches preTransport to the returned McpServer via ADCP_PRE_TRANSPORT symbol', () => {
      const server = createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: true }));
      const attached = server[ADCP_PRE_TRANSPORT];
      assert.strictEqual(typeof attached, 'function');
    });

    it('does not attach preTransport when signedRequests is omitted', () => {
      const server = createAdcpServer(sellerConfig({ withSignedRequests: false, withSpecialism: false }));
      assert.strictEqual(server[ADCP_PRE_TRANSPORT], undefined);
    });
  });

  describe('end-to-end request verification', () => {
    let started;

    before(async () => {
      started = await startServer(() =>
        createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: true }))
      );
    });

    after(async () => {
      if (started?.server) {
        await new Promise(resolve => started.server.close(resolve));
      }
    });

    it('accepts a properly signed create_media_buy request', async () => {
      const body = mcpCreateMediaBuyBody();
      const res = await postSigned({ url: started.url, body, sign: true });
      assert.strictEqual(res.status, 200, 'signed request should reach MCP dispatch');
    });

    it('rejects an unsigned create_media_buy request with 401', async () => {
      const body = mcpCreateMediaBuyBody();
      const res = await postSigned({ url: started.url, body, sign: false });
      assert.strictEqual(res.status, 401, 'unsigned mutating request must be rejected');
      const payload = await res.json();
      assert.strictEqual(payload.error, 'request_signature_required');
    });

    it('accepts a signed non-mutating get_products request', async () => {
      // Confirms `required_for` default doesn't over-reject: a read-only tool
      // that was signed anyway (for authenticity) must pass through the
      // verifier without a required_for violation.
      const body = mcpGetProductsBody();
      const res = await postSigned({ url: started.url, body, sign: true });
      assert.strictEqual(res.status, 200, 'signed non-mutating request should reach MCP dispatch');
    });

    it('honors signedRequests.required_for: unsigned update_media_buy is accepted (not in the list)', async () => {
      // sellerConfig() defaults signedRequests.required_for to ['create_media_buy'].
      // update_media_buy is mutating but NOT in the list, so the verifier must
      // let unsigned traffic through rather than defaulting to all MUTATING_TASKS.
      const body = mcpUpdateMediaBuyBody();
      const res = await postSigned({ url: started.url, body, sign: false });
      assert.strictEqual(
        res.status,
        200,
        'unsigned update_media_buy must pass when signedRequests.required_for=[create_media_buy] only'
      );
    });

    it('401 response carries the spec-shaped WWW-Authenticate header and error body', async () => {
      const body = mcpCreateMediaBuyBody();
      const res = await postSigned({ url: started.url, body, sign: false });
      assert.strictEqual(res.status, 401, 'unsigned mutating request must be rejected');
      assert.strictEqual(
        res.headers.get('www-authenticate'),
        'Signature error="request_signature_required"',
        'WWW-Authenticate must announce the Signature auth scheme with the verifier error code'
      );
      const payload = await res.json();
      assert.strictEqual(payload.error, 'request_signature_required');
      assert.strictEqual(
        typeof payload.message,
        'string',
        '401 body must include a human-readable message alongside the code'
      );
      assert.ok(payload.message.length > 0, 'error message should not be empty');
    });
  });

  describe('no-signedRequests server preserves existing behavior', () => {
    let started;

    before(async () => {
      started = await startServer(() =>
        createAdcpServer(sellerConfig({ withSignedRequests: false, withSpecialism: false }))
      );
    });

    after(async () => {
      if (started?.server) {
        await new Promise(resolve => started.server.close(resolve));
      }
    });

    it('accepts an unsigned create_media_buy request (no verifier wired)', async () => {
      const body = mcpCreateMediaBuyBody();
      const res = await postSigned({ url: started.url, body, sign: false });
      assert.strictEqual(res.status, 200, 'unsigned request should pass when no verifier');
    });
  });

  describe('required_for default derives from capabilities when signedRequests.required_for omitted', () => {
    let started;

    before(async () => {
      // signedRequests.required_for is omitted; capabilities.request_signing.required_for
      // declares only create_media_buy. The verifier must default to the
      // capability-declared list, NOT to every mutating task. update_media_buy
      // is mutating but not in the capability list, so it must pass unsigned.
      started = await startServer(() =>
        createAdcpServer(
          sellerConfig({
            withSignedRequests: true,
            withSpecialism: true,
            capabilityRequestSigning: {
              supported: true,
              covers_content_digest: 'either',
              required_for: ['create_media_buy'],
            },
            signedRequestsRequiredFor: undefined,
          })
        )
      );
    });

    after(async () => {
      if (started?.server) {
        await new Promise(resolve => started.server.close(resolve));
      }
    });

    it('get_products (non-mutating) passes unsigned', async () => {
      const res = await postSigned({ url: started.url, body: mcpGetProductsBody(), sign: false });
      assert.strictEqual(res.status, 200, 'read-only tool should not require signing');
    });

    it('update_media_buy passes unsigned because it is not in the capability-declared required_for', async () => {
      const res = await postSigned({ url: started.url, body: mcpUpdateMediaBuyBody(), sign: false });
      assert.strictEqual(
        res.status,
        200,
        'update_media_buy must NOT require signing when the seller advertised required_for=[create_media_buy] only'
      );
    });

    it('create_media_buy still requires signing because it is in the capability-declared required_for', async () => {
      const res = await postSigned({ url: started.url, body: mcpCreateMediaBuyBody(), sign: false });
      assert.strictEqual(res.status, 401, 'create_media_buy must reject unsigned traffic');
      const payload = await res.json();
      assert.strictEqual(payload.error, 'request_signature_required');
    });
  });

  describe('specialism claim requires capabilities.request_signing.supported === true', () => {
    it('throws when specialism is claimed but request_signing.supported is false', () => {
      assert.throws(
        () =>
          createAdcpServer(
            sellerConfig({
              withSignedRequests: true,
              withSpecialism: true,
              capabilityRequestSigning: {
                supported: false,
                covers_content_digest: 'either',
                required_for: ['create_media_buy'],
              },
            })
          ),
        /`capabilities\.request_signing\.supported` is not true/
      );
    });

    it('throws when specialism is claimed but request_signing is omitted entirely', () => {
      assert.throws(
        () =>
          createAdcpServer(
            sellerConfig({
              withSignedRequests: true,
              withSpecialism: true,
              capabilityRequestSigning: null,
            })
          ),
        /`capabilities\.request_signing\.supported` is not true/
      );
    });
  });

  describe('McpServer lifecycle on 401 rejection', () => {
    it('closes the agentServer when the verifier short-circuits with 401', async () => {
      // Regression guard: serve() must call agentServer.close() on the
      // preTransport-handled path or the McpServer leaks per rejected request.
      let closeCalls = 0;
      let agentRef;
      const factory = () => {
        const server = createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: true }));
        const originalClose = server.close.bind(server);
        server.close = async (...args) => {
          closeCalls++;
          return originalClose(...args);
        };
        agentRef = server;
        return server;
      };

      const started = await new Promise(resolve => {
        const srv = serve(factory, {
          port: 0,
          onListening: url => resolve({ server: srv, url }),
        });
      });

      try {
        const body = mcpCreateMediaBuyBody();
        const res = await postSigned({ url: started.url, body, sign: false });
        assert.strictEqual(res.status, 401, 'unsigned mutating request must be rejected');
        // The 401 reaches the client as soon as the verifier calls res.end(),
        // but serve() must still call agentServer.close() on its own tick.
        // Wait long enough that any reasonable async close has had a chance.
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(agentRef, 'factory must have been invoked to produce an agent server');
        assert.strictEqual(
          closeCalls,
          1,
          'agentServer.close() must fire exactly once when preTransport emits 401'
        );
      } finally {
        await new Promise(resolve => started.server.close(resolve));
      }
    });
  });

  describe('replay store scoping by @target-uri (adcp#2460)', () => {
    // Two servers share one replay store / jwks / revocation store. Signing
    // the same nonce against two different mount paths exercises the
    // (keyid, @target-uri) composite key: both inserts should land in
    // disjoint buckets and both requests should succeed.
    let serverA;
    let serverB;

    before(async () => {
      const sharedStores = makeStores();

      function configWithMount(path) {
        const cfg = sellerConfig({ withSignedRequests: true, withSpecialism: true });
        // Reuse the same stores across both servers so a nonce inserted on A
        // would collide on B if scoping were keyid-only.
        cfg.signedRequests.jwks = sharedStores.jwks;
        cfg.signedRequests.replayStore = sharedStores.replayStore;
        cfg.signedRequests.revocationStore = sharedStores.revocationStore;
        return { cfg, path };
      }

      const startAt = (mountPath, factoryCfg) =>
        new Promise(resolve => {
          const srv = serve(() => createAdcpServer(factoryCfg), {
            port: 0,
            path: mountPath,
            onListening: url => resolve({ server: srv, url }),
          });
        });

      const a = configWithMount('/mcp-a');
      const b = configWithMount('/mcp-b');
      serverA = await startAt(a.path, a.cfg);
      serverB = await startAt(b.path, b.cfg);
    });

    after(async () => {
      if (serverA?.server) await new Promise(resolve => serverA.server.close(resolve));
      if (serverB?.server) await new Promise(resolve => serverB.server.close(resolve));
    });

    it('accepts identical nonces signed against two different @target-uri values', async () => {
      const sharedNonce = 'scope-test-nonce-0001';
      const bodyA = mcpCreateMediaBuyBody();
      const resA = await postSigned({ url: serverA.url, body: bodyA, sign: true, nonce: sharedNonce });
      assert.strictEqual(resA.status, 200, 'first endpoint must accept the signed request');

      const bodyB = mcpCreateMediaBuyBody();
      const resB = await postSigned({ url: serverB.url, body: bodyB, sign: true, nonce: sharedNonce });
      assert.strictEqual(
        resB.status,
        200,
        'second endpoint must accept the same nonce because replay scope differs by @target-uri'
      );
    });
  });

  describe('explicit serve.preTransport wins over auto-wiring', () => {
    it('does not build the auto-wired verifier when options.preTransport is set', async () => {
      let preTransportCalls = 0;
      const factory = () => createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: true }));

      const started = await new Promise(resolve => {
        const srv = serve(factory, {
          port: 0,
          preTransport: async () => {
            preTransportCalls++;
            return false; // let MCP dispatch continue
          },
          onListening: url => resolve({ server: srv, url }),
        });
      });

      try {
        const body = mcpCreateMediaBuyBody();
        const res = await postSigned({ url: started.url, body, sign: false });
        assert.strictEqual(res.status, 200, 'explicit preTransport short-circuits auto-wiring');
        assert.ok(preTransportCalls >= 1, 'explicit preTransport must have been invoked');
      } finally {
        await new Promise(resolve => started.server.close(resolve));
      }
    });
  });
});
