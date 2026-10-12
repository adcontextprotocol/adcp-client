// AdCP 3.2.4 added 22 request-signing vectors. The grader re-signs every
// vector against a live clock, so these tests check that each adversarial or
// shape-sensitive request is actually constructed (not merely that a builder
// exists) and that the SDK verifier gives the corpus's refusal code for it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  loadRequestSigningVectors,
  buildNegativeRequest,
  buildPositiveRequest,
  listSupportedNegativeVectors,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');
const { semanticVectorExclusion, gradeOneVector } = require('../dist/lib/testing/storyboard/request-signing/grader.js');
const { probeSignedRequest } = require('../dist/lib/testing/storyboard/request-signing/probe.js');
const {
  verifyRequestSignature,
  RequestSignatureError,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  computeContentDigest,
} = require('../dist/lib/signing/index.js');

const loaded = loadRequestSigningVectors();
const rawKeys = JSON.parse(
  readFileSync(path.join(__dirname, '../compliance/cache/latest/test-vectors/request-signing/keys.json'), 'utf8')
).keys;

const ADDED = {
  negative: ['029-duplicate-signature-label', '030-content-digest-key-case', '031-malformed-host-authority'],
  positive: [
    '013-two-signature-labels-distinct',
    '014-content-digest-two-algorithms',
    '015-bracketed-ipv6-host-with-port',
  ],
  // Added as profile-3.2 mirrors only; the root vectors predate 3.2.4.
  profileOnlyNegative: [
    '001-no-signature-header',
    '011-malformed-header',
    '019-signature-without-signature-input',
    '021-duplicate-signature-input-label',
    '022-multi-valued-content-type',
    '023-multi-valued-content-digest',
    '024-unquoted-string-param',
    '026-non-ascii-host',
    '027-webhook-registration-authentication-unsigned',
    '028-unsigned-protocol-method-required',
  ],
};

const PROFILE = loaded.profiles['3.2'];
const allNegative = [...loaded.negative, ...PROFILE.negative];
const allPositive = [...loaded.positive, ...PROFILE.positive];
const byId = (list, id) => {
  const vector = list.find(v => v.id === id);
  assert.ok(vector, `${id} must be in the loaded corpus`);
  return vector;
};

