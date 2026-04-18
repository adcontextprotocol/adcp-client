const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createPublicKey } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  createExpressVerifier,
  createSigningFetch,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  signRequest,
  StaticJwksResolver,
} = require('../dist/lib/signing/index.js');

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
const ed = keys.find(k => k.kid === 'test-ed25519-2026');
const privateJwk = { ...ed, d: ed._private_d_for_test_only };
delete privateJwk._private_d_for_test_only;
delete privateJwk.key_ops;
delete privateJwk.use;

const publicJwk = { ...ed };
delete publicJwk._private_d_for_test_only;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Minimal "express-shaped" adapter so createExpressVerifier works with Node http.
function makeExpressShim(req, res) {
  const reqShim = {
    method: req.method,
    url: req.url,
    originalUrl: req.url,
    headers: req.headers,
    protocol: 'http',
    get(name) {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v.join(', ') : v;
    },
  };
  const resShim = {
    status(code) {
      res.statusCode = code;
      return {
        set(k, v) {
          res.setHeader(k, v);
          return {
            json(body) {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            },
          };
        },
      };
    },
  };
  return { reqShim, resShim };
}

function startServer(capability) {
  const jwks = new StaticJwksResolver([publicJwk]);
  const replayStore = new InMemoryReplayStore();
  const revocationStore = new InMemoryRevocationStore();
  const middleware = createExpressVerifier({
    capability,
    jwks,
    replayStore,
    revocationStore,
    resolveOperation: req => new URL('http://x' + req.originalUrl).pathname.split('/').filter(Boolean).pop(),
  });

  const server = http.createServer(async (req, res) => {
    const body = await readRawBody(req);
    const { reqShim, resShim } = makeExpressShim(req, res);
    reqShim.rawBody = body;
    await new Promise(resolve =>
      middleware(reqShim, resShim, err => {
        if (err) {
          // Log the cause server-side for debugging; return a generic 500 so
          // test responses don't echo stack traces or internal state.
          console.error('test-shim middleware error:', err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal_server_error' }));
          resolve();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            verified_signer: reqShim.verifiedSigner,
          })
        );
        resolve();
      })
    );
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, replayStore, revocationStore });
    });
  });
}

describe('RFC 9421 e2e: signing-fetch → http server → createExpressVerifier', () => {
  let instance;

  before(async () => {
    instance = await startServer({
      supported: true,
      covers_content_digest: 'either',
      required_for: ['create_media_buy'],
    });
  });

  after(() => {
    instance.server.close();
  });

  test('signed POST is accepted with verified_signer populated', async () => {
    const signingFetch = createSigningFetch((url, init) => fetch(url, init), {
      keyid: 'test-ed25519-2026',
      alg: 'ed25519',
      privateKey: privateJwk,
    });
    const url = `http://127.0.0.1:${instance.port}/adcp/create_media_buy`;
    const body = JSON.stringify({ plan_id: 'plan_001' });
    const res = await signingFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.verified_signer.keyid, 'test-ed25519-2026');
  });

  test('unsigned POST to required_for op rejects with request_signature_required', async () => {
    const url = `http://127.0.0.1:${instance.port}/adcp/create_media_buy`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 401);
    const json = await res.json();
    assert.strictEqual(json.error, 'request_signature_required');
    assert.strictEqual(res.headers.get('www-authenticate'), 'Signature error="request_signature_required"');
  });

  test('tampered body fails cryptographic verification', async () => {
    const url = `http://127.0.0.1:${instance.port}/adcp/create_media_buy`;
    const body = '{"plan_id":"plan_001"}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk }
    );
    const res = await fetch(url, {
      method: 'POST',
      headers: signed.headers,
      body: '{"plan_id":"plan_tampered"}',
    });
    // Body isn't covered by the signature (no content-digest), so crypto verify
    // still succeeds — tamper detection requires content-digest coverage.
    assert.strictEqual(res.status, 200);
  });

  test('tampered body with content-digest coverage is rejected at step 11', async () => {
    const capability = {
      supported: true,
      covers_content_digest: 'required',
      required_for: ['create_media_buy'],
    };
    const digestInstance = await startServer(capability);
    try {
      const url = `http://127.0.0.1:${digestInstance.port}/adcp/create_media_buy`;
      const body = '{"plan_id":"plan_001"}';
      const signed = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
        { coverContentDigest: true }
      );
      const tamperedRes = await fetch(url, {
        method: 'POST',
        headers: signed.headers,
        body: '{"plan_id":"plan_tampered"}',
      });
      assert.strictEqual(tamperedRes.status, 401);
      const json = await tamperedRes.json();
      assert.strictEqual(json.error, 'request_signature_digest_mismatch');
    } finally {
      digestInstance.server.close();
    }
  });

  test('replay of accepted signature is rejected', async () => {
    const replayInstance = await startServer({
      supported: true,
      covers_content_digest: 'either',
      required_for: ['create_media_buy'],
    });
    try {
      const url = `http://127.0.0.1:${replayInstance.port}/adcp/create_media_buy`;
      const body = '{"plan_id":"plan_001"}';
      const signed = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk }
      );
      const first = await fetch(url, { method: 'POST', headers: signed.headers, body });
      assert.strictEqual(first.status, 200);
      const second = await fetch(url, { method: 'POST', headers: signed.headers, body });
      assert.strictEqual(second.status, 401);
      const json = await second.json();
      assert.strictEqual(json.error, 'request_signature_replayed');
    } finally {
      replayInstance.server.close();
    }
  });

  test('publicJwk loads as Node KeyObject (sanity check)', () => {
    const pub = createPublicKey({ key: publicJwk, format: 'jwk' });
    assert.strictEqual(pub.asymmetricKeyType, 'ed25519');
  });
});
