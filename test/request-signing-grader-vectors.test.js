const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  loadRequestSigningVectors,
  buildPositiveRequest,
  buildNegativeRequest,
  listSupportedNegativeVectors,
  gradeOneVector,
  gradeRequestSigning,
  synthesizeRequestSigningSteps,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');

const {
  parseSignature,
  parseSignatureInput,
  verifySignature,
  jwkToPublicKey,
  buildSignatureBase,
  REQUEST_SIGNING_TAG,
  computeContentDigest,
} = require('../dist/lib/signing/index.js');

const loaded = loadRequestSigningVectors();

describe('request-signing vector loader', () => {
  test('loads root vectors and exposes version profiles without changing the 3.1-compatible grader set', () => {
    assert.strictEqual(loaded.positive.length, 12, 'positive count');
    assert.strictEqual(loaded.negative.length, 28, 'negative count');
    assert.strictEqual(loaded.profiles['3.2'].positive.length, 11, '3.2 positive profile count');
    assert.strictEqual(loaded.profiles['3.2'].negative.length, 19, '3.2 negative profile count');
  });

  test('every vector carries request, verifier_capability, and a jwks selector', () => {
    for (const v of [...loaded.positive, ...loaded.negative]) {
      assert.ok(v.id, `${v.id || '?'}: missing id`);
      assert.ok(v.request?.method, `${v.id}: missing request.method`);
      assert.ok(v.request?.url, `${v.id}: missing request.url`);
      assert.ok(v.verifier_capability, `${v.id}: missing verifier_capability`);
      const hasRef = Array.isArray(v.jwks_ref) && v.jwks_ref.length > 0;
      const hasOverride = v.jwks_override && Array.isArray(v.jwks_override.keys) && v.jwks_override.keys.length > 0;
      assert.ok(hasRef || hasOverride, `${v.id}: must declare jwks_ref or jwks_override`);
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
      'request_target_uri_malformed',
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

describe('3.2 profile grading', () => {
  const profilePositiveId = 'profile-3.2/positive/001-post-with-content-digest';
  const profileNegativeId = 'profile-3.2/negative/002-multiple-trailing-dots';

  test('batch grading selects profile vectors only when requested', async () => {
    const base = { onlyVectors: [profileNegativeId], transport: 'raw' };
    const root = await gradeRequestSigning('https://agent.example.invalid', base);
    assert.ok(!root.negative.some(vector => vector.vector_id === profileNegativeId));

    const profiled = await gradeRequestSigning('https://agent.example.invalid', {
      ...base,
      signingProfileVersion: '3.2',
    });
    assert.ok(profiled.positive.some(vector => vector.vector_id === profilePositiveId));
    assert.ok(
      [...profiled.positive, ...profiled.negative].every(vector => vector.vector_id.startsWith('profile-3.2/')),
      'legacy root vectors cannot grade a 3.2 verifier'
    );
    assert.strictEqual(
      profiled.negative.find(vector => vector.vector_id === profileNegativeId).skip_reason,
      'transport_ungradable'
    );
  });

  test('single-vector grading requires the profile gate', async () => {
    await assert.rejects(() => gradeOneVector(profileNegativeId, 'negative', 'https://agent.example.invalid'));
    const result = await gradeOneVector(profileNegativeId, 'negative', 'https://agent.example.invalid', {
      signingProfileVersion: '3.2',
    });
    assert.strictEqual(result.skip_reason, 'transport_ungradable');
  });

  test('3.2 storyboard synthesis includes profile vector steps', () => {
    const storyboard = {
      id: 'signed_requests',
      adcp_version: '3.2.1',
      phases: [
        { id: 'positive_vectors', steps: [] },
        { id: 'negative_vectors', steps: [] },
      ],
    };
    const result = synthesizeRequestSigningSteps(storyboard);
    assert.ok(result.phases[0].steps.some(step => step.id === `positive-${profilePositiveId}`));
    assert.ok(result.phases[1].steps.some(step => step.id === `negative-${profileNegativeId}`));
    assert.ok(result.phases.flatMap(phase => phase.steps).every(step => step.id.includes('profile-3.2/')));
  });

  test('3.2 negative builders are registered and preserve required digest coverage', () => {
    const suffixes = [
      '002-wrong-tag',
      '003-expired-signature',
      '004-window-too-long',
      '005-alg-not-allowed',
      '006-missing-covered-component',
      '007-missing-content-digest',
      '008-unknown-keyid',
      '009-key-ops-missing-verify',
      '010-content-digest-mismatch',
      '012-missing-expires-param',
      '013-expires-le-created',
      '014-missing-nonce-param',
      '015-signature-invalid',
      '016-replayed-nonce',
      '017-key-revoked',
      '020-rate-abuse',
      '025-jwk-alg-crv-mismatch',
    ];
    const registered = new Set(listSupportedNegativeVectors());
    for (const suffix of suffixes) assert.ok(registered.has(`profile-3.2/negative/${suffix}`), suffix);

    const root006 = loaded.negative.find(vector => vector.id === '006-missing-covered-component');
    const profile006 = {
      ...root006,
      id: 'profile-3.2/negative/006-missing-covered-component',
      signing_profile_version: '3.2',
      verifier_capability: { ...root006.verifier_capability, covers_content_digest: 'required' },
      request: {
        ...root006.request,
        headers: {
          ...root006.request.headers,
          'Content-Digest': computeContentDigest(root006.request.body ?? '', 'rfc8941-base64'),
        },
      },
    };
    const signed006 = buildNegativeRequest(profile006, loaded.keys);
    const components = parseSignatureInput(signed006.headers['Signature-Input']).components;
    assert.ok(components.includes('content-digest'));
    assert.ok(!components.includes('@authority'));
    const mcpOptions = { transport: 'mcp', baseUrl: 'https://agent.example.com/mcp' };
    const mcp006 = buildNegativeRequest(profile006, loaded.keys, mcpOptions);
    assert.strictEqual(mcp006.headers['Content-Digest'], computeContentDigest(mcp006.body, 'rfc8941-base64'));

    const root002 = loaded.negative.find(vector => vector.id === '002-wrong-tag');
    const profile002 = {
      ...root002,
      id: 'profile-3.2/negative/002-wrong-tag',
      signing_profile_version: '3.2',
      verifier_capability: { ...root002.verifier_capability, covers_content_digest: 'required' },
    };
    const mcp002 = buildNegativeRequest(profile002, loaded.keys, mcpOptions);
    assert.strictEqual(mcp002.headers['Content-Digest'], computeContentDigest(mcp002.body, 'rfc8941-base64'));
    assert.ok(parseSignatureInput(mcp002.headers['Signature-Input']).components.includes('content-digest'));

    const root010 = loaded.negative.find(vector => vector.id === '010-content-digest-mismatch');
    const profile010 = {
      ...root010,
      id: 'profile-3.2/negative/010-content-digest-mismatch',
      signing_profile_version: '3.2',
      verifier_capability: { ...root010.verifier_capability, covers_content_digest: 'required' },
    };
    const mcp010 = buildNegativeRequest(profile010, loaded.keys, mcpOptions);
    assert.notStrictEqual(mcp010.headers['Content-Digest'], computeContentDigest(mcp010.body, 'rfc8941-base64'));

    const root015 = loaded.negative.find(vector => vector.id === '015-signature-invalid');
    const profile015 = {
      ...root015,
      id: 'profile-3.2/negative/015-signature-invalid',
      signing_profile_version: '3.2',
      verifier_capability: { ...root015.verifier_capability, covers_content_digest: 'required' },
    };
    const signed015 = buildNegativeRequest(profile015, loaded.keys);
    assert.ok(parseSignatureInput(signed015.headers['Signature-Input']).components.includes('content-digest'));
    assert.ok(parseSignature(signed015.headers.Signature, 'sig1', 'rfc8941-base64').bytes.every(byte => byte === 0));
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
      const encoding = vector.signing_profile_version === '3.2' ? 'rfc8941-base64' : 'legacy-base64url';
      const parsedSig = parseSignature(signed.headers['Signature'], label, encoding);

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
        signatureParamsValue,
        vector.signing_profile_version === '3.2' ? '3.2' : 'legacy'
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

describe('preflightSkip — operator-facing skip paths', () => {
  const FAKE_URL = 'https://agent.example.invalid';

  test('onlyVectors filter skips every vector not in the list', async () => {
    const result = await gradeOneVector('016-replayed-nonce', 'negative', FAKE_URL, {
      onlyVectors: ['020-rate-abuse'],
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'not_in_only_vectors');
  });

  test('skipVectors list skips by vector id', async () => {
    const result = await gradeOneVector('002-wrong-tag', 'negative', FAKE_URL, {
      skipVectors: ['002-wrong-tag'],
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'operator_skip');
  });

  test('skipRateAbuse skips 020 with the rate_abuse_opt_out reason', async () => {
    const result = await gradeOneVector('020-rate-abuse', 'negative', FAKE_URL, {
      skipRateAbuse: true,
    });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skip_reason, 'rate_abuse_opt_out');
  });
});
