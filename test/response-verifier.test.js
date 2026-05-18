const { test, describe } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const {
  signResponse,
  verifyResponseSignature,
  createResponseVerifier,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  ResponseSignatureError,
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
const keysByKid = new Map(JSON.parse(readFileSync(KEYS_PATH, 'utf8')).keys.map(k => [k.kid, k]));

function publicJwk(kid, overrides = {}) {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...pub } = k;
  return {
    ...pub,
    adcp_use: 'response-signing',
    key_ops: ['verify'],
    ...overrides,
  };
}

function privateJwk(kid, adcpUse = 'response-signing') {
  const k = keysByKid.get(kid);
  const { _private_d_for_test_only, ...rest } = k;
  return { ...rest, d: _private_d_for_test_only, adcp_use: adcpUse };
}

const ORIGINATING_REQUEST = {
  method: 'POST',
  url: 'https://seller.example.com/adcp/get_products',
};

const SAMPLE_RESPONSE = {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ products: [{ id: 'prod_001' }] }),
  request: ORIGINATING_REQUEST,
};

const KID = 'test-ed25519-2026';
const SIGNER_KEY = { keyid: KID, alg: 'ed25519', privateKey: privateJwk(KID) };

function fixedNow() {
  return 1776520800;
}

const SIGN_OPTIONS = { now: fixedNow, nonce: 'KXYnfEfJ0PBRZXQyVXfVQA', windowSeconds: 300 };

function signedResponse(overrides = {}) {
  const signed = signResponse({ ...SAMPLE_RESPONSE, ...overrides.response }, SIGNER_KEY, {
    ...SIGN_OPTIONS,
    ...overrides.signOptions,
  });
  return {
    ...SAMPLE_RESPONSE,
    ...overrides.response,
    headers: { ...(overrides.response?.headers ?? SAMPLE_RESPONSE.headers), ...signed.headers },
  };
}

function verifyOptions(overrides = {}) {
  return {
    jwks: new StaticJwksResolver([publicJwk(KID)]),
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
    now: fixedNow,
    ...overrides,
  };
}

describe('verifyResponseSignature — happy path', () => {
  test('round-trip with a freshly signed response verifies', async () => {
    const response = signedResponse();
    const result = await verifyResponseSignature(response, verifyOptions());
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, KID);
    assert.strictEqual(result.verified_at, fixedNow());
  });

  test('empty-body response (204) verifies without content-digest coverage', async () => {
    const noBody = signedResponse({ response: { status: 204, headers: {}, body: undefined } });
    const result = await verifyResponseSignature(noBody, verifyOptions());
    assert.strictEqual(result.status, 'verified');
  });

  test('ECDSA-P256 round-trip', async () => {
    const kid = 'test-es256-2026';
    const signed = signResponse(
      SAMPLE_RESPONSE,
      { keyid: kid, alg: 'ecdsa-p256-sha256', privateKey: privateJwk(kid) },
      SIGN_OPTIONS
    );
    const response = { ...SAMPLE_RESPONSE, headers: { ...SAMPLE_RESPONSE.headers, ...signed.headers } };
    const result = await verifyResponseSignature(
      response,
      verifyOptions({ jwks: new StaticJwksResolver([publicJwk(kid)]) })
    );
    assert.strictEqual(result.status, 'verified');
    assert.strictEqual(result.keyid, kid);
  });

  test('agentUrlForKeyid populates agent_url on the result', async () => {
    const response = signedResponse();
    const result = await verifyResponseSignature(
      response,
      verifyOptions({ agentUrlForKeyid: () => 'https://seller.example.com' })
    );
    assert.strictEqual(result.agent_url, 'https://seller.example.com');
  });
});

describe('verifyResponseSignature — step 1 header_malformed', () => {
  test('missing Signature-Input header', async () => {
    const response = signedResponse();
    delete response.headers['Signature-Input'];
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err =>
        err instanceof ResponseSignatureError &&
        err.code === 'response_signature_header_malformed' &&
        err.failedStep === 1
    );
  });

  test('missing Signature header', async () => {
    const response = signedResponse();
    delete response.headers.Signature;
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err instanceof ResponseSignatureError && err.code === 'response_signature_header_malformed'
    );
  });

  test('garbage Signature-Input header', async () => {
    const response = signedResponse();
    response.headers['Signature-Input'] = 'totally not parseable';
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_header_malformed'
    );
  });
});

