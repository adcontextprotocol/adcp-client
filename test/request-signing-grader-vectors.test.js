const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  loadRequestSigningVectors,
  buildPositiveRequest,
  buildNegativeRequest,
  listSupportedNegativeVectors,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');

const {
  parseSignature,
  parseSignatureInput,
  verifySignature,
  jwkToPublicKey,
  buildSignatureBase,
  REQUEST_SIGNING_TAG,
} = require('../dist/lib/signing/index.js');

const loaded = loadRequestSigningVectors();

describe('request-signing vector loader', () => {
  test('loads 8 positive and 20 negative vectors from the compliance cache', () => {
    assert.strictEqual(loaded.positive.length, 8, 'positive count');
    assert.strictEqual(loaded.negative.length, 20, 'negative count');
  });

  test('every vector carries request, verifier_capability, and jwks_ref', () => {
    for (const v of [...loaded.positive, ...loaded.negative]) {
      assert.ok(v.id, `${v.id || '?'}: missing id`);
      assert.ok(v.request?.method, `${v.id}: missing request.method`);
      assert.ok(v.request?.url, `${v.id}: missing request.url`);
      assert.ok(v.verifier_capability, `${v.id}: missing verifier_capability`);
      assert.ok(Array.isArray(v.jwks_ref) && v.jwks_ref.length > 0, `${v.id}: empty jwks_ref`);
    }
  });

  test('keys.json ships private scalars for every test keypair', () => {
    assert.ok(loaded.keys.keys.length >= 3, 'at least 3 keypairs');
    for (const k of loaded.keys.keys) {
      assert.ok(k.private_d, `${k.kid}: _private_d_for_test_only must be present`);
      assert.ok(k.kid, 'kid');
      assert.ok(k.kty, 'kty');
    }
  });

  test('error codes on negatives belong to the stable enum', () => {
    const known = new Set([
      'request_signature_required',
      'request_signature_header_malformed',
      'request_signature_params_incomplete',
      'request_signature_tag_invalid',
      'request_signature_alg_not_allowed',
      'request_signature_window_invalid',
      'request_signature_components_incomplete',
      'request_signature_components_unexpected',
      'request_signature_key_unknown',
      'request_signature_key_purpose_invalid',
      'request_signature_key_revoked',
      'request_signature_invalid',
      'request_signature_digest_mismatch',
      'request_signature_replayed',
      'request_signature_rate_abuse',
    ]);
    for (const v of loaded.negative) {
      assert.ok(known.has(v.expected_error_code), `${v.id}: unknown code ${v.expected_error_code}`);
    }
  });
});

describe('positive builder — byte-level correctness against test keys', () => {
  test('every positive vector produces a request whose fresh signature verifies', () => {
    for (const vector of loaded.positive) {
      const signed = buildPositiveRequest(vector, loaded.keys);
      assert.ok(signed.headers['Signature-Input'], `${vector.id}: no Signature-Input`);
      assert.ok(signed.headers['Signature'], `${vector.id}: no Signature`);

      const parsedInput = parseSignatureInput(signed.headers['Signature-Input']);
      const { label, components, params, signatureParamsValue } = parsedInput;
      const parsedSig = parseSignature(signed.headers['Signature'], label);

      assert.strictEqual(params.tag, REQUEST_SIGNING_TAG, `${vector.id}: tag drift`);
      assert.ok(params.created, `${vector.id}: missing created`);
      assert.ok(params.expires > params.created, `${vector.id}: expires must exceed created`);
      assert.ok(params.nonce && params.nonce.length >= 22, `${vector.id}: weak nonce`);

      const base = buildSignatureBase(
        components,
        {
          method: signed.method,
          url: signed.url,
          headers: signed.headers,
          body: signed.body,
        },
        params,
        signatureParamsValue
      );
      const kid = params.keyid;
      const keypair = loaded.keys.keys.find(k => k.kid === kid);
      assert.ok(keypair, `${vector.id}: no keypair for ${kid}`);
      const publicJwk = { ...keypair };
      delete publicJwk.private_d;
      const publicKey = jwkToPublicKey(publicJwk);
      const ok = verifySignature(params.alg, publicKey, Buffer.from(base, 'utf8'), parsedSig.bytes);
      assert.strictEqual(ok, true, `${vector.id}: signature does not verify`);
    }
  });

  test('content-digest coverage follows verifier_capability policy', () => {
    for (const vector of loaded.positive) {
      const signed = buildPositiveRequest(vector, loaded.keys);
      const covers = signed.headers['Signature-Input'].includes('"content-digest"');
      if (vector.verifier_capability.covers_content_digest === 'required') {
        assert.ok(covers, `${vector.id}: must cover content-digest`);
        assert.ok(signed.headers['Content-Digest'], `${vector.id}: must emit Content-Digest`);
      }
    }
  });
});

