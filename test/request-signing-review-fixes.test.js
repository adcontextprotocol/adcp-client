const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { readFileSync, existsSync, unlinkSync, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSignatureBase,
  computeContentDigest,
  contentDigestMatches,
  createExpressVerifier,
  createSigningFetch,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  parseContentDigest,
  parseSignatureInput,
  RequestSignatureError,
  signRequest,
  StaticJwksResolver,
  verifyRequestSignature,
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

describe('parser hardening (security/code-review findings)', () => {
  test('empty-value numeric param is rejected (not silently coerced to 0)', () => {
    assert.throws(
      () =>
        parseSignatureInput(
          'sig1=("@method" "@target-uri" "@authority");created=;expires=1776521100;nonce="x";keyid="k";alg="ed25519";tag="adcp/request-signing/v1"'
        ),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /empty value|empty/i.test(err.message)
    );
  });

  test('unquoted string-typed param (tag) is rejected', () => {
    assert.throws(
      () =>
        parseSignatureInput(
          'sig1=("@method" "@target-uri" "@authority");created=1;expires=2;nonce="x";keyid="k";alg="ed25519";tag=bare'
        ),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /quoted string/i.test(err.message)
    );
  });

  test('non-integer numeric param (1e5) is rejected', () => {
    assert.throws(
      () =>
        parseSignatureInput(
          'sig1=("@method" "@target-uri" "@authority");created=1e5;expires=2;nonce="x";keyid="k";alg="ed25519";tag="adcp/request-signing/v1"'
        ),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /integer/i.test(err.message)
    );
  });

  test('escaped quote inside a quoted param does not terminate the string', () => {
    const parsed = parseSignatureInput(
      'sig1=("@method" "@target-uri" "@authority");created=1;expires=2;nonce="a\\"b";keyid="k";alg="ed25519";tag="adcp/request-signing/v1"'
    );
    assert.strictEqual(parsed.params.nonce, 'a\\"b');
  });

  test('Signature-Input with params in non-canonical order still produces byte-identical base', () => {
    // Our internal DEFAULT_PARAM_ORDER is created;expires;nonce;keyid;alg;tag.
    // A spec-legal sender could emit keyid first. The verifier path must re-
    // emit the raw substring, not reformat.
    const reordered =
      'sig1=("@method" "@target-uri" "@authority" "content-type");keyid="test-ed25519-2026";created=1776520800;expires=1776521100;nonce="KXYnfEfJ0PBRZXQyVXfVQA";alg="ed25519";tag="adcp/request-signing/v1"';
    const parsed = parseSignatureInput(reordered);
    const request = {
      method: 'POST',
      url: 'https://seller.example.com/adcp/create_media_buy',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    };
    const base = buildSignatureBase(parsed.components, request, parsed.params, parsed.signatureParamsValue);
    // Last line's params MUST match the received substring byte-for-byte.
    const lastLine = base.split('\n').at(-1);
    assert.strictEqual(
      lastLine,
      '"@signature-params": ("@method" "@target-uri" "@authority" "content-type");keyid="test-ed25519-2026";created=1776520800;expires=1776521100;nonce="KXYnfEfJ0PBRZXQyVXfVQA";alg="ed25519";tag="adcp/request-signing/v1"'
    );
  });

  test('Signature-Input with multiple labels selects sig1 even when not first', () => {
    const header =
      'proxy=("@method");created=1;expires=2;nonce="x";keyid="k";alg="ed25519";tag="adcp/request-signing/v1", sig1=("@method" "@target-uri" "@authority");created=10;expires=20;nonce="y";keyid="kk";alg="ed25519";tag="adcp/request-signing/v1"';
    const parsed = parseSignatureInput(header);
    assert.strictEqual(parsed.label, 'sig1');
    assert.strictEqual(parsed.params.keyid, 'kk');
  });

  test('signature value with trailing sf-dictionary parameters is accepted', () => {
    // RFC 8941 sf-binary values can carry member-level parameters. Our parser
    // must not reject these — it should decode just the inner :base64: payload.
    const { parseSignature } = require('../dist/lib/signing/index.js');
    const parsed = parseSignature('sig1=:dGVzdA==:;created=1776520800', 'sig1');
    assert.deepStrictEqual(Buffer.from(parsed.bytes).toString('utf8'), 'test');
  });

  test('signature value with invalid base64 characters is rejected', () => {
    const { parseSignature } = require('../dist/lib/signing/index.js');
    assert.throws(
      () => parseSignature('sig1=:not$base64!:', 'sig1'),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /non-base64/i.test(err.message)
    );
  });
});

describe('content-digest SF dictionary support (protocol finding)', () => {
  test('parseContentDigest extracts sha-256 member when sha-512 is listed first', () => {
    const header =
      'sha-512=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==:, sha-256=:SNIVma8dgUBx/U1CBaYFQnsJep9S0/tXaNXlQQOdoxQ=:';
    const buf = parseContentDigest(header);
    assert.ok(buf);
    assert.strictEqual(buf.length, 32);
  });

  test('contentDigestMatches works on multi-member Content-Digest', () => {
    const body = '{"plan_id":"plan_001"}';
    const sha256 = computeContentDigest(body).match(/:(.+):/)[1];
    const header = `sha-512=:AAAA==:, sha-256=:${sha256}:`;
    assert.strictEqual(contentDigestMatches(header, body), true);
  });
});

describe('verifier: kid consistency + replay TTL floor (protocol/security findings)', () => {
  const buildReq = ({ keyid, now = 1776520800 }) => {
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"plan_id":"plan_001"}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid, alg: 'ed25519', privateKey: privateJwk },
      { now: () => now, windowSeconds: 300, nonce: 'test-nonce-aaaaaaaaaaaa' }
    );
    return { method: 'POST', url, headers: signed.headers, body };
  };

  test('JWKS returning a JWK with mismatched kid is rejected as key_unknown', async () => {
    const mismatched = { ...publicJwk, kid: 'different-kid' };
    const jwks = {
      async resolve() {
        return mismatched;
      },
    };
    const req = buildReq({ keyid: 'test-ed25519-2026' });
    await assert.rejects(
      async () =>
        await verifyRequestSignature(req, {
          capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
          jwks,
          replayStore: new InMemoryReplayStore(),
          revocationStore: new InMemoryRevocationStore(),
          now: () => 1776520800,
          operation: 'create_media_buy',
        }),
      err =>
        err instanceof RequestSignatureError && err.code === 'request_signature_key_unknown' && /kid/i.test(err.message)
    );
  });

  test('replay TTL is floored at max-window + skew so short-validity signatures cannot escape the replay horizon', async () => {
    const replayStore = new InMemoryReplayStore();
    const jwks = new StaticJwksResolver([publicJwk]);
    const now = 1776520800;
    // Sign with a 10-second validity window (well below the replay horizon).
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"plan_id":"plan_001"}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
      { now: () => now, windowSeconds: 10, nonce: 'short-window-nonce-xxxx' }
    );
    await verifyRequestSignature(
      { method: 'POST', url, headers: signed.headers, body },
      {
        capability: { supported: true, covers_content_digest: 'either', required_for: [] },
        jwks,
        replayStore,
        revocationStore: new InMemoryRevocationStore(),
        now: () => now,
        operation: 'create_media_buy',
      }
    );
    // 61s later (past the 10s validity + 60s skew) — the entry must still be
    // in the cache so a replay is still caught, not silently forgotten.
    const stillPresent = await replayStore.has('test-ed25519-2026', 'short-window-nonce-xxxx', now + 75);
    assert.strictEqual(stillPresent, true);
    const stillPresentMuchLater = await replayStore.has('test-ed25519-2026', 'short-window-nonce-xxxx', now + 350);
    assert.strictEqual(stillPresentMuchLater, true);
  });
});