describe('verifyResponseSignature — step 3 tag_invalid', () => {
  test('rejects when the tag in the signature does not match the required tag', async () => {
    const response = signedResponse({ signOptions: { tag: 'adcp/some-other-tag/v1' } });
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_tag_invalid' && err.failedStep === 3
    );
  });

  test('requiredTag override accepts a custom tag', async () => {
    const response = signedResponse({ signOptions: { tag: 'adcp/response-signing/v2' } });
    const result = await verifyResponseSignature(response, verifyOptions({ requiredTag: 'adcp/response-signing/v2' }));
    assert.strictEqual(result.status, 'verified');
  });
});

describe('verifyResponseSignature — step 5 window_invalid', () => {
  test('rejects expired signature (now > expires + skew)', async () => {
    const response = signedResponse();
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ now: () => fixedNow() + 1000 })),
      err => err.code === 'response_signature_window_invalid' && err.failedStep === 5
    );
  });

  test('rejects created-in-future (now < created - skew)', async () => {
    const response = signedResponse();
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ now: () => fixedNow() - 1000 })),
      err => err.code === 'response_signature_window_invalid'
    );
  });
});

describe('verifyResponseSignature — step 6 components_incomplete', () => {
  test('rejects when @target-uri is missing from covered components', async () => {
    // signResponse always includes @target-uri in defaults; to simulate a
    // foreign signer that omitted it, hand-craft a payload. We can verify
    // the error path by signing with @target-uri removed via a custom signer.
    // Easier: feed the verifier a payload whose Signature-Input doesn't
    // mention @target-uri.
    const response = signedResponse();
    // Strip @target-uri from Signature-Input (Signature itself is now mismatched
    // but step 6 fires before crypto, so we'll trip 6 first).
    response.headers['Signature-Input'] = response.headers['Signature-Input'].replace(' "@target-uri"', '');
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_components_incomplete' && err.failedStep === 6
    );
  });

  test('rejects body-bearing response signed without content-digest coverage', async () => {
    // Foreign signer that omitted content-digest despite a body. Strip from
    // Signature-Input. Step 6 catches before crypto.
    const response = signedResponse();
    response.headers['Signature-Input'] = response.headers['Signature-Input'].replace(' "content-digest"', '');
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_components_incomplete'
    );
  });
});

describe('verifyResponseSignature — step 6a target_uri_malformed', () => {
  function withTargetUri(badUrl) {
    const response = signedResponse();
    return { ...response, request: { ...response.request, url: badUrl } };
  }

  test('non-parseable URL', async () => {
    await assert.rejects(
      () => verifyResponseSignature(withTargetUri('not-a-url'), verifyOptions()),
      err => err.code === 'response_target_uri_malformed' && err.failedStep === 6
    );
  });

  test('non-https scheme (non-loopback)', async () => {
    await assert.rejects(
      () => verifyResponseSignature(withTargetUri('http://seller.example.com/adcp/get_products'), verifyOptions()),
      err => err.code === 'response_target_uri_malformed'
    );
  });

  test('userinfo in authority', async () => {
    await assert.rejects(
      () =>
        verifyResponseSignature(withTargetUri('https://user:pw@seller.example.com/adcp/get_products'), verifyOptions()),
      err => err.code === 'response_target_uri_malformed'
    );
  });

  test('fragment present', async () => {
    await assert.rejects(
      () =>
        verifyResponseSignature(withTargetUri('https://seller.example.com/adcp/get_products#frag'), verifyOptions()),
      err => err.code === 'response_target_uri_malformed'
    );
  });

  test('loopback host is exempt from the https rule', async () => {
    // Re-sign so the signature actually binds to the loopback URL.
    const localRequest = { method: 'POST', url: 'http://127.0.0.1:8080/adcp/get_products' };
    const signed = signResponse({ ...SAMPLE_RESPONSE, request: localRequest }, SIGNER_KEY, SIGN_OPTIONS);
    const response = {
      ...SAMPLE_RESPONSE,
      request: localRequest,
      headers: { ...SAMPLE_RESPONSE.headers, ...signed.headers },
    };
    const result = await verifyResponseSignature(response, verifyOptions());
    assert.strictEqual(result.status, 'verified');
  });
});

describe('verifyResponseSignature — step 7 key_unknown', () => {
  test('rejects when JWKS resolver returns nothing for the keyid', async () => {
    const response = signedResponse();
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ jwks: new StaticJwksResolver([]) })),
      err => err.code === 'response_signature_key_unknown' && err.failedStep === 7
    );
  });
});

