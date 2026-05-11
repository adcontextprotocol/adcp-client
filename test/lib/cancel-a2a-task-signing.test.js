/**
 * Phase 2 cancel-signing tests for adcp-client#1617.
 *
 * Phase 1 sent the A2A `tasks/cancel` POST unsigned. A `signed-requests`
 * seller that enforces signing on the cancel path would 401 it, defeating
 * the orphan-prevention goal of cancel-on-abort. Phase 2 signs the POST
 * when `agent.request_signing` is configured.
 *
 * Test fixture: a minimal HTTP server that runs the SDK's own
 * `verifyRequestSignature` against incoming `tasks/cancel` POSTs. Returns
 * 200 on valid signature, 401 on missing/invalid. Mirrors what a real
 * signed-requests seller does at the verifier seam.
 *
 * upstream issue adcp#4314 asks test-agent to add a per-session strict-mode
 * header so we can also exercise this against the production fixture once
 * that lands. Until then, this in-process fixture covers the regression
 * surface.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const { cancelA2ATask } = require('../../dist/lib/protocols/a2a.js');
const { verifyRequestSignature } = require('../../dist/lib/signing/verifier.js');
const {
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../../dist/lib/signing/server.js');

// Reuse the compliance cache's ed25519 test keypair — same one
// `server-auto-signed-requests.test.js` exercises end-to-end.
const KEYS_PATH = path.join(
  __dirname,
  '..',
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
const edPrivateJwk = { ...edRaw, d: edRaw._private_d_for_test_only };
delete edPrivateJwk._private_d_for_test_only;
delete edPrivateJwk.key_ops;
delete edPrivateJwk.use;

/**
 * Minimal A2A-shaped seller that requires signing on the cancel POST.
 * Runs `verifyRequestSignature` from the SDK against incoming requests
 * and rejects unsigned / invalid-signed POSTs with 401. Records each
 * request so tests can assert the wire shape.
 */
function startStrictSigningSeller() {
  const requests = [];
  const jwks = new StaticJwksResolver([edPublic]);
  const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 100 });
  const revocationStore = new InMemoryRevocationStore({
    issuer: 'http://test-strict-seller',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 3600_000).toISOString(),
    revoked_kids: [],
    revoked_jtis: [],
  });

  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        }
        // Inferred URL — tests construct against the loopback server's URL.
        const url = `http://127.0.0.1:${server.address().port}${req.url}`;
        requests.push({ method: req.method, url, headers, body });

        try {
          const result = await verifyRequestSignature({
            method: req.method,
            url,
            headers,
            body,
            jwks,
            replayStore,
            revocationStore,
          });
          if (!result.verified) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ error: 'signature_required', detail: result.reason ?? 'missing or invalid signature' })
            );
            return;
          }
          // Accept the cancel — return a synthetic success body. Phase 2
          // doesn't care about the response shape; cancel is fire-and-forget.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: JSON.parse(body).id,
              result: { id: 'task-id', status: { state: 'canceled' } },
            })
          );
        } catch (err) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'verifier_error', detail: err?.message }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        requests,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

describe('cancelA2ATask: Phase 2 signing (#1617)', () => {
  test('signs the cancel POST when agent.request_signing is configured (inline ed25519)', async () => {
    const seller = await startStrictSigningSeller();
    try {
      const agent = {
        id: 'test',
        name: 'Test Strict Seller',
        agent_uri: seller.url,
        protocol: 'a2a',
        auth_token: 'test-bearer',
        request_signing: {
          kind: 'inline',
          alg: 'ed25519',
          kid: edRaw.kid,
          private_key: edPrivateJwk,
        },
      };

      await cancelA2ATask(agent, 'task-being-cancelled');

      assert.strictEqual(seller.requests.length, 1, 'cancel POST should hit the seller exactly once');
      const req = seller.requests[0];
      assert.ok(req.headers['signature'], 'Signature header MUST be present (Phase 2 fix)');
      assert.ok(req.headers['signature-input'], 'Signature-Input header MUST be present');
      // Verifier inside the test server already checks the signature is valid;
      // reaching the verified branch (=> the test server returns 200) means
      // the cancel was accepted. No assertion on response body — cancel is
      // fire-and-forget at the buyer side.
    } finally {
      await seller.close();
    }
  });

  test('Phase 1 unsigned path still works when agent has no request_signing (regression guard)', async () => {
    // Tiny accept-anything seller — confirms Phase 1 behavior is preserved
    // when the agent is unsigned.
    const requests = [];
    const server = await new Promise(resolve => {
      const s = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"jsonrpc":"2.0","id":"x","result":{"id":"task","status":{"state":"canceled"}}}');
        });
      });
      s.listen(0, '127.0.0.1', () =>
        resolve({ url: `http://127.0.0.1:${s.address().port}/`, close: () => new Promise(r => s.close(() => r())) })
      );
    });
    try {
      const agent = {
        id: 'test',
        name: 'Test Unsigned Seller',
        agent_uri: server.url,
        protocol: 'a2a',
        auth_token: 'test-bearer',
        // No request_signing — Phase 1 unsigned path
      };

      await cancelA2ATask(agent, 'task-being-cancelled');

      assert.strictEqual(requests.length, 1);
      assert.strictEqual(
        requests[0].headers['signature'],
        undefined,
        'Unsigned agent should NOT send a Signature header'
      );
      assert.strictEqual(requests[0].headers['signature-input'], undefined);
      assert.ok(requests[0].headers['authorization'], 'Bearer auth still attached');
    } finally {
      await server.close();
    }
  });

  test('signed cancel includes the auth bearer alongside the signature', async () => {
    // Confirms the bearer header is still attached on the signed path
    // (signing wraps the existing fetch, doesn't replace auth headers).
    const seller = await startStrictSigningSeller();
    try {
      const agent = {
        id: 'test',
        name: 'Test Strict Seller',
        agent_uri: seller.url,
        protocol: 'a2a',
        auth_token: 'phase2-bearer',
        request_signing: {
          kind: 'inline',
          alg: 'ed25519',
          kid: edRaw.kid,
          private_key: edPrivateJwk,
        },
      };

      await cancelA2ATask(agent, 'task-x');

      assert.strictEqual(seller.requests.length, 1);
      const req = seller.requests[0];
      assert.strictEqual(req.headers['authorization'], 'Bearer phase2-bearer');
      assert.strictEqual(req.headers['x-adcp-auth'], 'phase2-bearer');
      assert.ok(req.headers['signature'], 'signed AND authenticated');
    } finally {
      await seller.close();
    }
  });
});
