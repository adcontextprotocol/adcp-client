/**
 * Unit tests for the K-pair replay-window grading logic (neg/016).
 *
 * Uses a real HTTP server so we can simulate the multi-instance
 * InMemoryReplayStore pattern without mocking internals.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  createExpressVerifier,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  StaticJwksResolver,
} = require('../dist/lib/signing/index.js');

const { gradeRequestSigning } = require('../dist/lib/testing/storyboard/request-signing/index.js');

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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

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

function loadPublicKeys() {
  return JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys.map(k => {
    const pub = { ...k };
    delete pub._private_d_for_test_only;
    return pub;
  });
}

function makeRevocationStore() {
  return new InMemoryRevocationStore({
    issuer: 'http://127.0.0.1',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_kids: ['test-revoked-2026'],
    revoked_jtis: [],
  });
}

function makeMiddleware(replayStore) {
  const jwks = new StaticJwksResolver(loadPublicKeys());
  return createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: 'either',
      required_for: ['create_media_buy'],
    },
    jwks,
    replayStore,
    revocationStore: makeRevocationStore(),
    resolveOperation: req => new URL('http://x' + req.originalUrl).pathname.split('/').filter(Boolean).pop(),
  });
}

/**
 * Single-instance verifier: one shared InMemoryReplayStore. Every replayed
 * nonce is rejected — K/K pairs should pass.
 */