async function verify(vector, request, now) {
  try {
    await verifyRequestSignature(request, {
      capability: vector.verifier_capability,
      jwks: new StaticJwksResolver(rawKeys.filter(key => (vector.jwks_ref ?? []).includes(key.kid))),
      replayStore: new InMemoryReplayStore(),
      revocationStore: new InMemoryRevocationStore(),
      now: () => now,
      operation: new URL(vector.request.url).pathname.split('/').filter(Boolean).pop(),
      adcpVersion: vector.signing_profile_version ?? '3.1',
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof RequestSignatureError) return { ok: false, code: error.code };
    throw error;
  }
}

const transports = [
  ['raw', {}],
  ['mcp', { baseUrl: 'https://seller.example.com/mcp', mcpJsonRpcId: 'vector' }],
];

describe('3.2.4 negative vectors are built, not skipped', () => {
  test('every negative vector on disk, root and profile-3.2, has a registered builder', () => {
    const registered = new Set(listSupportedNegativeVectors());
    for (const vector of allNegative) assert.ok(registered.has(vector.id), `no builder for ${vector.id}`);
  });

  const negatives = [
    ...ADDED.negative.flatMap(id => [id, `profile-3.2/negative/${id}`]),
    ...ADDED.profileOnlyNegative.map(id => `profile-3.2/negative/${id}`),
  ];
  for (const [transport, extra] of transports) {
    for (const id of negatives) {
      // 026 (raw U-label) and 031 (Host header) cannot be put on the wire by an
      // HTTP client; they are graded at the library level below.
      if (/026-non-ascii-host$/.test(id)) continue;
      test(`${id} (${transport}) is refused with the corpus code`, async () => {
        const vector = byId(allNegative, id);
        const now = Math.floor(Date.now() / 1000);
        const request = buildNegativeRequest(vector, loaded.keys, { now, transport, ...extra });
        const outcome = await verify(vector, request, now);
        assert.equal(outcome.ok, false, `${id} must be refused`);
        assert.equal(outcome.code, vector.expected_error_code);
      });
    }
  }
});

describe('unknown negative vectors still fail closed', () => {
  test('a vector without a registered builder throws instead of being skipped or passed through', () => {
    const [template] = loaded.negative;
    for (const id of ['099-future-vector', 'profile-3.2/negative/099-future-vector']) {
      assert.throws(
        () => buildNegativeRequest({ ...template, id }, loaded.keys),
        /No adversarial builder registered for negative vector/
      );
    }
  });
});

describe('3.2.4 negative vectors present their documented defect', () => {
  const key = vector => {
    const now = vector.reference_now;
    const nonce = /nonce="([^"]+)"/.exec(vector.request.headers['Signature-Input'])[1];
    return { now, nonce };
  };

  for (const id of ['029-duplicate-signature-label', 'profile-3.2/negative/029-duplicate-signature-label']) {
    test(`${id} repeats one real sig1 member and nothing else is wrong`, () => {
      const vector = byId(allNegative, id);
      const request = buildNegativeRequest(vector, loaded.keys, key(vector));
      const members = request.headers.Signature.split(', ');
      assert.equal(members.length, 2);
      assert.ok(members.every(member => member.startsWith('sig1=:') && member === members[0]));
      assert.equal(request.headers['Signature-Input'].match(/(^|, )sig\d+=/g).length, 1);
    });
  }

  for (const id of ['030-content-digest-key-case', 'profile-3.2/negative/030-content-digest-key-case']) {
    for (const [transport, extra] of transports) {
      test(`${id} (${transport}) carries SHA-256 and sha-256 over the body actually sent`, () => {
        const vector = byId(allNegative, id);
        const request = buildNegativeRequest(vector, loaded.keys, { ...key(vector), transport, ...extra });
        const encoding = vector.signing_profile_version === '3.2' ? 'rfc8941-base64' : 'legacy-base64url';
        const digest = computeContentDigest(request.body, encoding);
        assert.equal(request.headers['Content-Digest'], `SHA-256${digest.slice('sha-256'.length)}, ${digest}`);
        assert.match(request.headers['Signature-Input'], /"content-digest"/);
      });
    }
  }

  for (const id of ['031-malformed-host-authority', 'profile-3.2/negative/031-malformed-host-authority']) {
    test(`${id} keeps the fixture Host header and signs the clean URL authority`, () => {
      const vector = byId(allNegative, id);
      const request = buildNegativeRequest(vector, loaded.keys, key(vector));
      assert.equal(request.headers.Host, '::1');
      assert.equal(request.url, vector.request.url);
      // A real signature over the same inputs reproduces the fixture bytes for
      // the profile mirror, which carries a real Ed25519 signature.
      if (vector.signing_profile_version === '3.2') {
        assert.deepEqual(request.headers, vector.request.headers);
      }
    });
  }

  test('a profile mirror reuses a root builder only when its fixture shape matches', () => {
    // Mirrors that ship a Content-Digest keep it, recomputed for the body sent.
    for (const id of ['001-no-signature-header', '027-webhook-registration-authentication-unsigned']) {
      const vector = byId(PROFILE.negative, `profile-3.2/negative/${id}`);
      assert.ok(vector.request.headers['Content-Digest'], `${id} fixture carries a Content-Digest`);
      for (const [transport, extra] of transports) {
        const request = buildNegativeRequest(vector, loaded.keys, { now: vector.reference_now, transport, ...extra });
        assert.equal(
          request.headers['Content-Digest'],
          computeContentDigest(request.body, 'rfc8941-base64'),
          `${id} (${transport})`
        );
        assert.equal(request.headers.Signature, undefined);
        assert.equal(request.headers['Signature-Input'], undefined);
      }
    }
  });
});

