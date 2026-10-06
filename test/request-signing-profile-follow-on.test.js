const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { signingProfileForAdcpVersion } = require('../dist/lib/testing/storyboard/request-signing/vector-loader.js');
const {
  loadRequestSigningVectors,
  buildNegativeRequest,
  listSupportedNegativeVectors,
} = require('../dist/lib/testing/storyboard/request-signing/index.js');
const { semanticVectorExclusion } = require('../dist/lib/testing/storyboard/request-signing/grader.js');
const {
  signRequest,
  verifyRequestSignature,
  StaticJwksResolver,
  InMemoryReplayStore,
  InMemoryRevocationStore,
  computeContentDigest,
} = require('../dist/lib/signing/index.js');

const keys = JSON.parse(
  readFileSync(path.join(__dirname, '../compliance/cache/latest/test-vectors/request-signing/keys.json'), 'utf8')
).keys;
const testKey = keys.find(key => key.kid === 'test-ed25519-2026');
const { _private_d_for_test_only: d, ...publicKey } = testKey;
const privateKey = { ...publicKey, d };

describe('request-signing profile selection after AdCP 3.2', () => {
  for (const version of ['3.2', '3.2.1', '3.2-beta.1', '3.3', '3.9.0', '3.10.0-beta.1', '4.0', '10.0']) {
    test(`${version} retains the mandatory body-bound 3.2 corpus`, () => {
      assert.equal(signingProfileForAdcpVersion(version), '3.2');
    });
  }
  for (const version of [undefined, '', '2.9', '3.0.27', '3.1.24', 'v3', 'not-a-version']) {
    test(`${String(version)} retains the legacy corpus`, () => {
      assert.equal(signingProfileForAdcpVersion(version), undefined);
    });
  }
});

describe('remaining 3.2 negative builder conditions', () => {
  const loaded = loadRequestSigningVectors();
  const added = [
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
  ];
  for (const id of added) {
    // Shape an input from the released legacy fixture: the new profile changes
    // encoding and body coverage, while retaining its intentional refusal.
    const legacy = loaded.negative.find(vector => vector.id === id);
    const headers = { ...legacy.request.headers };
    if (headers['Signature-Input'])
      headers['Signature-Input'] = headers['Signature-Input'].replace(/\(([^)]*)\)/g, (list, components) =>
        components.includes('"content-digest"') ? list : `(${components} "content-digest")`
      );
    if (headers.Signature) headers.Signature = `sig1=:${Buffer.alloc(64).toString('base64')}:`;
    if (id !== '023-multi-valued-content-digest') headers['Content-Digest'] = computeContentDigest(legacy.request.body);
    const vector = {
      ...legacy,
      id: `profile-3.2/negative/${id}`,
      signing_profile_version: '3.2',
      verifier_capability: { ...legacy.verifier_capability, covers_content_digest: 'required' },
      request: { ...legacy.request, headers },
    };
    test(`${id} has a registered 3.2 builder`, () => {
      assert.ok(listSupportedNegativeVectors().includes(vector.id));
    });
    if (id === '026-non-ascii-host') {
      test('raw U-label profile fixture retains the documented HTTP limitation', () => {
        const result = semanticVectorExclusion(vector);
        assert.equal(result.skip_reason, 'transport_ungradable');
        assert.match(result.diagnostic, /punycodes U-labels/);
        assert.equal(buildNegativeRequest(vector, loaded.keys).url, legacy.request.url);
      });
      continue;
    }
    for (const transport of ['raw', 'mcp']) {
      test(`${id} preserves its ${transport} refusal code and checklist step`, async () => {
        const request = buildNegativeRequest(vector, loaded.keys, {
          now: vector.reference_now,
          transport,
          ...(transport === 'mcp' && { baseUrl: 'https://seller.example.com/mcp', mcpJsonRpcId: 'profile-refusal' }),
        });
        if (id === '028-unsigned-protocol-method-required') {
          assert.equal(JSON.parse(request.body).method, 'tasks/cancel');
        }
        await assert.rejects(
          () =>
            verifyRequestSignature(request, {
              capability: vector.verifier_capability,
              jwks: new StaticJwksResolver([publicKey]),
              replayStore: new InMemoryReplayStore(),
              revocationStore: new InMemoryRevocationStore(),
              now: () => vector.reference_now,
              operation: new URL(legacy.request.url).pathname.split('/').at(-1),
              adcpVersion: '3.2',
            }),
          error => error.code === vector.expected_error_code && error.failedStep === vector.expected_failed_step
        );
      });
    }
  }
});

describe('received signed IDN authorities', () => {
  for (const adcpVersion of ['3.1', '3.2', '3.3', undefined]) {
    test(`${String(adcpVersion)} rejects a raw U-label at step 1 before JWKS or replay`, async () => {
      const now = 1776520800;
      const url = 'https://xn--bcher-kva.example.com/adcp/create_media_buy';
      const body = '{}';
      const signed = signRequest(
        { method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body },
        { keyid: testKey.kid, alg: 'ed25519', privateKey },
        {
          now: () => now,
          windowSeconds: 300,
          nonce: 'received-idn-authority',
          coverContentDigest: true,
          binaryEncoding: adcpVersion === '3.1' ? 'legacy-base64url' : 'rfc8941-base64',
        }
      );
      let keyLookups = 0;
      const resolver = new StaticJwksResolver([publicKey]);
      const options = {
        capability: { supported: true, covers_content_digest: 'required', required_for: [] },
        jwks: {
          resolve: keyid => {
            keyLookups++;
            return resolver.resolve(keyid);
          },
        },
        replayStore: new InMemoryReplayStore(),
        revocationStore: new InMemoryRevocationStore(),
        now: () => now,
        ...(adcpVersion && { adcpVersion }),
      };
      await assert.rejects(
        () =>
          verifyRequestSignature(
            { method: 'POST', headers: signed.headers, url: 'https://bücher.example.com/adcp/create_media_buy', body },
            options
          ),
        // security.mdx#transport-error-taxonomy classifies the received URI,
        // not the otherwise valid signature headers. Step 1 is SDK-local
        // parsing diagnostics, not a normative URI checklist step.
        error => error.code === 'request_target_uri_malformed' && error.failedStep === 1
      );
      assert.equal(keyLookups, 0);
      // The equivalent A-label still verifies with the same nonce: malformed
      // authority rejection must not insert a replay entry.
      assert.equal(
        (await verifyRequestSignature({ method: 'POST', url, headers: signed.headers, body }, options)).status,
        'verified'
      );
    });
  }
});
