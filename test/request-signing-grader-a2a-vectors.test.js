/**
 * A2A operation-resolution vectors in the request-signing grader
 * (adcp#7945, GHSA-frxv-c96c-4vqw).
 *
 * `adcp grade request-signing --transport a2a` must catch a seller whose
 * `required_for` is not enforced over A2A. The vulnerable stand-in below ignores
 * `required_for` for A2A and accepts everything; the correct stand-in resolves
 * the operation with the SDK's own `resolveRequestOperation`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  gradeRequestSigning,
  loadA2aOperationResolutionVectors,
  loadRequestSigningVectors,
  A2A_VECTORS_UNAVAILABLE_MESSAGE,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');
const { resolveRequestOperation, UNRESOLVABLE_OPERATION } = require('../dist/lib/signing/operation-resolution');
const {
  verifyRequestSignature,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
} = require('../dist/lib/signing/index.js');

const VENDORED_DIR = path.join(__dirname, 'fixtures', 'request-signing-a2a');

function complianceCacheWithoutA2aVectors(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a2a-no-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.dirname(path.dirname(loadRequestSigningVectors().sourceDir));
  cpSync(source, dir, {
    recursive: true,
    filter: file => path.relative(source, file) !== path.join('test-vectors', 'request-signing', 'a2a'),
  });
  return dir;
}
const CAPABILITY = {
  supported: true,
  covers_content_digest: 'required',
  required_for: ['create_media_buy'],
  protocol_methods_required_for: [],
};

function rawVectors(kind) {
  const dir = path.join(VENDORED_DIR, kind);
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({ file: f, vector: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
}

/**
 * Minimal A2A agent. `decide({ rawBody, req, requests })` returns the POST response.
 * The card names a JSON-RPC interface (`/rpc`) and an HTTP+JSON interface (`/http`).
 */
