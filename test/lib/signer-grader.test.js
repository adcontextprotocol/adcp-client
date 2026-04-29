/**
 * Signer-grader unit + integration tests.
 *
 * The grader produces a sample signed request through the user's signer
 * (key-file mode or HTTP signing-oracle mode), then verifies the result
 * against the user's published JWKS via the SDK's RFC 9421 verifier. Tests
 * cover both signer-source modes and the verifier failure paths a misconfigured
 * adapter would hit.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { writeFileSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { gradeSigner } = require('../../dist/lib/testing/storyboard/signer-grader/index.js');

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
const keysData = JSON.parse(require('node:fs').readFileSync(KEYS_PATH, 'utf8'));
const ed = keysData.keys.find(k => k.kid === 'test-ed25519-2026');
const es = keysData.keys.find(k => k.kid === 'test-es256-2026');

function privateJwkFor(entry) {
  const out = { ...entry, d: entry._private_d_for_test_only };
  delete out._private_d_for_test_only;
  return out;
}
function publicJwkFor(entry) {
  const out = { ...entry };
  delete out._private_d_for_test_only;
  return out;
}

function startJwksServer(jwks) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ keys: jwks }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startSigningOracle(privateJwk, algorithm) {
  // A correct signing oracle: takes payload_b64, signs with the private key,
  // returns signature_b64 in the wire format the verifier expects.
  const { createPrivateKey, sign: nodeSign } = require('node:crypto');
  return new Promise(resolve => {
    const server = http.createServer(async (req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          const payload = Buffer.from(body.payload_b64, 'base64');
          const pk = createPrivateKey({ key: privateJwk, format: 'jwk' });
          let signature;
          if (algorithm === 'ed25519') {
            signature = nodeSign(null, payload, pk);
          } else {
            signature = nodeSign('sha256', payload, { key: pk, dsaEncoding: 'ieee-p1363' });
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ signature_b64: Buffer.from(signature).toString('base64') }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function port(server) {
  return server.address().port;
}

describe('gradeSigner', () => {
  let jwksServer;
  let jwksUrl;
  before(async () => {
    jwksServer = await startJwksServer([publicJwkFor(ed), publicJwkFor(es)]);
    jwksUrl = `http://127.0.0.1:${port(jwksServer)}/.well-known/jwks.json`;
  });
  after(() => {
    jwksServer.close();
  });

  test('key-file mode: Ed25519 signer with matching JWKS → PASS', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    writeFileSync(keyFilePath, JSON.stringify(privateJwkFor(ed)));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent', // arbitrary, only used for sample request URL
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath,
      jwksUrl,
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, true, JSON.stringify(report.step));
    assert.strictEqual(report.step.status, 'pass');
    assert.match(report.sample.headers['Signature-Input'], /keyid="test-ed25519-2026"/);
  });

  test('key-file mode: ECDSA-P256 signer with matching JWKS → PASS', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    writeFileSync(keyFilePath, JSON.stringify(privateJwkFor(es)));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-es256-2026',
      algorithm: 'ecdsa-p256-sha256',
      keyFilePath,
      jwksUrl,
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, true, JSON.stringify(report.step));
  });

  test('signer-url mode: matching JWKS → PASS', async () => {
    const oracle = await startSigningOracle(privateJwkFor(ed), 'ed25519');
    try {
      const report = await gradeSigner({
        agentUrl: 'http://127.0.0.1:9999/agent',
        kid: 'test-ed25519-2026',
        algorithm: 'ed25519',
        signerUrl: `http://127.0.0.1:${port(oracle)}/sign`,
        jwksUrl,
        allowPrivateIp: true,
      });
      assert.strictEqual(report.passed, true, JSON.stringify(report.step));
    } finally {
      oracle.close();
    }
  });

  test('signer-url 401 surfaces signer_invocation_failed (not generic verifier failure)', async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const report = await gradeSigner({
        agentUrl: 'http://127.0.0.1:9999/agent',
        kid: 'test-ed25519-2026',
        algorithm: 'ed25519',
        signerUrl: `http://127.0.0.1:${port(server)}/sign`,
        jwksUrl,
        allowPrivateIp: true,
      });
      assert.strictEqual(report.passed, false);
      assert.strictEqual(report.step.error_code, 'signer_invocation_failed');
      assert.match(report.step.diagnostic, /401/);
    } finally {
      server.close();
    }
  });

  test('mismatched algorithm advertised vs JWK alg → grader surfaces failure (signer-side or verifier-side)', async () => {
    // Sign with ed25519 keypair but advertise algorithm: ecdsa-p256-sha256.
    // This is a common KMS-misconfiguration shape. The in-process signer
    // refuses (Node throws when ECDSA-shaped sign is asked of an Ed25519
    // key) → signer_invocation_failed. A KMS-backed signer that happily
    // signs with whatever it has → verifier rejects post-wire. Both
    // outcomes are operationally useful — the operator sees the failure
    // before pushing live traffic.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    writeFileSync(keyFilePath, JSON.stringify(privateJwkFor(ed)));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ecdsa-p256-sha256', // <-- wrong: this kid is Ed25519
      keyFilePath,
      jwksUrl,
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, false);
    assert.match(
      report.step.error_code,
      /signer_invocation_failed|request_signature_(invalid|key_purpose_invalid|alg_not_allowed)/
    );
  });

  test('signer signs with wrong key (different `d`) → verifier rejects request_signature_invalid', async () => {
    // Advertise ed25519 + correct kid, but sign with ES256 private material.
    // This simulates a KMS adapter pointed at the wrong key version.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    // Create a frankenstein JWK: kid + alg of ed25519, but `d` from a different
    // ed25519 key that's not in the JWKS. Reuses the gov-signing key from the
    // test vectors.
    const govEd = keysData.keys.find(k => k.adcp_use === 'governance-signing' && k.crv === 'Ed25519');
    assert.ok(govEd, 'test fixture: governance-signing Ed25519 key required for wrong-key assertion');
    const wrongKey = { ...privateJwkFor(ed), d: govEd._private_d_for_test_only };
    writeFileSync(keyFilePath, JSON.stringify(wrongKey));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath,
      jwksUrl,
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, false);
    assert.match(report.step.error_code, /request_signature_invalid|request_signature_key_unknown/);
  });

  test('passing both --key-file and --signer-url throws a clear setup error', async () => {
    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath: '/nonexistent.jwk',
      signerUrl: 'http://127.0.0.1:1/sign',
      jwksUrl,
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.step.error_code, 'signer_setup_failed');
    assert.match(report.step.diagnostic, /exactly one/);
  });

  test('key-file points at a missing path → signer_setup_failed', async () => {
    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath: '/definitely/not/a/file.jwk',
      jwksUrl,
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.step.error_code, 'signer_setup_failed');
  });

  test('default coversContentDigest is required → step 11 (digest recompute) is exercised', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    writeFileSync(keyFilePath, JSON.stringify(privateJwkFor(ed)));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath,
      jwksUrl,
      allowPrivateIp: true,
      // No coversContentDigest passed → defaults to 'required'.
    });
    assert.strictEqual(report.passed, true);
    // With required policy, the signer must emit Content-Digest. Confirm
    // the header is present in the sample headers we report.
    const headers = report.sample.headers;
    const lookup = name => {
      const k = Object.keys(headers).find(h => h.toLowerCase() === name.toLowerCase());
      return k ? headers[k] : undefined;
    };
    assert.ok(lookup('content-digest'), 'Content-Digest header must be present under coversContentDigest=required');
    assert.match(lookup('signature-input'), /content-digest/);
  });

  test('coversContentDigest=forbidden → signer omits Content-Digest', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    writeFileSync(keyFilePath, JSON.stringify(privateJwkFor(ed)));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath,
      jwksUrl,
      allowPrivateIp: true,
      coversContentDigest: 'forbidden',
    });
    assert.strictEqual(report.passed, true);
    const headers = report.sample.headers;
    const sigInput = Object.entries(headers).find(([k]) => k.toLowerCase() === 'signature-input')?.[1];
    assert.doesNotMatch(sigInput, /content-digest/);
  });

  test('JWKS endpoint unreachable → verifier rejects key_unknown / fetch error', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adcp-grader-'));
    const keyFilePath = path.join(dir, 'key.jwk');
    writeFileSync(keyFilePath, JSON.stringify(privateJwkFor(ed)));

    const report = await gradeSigner({
      agentUrl: 'http://127.0.0.1:9999/agent',
      kid: 'test-ed25519-2026',
      algorithm: 'ed25519',
      keyFilePath,
      jwksUrl: 'http://127.0.0.1:1/.well-known/jwks.json', // unroutable
      allowPrivateIp: true,
    });
    assert.strictEqual(report.passed, false);
    // Either the verifier surfaces it as request_signature_key_unknown
    // (after fetch fail) or as a thrown verifier_threw_unexpected.
    assert.match(report.step.error_code, /request_signature|verifier_threw|signer/);
  });
});