function startSingleInstanceServer() {
  const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: 1000 });
  const middleware = makeMiddleware(replayStore);

  const server = http.createServer(async (req, res) => {
    const body = await readRawBody(req);
    const { reqShim, resShim } = makeExpressShim(req, res);
    reqShim.rawBody = body;
    await new Promise(resolve =>
      middleware(reqShim, resShim, err => {
        if (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal' }));
          resolve();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        resolve();
      })
    );
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Multi-instance verifier: two separate InMemoryReplayStore instances
 * served by two independent handlers behind a round-robin counter.
 * Each request alternates between instance 0 and instance 1, simulating
 * a two-instance LB pool. Within a single (probe1, probe2) pair, both
 * probes land on the same instance when pairs are sequential (counter
 * is even → instance 0 for probe1, odd → instance 1 for probe2). This
 * means every pair's second probe goes to a different instance than the
 * first, guaranteeing 0/K rejections — the perfect multi-instance signal.
 */
function startMultiInstanceServer() {
  const stores = [
    new InMemoryReplayStore({ maxEntriesPerKeyid: 1000 }),
    new InMemoryReplayStore({ maxEntriesPerKeyid: 1000 }),
  ];
  const middlewares = stores.map(makeMiddleware);
  let counter = 0;

  const server = http.createServer(async (req, res) => {
    const instance = counter % 2;
    counter++;
    const middleware = middlewares[instance];
    const body = await readRawBody(req);
    const { reqShim, resShim } = makeExpressShim(req, res);
    reqShim.rawBody = body;
    await new Promise(resolve =>
      middleware(reqShim, resShim, err => {
        if (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal' }));
          resolve();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        resolve();
      })
    );
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Broken verifier: accepts all requests including replayed nonces.
 * The InMemoryReplayStore is replaced by a no-op that never rejects.
 */
function startNoopReplayServer() {
  const jwks = new StaticJwksResolver(loadPublicKeys());
  // Custom store that never rejects replays
  const noopStore = {
    async check() {}, // never throws
    async record() {},
  };
  const middleware = createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: 'either',
      required_for: ['create_media_buy'],
    },
    jwks,
    replayStore: noopStore,
    revocationStore: makeRevocationStore(),
    resolveOperation: req => new URL('http://x' + req.originalUrl).pathname.split('/').filter(Boolean).pop(),
  });

  const server = http.createServer(async (req, res) => {
    const body = await readRawBody(req);
    const { reqShim, resShim } = makeExpressShim(req, res);
    reqShim.rawBody = body;
    await new Promise(resolve =>
      middleware(reqShim, resShim, err => {
        if (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal' }));
          resolve();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
        resolve();
      })
    );
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const ONLY_016 = { onlyVectors: ['016-replayed-nonce'], allowLiveSideEffects: true, allowPrivateIp: true };

describe('neg/016 K-pair replay-window grading', () => {
  // ── single-instance (K/K pass) ────────────────────────────────────────

  describe('single-instance verifier (shared replay store)', () => {
    let instance;
    before(async () => {
      instance = await startSingleInstanceServer();
    });
    after(() => instance.server.close());

    test('passes with replayProbePairs=4 when all pairs are correctly rejected', async () => {
      const report = await gradeRequestSigning(instance.url, { ...ONLY_016, replayProbePairs: 4 });
      const v016 = report.negative.find(v => v.vector_id === '016-replayed-nonce');
      assert.ok(v016, '016 present');
      assert.ok(v016.passed && !v016.skipped, `expected pass: ${v016.diagnostic}`);
      assert.strictEqual(v016.replay_pairs_tried, 4, 'tried 4 pairs');
      assert.strictEqual(v016.replay_pairs_rejected, 4, 'all 4 rejected');
      assert.strictEqual(v016.actual_error_code, 'request_signature_replayed');
      assert.strictEqual(v016.diagnostic, undefined, 'no diagnostic on pass');
    });

    test('passes with default replayProbePairs=10', async () => {
      const report = await gradeRequestSigning(instance.url, ONLY_016);
      const v016 = report.negative.find(v => v.vector_id === '016-replayed-nonce');
      assert.ok(v016?.passed && !v016.skipped, `expected pass: ${v016?.diagnostic}`);
      assert.strictEqual(v016.replay_pairs_tried, 10);
      assert.strictEqual(v016.replay_pairs_rejected, 10);
    });
  });

  // ── multi-instance (partial rejection → FAIL + cross-instance diagnostic) ─

  describe('multi-instance verifier (per-process replay stores)', () => {
    let instance;
    before(async () => {
      instance = await startMultiInstanceServer();
    });
    after(() => instance.server.close());

    test('fails with multi-instance diagnostic when second probes land on different instances', async () => {
      const report = await gradeRequestSigning(instance.url, { ...ONLY_016, replayProbePairs: 4 });
      const v016 = report.negative.find(v => v.vector_id === '016-replayed-nonce');
      assert.ok(v016, '016 present');
      assert.ok(!v016.passed && !v016.skipped, `expected fail, got: passed=${v016.passed}`);
      assert.strictEqual(v016.replay_pairs_tried, 4);
      // Every second probe hits the other instance — 0 rejections
      assert.strictEqual(v016.replay_pairs_rejected, 0);
      assert.ok(
        v016.diagnostic?.includes('InMemoryReplayStore'),
        `diagnostic should mention InMemoryReplayStore: ${v016.diagnostic}`
      );
      assert.ok(
        v016.diagnostic?.includes('PostgresReplayStore'),
        `diagnostic should mention PostgresReplayStore: ${v016.diagnostic}`
      );
    });
  });

  // ── no replay protection (0/K → FAIL + broken-verifier diagnostic) ───────

  describe('broken verifier (no replay protection)', () => {
    let instance;
    before(async () => {
      instance = await startNoopReplayServer();
    });
    after(() => instance.server.close());

    test('fails with 0/K diagnostic when verifier has no replay protection', async () => {
      const report = await gradeRequestSigning(instance.url, { ...ONLY_016, replayProbePairs: 3 });
      const v016 = report.negative.find(v => v.vector_id === '016-replayed-nonce');
      assert.ok(v016, '016 present');
      assert.ok(!v016.passed && !v016.skipped, `expected fail`);
      assert.strictEqual(v016.replay_pairs_tried, 3);
      assert.strictEqual(v016.replay_pairs_rejected, 0);
      assert.ok(
        v016.diagnostic?.includes('all 3 probe pairs'),
        `diagnostic should mention pair count: ${v016.diagnostic}`
      );
      assert.ok(
        v016.diagnostic?.includes('InMemoryReplayStore'),
        `diagnostic should mention replay store: ${v016.diagnostic}`
      );
    });
  });

  // ── replay_pairs_tried / replay_pairs_rejected absent on skipped vectors ─

  test('replay_pairs_tried and replay_pairs_rejected are undefined on a skipped vector', async () => {
    const instance = await startSingleInstanceServer();
    try {
      // Skip 016 explicitly
      const report = await gradeRequestSigning(instance.url, {
        allowPrivateIp: true,
        skipVectors: ['016-replayed-nonce'],
        skipRateAbuse: true,
      });
      const v016 = report.negative.find(v => v.vector_id === '016-replayed-nonce');
      assert.ok(v016?.skipped, '016 should be skipped');
      assert.strictEqual(v016.replay_pairs_tried, undefined);
      assert.strictEqual(v016.replay_pairs_rejected, undefined);
    } finally {
      instance.server.close();
    }
  });
});
