const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  serve,
  createAdcpServer,
  InMemoryStateStore,
  ADCP_PRE_TRANSPORT,
} = require('../dist/lib/server/index.js');
const {
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../dist/lib/signing/server.js');
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

function sellerConfig({ withSignedRequests = true, withSpecialism = true } = {}) {
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
    },
    capabilities: {
      features: { inlineCreativeManagement: false },
      request_signing: {
        supported: true,
        covers_content_digest: 'either',
        required_for: ['create_media_buy'],
      },
      specialisms: withSpecialism ? ['signed-requests'] : [],
    },
  };
  if (withSignedRequests) {
    config.signedRequests = {
      ...makeStores(),
      required_for: ['create_media_buy'],
    };
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

async function postSigned({ url, body, sign }) {
  const parsed = new URL(url);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sign) {
    const signed = signRequest(
      { method: 'POST', url, headers, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: edPrivate },
      { coverContentDigest: true }
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
        () =>
          createAdcpServer(
            sellerConfig({ withSignedRequests: true, withSpecialism: false })
          ),
        /specialisms.*does not include "signed-requests"/
      );
    });

    it('logs an error when the specialism is claimed without signedRequests config (legacy manual-wiring path)', () => {
      const errors = [];
      const logger = {
        debug() {},
        info() {},
        warn() {},
        error: (msg) => errors.push(msg),
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
      assert.doesNotThrow(() =>
        createAdcpServer(
          sellerConfig({ withSignedRequests: false, withSpecialism: false })
        )
      );
    });

    it('does not throw when both are set', () => {
      assert.doesNotThrow(() =>
        createAdcpServer(
          sellerConfig({ withSignedRequests: true, withSpecialism: true })
        )
      );
    });

    it('attaches preTransport to the returned McpServer via ADCP_PRE_TRANSPORT symbol', () => {
      const server = createAdcpServer(
        sellerConfig({ withSignedRequests: true, withSpecialism: true })
      );
      const attached = server[ADCP_PRE_TRANSPORT];
      assert.strictEqual(typeof attached, 'function');
    });

    it('does not attach preTransport when signedRequests is omitted', () => {
      const server = createAdcpServer(
        sellerConfig({ withSignedRequests: false, withSpecialism: false })
      );
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

  describe('explicit serve.preTransport wins over auto-wiring', () => {
    it('does not build the auto-wired verifier when options.preTransport is set', async () => {
      let preTransportCalls = 0;
      const factory = () =>
        createAdcpServer(sellerConfig({ withSignedRequests: true, withSpecialism: true }));

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
