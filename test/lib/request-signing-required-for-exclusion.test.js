// adcp-client#3056 — the `required_for` advertisement axis.
//
// A 3.x shadow-posture agent (`supported: true`, `required_for: []`) failed
// `negative/001-no-signature-header` on every storyboard run: the grader's
// `capabilityMismatch()` knew to skip it, but the storyboard dispatch never
// fed it the agent's `required_for`. These tests pin both entry points —
// the storyboard dispatch reading the discovered advertisement, and the
// `gradeOneVector` option path — and the fail-closed grammar around them.
const test = require('node:test');
const assert = require('node:assert');

const {
  gradeOneVector,
  loadRequestSigningVectors,
  probeRequestSigningVector,
} = require('../../dist/lib/testing/storyboard/request-signing/index.js');

// An unreachable address: a vector that is NOT skipped fails on the probe
// instead, which is exactly the discrimination these tests need — skipped vs
// graded, without a network.
const UNREACHABLE = 'http://127.0.0.1:1';

const vectorById = (() => {
  const { positive, negative } = loadRequestSigningVectors();
  return (kind, fragment) => (kind === 'positive' ? positive : negative).find(v => v.id.includes(fragment));
})();

const profileWith = requestSigning => ({
  name: 'Shadow-posture seller',
  tools: ['get_adcp_capabilities', 'create_media_buy'],
  raw_capabilities: { request_signing: requestSigning },
});

const dispatchOptions = requestSigning => ({
  allow_http: true,
  request_signing: { transport: 'raw' },
  _profile: profileWith(requestSigning),
});

test('vector 001 declares a required_for the shadow posture does not', () => {
  const vector = vectorById('negative', '001-no-signature-header');
  assert.ok(vector, 'vector 001 should exist');
  assert.deepStrictEqual(vector.verifier_capability.required_for, ['create_media_buy']);
  assert.strictEqual(vector.expected_error_code, 'request_signature_required');
});

test('storyboard dispatch: a required_for [] agent skips vector 001 as capability_profile_mismatch', async () => {
  const result = await probeRequestSigningVector(
    'negative-001-no-signature-header',
    UNREACHABLE,
    dispatchOptions({ supported: true, covers_content_digest: 'either', required_for: [] })
  );
  assert.strictEqual(result.skipped, true, 'vector 001 should skip');
  assert.strictEqual(result.skip_reason, 'capability_profile_mismatch');
  assert.match(result.error ?? '', /required_for includes \[create_media_buy\]/);
});

test('storyboard dispatch: the same agent still grades negatives that test the verifier, not the posture', async () => {
  // Nearly every vector's fixture lists create_media_buy under required_for —
  // that is the profile the vector was authored against, not an expected
  // refusal. Only the unsigned-request pre-check (request_signature_required)
  // exists solely because of required_for; everything else must stay graded,
  // or an agent could switch the storyboard off by under-declaring.
  for (const fragment of [
    '002-wrong-tag',
    '010-content-digest-mismatch',
    '015-signature-invalid',
    '023-multi-valued-content-digest',
  ]) {
    const vector = vectorById('negative', fragment);
    assert.ok(vector, `vector ${fragment} should exist`);
    assert.ok(
      (vector.verifier_capability.required_for ?? []).includes('create_media_buy'),
      `${fragment} fixture lists create_media_buy`
    );
    assert.notStrictEqual(vector.expected_error_code, 'request_signature_required');
    const result = await probeRequestSigningVector(
      `negative-${fragment}`,
      UNREACHABLE,
      dispatchOptions({ supported: true, covers_content_digest: 'either', required_for: [] })
    );
    assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch', `${fragment} must still be graded`);
  }
});

test('storyboard dispatch: request_signature_required vectors with required_for [] are never excluded', async () => {
  // 027 expects the same refusal code as 001, but its fixture declares
  // required_for: [] — the refusal comes from the body, not the posture.
  const vector = vectorById('negative', '027-webhook-registration-authentication-unsigned');
  assert.ok(vector, 'vector 027 should exist');
  assert.deepStrictEqual(vector.verifier_capability.required_for, []);
  const result = await probeRequestSigningVector(
    'negative-027-webhook-registration-authentication-unsigned',
    UNREACHABLE,
    dispatchOptions({ supported: true, covers_content_digest: 'either', required_for: [] })
  );
  assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch', '027 must still be graded');
});

test('storyboard dispatch: an agent that declares create_media_buy keeps grading vector 001', async () => {
  const result = await probeRequestSigningVector(
    'negative-001-no-signature-header',
    UNREACHABLE,
    dispatchOptions({ supported: true, covers_content_digest: 'either', required_for: ['create_media_buy'] })
  );
  assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch', '001 must be graded');
});

test('storyboard dispatch: an absent or malformed required_for never suppresses the vector', async () => {
  for (const block of [
    { supported: true, covers_content_digest: 'either' }, // absent — no posture declared
    { supported: true, covers_content_digest: 'either', required_for: null },
    { supported: true, covers_content_digest: 'either', required_for: 'create_media_buy' },
    { supported: true, covers_content_digest: 'either', required_for: [''] },
    { supported: true, covers_content_digest: 'either', required_for: ['create media buy'] },
    { supported: false, required_for: [] },
  ]) {
    const result = await probeRequestSigningVector(
      'negative-001-no-signature-header',
      UNREACHABLE,
      dispatchOptions(block)
    );
    assert.notStrictEqual(
      result.skip_reason,
      'capability_profile_mismatch',
      `${JSON.stringify(block)} must not exclude vector 001`
    );
  }
});

test('gradeOneVector: the agentRequiredFor option narrows the same way', async () => {
  const vector = vectorById('negative', '001-no-signature-header');
  const skipped = await gradeOneVector(vector.id, 'negative', UNREACHABLE, {
    agentRequiredFor: [],
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.skip_reason, 'capability_profile_mismatch');
  const graded = await gradeOneVector(vector.id, 'negative', UNREACHABLE, {
    agentRequiredFor: ['create_media_buy'],
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.notStrictEqual(graded.skip_reason, 'capability_profile_mismatch');
});

test('gradeOneVector: agentRequiredFor leaves verifier-testing negatives graded', async () => {
  const vector = vectorById('negative', '002-wrong-tag');
  const result = await gradeOneVector(vector.id, 'negative', UNREACHABLE, {
    agentRequiredFor: [],
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch');
});

test('gradeOneVector: agentRequiredFor never excludes a positive vector', async () => {
  const vector = vectorById('positive', '001-basic-post');
  assert.ok(vector, 'positive 001 should exist');
  const result = await gradeOneVector(vector.id, 'positive', UNREACHABLE, {
    agentRequiredFor: [],
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch');
});