async function startStandIn(decide) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    if (req.method === 'GET' && req.url.startsWith('/.well-known/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: '1.0',
          name: 'a2a-stand-in',
          description: 'A2A operation-resolution stand-in',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['application/json'],
          defaultOutputModes: ['application/json'],
          skills: [],
          supportedInterfaces: [
            { url: `${base}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
            { url: `${base}/http`, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', tenant: '' },
          ],
        })
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, rawBody });
    const out = decide({ rawBody, req, requests });
    res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.json ?? { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const reject = code => ({
  status: 401,
  headers: { 'www-authenticate': `Signature error="${code}"` },
  json: { error: code },
});

/** Accepts everything: `required_for` is never consulted over A2A. */
const vulnerableAgent = () => ({ status: 200, json: { jsonrpc: '2.0', id: 'x', result: {} } });

/** Reference behavior: resolve once, fail closed, then apply both namespaces. */
function correctAgent({ requiredFor = ['create_media_buy'], protocolMethodsRequiredFor = [] } = {}) {
  return ({ rawBody, req }) => {
    const operation = resolveRequestOperation({ rawBody, method: req.method, url: req.url });
    if (operation === UNRESOLVABLE_OPERATION) return reject('request_body_malformed');
    // Minimal stand-in: a request that presents a signature is accepted.
    if (!req.headers['signature-input']) {
      if (typeof operation === 'string' && requiredFor.includes(operation)) return reject('request_signature_required');
      let method;
      try {
        method = JSON.parse(rawBody).method;
      } catch {
        // not JSON-RPC
      }
      if (typeof method === 'string' && protocolMethodsRequiredFor.includes(method)) {
        return reject('request_signature_required');
      }
    }
    return { status: 200, json: { jsonrpc: '2.0', id: 'x', result: {} } };
  };
}

/**
 * A compliance dir whose test-kit declares a non-sandbox endpoint, so the
 * live-side-effect gate is not waived by the contract.
 */
function nonSandboxComplianceDir() {
  const src = path.join(__dirname, '..', 'compliance', 'cache', 'latest');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'a2a-compliance-'));
  mkdirSync(path.join(dir, 'test-vectors'), { recursive: true });
  mkdirSync(path.join(dir, 'test-kits'), { recursive: true });
  cpSync(path.join(src, 'test-vectors', 'request-signing'), path.join(dir, 'test-vectors', 'request-signing'), {
    recursive: true,
  });
  const kit = readFileSync(path.join(src, 'test-kits', 'signed-requests-runner.yaml'), 'utf8');
  writeFileSync(
    path.join(dir, 'test-kits', 'signed-requests-runner.yaml'),
    kit.replace(/^endpoint_scope: sandbox$/m, 'endpoint_scope: production')
  );
  return dir;
}

const allA2aIds = () => {
  const loaded = loadA2aOperationResolutionVectors({ a2aVectorsDir: VENDORED_DIR });
  return [...loaded.positive, ...loaded.negative].map(v => v.id);
};

async function gradeA2a(url, extra = {}) {
  return gradeRequestSigning(url, {
    transport: 'a2a',
    allowPrivateIp: true,
    allowLiveSideEffects: true,
    // Only the A2A corpus: root vectors have their own tests.
    onlyVectors: allA2aIds(),
    agentCapability: CAPABILITY,
    ...extra,
  });
}

const a2aRows = report => [...report.positive, ...report.negative].filter(r => r.vector_id.startsWith('a2a/'));
const failures = report => a2aRows(report).filter(r => !r.passed && !r.skipped);
const skips = report =>
  a2aRows(report)
    .filter(r => r.skipped && r.skip_reason !== 'not_in_only_vectors')
    .map(r => r.vector_id);

describe('A2A operation-resolution vector loader', () => {
  test('ships all 33 canonical A2A vectors in the default compliance cache', () => {
    const loaded = loadA2aOperationResolutionVectors({ a2aVendoredFallback: false });
    assert.strictEqual(loaded.source, 'compliance_cache');
    assert.strictEqual(loaded.positive.length, 7);
    assert.strictEqual(loaded.negative.length, 26);
    for (const kind of ['positive', 'negative']) {
      for (const { file } of rawVectors(kind)) {
        assert.deepStrictEqual(
          readFileSync(path.join(loaded.sourceDir, kind, file)),
          readFileSync(path.join(VENDORED_DIR, kind, file)),
          `${kind}/${file}`
        );
      }
    }
  });
  test('loads 26 negative and 7 positive vectors from the vendored fixtures', () => {
    const loaded = loadA2aOperationResolutionVectors({ a2aVectorsDir: VENDORED_DIR });
    assert.strictEqual(loaded.source, 'override');
    assert.strictEqual(loaded.negative.length, 26);
    assert.strictEqual(loaded.positive.length, 7);
    assert.ok(loaded.negative.every(v => v.id.startsWith('a2a/negative/')));
    assert.ok(loaded.positive.every(v => v.id.startsWith('a2a/positive/')));
  });

  test('carries tier and expected_outcome, including request_body_malformed', () => {
    const loaded = loadA2aOperationResolutionVectors({ a2aVectorsDir: VENDORED_DIR });
    const byId = new Map([...loaded.positive, ...loaded.negative].map(v => [v.id, v]));
    const raw = [
      ...rawVectors('positive').map(r => ['a2a/positive/' + r.file.replace(/\.json$/, ''), r.vector]),
      ...rawVectors('negative').map(r => ['a2a/negative/' + r.file.replace(/\.json$/, ''), r.vector]),
    ];
    for (const [id, source] of raw) {
      assert.strictEqual(byId.get(id).tier, source.tier, `${id} tier`);
      assert.deepStrictEqual(
        byId.get(id).expected_outcome.resolved_operation,
        source.expected_outcome.resolved_operation,
        `${id} resolved_operation`
      );
    }
    const dup = byId.get('a2a/negative/004-duplicate-invocation-datapart');
    assert.strictEqual(dup.expected_error_code, 'request_body_malformed');
    assert.strictEqual(dup.expected_outcome.failed_step, 0);
    const pos007 = byId.get('a2a/positive/007-unsigned-method-case-variant');
    assert.strictEqual(pos007.expected_outcome.resolved_operation, null);
    assert.strictEqual(pos007.expected_outcome.dispatch, 'method_not_found');
  });

  test('in a repo checkout the default load falls back to the vendored copy when the cache lacks the vectors', t => {
    const loaded = loadA2aOperationResolutionVectors({ complianceDir: complianceCacheWithoutA2aVectors(t) });
    assert.strictEqual(loaded.source, 'vendored_fixture');
    assert.strictEqual(loaded.negative.length + loaded.positive.length, 33);
  });

  test('without a cache copy and without the vendored fallback (an installed package) there are no vectors', t => {
    const loaded = loadA2aOperationResolutionVectors({
      complianceDir: complianceCacheWithoutA2aVectors(t),
      a2aVendoredFallback: false,
    });
    assert.strictEqual(loaded.source, 'none');
    assert.deepStrictEqual([loaded.positive.length, loaded.negative.length], [0, 0]);
  });

  test('an explicit directory that does not exist is an error, not a silent fall-through', () => {
    const missing = path.join(mkdtempSync(path.join(os.tmpdir(), 'a2a-vectors-')), 'nope');
    assert.throws(() => loadA2aOperationResolutionVectors({ a2aVectorsDir: missing }), /not found/);
  });

  test('the root loader accepts request_body_malformed', () => {
    assert.ok(loadRequestSigningVectors().negative.length > 0);
  });
});

describe('A2A operation-resolution grading', () => {
  test('reports unavailable vectors clearly instead of passing silently', async t => {
    const report = await gradeRequestSigning('http://127.0.0.1:1', {
      transport: 'a2a',
      allowPrivateIp: true,
      complianceDir: complianceCacheWithoutA2aVectors(t),
      a2aVendoredFallback: false,
      onlyVectors: ['a2a/negative/001-unsigned-sendmessage-required'],
    });
    assert.strictEqual(report.a2a_operation_resolution.vectors_available, false);
    assert.strictEqual(report.a2a_operation_resolution.message, A2A_VECTORS_UNAVAILABLE_MESSAGE);
    const row = report.negative.find(r => r.vector_id === 'a2a/operation-resolution-vectors');
    assert.ok(row, 'a visible row exists');
    assert.strictEqual(row.skipped, true);
    assert.strictEqual(row.skip_reason, 'a2a_vectors_unavailable');
    assert.strictEqual(row.diagnostic, 'a2a operation-resolution vectors unavailable in this compliance bundle');
  });

  test('is not run for non-a2a transports', async () => {
    const report = await gradeRequestSigning('http://127.0.0.1:1', {
      transport: 'mcp',
      allowPrivateIp: true,
      mcpSessionId: '',
      onlyVectors: ['a2a/negative/001-unsigned-sendmessage-required'],
    });
    assert.strictEqual(report.a2a_operation_resolution, undefined);
    assert.deepStrictEqual(a2aRows(report), []);
  });

  test('a vulnerable agent that ignores required_for over A2A FAILS the contradiction-resolution negatives', async () => {
    const agent = await startStandIn(vulnerableAgent);
    try {
      const report = await gradeA2a(agent.url, {
        agentCapability: { ...CAPABILITY, protocol_methods_required_for: ['SendMessage'] },
      });
      assert.strictEqual(report.passed, false);
      const loaded = loadA2aOperationResolutionVectors({ a2aVectorsDir: VENDORED_DIR });
      const mustIds = loaded.negative.filter(v => v.tier === 'contradiction-resolution').map(v => v.id);
      assert.ok(mustIds.length >= 15, `expected the MUST tier to be non-trivial, got ${mustIds.length}`);
      const failed = new Set(failures(report).map(r => r.vector_id));
      for (const id of mustIds) assert.ok(failed.has(id), `${id} should fail against an accept-everything agent`);
      assert.strictEqual(report.a2a_operation_resolution.tiers['contradiction-resolution'].failed, mustIds.length);
      assert.ok(report.a2a_operation_resolution.tiers.hardening.failed > 0, 'hardening failures are tallied apart');
      // Everything the agent accepted is a pass for the positives.
      assert.ok(report.positive.filter(r => r.vector_id.startsWith('a2a/')).every(r => r.passed));
      const neg001 = report.negative.find(r => r.vector_id === 'a2a/negative/001-unsigned-sendmessage-required');
      assert.strictEqual(neg001.tier, 'contradiction-resolution');
      assert.strictEqual(neg001.http_status, 200);
      assert.match(neg001.diagnostic, /GHSA-frxv-c96c-4vqw/);
    } finally {
      await agent.close();
    }
  });

  test('a correct agent passes every graded vector (negative/007 skipped: SendMessage not advertised)', async () => {
    const agent = await startStandIn(correctAgent());
    try {
      const report = await gradeA2a(agent.url);
      assert.deepStrictEqual(
        failures(report).map(r => `${r.vector_id}: ${r.diagnostic}`),
        []
      );
      assert.strictEqual(report.passed, true);
      assert.deepStrictEqual(skips(report), ['a2a/negative/007-protocol-method-required-covers-sendmessage']);
      const tiers = report.a2a_operation_resolution.tiers;
      assert.strictEqual(tiers['contradiction-resolution'].failed + tiers.hardening.failed, 0);
      assert.strictEqual(report.a2a_operation_resolution.vectors_available, true);
      assert.strictEqual(a2aRows(report).filter(r => !r.skipped && r.passed).length, 32);
    } finally {
      await agent.close();
    }
  });

  test('grades negative/007 against protocol_methods_required_for the stand-in advertises', async () => {
    const protocolMethodsRequiredFor = ['SendMessage'];
    const agent = await startStandIn(correctAgent({ protocolMethodsRequiredFor }));
    try {
      const report = await gradeA2a(agent.url, {
        agentCapability: { ...CAPABILITY, protocol_methods_required_for: protocolMethodsRequiredFor },
      });
      assert.deepStrictEqual(
        failures(report).map(r => `${r.vector_id}: ${r.diagnostic}`),
        []
      );
      const n007 = report.negative.find(r => r.vector_id.includes('007-protocol-method-required'));
      assert.ok(n007.passed && !n007.skipped, 'negative/007 graded and passed');
      assert.strictEqual(n007.actual_error_code, 'request_signature_required');
      // Unsigned SendMessage positives are correctly 401'd by this agent, so they are out of scope for it.
      assert.deepStrictEqual(skips(report).sort(), [
        'a2a/positive/003-unsigned-sendmessage-get-products-not-required',
        'a2a/positive/004-unsigned-decoy-text-and-metadata',
        'a2a/positive/005-unsigned-alias-skill-not-in-lists',
      ]);
    } finally {
      await agent.close();
    }
  });

  test('skips vectors that assert create_media_buy is required when the agent does not require it', async () => {
    const agent = await startStandIn(correctAgent({ requiredFor: [] }));
    try {
      const report = await gradeA2a(agent.url, { agentCapability: { ...CAPABILITY, required_for: [] } });
      assert.deepStrictEqual(
        failures(report).map(r => `${r.vector_id}: ${r.diagnostic}`),
        []
      );
      const n001 = report.negative.find(r => r.vector_id === 'a2a/negative/001-unsigned-sendmessage-required');
      assert.strictEqual(n001.skipped, true);
      assert.strictEqual(n001.skip_reason, 'capability_profile_mismatch');
      // request_body_malformed vectors never depend on required_for.
      const n004 = report.negative.find(r => r.vector_id === 'a2a/negative/004-duplicate-invocation-datapart');
      assert.ok(n004.passed && !n004.skipped);
    } finally {
      await agent.close();
    }
  });

  test('signed create_media_buy vectors follow the live-side-effect gate', async () => {
    const agent = await startStandIn(correctAgent());
    try {
      const report = await gradeA2a(agent.url, {
        allowLiveSideEffects: false,
        complianceDir: nonSandboxComplianceDir(),
      });
      for (const id of [
        'a2a/positive/001-signed-sendmessage-create-media-buy',
        'a2a/positive/002-signed-message-send-v0-3-create-media-buy',
      ]) {
        const row = report.positive.find(r => r.vector_id === id);
        assert.strictEqual(row.skip_reason, 'live_side_effect_opt_in_required', id);
      }
      assert.strictEqual(
        agent.requests.filter(
          r => r.headers['signature-input'] && r.rawBody.includes('"data":{"skill":"create_media_buy"')
        ).length,
        // negative/005 is signed but carries two DataParts, so it is sent; the two positives are not.
        1
      );
    } finally {
      await agent.close();
    }
  });

  test('retargets at the real endpoint, keeps vector bytes and headers, re-signs signed vectors over the real URL', async () => {
    const agent = await startStandIn(correctAgent());
    try {
      await gradeA2a(agent.url);
      const rpc = agent.requests.filter(r => r.url === '/rpc');
      const http = agent.requests.filter(r => r.url === '/http/message:send');
      assert.strictEqual(http.length, 1, 'negative/022 targets the card-declared HTTP+JSON interface');
      // 33 vectors; negative/007 is skipped because the default capability does not declare SendMessage.
      assert.strictEqual(rpc.length + http.length, 32);

      const sent = id => {
        const v = JSON.parse(readFileSync(path.join(VENDORED_DIR, id), 'utf8'));
        return { v, req: agent.requests.find(r => r.rawBody === v.request.body) };
      };

      // Unsigned vector: bytes and A2A headers are the vector's own.
      const n001 = sent('negative/001-unsigned-sendmessage-required.json');
      assert.ok(n001.req, 'vector body sent verbatim');
      assert.strictEqual(n001.req.headers['a2a-version'], '1.0');
      assert.strictEqual(n001.req.headers['a2a-extensions'], 'https://adcontextprotocol.org/extensions/adcp/v3');
      assert.strictEqual(n001.req.headers['signature-input'], undefined);

      // Negative/018 keeps its lone Signature header.
      const n018 = sent('negative/018-unresolvable-with-lone-signature-header.json');
      assert.ok(n018.req.headers.signature);
      assert.strictEqual(n018.req.headers['signature-input'], undefined);

      // Signed vector: fresh signature bound to the real URL, valid under the test key.
      const p001 = sent('positive/001-signed-sendmessage-create-media-buy.json');
      assert.ok(p001.req, 'signed vector body sent verbatim');
      assert.notStrictEqual(p001.req.headers['signature-input'], p001.v.request.headers['Signature-Input']);
      assert.match(p001.req.headers['content-digest'], /^sha-256=:/);
      const keys = JSON.parse(
        readFileSync(
          path.join(__dirname, '..', 'compliance', 'cache', 'latest', 'test-vectors', 'request-signing', 'keys.json'),
          'utf8'
        )
      ).keys.map(k => {
        const pub = { ...k };
        delete pub._private_d_for_test_only;
        return pub;
      });
      const verified = await verifyRequestSignature(
        {
          method: p001.req.method,
          url: `${agent.url}${p001.req.url}`,
          headers: p001.req.headers,
          body: p001.req.rawBody,
        },
        {
          capability: CAPABILITY,
          jwks: new StaticJwksResolver(keys),
          replayStore: new InMemoryReplayStore(),
          revocationStore: new InMemoryRevocationStore(),
          operation: 'create_media_buy',
          adcpVersion: '3.2',
        }
      );
      assert.strictEqual(verified.keyid, 'test-ed25519-2026');
    } finally {
      await agent.close();
    }
  });

  test('negative/023 (batch) accepts request_signature_required as well as request_body_malformed', async () => {
    const agent = await startStandIn(() => reject('request_signature_required'));
    try {
      const report = await gradeRequestSigning(agent.url, {
        transport: 'a2a',
        allowPrivateIp: true,
        onlyVectors: ['a2a/negative/023-batch-body', 'a2a/negative/004-duplicate-invocation-datapart'],
      });
      const batch = report.negative.find(r => r.vector_id === 'a2a/negative/023-batch-body');
      assert.strictEqual(batch.passed, true);
      assert.strictEqual(batch.tier, 'hardening');
      // Same code is wrong for a non-batch ambiguity.
      const dup = report.negative.find(r => r.vector_id === 'a2a/negative/004-duplicate-invocation-datapart');
      assert.strictEqual(dup.passed, false);
    } finally {
      await agent.close();
    }
  });

  test('skips the HTTP+JSON vector when the card declares no HTTP+JSON interface', async () => {
    const requests = [];
    const server = http.createServer(async (req, res) => {
      const port = server.address().port;
      if (req.url.startsWith('/.well-known/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocolVersion: '1.0',
            name: 'rpc-only',
            description: 'rpc only',
            version: '1.0.0',
            capabilities: {},
            defaultInputModes: ['application/json'],
            defaultOutputModes: ['application/json'],
            skills: [],
            supportedInterfaces: [
              { url: `http://127.0.0.1:${port}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
            ],
          })
        );
        return;
      }
      requests.push(req.url);
      res.writeHead(401, { 'www-authenticate': 'Signature error="request_signature_required"' });
      res.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const report = await gradeRequestSigning(`http://127.0.0.1:${server.address().port}`, {
        transport: 'a2a',
        allowPrivateIp: true,
        onlyVectors: ['a2a/negative/022-unsigned-http-json-message-send-required'],
      });
      const row = report.negative.find(r => r.vector_id.includes('022-unsigned-http-json'));
      assert.strictEqual(row.skipped, true);
      assert.strictEqual(row.skip_reason, 'transport_ungradable');
      assert.deepStrictEqual(requests, []);
    } finally {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
