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

const { loadComplianceIndex, loadBundleStoryboards } = require('../dist/lib/testing/storyboard/compliance.js');

const {
  synthesizeRequestSigningSteps,
  parseRequestSigningStepId,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');

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

function startReferenceVerifier({ replayCap = 1000 } = {}) {
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
      covers_content_digest: 'either',
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
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe('request-signing: synthesize step expansion', () => {
  test('compliance loader synthesizes per-vector steps for the signed-requests universal storyboard', () => {
    // AdCP 3.0.1 promoted `signed-requests` from a specialism to a universal
    // capability-gated storyboard (lives at `universal/signed-requests.yaml`,
    // gated on `request_signing.supported: true`). The deprecated specialism
    // enum value is still accepted for back-compat (adcp#3075) but the
    // bundle source-of-truth is the universal entry.
    const index = loadComplianceIndex();
    assert.ok(index.universal.includes('signed-requests'), 'signed-requests is indexed under universal storyboards');

    const storyboards = loadBundleStoryboards({
      kind: 'universal',
      id: 'signed-requests',
      path: path.join('compliance', 'cache', 'latest', 'universal', 'signed-requests.yaml'),
    });
    const sb = storyboards.find(s => s.id === 'signed_requests');
    assert.ok(sb, 'signed_requests storyboard loaded');

    const positivePhase = sb.phases.find(p => p.id === 'positive_vectors');
    const negativePhase = sb.phases.find(p => p.id === 'negative_vectors');
    assert.ok(positivePhase && negativePhase, 'vector phases present');
    assert.strictEqual(positivePhase.steps.length, 12, 'all 12 positive steps synthesized');
    assert.strictEqual(negativePhase.steps.length, 27, 'all 27 negative steps synthesized');

    for (const step of positivePhase.steps) {
      assert.ok(step.id.startsWith('positive-'), `positive step id: ${step.id}`);
      assert.strictEqual(step.task, 'request_signing_probe');
    }
    for (const step of negativePhase.steps) {
      assert.ok(step.id.startsWith('negative-'), `negative step id: ${step.id}`);
      assert.strictEqual(step.task, 'request_signing_probe');
    }

    const roundtrip = parseRequestSigningStepId(positivePhase.steps[0].id);
    assert.strictEqual(roundtrip.kind, 'positive');
    assert.strictEqual(roundtrip.vector_id, '001-basic-post');
  });

  test('synthesizeRequestSigningSteps respects skipVectors', () => {
    const bare = loadBundleStoryboards({
      kind: 'universal',
      id: 'signed-requests',
      path: path.join('compliance', 'cache', 'latest', 'universal', 'signed-requests.yaml'),
    })[0];
    // Already synthesized by the loader, so re-synthesize with skipVectors on
    // a clone with empty phases to check the skip path.
    const skipped = synthesizeRequestSigningSteps(
      {
        ...bare,
        phases: bare.phases.map(p =>
          p.id === 'positive_vectors' || p.id === 'negative_vectors' ? { ...p, steps: [] } : p
        ),
      },
      { skipVectors: ['001-basic-post', '015-signature-invalid'] }
    );
    const posIds = skipped.phases.find(p => p.id === 'positive_vectors').steps.map(s => s.id);
    const negIds = skipped.phases.find(p => p.id === 'negative_vectors').steps.map(s => s.id);
    assert.ok(!posIds.includes('positive-001-basic-post'), 'positive 001 skipped');
    assert.ok(!negIds.includes('negative-015-signature-invalid'), 'negative 015 skipped');
    assert.strictEqual(posIds.length, 11, 'remaining positives = 11');
    assert.strictEqual(negIds.length, 26, 'remaining negatives = 26');
  });
});

const { probeRequestSigningVector } = require('../dist/lib/testing/storyboard/request-signing/index.js');

describe('request-signing: runner dispatch against reference verifier', () => {
  let instance;

  before(async () => {
    instance = await startReferenceVerifier({ replayCap: 1000 });
  });

  after(() => {
    instance.server.close();
  });

  test('probe dispatch grades a positive vector with 2xx + empty WWW-Authenticate', async () => {
    const result = await probeRequestSigningVector('positive-001-basic-post', instance.url, {
      allow_http: true,
    });
    assert.ok(!result.error, `probe error: ${result.error}`);
    assert.ok(result.status >= 200 && result.status < 300, `status ${result.status}`);
    assert.strictEqual(result.headers['www-authenticate'], undefined);
  });

  test('probe dispatch grades a negative vector with 401 + matching WWW-Authenticate', async () => {
    const fresh = await startReferenceVerifier({ replayCap: 1000 });
    try {
      const result = await probeRequestSigningVector('negative-002-wrong-tag', fresh.url, {
        allow_http: true,
      });
      assert.ok(!result.error, `probe error: ${result.error}`);
      assert.strictEqual(result.status, 401);
      assert.ok(
        result.headers['www-authenticate']?.includes('request_signature_tag_invalid'),
        `WWW-Authenticate: ${result.headers['www-authenticate']}`
      );
    } finally {
      fresh.server.close();
    }
  });

  test('probe dispatch honors request_signing.skipRateAbuse', async () => {
    const result = await probeRequestSigningVector('negative-020-rate-abuse', instance.url, {
      allow_http: true,
      request_signing: { skipRateAbuse: true },
    });
    assert.strictEqual(result.skipped, true, `expected skipped, got: ${JSON.stringify(result)}`);
    assert.match(result.skip_reason ?? '', /rate_abuse_opt_out|skipRateAbuse/);
    assert.strictEqual(result.error, undefined, 'skipped probe should not set error');
  });

  test('probe dispatch honors request_signing.skipVectors', async () => {
    const result = await probeRequestSigningVector('negative-003-expired-signature', instance.url, {
      allow_http: true,
      request_signing: { skipVectors: ['003-expired-signature'] },
    });
    assert.strictEqual(result.skipped, true, `expected skipped, got: ${JSON.stringify(result)}`);
    assert.match(result.skip_reason ?? '', /operator_skip|skipVectors/);
  });

  test('probe dispatch rejects unknown step id', async () => {
    const result = await probeRequestSigningVector('random-step', 'http://127.0.0.1:1', {});
    assert.match(result.error ?? '', /does not match positive-\/negative-/);
  });

  test('runStoryboardStep routes request_signing_probe through the dispatch', async () => {
    // Guarantees the wire-up in runner.ts (executeProbeStep's dispatch on
    // step.task === 'request_signing_probe') stays live. If someone
    // removes the task from PROBE_TASKS or the dispatch condition, this
    // test catches it — callers to probeRequestSigningVector directly
    // would not.
    const fresh = await startReferenceVerifier({ replayCap: 1000 });
    try {
      const { runStoryboardStep } = require('../dist/lib/testing/storyboard/runner.js');
      const storyboard = {
        id: 'test-wire-up',
        version: '1.0.0',
        title: 'Dispatch wire-up smoke',
        phases: [
          {
            id: 'wire_up',
            title: 'wire_up',
            steps: [
              {
                id: 'positive-001-basic-post',
                title: 'Positive: wire-up',
                task: 'request_signing_probe',
                validations: [
                  {
                    check: 'http_status_in',
                    allowed_values: [200, 201, 202, 203, 204],
                    description: 'ok',
                  },
                ],
              },
            ],
          },
        ],
      };
      const result = await runStoryboardStep(fresh.url, storyboard, 'positive-001-basic-post', {
        allow_http: true,
        _client: {}, // bypass MCP profile discovery — probe tasks don't touch the client
      });
      assert.strictEqual(result.passed, true, `step should pass: ${result.error}`);
      assert.strictEqual(result.response.status, 200);
    } finally {
      fresh.server.close();
    }
  });

  test('runStoryboardStep propagates skipped status to the step result', async () => {
    const fresh = await startReferenceVerifier({ replayCap: 1000 });
    try {
      const { runStoryboardStep } = require('../dist/lib/testing/storyboard/runner.js');
      const storyboard = {
        id: 'test-skip-propagation',
        version: '1.0.0',
        title: 'Skip propagation',
        phases: [
          {
            id: 'skip_check',
            title: 'skip_check',
            steps: [
              {
                id: 'negative-020-rate-abuse',
                title: 'Rate-abuse',
                task: 'request_signing_probe',
                validations: [{ check: 'http_status', value: 401, description: '' }],
              },
            ],
          },
        ],
      };
      const result = await runStoryboardStep(fresh.url, storyboard, 'negative-020-rate-abuse', {
        allow_http: true,
        _client: {},
        request_signing: { skipRateAbuse: true },
      });
      // Skipped ≠ failed — this is the bug the review caught.
      assert.strictEqual(result.skipped, true, 'step marked skipped');
      assert.strictEqual(result.passed, true, 'skipped steps do not count as failures');
      assert.match(result.skip_reason ?? '', /rate_abuse_opt_out|skipRateAbuse/);
    } finally {
      fresh.server.close();
    }
  });

  test('probe dispatch propagates grader error on verifier mismatch', async () => {
    // Vector 007 expects request_signature_components_incomplete under the
    // 'required' covers_content_digest profile. Our default server is
    // 'either', so the request is accepted (200). The grader surfaces this
    // as a failure with a diagnostic.
    const fresh = await startReferenceVerifier({ replayCap: 1000 });
    try {
      const result = await probeRequestSigningVector('negative-007-missing-content-digest', fresh.url, {
        allow_http: true,
      });
      assert.ok(result.error, 'grader mismatch surfaces as probe error');
      assert.ok(/expected 401/.test(result.error), `diagnostic: ${result.error}`);
    } finally {
      fresh.server.close();
    }
  });
});