describe('negative builder — one mutation per vector', () => {
  test('registered mutations cover every negative vector on disk', () => {
    const supported = new Set(listSupportedNegativeVectors());
    for (const v of loaded.negative) {
      assert.ok(supported.has(v.id), `no mutation registered for ${v.id}`);
    }
  });

  const structuralAssertions = {
    '001-no-signature-header': signed => {
      assert.ok(!signed.headers['Signature'], 'Signature must be absent');
      assert.ok(!signed.headers['Signature-Input'], 'Signature-Input must be absent');
    },
    '002-wrong-tag': signed => {
      assert.match(signed.headers['Signature-Input'], /tag="example-org\/signing\/v1"/);
    },
    '003-expired-signature': signed => {
      const input = signed.headers['Signature-Input'];
      const match = /created=(\d+);expires=(\d+)/.exec(input);
      assert.ok(match, 'created/expires params present');
      const expires = Number(match[2]);
      assert.ok(expires < Math.floor(Date.now() / 1000), 'expires in the past');
    },
    '004-window-too-long': signed => {
      const match = /created=(\d+);expires=(\d+)/.exec(signed.headers['Signature-Input']);
      assert.ok(Number(match[2]) - Number(match[1]) > 300, 'window exceeds 300s');
    },
    '005-alg-not-allowed': signed => {
      assert.match(signed.headers['Signature-Input'], /alg="rsa-pss-sha512"/);
    },
    '006-missing-covered-component': signed => {
      assert.ok(!signed.headers['Signature-Input'].includes('"@authority"'), '@authority must be absent');
    },
    '007-missing-content-digest': signed => {
      assert.ok(!signed.headers['Content-Digest'], 'Content-Digest must be absent');
      assert.ok(!signed.headers['Signature-Input'].includes('"content-digest"'));
    },
    '008-unknown-keyid': signed => {
      assert.match(signed.headers['Signature-Input'], /keyid="unknown-key-9999"/);
    },
    '010-content-digest-mismatch': signed => {
      // Body was mutated post-sign; the Content-Digest no longer matches the payload.
      assert.ok(signed.headers['Content-Digest'], 'digest header present');
    },
    '011-malformed-header': signed => {
      assert.ok(!/^sig1=\(/.test(signed.headers['Signature-Input']), 'malformed structured-field');
    },
    '012-missing-expires-param': signed => {
      assert.ok(!/\bexpires=/.test(signed.headers['Signature-Input']));
    },
    '013-expires-le-created': signed => {
      const match = /created=(\d+);expires=(\d+)/.exec(signed.headers['Signature-Input']);
      assert.strictEqual(match[1], match[2], 'expires === created');
    },
    '014-missing-nonce-param': signed => {
      assert.ok(!/\bnonce=/.test(signed.headers['Signature-Input']));
    },
    '015-signature-invalid': signed => {
      const match = /sig1=:([^:]+):/.exec(signed.headers['Signature']);
      const decoded = Buffer.from(match[1], 'base64url');
      assert.ok(
        decoded.every(b => b === 0),
        'all-zero signature bytes'
      );
    },
    '019-signature-without-signature-input': signed => {
      assert.ok(signed.headers['Signature'], 'Signature present');
      assert.ok(!signed.headers['Signature-Input'], 'Signature-Input absent');
    },
  };

  for (const vector of loaded.negative) {
    test(`${vector.id}: mutation is structurally correct`, () => {
      const signed = buildNegativeRequest(vector, loaded.keys);
      assert.ok(signed.method && signed.url, 'method + url preserved');
      const assertion = structuralAssertions[vector.id];
      if (assertion) assertion(signed);
    });
  }
});
