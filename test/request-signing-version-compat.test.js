const { describe, test } = require('node:test');
const assert = require('node:assert');

const {
  InMemoryReplayStore,
  InMemoryRevocationStore,
  RequestSignatureError,
  StaticJwksResolver,
  verifyRequestSignature,
} = require('../dist/lib/signing/index.js');
const { loadRequestSigningVectors } = require('../dist/lib/testing/storyboard/request-signing/index.js');

function publicKeys(loaded) {
  return loaded.keys.keys.map(({ private_d: _private, ...key }) => key);
}

function verificationOptions(vector, loaded, adcpVersion) {
  return {
    capability: vector.verifier_capability,
    jwks: new StaticJwksResolver(publicKeys(loaded)),
    replayStore: new InMemoryReplayStore(),
    revocationStore: new InMemoryRevocationStore(),
    now: () => vector.reference_now,
    operation: new URL(vector.request.url).pathname.split('/').filter(Boolean).at(-1),
    ...(adcpVersion && { adcpVersion }),
  };
}

describe('request-signing compatibility across frozen AdCP bundles', () => {
  for (const version of ['3.0.24', '3.1.15']) {
    test(`${version} positive vectors work with both omitted and explicit endpoint pins`, async () => {
      const loaded = loadRequestSigningVectors({ version });
      const vectors = ['001-basic-post', '002-post-with-content-digest'].map(id =>
        loaded.positive.find(vector => vector.id === id)
      );

      for (const vector of vectors) {
        assert.ok(vector, `${version} vector should exist`);
        for (const adcpVersion of [undefined, version]) {
          const result = await verifyRequestSignature(vector.request, verificationOptions(vector, loaded, adcpVersion));
          assert.strictEqual(result.status, 'verified', `${vector.id} with pin ${adcpVersion ?? 'omitted'}`);
        }
      }
    });

    test(`${version} omitted endpoint pin preserves negative-vector error precedence`, async () => {
      const loaded = loadRequestSigningVectors({ version });
      for (const id of ['002-wrong-tag', '007-missing-content-digest', '018-digest-covered-when-forbidden']) {
        const vector = loaded.negative.find(candidate => candidate.id === id);
        assert.ok(vector, `${version} negative vector ${id} should exist`);

        await assert.rejects(
          () => verifyRequestSignature(vector.request, verificationOptions(vector, loaded)),
          error => error instanceof RequestSignatureError && error.code === vector.expected_error_code,
          `${id} should fail with ${vector.expected_error_code}`
        );
      }
    });
  }
});
