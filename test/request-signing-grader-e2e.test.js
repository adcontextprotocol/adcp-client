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
    req.on('data', chunk => chunks.push(chunk));
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

/**
 * Stand up a reference verifier per the signed-requests-runner test-kit:
 *   - JWKS contains runner's signing keys (test-ed25519-2026, test-es256-2026)
 *     plus test-gov-2026 (for vector 009 key-purpose check) and
 *     test-revoked-2026 (pre-revoked for vector 017).
 *   - Revocation list pre-contains test-revoked-2026.
 *   - Replay cap tunable so vector 020 finishes in under a second.
 */
function startGraderServer({ replayCap, coversContentDigest = 'either' }) {
  const publicKeys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys.map(k => {
    const pub = { ...k };
    delete pub._private_d_for_test_only;
    return pub;
  });
  const jwks = new StaticJwksResolver(publicKeys);
  const replayStore = new InMemoryReplayStore({ maxEntriesPerKeyid: replayCap });
  const revocationStore = new InMemoryRevocationStore({
    issuer: 'http://127.0.0.1',
    updated: new Date().toISOString(),
    next_update: new Date(Date.now() + 3600_000).toISOString(),
    revoked_kids: ['test-revoked-2026'],
    revoked_jtis: [],
  });

  const middleware = createExpressVerifier({
    capability: {
      supported: true,
      covers_content_digest: coversContentDigest,
      required_for: ['create_media_buy'],
    },
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
          console.error('grader-shim middleware error:', err);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: 'internal_server_error' }));
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
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, replayStore, revocationStore });
    });
  });
}

// Vectors 007 and 018 depend on the verifier advertising a specific
// `covers_content_digest` policy. The main-test server advertises `either`;
// 007 expects `required` and 018 expects `forbidden`. Each has its own test
// that stands up a matching server.
const CAPABILITY_PROFILE_VECTORS = ['007-missing-content-digest', '018-digest-covered-when-forbidden'];

// Vector 027 exercises the "webhook authentication MUST require 9421" rule
// (#webhook-security downgrade resistance). The reference verifier does not
// yet inspect request bodies for `push_notification_config.authentication`,
// so the vector grades as unsigned-allowed instead of the expected
// `request_signature_required`. Skip until the verifier learns the rule.
const UNIMPLEMENTED_VERIFIER_RULE_VECTORS = ['027-webhook-registration-authentication-unsigned'];
const SKIPPED_VECTORS = [...CAPABILITY_PROFILE_VECTORS, ...UNIMPLEMENTED_VERIFIER_RULE_VECTORS];

describe('request-signing grader — end-to-end vs. reference verifier', () => {
  let instance;

  before(async () => {
    instance = await startGraderServer({ replayCap: 1000, coversContentDigest: 'either' });
  });

  after(() => {
    instance.server.close();
  });

  test('grades the 17 non-stateful + 2 non-rate vectors on a covers_content_digest=either verifier', async () => {
    const report = await gradeRequestSigning(instance.url, {
      allowPrivateIp: true,
      skipRateAbuse: true, // 020 has its own test below with matched caps.
      skipVectors: SKIPPED_VECTORS,
    });

    assert.ok(report.contract_loaded, 'test-kit contract loaded');
    assert.strictEqual(report.harness_mode, 'black_box');

    const failures = [];
    for (const v of [...report.positive, ...report.negative]) {
      if (!v.passed && !v.skipped) {
        failures.push(
          `${v.kind}/${v.vector_id}: ${v.diagnostic ?? 'no diagnostic'} (status=${v.http_status}, actual=${v.actual_error_code ?? 'none'})`
        );
      }
    }
    assert.deepStrictEqual(failures, [], 'every non-capability-profile vector grades as expected');

    assert.strictEqual(report.positive.length, 12);
    assert.strictEqual(report.negative.length, 27);
  });

  test('capability profile "required": vector 007 grades correctly', async () => {
    const fresh = await startGraderServer({ replayCap: 1000, coversContentDigest: 'required' });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        onlyVectors: ['007-missing-content-digest'],
      });
      const v007 = report.negative.find(v => v.vector_id === '007-missing-content-digest');
      assert.ok(v007, '007 present');
      assert.ok(v007.passed && !v007.skipped, `007 should pass under required profile: ${v007.diagnostic}`);
    } finally {
      fresh.server.close();
    }
  });

  test('capability profile "forbidden": vector 018 grades correctly', async () => {
    const fresh = await startGraderServer({ replayCap: 1000, coversContentDigest: 'forbidden' });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        onlyVectors: ['018-digest-covered-when-forbidden'],
      });
      const v018 = report.negative.find(v => v.vector_id === '018-digest-covered-when-forbidden');
      assert.ok(v018, '018 present');
      assert.ok(v018.passed && !v018.skipped, `018 should pass under forbidden profile: ${v018.diagnostic}`);
    } finally {
      fresh.server.close();
    }
  });

  test('rate-abuse vector: cap+1th request rejected with request_signature_rate_abuse', async () => {
    // Dedicated server with a tight cap matched to the grader so the
    // (cap+1)th request trips the rejection. `onlyVectors` isolates 020 on
    // a fresh replay cache so prior vectors don't consume the quota.
    const fresh = await startGraderServer({ replayCap: 10 });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        rateAbuseCap: 10,
        onlyVectors: ['020-rate-abuse'],
        // 020 produces live side effects (fills the cap); test-kit contract
        // says sandbox but the localhost verifier doesn't advertise that.
        allowLiveSideEffects: true,
      });
      const v020 = report.negative.find(v => v.vector_id === '020-rate-abuse');
      assert.ok(v020, '020 present');
      assert.ok(v020.passed && !v020.skipped, `020 should pass with matched cap: ${v020.diagnostic}`);
      assert.strictEqual(v020.actual_error_code, 'request_signature_rate_abuse');
    } finally {
      fresh.server.close();
    }
  });

  test('skipRateAbuse marks the rate-abuse vector skipped, not failed', async () => {
    const fresh = await startGraderServer({ replayCap: 1000 });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        skipRateAbuse: true,
        skipVectors: SKIPPED_VECTORS,
      });
      const rateAbuse = report.negative.find(v => v.vector_id === '020-rate-abuse');
      assert.ok(rateAbuse, '020-rate-abuse present');
      assert.strictEqual(rateAbuse.skipped, true);
      assert.strictEqual(rateAbuse.skip_reason, 'rate_abuse_opt_out');
    } finally {
      fresh.server.close();
    }
  });

  test('positive vectors all accepted with 2xx', async () => {
    const fresh = await startGraderServer({ replayCap: 1000 });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        skipRateAbuse: true,
        skipVectors: SKIPPED_VECTORS,
      });
      for (const p of report.positive) {
        assert.ok(p.passed, `positive/${p.vector_id} should pass: ${p.diagnostic}`);
        assert.ok(p.http_status >= 200 && p.http_status < 300, `${p.vector_id}: status ${p.http_status}`);
      }
    } finally {
      fresh.server.close();
    }
  });
});