describe('verifyResponseSignature — step 8 key purpose', () => {
  test('rejects JWK with adcp_use missing', async () => {
    const response = signedResponse();
    const jwkNoPurpose = publicJwk(KID);
    delete jwkNoPurpose.adcp_use;
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ jwks: new StaticJwksResolver([jwkNoPurpose]) })),
      err => err.code === 'response_signature_key_purpose_invalid' && err.failedStep === 8
    );
  });

  test('rejects JWK with adcp_use="webhook-signing" via mode_mismatch', async () => {
    const response = signedResponse();
    const jwkWrongPurpose = publicJwk(KID, { adcp_use: 'webhook-signing' });
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ jwks: new StaticJwksResolver([jwkWrongPurpose]) })),
      err => err.code === 'response_mode_mismatch' && err.failedStep === 8 && /webhook-signing/.test(err.message)
    );
  });

  test('rejects JWK without verify key_op', async () => {
    const response = signedResponse();
    const jwkNoVerify = publicJwk(KID, { key_ops: ['sign'] });
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ jwks: new StaticJwksResolver([jwkNoVerify]) })),
      err => err.code === 'response_signature_key_purpose_invalid'
    );
  });
});

describe('verifyResponseSignature — step 10 signature_invalid', () => {
  test('rejects body tampered post-signing (signature recomputed; bytes mismatch)', async () => {
    const response = signedResponse();
    // Mutate the body but leave the Content-Digest header intact — crypto check
    // passes (signature is over the original base) but content-digest mismatch
    // would fire at step 11. To force step 10, mutate a covered header value
    // without re-stamping Content-Digest. We'll change content-type instead.
    response.headers['Content-Type'] = 'application/xml';
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_invalid' && err.failedStep === 10
    );
  });
});

describe('verifyResponseSignature — step 11 digest_mismatch', () => {
  test('rejects when body has been tampered (digest no longer matches)', async () => {
    const response = signedResponse();
    // Re-stamp the headers with a digest of the original body but swap the body
    // out — crypto passes (base hasn't changed), then step 11 catches the
    // recompute mismatch.
    response.body = JSON.stringify({ products: [{ id: 'tampered' }] });
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_digest_mismatch' && err.failedStep === 11
    );
  });
});

describe('verifyResponseSignature — step 9 revocation', () => {
  test('rejects revoked keyid', async () => {
    const response = signedResponse();
    const revocation = new InMemoryRevocationStore({
      issuer: 'test',
      updated: '2026-01-01T00:00:00Z',
      next_update: '2027-01-01T00:00:00Z',
      revoked_kids: [KID],
      revoked_jtis: [],
    });
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ revocationStore: revocation })),
      err => err.code === 'response_signature_key_revoked' && err.failedStep === 9
    );
  });
});

describe('verifyResponseSignature — step 12/13 replay', () => {
  test('rejects same nonce a second time (commit phase)', async () => {
    const response = signedResponse();
    const replay = new InMemoryReplayStore();
    const opts = verifyOptions({ replayStore: replay });

    const first = await verifyResponseSignature(response, opts);
    assert.strictEqual(first.status, 'verified');

    await assert.rejects(
      () => verifyResponseSignature(response, opts),
      err => err.code === 'response_signature_replayed'
    );
  });
});

describe('createResponseVerifier — factory shares stores across calls', () => {
  test('replay detection works across two calls with the bound verifier', async () => {
    const verify = createResponseVerifier({
      jwks: new StaticJwksResolver([publicJwk(KID)]),
      now: fixedNow,
    });
    const response = signedResponse();
    const first = await verify(response);
    assert.strictEqual(first.status, 'verified');
    await assert.rejects(
      () => verify(response),
      err => err.code === 'response_signature_replayed'
    );
  });
});

describe('verifyResponseSignature — cross-purpose signing from outside-SDK source', () => {
  test('rejects a wrong-tag signature even when crypto would otherwise verify', async () => {
    // Author a payload with the *request-signing* tag — same crypto, wrong
    // purpose. The verifier should reject at step 3 (tag mismatch), not step
    // 10 (crypto valid).
    const response = signedResponse({ signOptions: { tag: 'adcp/request-signing/v1' } });
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_tag_invalid'
    );
  });
});

