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
      agentContentDigestPolicy: 'either',
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
        agentContentDigestPolicy: 'either',
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
        agentContentDigestPolicy: 'either',
      });
      for (const p of report.positive) {
        assert.ok(p.passed, `positive/${p.vector_id} should pass: ${p.diagnostic}`);
        assert.ok(p.http_status >= 200 && p.http_status < 300, `${p.vector_id}: status ${p.http_status}`);
      }
    } finally {
      fresh.server.close();
    }
  });

  test('agentContentDigestPolicy "required" skips uncovered vectors structurally (issue #1840)', async () => {
    const fresh = await startGraderServer({ replayCap: 1000, coversContentDigest: 'required' });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        skipRateAbuse: true,
        agentContentDigestPolicy: 'required',
      });

      // Positives whose Signature-Input omits "content-digest" must be skipped
      // structurally — the strict-required verifier would reject them with
      // request_signature_components_incomplete before any acceptance check.
      const uncoveredPositiveIds = [
        '001-basic-post',
        '003-es256-post',
        '004-multiple-signature-labels',
        '009-percent-encoded-unreserved-decoded',
        '010-percent-encoded-slash-preserved',
        '011-ipv6-authority',
        '012-ipv6-authority-default-port-stripped',
      ];
      for (const id of uncoveredPositiveIds) {
        const v = report.positive.find(p => p.vector_id === id);
        assert.ok(v, `${id} in report`);
        assert.strictEqual(v.skipped, true, `positive/${id} should skip under required policy`);
        assert.strictEqual(v.skip_reason, 'capability_profile_mismatch', `positive/${id} skip_reason`);
      }

      // Vector 002 signs WITH content-digest and declares 'required' — it must
      // run and pass against a required verifier.
      const v002 = report.positive.find(p => p.vector_id === '002-post-with-content-digest');
      assert.ok(v002, '002 in report');
      assert.strictEqual(v002.skipped, undefined, '002 should not skip under required policy');
      assert.ok(
        v002.passed && v002.http_status >= 200 && v002.http_status < 300,
        `002 should pass: ${v002.diagnostic}`
      );

      // Negatives whose Signature-Input omits content-digest hit the digest
      // gate before their intended error path — must be skipped, not failed.
      const uncoveredNegativeIds = [
        '008-unknown-keyid',
        '009-key-ops-missing-verify',
        '015-signature-invalid',
        '016-replayed-nonce',
        '017-key-revoked',
      ];
      for (const id of uncoveredNegativeIds) {
        const v = report.negative.find(n => n.vector_id === id);
        assert.ok(v, `${id} in report`);
        assert.strictEqual(v.skipped, true, `negative/${id} should skip under required policy`);
        assert.strictEqual(v.skip_reason, 'capability_profile_mismatch', `negative/${id} skip_reason`);
      }

      // No un-skipped failures: every vector that ran must either pass or be
      // skipped — that's the whole point of the fix.
      const failures = [...report.positive, ...report.negative].filter(v => !v.passed && !v.skipped);
      assert.deepStrictEqual(
        failures.map(v => v.vector_id),
        [],
        'no un-skipped failures when grading against a strict-required verifier'
      );
    } finally {
      fresh.server.close();
    }
  });

  test('agentContentDigestPolicy "forbidden" skips covered vectors structurally (issue #1840)', async () => {
    const fresh = await startGraderServer({ replayCap: 1000, coversContentDigest: 'forbidden' });
    try {
      const report = await gradeRequestSigning(fresh.url, {
        allowPrivateIp: true,
        skipRateAbuse: true,
        agentContentDigestPolicy: 'forbidden',
      });

      // Vector 002 signs WITH content-digest — strict-forbidden verifier rejects
      // it with request_signature_components_unexpected before any other path.
      const v002 = report.positive.find(p => p.vector_id === '002-post-with-content-digest');
      assert.ok(v002, '002 in report');
      assert.strictEqual(v002.skipped, true, 'positive/002 should skip under forbidden policy');
      assert.strictEqual(v002.skip_reason, 'capability_profile_mismatch', 'positive/002 skip_reason');

      // Negative-010 (content-digest-mismatch) signs WITH content-digest — same
      // fate. Likewise negative-018 (digest-covered-when-forbidden) is already
      // declared 'forbidden' and matches the agent — runs and passes.
      const v010 = report.negative.find(n => n.vector_id === '010-content-digest-mismatch');
      assert.ok(v010, '010 in report');
      assert.strictEqual(v010.skipped, true, 'negative/010 should skip under forbidden policy');

      const failures = [...report.positive, ...report.negative].filter(v => !v.passed && !v.skipped);
      assert.deepStrictEqual(
        failures.map(v => v.vector_id),
        [],
        'no un-skipped failures when grading against a strict-forbidden verifier'
      );
    } finally {
      fresh.server.close();
    }
  });

  test('agentContentDigestPolicy "either" auto-skips vectors 007 and 018 with capability_profile_mismatch', async () => {
    const report = await gradeRequestSigning(instance.url, {
      allowPrivateIp: true,
      skipRateAbuse: true,
      agentContentDigestPolicy: 'either',
    });

    const v007 = report.negative.find(v => v.vector_id === '007-missing-content-digest');
    const v018 = report.negative.find(v => v.vector_id === '018-digest-covered-when-forbidden');
    assert.ok(v007, '007 in report');
    assert.ok(v018, '018 in report');
    assert.strictEqual(v007.skipped, true, '007 should be skipped under either policy');
    assert.strictEqual(v018.skipped, true, '018 should be skipped under either policy');
    assert.strictEqual(v007.skip_reason, 'capability_profile_mismatch', '007 skip_reason');
    assert.strictEqual(v018.skip_reason, 'capability_profile_mismatch', '018 skip_reason');

    const failures = [...report.positive, ...report.negative].filter(v => !v.passed && !v.skipped);
    assert.deepStrictEqual(
      failures.map(v => v.vector_id),
      [],
      'no un-skipped failures when content-digest policy is declared'
    );
  });
});