describe('3.2.4 positive vectors present the shape they exist to grade', () => {
  for (const base of ['', 'profile-3.2/positive/']) {
    const id = `${base}013-two-signature-labels-distinct`;
    test(`${id} sends two distinct labels and still verifies through sig1`, async () => {
      const vector = byId(allPositive, id);
      const now = Math.floor(Date.now() / 1000);
      const request = buildPositiveRequest(vector, loaded.keys, { now });
      const labels = header =>
        (request.headers[header].match(/(?:^|, )(sig\d+)=/g) ?? []).map(l => l.replace(/^, /, ''));
      assert.deepEqual(labels('Signature-Input'), ['sig1=', 'sig2=']);
      assert.deepEqual(labels('Signature'), ['sig1=', 'sig2=']);
      assert.deepEqual(await verify(vector, request, now), { ok: true });
    });

    const digestId = `${base}014-content-digest-two-algorithms`;
    for (const [transport, extra] of transports) {
      test(`${digestId} (${transport}) lists sha-256 and sha-512 for the body sent`, async () => {
        const vector = byId(allPositive, digestId);
        const now = Math.floor(Date.now() / 1000);
        const request = buildPositiveRequest(vector, loaded.keys, { now, transport, ...extra });
        assert.match(request.headers['Content-Digest'], /^sha-256=:[^:]+:, sha-512=:[^:]+:$/);
        assert.ok(
          request.headers['Content-Digest'].startsWith(
            computeContentDigest(
              request.body,
              vector.signing_profile_version === '3.2' ? 'rfc8941-base64' : 'legacy-base64url'
            )
          )
        );
        assert.deepEqual(await verify(vector, request, now), { ok: true });
      });
    }

    const ipv6Id = `${base}015-bracketed-ipv6-host-with-port`;
    test(`${ipv6Id} keeps its Host header only while the request is not retargeted`, async () => {
      const vector = byId(allPositive, ipv6Id);
      const now = Math.floor(Date.now() / 1000);
      const untouched = buildPositiveRequest(vector, loaded.keys, { now });
      assert.equal(untouched.headers.Host, '[2001:db8::1]:8443');
      assert.deepEqual(await verify(vector, untouched, now), { ok: true });
      const retargeted = buildPositiveRequest(vector, loaded.keys, { now, baseUrl: 'https://agent.example.com' });
      assert.equal(retargeted.headers.Host, undefined, 'a stale fixture Host would contradict the signed authority');
    });
  }
});

describe('3.2.4 coverage claims stay truthful', () => {
  test('the production probe replaces malformed Host, substantiating the transport exclusion', async t => {
    let receivedHost;
    const server = http.createServer((request, response) => {
      receivedHost = request.headers.host;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const result = await probeSignedRequest(
      { method: 'POST', url, headers: { Host: '::1', 'Content-Type': 'application/json' }, body: '{}' },
      { allowPrivateIp: true, timeoutMs: 5000 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 200);
    assert.equal(
      receivedHost,
      new URL(url).host,
      'if the production transport preserves Host, the exclusion must be revisited'
    );
  });

  test('031 is transport-ungradable at the HTTP layer and still built for library-level checks', () => {
    for (const id of ['031-malformed-host-authority', 'profile-3.2/negative/031-malformed-host-authority']) {
      const exclusion = semanticVectorExclusion(byId(allNegative, id));
      assert.equal(exclusion.skip_reason, 'transport_ungradable');
      assert.match(exclusion.diagnostic, /Host header/);
    }
  });

  test('015 is skipped, not passed, where the transport cannot carry its authority', async () => {
    for (const transport of ['mcp', 'a2a']) {
      for (const id of [
        '015-bracketed-ipv6-host-with-port',
        'profile-3.2/positive/015-bracketed-ipv6-host-with-port',
      ]) {
        const result = await gradeOneVector(id, 'positive', 'https://agent.example.invalid', {
          transport,
          signingProfileVersion: id.startsWith('profile-3.2/') ? '3.2' : undefined,
        });
        assert.equal(result.skip_reason, 'mcp_mode_flattens_url_edges', `${id} over ${transport}`);
      }
    }
  });
});

describe('verifier judges a Host header the URL does not carry', () => {
  const vector = byId(PROFILE.positive, 'profile-3.2/positive/015-bracketed-ipv6-host-with-port');
  const retry = async host => {
    const now = Math.floor(Date.now() / 1000);
    const request = buildPositiveRequest(vector, loaded.keys, { now });
    const headers = { ...request.headers };
    if (host === undefined) delete headers.Host;
    else headers.Host = host;
    return verify(vector, { ...request, headers }, now);
  };

  test('well-formed authorities verify', async () => {
    for (const host of ['[2001:db8::1]:8443', undefined]) assert.deepEqual(await retry(host), { ok: true });
  });

  for (const host of [
    '::1',
    '[::1',
    '[fe80::1%25eth0]:8443',
    ':443',
    'seller.example.com/x',
    'a@seller.example.com',
    'seller..example.com',
  ]) {
    test(`${JSON.stringify(host)} is refused as request_target_uri_malformed`, async () => {
      assert.deepEqual(await retry(host), { ok: false, code: 'request_target_uri_malformed' });
    });
  }
});