describe('middleware: rawBody + failed_step hardening (security findings)', () => {
  test('request with Content-Length > 0 but no rawBody is rejected as malformed', async () => {
    const middleware = createExpressVerifier({
      capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
      jwks: new StaticJwksResolver([publicJwk]),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      resolveOperation: () => 'create_media_buy',
    });
    const req = {
      method: 'POST',
      url: '/adcp/create_media_buy',
      originalUrl: '/adcp/create_media_buy',
      headers: { host: 'seller.example.com', 'content-length': '100', 'content-type': 'application/json' },
      protocol: 'https',
      get(name) {
        return this.headers[name.toLowerCase()];
      },
    };
    let captured;
    const res = {
      status(code) {
        captured = { code };
        return {
          set(k, v) {
            captured.wwwAuth = v;
            return {
              json(body) {
                captured.body = body;
              },
            };
          },
        };
      },
    };
    await middleware(req, res, () => {});
    assert.strictEqual(captured.code, 401);
    assert.strictEqual(captured.body.error, 'request_signature_header_malformed');
    assert.ok(captured.body.failed_step === undefined, 'failed_step must not be exposed in 401 body');
  });
});

describe('CLI: private key stdout suppression when --private-out is set (security finding)', () => {
  const cli = path.join(__dirname, '..', 'bin', 'adcp.js');
  test('generate-key with --private-out omits private JWK from stdout', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'adcp-signing-test-'));
    const privateOut = path.join(tmp, 'priv.pem');
    try {
      const result = spawnSync(
        process.execPath,
        [cli, 'signing', 'generate-key', '--alg', 'ed25519', '--private-out', privateOut],
        {
          encoding: 'utf8',
        }
      );
      assert.strictEqual(result.status, 0, result.stderr);
      assert.ok(existsSync(privateOut), 'private key file was written');
      assert.ok(!/Private JWK/.test(result.stdout), 'private JWK must not appear on stdout when --private-out is set');
      assert.ok(!/"d":/.test(result.stdout), 'private scalar "d" must not appear on stdout when --private-out is set');
    } finally {
      if (existsSync(privateOut)) unlinkSync(privateOut);
    }
  });
});