describe('verifyResponseSignature — step 2 params_incomplete', () => {
  // Mutate the parsed Signature-Input by dropping one required param. Step 2
  // fires before crypto, so we don't need the resulting bytes to verify.
  function dropParam(response, paramName) {
    const sigInput = response.headers['Signature-Input'];
    // Match `;<name>=...` whether the value is quoted (string) or bare (int).
    const stripped = sigInput.replace(new RegExp(`;${paramName}=(?:"[^"]*"|[0-9]+)`), '');
    return { ...response, headers: { ...response.headers, 'Signature-Input': stripped } };
  }

  for (const param of ['created', 'expires', 'nonce', 'keyid', 'alg', 'tag']) {
    test(`rejects when ${param} is missing`, async () => {
      const response = dropParam(signedResponse(), param);
      await assert.rejects(
        () => verifyResponseSignature(response, verifyOptions()),
        err => err.code === 'response_signature_params_incomplete' && err.failedStep === 2
      );
    });
  }
});

describe('verifyResponseSignature — step 4 alg_not_allowed', () => {
  test('rejects when alg is not in the AdCP allowlist (e.g. hs256)', async () => {
    const response = signedResponse();
    response.headers['Signature-Input'] = response.headers['Signature-Input'].replace(/alg="[^"]+"/, 'alg="hs256"');
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions()),
      err => err.code === 'response_signature_alg_not_allowed' && err.failedStep === 4
    );
  });
});

describe('verifyResponseSignature — step 7 kid mismatch', () => {
  test('rejects when JWKS resolver returns a JWK whose kid disagrees with the requested keyid', async () => {
    const response = signedResponse();
    const mismatchedJwk = publicJwk(KID, { kid: 'some-other-kid' });
    // StaticJwksResolver indexes by kid; bypass via a custom resolver.
    const liarJwks = { resolve: async () => mismatchedJwk };
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ jwks: liarJwks })),
      err => err.code === 'response_signature_key_unknown' && err.failedStep === 7
    );
  });
});

describe('verifyResponseSignature — step 9 revocation_stale', () => {
  test('re-maps request_signature_revocation_stale → response_signature_revocation_stale', async () => {
    const response = signedResponse();
    const { RequestSignatureError: RequestSignatureErrorClass } = require('../dist/lib/signing/index.js');
    const staleStore = {
      isRevoked: async () => {
        throw new RequestSignatureErrorClass(
          'request_signature_revocation_stale',
          9,
          'revocation snapshot is past grace'
        );
      },
    };
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ revocationStore: staleStore })),
      err => err.code === 'response_signature_revocation_stale' && err.failedStep === 9
    );
  });
});

describe('verifyResponseSignature — step 9a / 13 rate_abuse', () => {
  test('isCapHit at pre-check phase trips rate_abuse', async () => {
    const response = signedResponse();
    const capStore = {
      has: async () => false,
      isCapHit: async () => true,
      insert: async () => 'ok',
    };
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ replayStore: capStore })),
      err => err.code === 'response_signature_rate_abuse' && err.failedStep === 9
    );
  });

  test('insert returns rate_abuse at commit phase', async () => {
    const response = signedResponse();
    const commitStore = {
      has: async () => false,
      isCapHit: async () => false,
      insert: async () => 'rate_abuse',
    };
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ replayStore: commitStore })),
      err => err.code === 'response_signature_rate_abuse' && err.failedStep === 13
    );
  });

  test('insert returns replayed at commit phase', async () => {
    // Path 13 vs path 12: cover both phases. Pre-check (12) hit by repeating a
    // call; this test hits the commit-side replay arm.
    const response = signedResponse();
    const racyStore = {
      has: async () => false,
      isCapHit: async () => false,
      insert: async () => 'replayed',
    };
    await assert.rejects(
      () => verifyResponseSignature(response, verifyOptions({ replayStore: racyStore })),
      err => err.code === 'response_signature_replayed' && err.failedStep === 13
    );
  });
});

describe('verifyResponseSignature — agentUrlForKeyid is invoked with the resolved kid', () => {
  test('agentUrlForKeyid receives the JWK kid, not the requested keyid', async () => {
    const response = signedResponse();
    const seen = [];
    const result = await verifyResponseSignature(
      response,
      verifyOptions({
        agentUrlForKeyid: kid => {
          seen.push(kid);
          return 'https://seller.example.com';
        },
      })
    );
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0], KID);
    assert.strictEqual(result.agent_url, 'https://seller.example.com');
  });
});
