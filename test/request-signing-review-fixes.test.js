const { test, describe } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { createPrivateKey, sign: nodeSign } = require('node:crypto');
const { readFileSync, existsSync, unlinkSync, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSignatureBase,
  computeContentDigest,
  contentDigestUsesEncoding,
  contentDigestMatches,
  createExpressVerifier,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  parseContentDigest,
  parseSignatureInput,
  prepareRequestSignature,
  finalizeRequestSignature,
  requestSigningEncodingForVersion,
  RequestSignatureError,
  signRequest,
  StaticJwksResolver,
  verifyRequestSignature,
} = require('../dist/lib/signing/index.js');
const { RequestSigningErrorCodeMetadata } = require('../dist/lib/types/enums.generated.js');

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

function signIntentionalNegativeVector(request, options) {
  const prepared = prepareRequestSignature(request, { keyid: 'test-ed25519-2026', alg: 'ed25519' }, options);
  const signature = nodeSign(
    null,
    Buffer.from(prepared.base, 'utf8'),
    createPrivateKey({ key: privateJwk, format: 'jwk' })
  );
  return finalizeRequestSignature(prepared, signature);
}

describe('parser hardening (security/code-review findings)', () => {
  test('empty-value numeric param is rejected (not silently coerced to 0)', () => {
    assert.throws(
      () =>
        parseSignatureInput(
          'sig1=("@method" "@target-uri" "@authority");created=;expires=1776521100;nonce="x";keyid="k";alg="ed25519";tag="adcp/request-signing/v1"'
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_header_malformed'
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
      err => err instanceof RequestSignatureError && err.code === 'request_signature_header_malformed'
    );
  });

  test('decimal numeric param (1.5) is rejected — created/expires must be integers', () => {
    assert.throws(
      () =>
        parseSignatureInput(
          'sig1=("@method" "@target-uri" "@authority");created=1.5;expires=2;nonce="x";keyid="k";alg="ed25519";tag="adcp/request-signing/v1"'
        ),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /integer/i.test(err.message)
    );
  });

  test('escaped quote inside a quoted param does not terminate the string', () => {
    // RFC 8941 §3.3.3: backslash-escapes decode, so the literal `nonce="a\"b"`
    // on the wire surfaces as the logical value `a"b` after parsing.
    const parsed = parseSignatureInput(
      'sig1=("@method" "@target-uri" "@authority");created=1;expires=2;nonce="a\\"b";keyid="k";alg="ed25519";tag="adcp/request-signing/v1"'
    );
    assert.strictEqual(parsed.params.nonce, 'a"b');
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

  test('Signature rejects duplicate dictionary labels before profile validation', () => {
    const { parseSignature } = require('../dist/lib/signing/index.js');
    assert.throws(
      () => parseSignature('sig1=:dGVzdA==:, sig1=:bGVnYWN5:', 'sig1', 'rfc8941-base64'),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /more than once/.test(err.message)
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
    const parsed = parseSignature('sig1=:dGVzdA==:;created=1776520800', 'sig1', 'rfc8941-base64');
    assert.deepStrictEqual(Buffer.from(parsed.bytes).toString('utf8'), 'test');
  });

  test('signature value with invalid base64 characters is rejected', () => {
    const { parseSignature } = require('../dist/lib/signing/index.js');
    assert.throws(
      () => parseSignature('sig1=:not$base64!:', 'sig1'),
      err =>
        err instanceof RequestSignatureError &&
        err.code === 'request_signature_header_malformed' &&
        /base64/i.test(err.message)
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

  test('legacy request signatures still emit RFC 9530 standard-Base64 Content-Digest', () => {
    const body = '{"plan_id":"legacy_digest"}';
    const signed = signRequest(
      {
        method: 'POST',
        url: 'https://seller.example.com/adcp/create_media_buy',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
      { coverContentDigest: true, binaryEncoding: 'legacy-base64url' }
    );

    assert.strictEqual(contentDigestUsesEncoding(signed.headers['Content-Digest'], 'rfc8941-base64'), true);
    assert.strictEqual(contentDigestUsesEncoding(signed.headers['Content-Digest'], 'legacy-base64url'), false);
  });
});

describe('AdCP 3.2 RFC 8941 binary profile', () => {
  test('normative signing recovery metadata is runtime-immutable', () => {
    assert.strictEqual(Object.isFrozen(RequestSigningErrorCodeMetadata), true);
    assert.strictEqual(Object.isFrozen(RequestSigningErrorCodeMetadata.request_signature_jwks_untrusted), true);
    assert.strictEqual(
      Reflect.set(RequestSigningErrorCodeMetadata.request_signature_jwks_untrusted, 'recovery', 'transient'),
      false
    );
    assert.strictEqual(RequestSigningErrorCodeMetadata.request_signature_jwks_untrusted.recovery, 'terminal');
  });

  test('version selection keeps 3.0/3.1 legacy and makes 3.2 standards-compliant', () => {
    assert.strictEqual(requestSigningEncodingForVersion('3.0.25'), 'legacy-base64url');
    assert.strictEqual(requestSigningEncodingForVersion('3.1.18'), 'legacy-base64url');
    assert.strictEqual(requestSigningEncodingForVersion('3.2-beta.1'), 'rfc8941-base64');
    assert.strictEqual(requestSigningEncodingForVersion('3.2.0-beta.1'), 'rfc8941-base64');
  });

  test('an explicitly pinned 3.2 verifier uses padded Base64 and mandatory Content-Digest', async () => {
    const now = 1776520800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"plan_id":"plan_3_2"}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
      {
        now: () => now,
        windowSeconds: 300,
        nonce: 'adcp-3-2-profile-nonce',
        binaryEncoding: 'rfc8941-base64',
      }
    );

    assert.match(signed.headers.Signature, /^sig1=:[A-Za-z0-9+/]+={1,2}:$/);
    assert.ok(signed.headers['Signature-Input'].includes('"content-digest"'));
    assert.strictEqual(contentDigestUsesEncoding(signed.headers['Content-Digest'], 'rfc8941-base64'), true);

    const result = await verifyRequestSignature(
      { method: 'POST', url, headers: signed.headers, body },
      {
        capability: { supported: true, covers_content_digest: 'required', required_for: [] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => now,
        operation: 'create_media_buy',
        adcpVersion: '3.2-beta.1',
      }
    );
    assert.strictEqual(result.keyid, 'test-ed25519-2026');
  });

  test('strict signed JSON rejects duplicate keys without committing the nonce', async () => {
    const now = 1776520800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const nonce = 'duplicate-json-key-nonce';
    const replayStore = new InMemoryReplayStore();
    const options = {
      capability: { supported: true, covers_content_digest: 'required', required_for: [] },
      jwks: new StaticJwksResolver([publicJwk]),
      replayStore,
      revocationStore: new InMemoryRevocationStore(),
      now: () => now,
      operation: 'create_media_buy',
      adcpVersion: '3.2.1',
    };
    const signBody = body =>
      signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
        { now: () => now, windowSeconds: 300, nonce, binaryEncoding: 'rfc8941-base64' }
      );

    const duplicateBody = '{"plan_id":"first","plan_id":"second"}';
    const duplicate = signBody(duplicateBody);
    await assert.rejects(
      () => verifyRequestSignature({ method: 'POST', url, headers: duplicate.headers, body: duplicateBody }, options),
      err => err instanceof RequestSignatureError && err.code === 'request_body_malformed'
    );

    const validBody = '{"plan_id":"valid"}';
    const valid = signBody(validBody);
    const result = await verifyRequestSignature(
      { method: 'POST', url, headers: valid.headers, body: validBody },
      options
    );
    assert.strictEqual(result.keyid, 'test-ed25519-2026');
  });

  test('an unpinned verifier accepts 3.2 Base64 without overriding the trusted digest policy', async () => {
    const now = 1776520800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"plan_id":"plan_3_2_unpinned"}';
    const signed = signIntentionalNegativeVector(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      {
        now: () => now,
        windowSeconds: 300,
        nonce: 'adcp-3-2-unpinned-nonce',
        coverContentDigest: false,
        binaryEncoding: 'rfc8941-base64',
      }
    );

    const result = await verifyRequestSignature(
      { method: 'POST', url, headers: signed.headers, body },
      {
        capability: { supported: true, covers_content_digest: 'forbidden', required_for: [] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => now,
        operation: 'create_media_buy',
      }
    );
    assert.strictEqual(result.keyid, 'test-ed25519-2026');
  });

  test('an explicit 3.2 pin rejects body signatures that omit Content-Digest', async () => {
    const now = 1776520800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"amount":1}';
    const signed = signIntentionalNegativeVector(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      {
        now: () => now,
        nonce: 'standard-no-digest-nonce',
        binaryEncoding: 'rfc8941-base64',
        coverContentDigest: false,
      }
    );
    for (const adcpVersion of ['3.2-beta.1', '']) {
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', url, headers: signed.headers, body: '{"amount":999999}' },
            {
              capability: { supported: true, covers_content_digest: 'either', required_for: [] },
              jwks: new StaticJwksResolver([publicJwk]),
              replayStore: new InMemoryReplayStore(),
              revocationStore: new InMemoryRevocationStore(),
              now: () => now,
              adcpVersion,
            }
          ),
        err => err instanceof RequestSignatureError && err.code === 'request_signature_components_incomplete'
      );
    }
  });

  test('high-level 3.2 signer refuses an undigested body', () => {
    assert.throws(
      () =>
        signRequest(
          {
            method: 'POST',
            url: 'https://seller.example.com/mcp',
            headers: { 'Content-Type': 'application/json' },
            body: '{"amount":1}',
          },
          { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
          { binaryEncoding: 'rfc8941-base64', coverContentDigest: false }
        ),
      /requires Content-Digest coverage/
    );
  });

  test('strict verification rejects duplicate Content-Digest dictionary members', async () => {
    const now = 1776520800;
    const url = 'https://seller.example.com/adcp/create_media_buy';
    const body = '{"amount":1}';
    const signed = signRequest(
      { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
      { now: () => now, nonce: 'duplicate-digest-nonce', binaryEncoding: 'rfc8941-base64' }
    );
    const headers = {
      ...signed.headers,
      'Content-Digest': `sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:, ${signed.headers['Content-Digest']}`,
    };
    await assert.rejects(
      () =>
        verifyRequestSignature(
          { method: 'POST', url, headers, body },
          {
            capability: { supported: true, covers_content_digest: 'required', required_for: [] },
            jwks: new StaticJwksResolver([publicJwk]),
            replayStore: new InMemoryReplayStore(),
            revocationStore: new InMemoryRevocationStore(),
            now: () => now,
          }
        ),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_header_malformed'
    );
  });

  // adcp-client#3073: a 3.2 verifier MUST NOT retry a Base64URL token
  // through the legacy decoder, whatever its internal digest policy.
  const signLegacyProfile = ({ now, nonce, body }) =>
    signRequest(
      {
        method: 'POST',
        url: 'https://seller.example.com/adcp/create_media_buy',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
      { now: () => now, windowSeconds: 300, nonce, coverContentDigest: true, binaryEncoding: 'legacy-base64url' }
    );
  const verifyAt = (signed, body, now, capabilityDigest, adcpVersion) =>
    verifyRequestSignature(
      { method: 'POST', url: 'https://seller.example.com/adcp/create_media_buy', headers: signed.headers, body },
      {
        capability: { supported: true, covers_content_digest: capabilityDigest, required_for: [] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => now,
        operation: 'create_media_buy',
        ...(adcpVersion !== undefined ? { adcpVersion } : {}),
      }
    );
  const isMalformedAtStep = step => err =>
    err instanceof RequestSignatureError &&
    err.code === 'request_signature_header_malformed' &&
    err.failedStep === step;

  for (const digestPolicy of ['either', 'required']) {
    test(`3.2 verifier rejects a legacy Base64URL Signature at step 1 when digest policy is ${digestPolicy}`, async () => {
      const now = 1776520800;
      const body = '{"plan_id":"legacy_profile"}';
      const signed = signLegacyProfile({ now, nonce: `legacy-profile-${digestPolicy}`, body });
      assert.match(signed.headers.Signature, /[-_]/, 'fixture must exercise the Base64URL alphabet');
      await assert.rejects(() => verifyAt(signed, body, now, digestPolicy, '3.2-beta.1'), isMalformedAtStep(1));
    });
  }

  test('3.2 verifier reports the malformed Signature before an expired window', async () => {
    // Mirrors profile-3.2/negative/001 graded live: the vector's timestamps
    // are fixed, so a lenient parser would surface window_invalid instead.
    const signedAt = 1776520800;
    const body = '{"plan_id":"legacy_profile"}';
    const signed = signLegacyProfile({ now: signedAt, nonce: 'legacy-profile-expired', body });
    await assert.rejects(() => verifyAt(signed, body, signedAt + 86400, 'either', '3.2'), isMalformedAtStep(1));
  });

  test('3.0/3.1-pinned and unpinned verifiers keep accepting legacy Base64URL signatures', async () => {
    const now = 1776520800;
    const body = '{"plan_id":"legacy_profile"}';
    for (const [adcpVersion, digestPolicy] of [
      ['3.1', 'either'],
      ['3.1', 'required'],
      ['3.0', 'either'],
      [undefined, 'either'],
      [undefined, 'required'],
    ]) {
      const signed = signLegacyProfile({ now, nonce: `legacy-ok-${adcpVersion ?? 'unpinned'}-${digestPolicy}`, body });
      const result = await verifyAt(signed, body, now, digestPolicy, adcpVersion);
      assert.strictEqual(result.keyid, 'test-ed25519-2026', `${adcpVersion ?? 'unpinned'} / ${digestPolicy}`);
    }
  });

  test('3.2 verifier rejects a Base64URL Content-Digest as malformed even when digest policy is either', async () => {
    const now = 1776520800;
    const body = '{"plan_id":"digest_alphabet"}';
    const legacyDigest = computeContentDigest(body, 'legacy-base64url');
    assert.match(legacyDigest, /[-_]|[^=]:$/, 'fixture must not be valid padded standard Base64');
    // Re-sign over the legacy digest so the signature itself is valid and
    // only the digest serialization is wrong.
    const resignWithDigest = (binaryEncoding, nonce) => {
      const signed = signRequest(
        {
          method: 'POST',
          url: 'https://seller.example.com/adcp/create_media_buy',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
        { keyid: 'test-ed25519-2026', alg: 'ed25519', privateKey: privateJwk },
        { now: () => now, windowSeconds: 300, nonce, binaryEncoding, coverContentDigest: true }
      );
      const headers = { ...signed.headers, 'Content-Digest': legacyDigest };
      const input = parseSignatureInput(headers['Signature-Input']);
      const base = buildSignatureBase(
        input.components,
        { method: 'POST', url: 'https://seller.example.com/adcp/create_media_buy', headers, body },
        input.params,
        input.signatureParamsValue,
        binaryEncoding === 'rfc8941-base64' ? '3.2' : 'legacy'
      );
      const sig = nodeSign(null, Buffer.from(base, 'utf8'), createPrivateKey({ key: privateJwk, format: 'jwk' }));
      const encoded = binaryEncoding === 'rfc8941-base64' ? sig.toString('base64') : sig.toString('base64url');
      return { headers: { ...headers, Signature: `sig1=:${encoded}:` } };
    };

    const strict = resignWithDigest('rfc8941-base64', 'digest-alphabet-nonce');
    for (const digestPolicy of ['either', 'required']) {
      await assert.rejects(() => verifyAt(strict, body, now, digestPolicy, '3.2'), isMalformedAtStep(11));
    }
    // A 3.1 endpoint keeps its lenient digest parsing for legacy peers.
    const legacy = resignWithDigest('legacy-base64url', 'digest-alphabet-legacy');
    const result = await verifyAt(legacy, body, now, 'either', '3.1');
    assert.strictEqual(result.keyid, 'test-ed25519-2026');
  });
});

describe('parseSignature sf-binary encoding (adcp-client#3073)', () => {
  const { parseSignature } = require('../dist/lib/signing/parser.js');
  const SIG_STD = 'RiD5mPhxpBWhmaqUL5+vceyPX5jpjzYZhSnteuYCIYhIqdIl0Yxdh5qstCPXwkKL4AZOsPBL7+8ctbPkHunSAw==';
  const SIG_URL = SIG_STD.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const malformed = err => err instanceof RequestSignatureError && err.code === 'request_signature_header_malformed';

  test('3.2 profile accepts padded standard Base64 and decodes the same bytes as the legacy form', () => {
    const strict = parseSignature(`sig1=:${SIG_STD}:`, 'sig1', 'rfc8941-base64');
    const legacy = parseSignature(`sig1=:${SIG_URL}:`, 'sig1', 'legacy-base64url');
    assert.strictEqual(strict.bytes.length, 64);
    assert.deepStrictEqual(Buffer.from(strict.bytes), Buffer.from(legacy.bytes));
  });

  test('3.2 profile accepts a byte length that needs no padding', () => {
    const noPad = Buffer.alloc(48, 7).toString('base64');
    assert.ok(!noPad.includes('='));
    assert.strictEqual(parseSignature(`sig1=:${noPad}:`, 'sig1', 'rfc8941-base64').bytes.length, 48);
  });

  for (const [name, value] of [
    ['Base64URL alphabet, unpadded', SIG_URL],
    ['Base64URL alphabet, padded', `${SIG_URL}==`],
    ['standard alphabet without padding', SIG_STD.replace(/=+$/, '')],
    ['excess padding', `${SIG_STD.slice(0, -2)}A===`],
    ['padding before the end', `${SIG_STD.slice(0, 4)}=${SIG_STD.slice(5)}`],
  ]) {
    test(`3.2 profile rejects ${name} at step 1`, () => {
      assert.throws(
        () => parseSignature(`sig1=:${value}:`, 'sig1', 'rfc8941-base64'),
        err => malformed(err) && err.failedStep === 1
      );
    });
  }

  test('3.2 profile parses the whole Signature dictionary strictly, including ignored labels', () => {
    assert.throws(() => parseSignature(`sig1=:${SIG_STD}:, sig2=:${SIG_URL}:`, 'sig1', 'rfc8941-base64'), malformed);
  });

  test('legacy profile still requires unpadded Base64URL for the processed label', () => {
    assert.strictEqual(parseSignature(`sig1=:${SIG_URL}:`, 'sig1', 'legacy-base64url').bytes.length, 64);
    assert.throws(() => parseSignature(`sig1=:${SIG_STD}:`, 'sig1', 'legacy-base64url'), malformed);
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
          adcpVersion: '3.1',
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
        adcpVersion: '3.1',
      }
    );
    // 61s later (past the 10s validity + 60s skew) — the entry must still be
    // in the cache so a replay is still caught, not silently forgotten.
    // Probe under the same `(keyid, @target-uri)` scope the verifier committed.
    const scope = url;
    const stillPresent = await replayStore.has('test-ed25519-2026', scope, 'short-window-nonce-xxxx', now + 75);
    assert.strictEqual(stillPresent, true);
    const stillPresentMuchLater = await replayStore.has(
      'test-ed25519-2026',
      scope,
      'short-window-nonce-xxxx',
      now + 350
    );
    assert.strictEqual(stillPresentMuchLater, true);
  });

  test('replay pre-check takes precedence when the per-scope cap is also hit', async () => {
    const req = buildReq({ keyid: 'test-ed25519-2026' });
    const replayStore = {
      has: async () => true,
      isCapHit: async () => true,
      insert: async () => 'ok',
    };

    await assert.rejects(
      verifyRequestSignature(req, {
        capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore,
        revocationStore: new InMemoryRevocationStore(),
        now: () => 1776520800,
        operation: 'create_media_buy',
        adcpVersion: '3.1',
      }),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_replayed'
    );
  });

  test('rechecks replay when a concurrent same-nonce insert fills the cap', async () => {
    const req = buildReq({ keyid: 'test-ed25519-2026' });
    let hasCalls = 0;
    let insertCalls = 0;
    const replayStore = {
      has: async () => ++hasCalls === 2,
      isCapHit: async () => true,
      insert: async () => {
        insertCalls += 1;
        return 'ok';
      },
    };

    await assert.rejects(
      verifyRequestSignature(req, {
        capability: { supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] },
        jwks: new StaticJwksResolver([publicJwk]),
        replayStore,
        revocationStore: new InMemoryRevocationStore(),
        now: () => 1776520800,
        operation: 'create_media_buy',
        adcpVersion: '3.1',
      }),
      err => err instanceof RequestSignatureError && err.code === 'request_signature_replayed'
    );
    assert.strictEqual(hasCalls, 2);
    assert.strictEqual(insertCalls, 0);
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
