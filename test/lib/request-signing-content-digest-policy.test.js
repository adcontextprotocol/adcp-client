const test = require('node:test');
const assert = require('node:assert');

const {
  gradeOneVector,
  loadRequestSigningVectors,
} = require('../../dist/lib/testing/storyboard/request-signing/index.js');

// An unreachable address: a vector that is NOT skipped fails on the probe
// instead, which is exactly the discrimination these tests need — skipped vs
// graded, without a network.
const UNREACHABLE = 'http://127.0.0.1:1';

const vectorById = (() => {
  const { positive, negative } = loadRequestSigningVectors();
  return (kind, fragment) => (kind === 'positive' ? positive : negative).find(v => v.id.includes(fragment));
})();

const EITHER_AGENT = {
  supported: true,
  covers_content_digest: 'either',
  required_for: ['create_media_buy'],
};

test("an 'either' agent skips exactly the two policy-refusal vectors", async () => {
  // These are the only outcomes that exist solely because of a narrowed
  // policy: a signature that omits the digest, and one that covers it.
  for (const [fragment, expectedCode] of [
    ['007-missing-content-digest', 'request_signature_components_incomplete'],
    ['018-digest-covered-when-forbidden', 'request_signature_components_unexpected'],
  ]) {
    const vector = vectorById('negative', fragment);
    assert.ok(vector, `vector ${fragment} should exist`);
    assert.strictEqual(vector.expected_error_code, expectedCode);
    const result = await gradeOneVector(vector.id, 'negative', UNREACHABLE, {
      agentCapability: EITHER_AGENT,
      transport: 'raw',
      timeoutMs: 500,
    });
    assert.strictEqual(result.skipped, true, `${fragment} should skip`);
    assert.strictEqual(result.skip_reason, 'capability_profile_mismatch');
  }
});

test("an 'either' agent still grades the content-digest vectors that test the verifier, not the policy", async () => {
  // All three declare `covers_content_digest: 'required'` in their fixture,
  // but none of them expects a policy refusal: 002 must be ACCEPTED, 010 is a
  // falsified digest, 023 is a malformed digest header. Keying the skip on
  // the declared field alone dropped all three.
  const cases = [
    ['positive', '002-post-with-content-digest', undefined],
    ['negative', '010-content-digest-mismatch', 'request_signature_digest_mismatch'],
    ['negative', '023-multi-valued-content-digest', 'request_signature_header_malformed'],
  ];
  for (const [kind, fragment, expectedCode] of cases) {
    const vector = vectorById(kind, fragment);
    assert.ok(vector, `vector ${fragment} should exist`);
    assert.strictEqual(vector.verifier_capability.covers_content_digest, 'required');
    if (expectedCode) assert.strictEqual(vector.expected_error_code, expectedCode);
    const result = await gradeOneVector(vector.id, kind, UNREACHABLE, {
      agentCapability: EITHER_AGENT,
      transport: 'raw',
      timeoutMs: 500,
    });
    assert.notStrictEqual(
      result.skip_reason,
      'capability_profile_mismatch',
      `${fragment} must stay graded against an 'either' agent`
    );
  }
});

test('a strict agent still skips vectors written for the other strict policy', async () => {
  // 018 asserts `'forbidden'`; a `'required'` agent never rejects a covered
  // digest, so the vector cannot surface its intended error path.
  const v018 = vectorById('negative', '018-digest-covered-when-forbidden');
  const result = await gradeOneVector(v018.id, 'negative', UNREACHABLE, {
    agentCapability: { supported: true, covers_content_digest: 'required', required_for: ['create_media_buy'] },
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.skip_reason, 'capability_profile_mismatch');
});

test('the agentContentDigestPolicy path narrows the same way', async () => {
  // `adcp grade request-signing --content-digest-policy either` shares the
  // predicate; it over-skipped 010 for the same reason.
  const v010 = vectorById('negative', '010-content-digest-mismatch');
  const graded = await gradeOneVector(v010.id, 'negative', UNREACHABLE, {
    agentContentDigestPolicy: 'either',
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.notStrictEqual(graded.skip_reason, 'capability_profile_mismatch');

  const v007 = vectorById('negative', '007-missing-content-digest');
  const skipped = await gradeOneVector(v007.id, 'negative', UNREACHABLE, {
    agentContentDigestPolicy: 'either',
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.strictEqual(skipped.skip_reason, 'capability_profile_mismatch');
});
