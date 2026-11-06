// adcp-client#3410: request-signing vectors can declare `applies_when`
// (adcp#8064). Vector 027 grades condition (b) of request_signature_required,
// which applies only while `webhook_signing.legacy_hmac_fallback` is true. A
// seller with the flag false or the block absent skips it instead of failing.
const test = require('node:test');
const assert = require('node:assert');

const {
  gradeOneVector,
  loadRequestSigningVectors,
  probeRequestSigningVector,
} = require('../../dist/lib/testing/storyboard/request-signing/index.js');
const { appliesWhenExclusion } = require('../../dist/lib/testing/storyboard/request-signing/grader.js');

// A vector that is not skipped fails on the probe instead, which separates
// skipped from graded without a network.
const UNREACHABLE = 'http://127.0.0.1:1';
const VECTOR_ID = '027-webhook-registration-authentication-unsigned';
const PROFILE_32_VECTOR_ID = `profile-3.2/negative/${VECTOR_ID}`;
const CONDITION = 'webhook_signing.legacy_hmac_fallback == true';

const capabilitiesWith = webhookSigning => ({
  request_signing: { supported: true, covers_content_digest: 'either', required_for: [] },
  ...(webhookSigning !== undefined && { webhook_signing: webhookSigning }),
});

const dispatchOptions = (capabilities, extra = {}) => ({
  allow_http: true,
  request_signing: { transport: 'raw' },
  _profile: {
    name: 'Signing seller',
    tools: ['get_adcp_capabilities', 'update_media_buy'],
    raw_capabilities: capabilities,
  },
  ...extra,
});

const probes = [
  { label: 'root', stepId: `negative-${VECTOR_ID}`, extra: {} },
  { label: '3.2 profile', stepId: `negative-${PROFILE_32_VECTOR_ID}`, extra: { adcpVersion: '3.3.0-beta.3' } },
];

test('the loader keeps applies_when on both copies of vector 027', () => {
  const loaded = loadRequestSigningVectors();
  const root = loaded.negative.find(v => v.id === VECTOR_ID);
  const profile = loaded.profiles['3.2']?.negative.find(v => v.id === PROFILE_32_VECTOR_ID);
  assert.ok(root, 'root vector 027 should exist');
  assert.ok(profile, '3.2 profile vector 027 should exist');
  assert.strictEqual(root.applies_when, CONDITION);
  assert.strictEqual(profile.applies_when, CONDITION);
  assert.strictEqual(
    loaded.negative.find(v => v.id === '001-no-signature-header').applies_when,
    undefined,
    'unconditional vectors carry no applies_when'
  );
});

for (const { label, stepId, extra } of probes) {
  for (const [state, webhookSigning] of [
    ['false', { legacy_hmac_fallback: false }],
    ['absent from the block', {}],
    ['absent with no block', undefined],
  ]) {
    test(`storyboard dispatch (${label}): legacy_hmac_fallback ${state} skips vector 027`, async () => {
      const result = await probeRequestSigningVector(
        stepId,
        UNREACHABLE,
        dispatchOptions(capabilitiesWith(webhookSigning), extra)
      );
      assert.strictEqual(result.skipped, true, '027 should skip');
      assert.strictEqual(result.skip_reason, 'capability_profile_mismatch');
      assert.match(result.error ?? '', /applies only when `webhook_signing\.legacy_hmac_fallback == true`/);
    });
  }

  test(`storyboard dispatch (${label}): legacy_hmac_fallback true still grades vector 027`, async () => {
    const result = await probeRequestSigningVector(
      stepId,
      UNREACHABLE,
      dispatchOptions(capabilitiesWith({ legacy_hmac_fallback: true }), extra)
    );
    assert.notStrictEqual(result.skipped, true, '027 must be graded');
    assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch');
  });
}

test('storyboard dispatch: a run without discovered capabilities still grades vector 027', async () => {
  const result = await probeRequestSigningVector(`negative-${VECTOR_ID}`, UNREACHABLE, {
    allow_http: true,
    request_signing: { transport: 'raw' },
  });
  assert.notStrictEqual(result.skip_reason, 'capability_profile_mismatch');
});

test('gradeOneVector: agentCapabilities evaluates applies_when the same way', async () => {
  const skipped = await gradeOneVector(VECTOR_ID, 'negative', UNREACHABLE, {
    agentCapabilities: capabilitiesWith({ legacy_hmac_fallback: false }),
    transport: 'raw',
    timeoutMs: 500,
  });
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(skipped.skip_reason, 'capability_profile_mismatch');
  assert.match(skipped.diagnostic ?? '', /applies only when/);

  for (const options of [{ agentCapabilities: capabilitiesWith({ legacy_hmac_fallback: true }) }, {}]) {
    const graded = await gradeOneVector(VECTOR_ID, 'negative', UNREACHABLE, {
      ...options,
      transport: 'raw',
      timeoutMs: 500,
    });
    assert.notStrictEqual(graded.skipped, true, `${JSON.stringify(options)} must grade 027`);
  }
});

test('appliesWhenExclusion: compares a dotted path to a JSON scalar', () => {
  const vector = condition => ({ id: 'synthetic', applies_when: condition });
  const capabilities = { webhook_signing: { legacy_hmac_fallback: false, profile: 'rfc9421' } };
  assert.ok(appliesWhenExclusion(vector(CONDITION), capabilities));
  assert.strictEqual(
    appliesWhenExclusion(vector('webhook_signing.legacy_hmac_fallback == false'), capabilities),
    undefined
  );
  assert.strictEqual(
    appliesWhenExclusion(vector('webhook_signing.legacy_hmac_fallback != true'), capabilities),
    undefined
  );
  assert.strictEqual(appliesWhenExclusion(vector('webhook_signing.profile == "rfc9421"'), capabilities), undefined);
  assert.ok(appliesWhenExclusion(vector('webhook_signing.profile != "rfc9421"'), capabilities));
  assert.strictEqual(appliesWhenExclusion({ id: 'synthetic' }, capabilities), undefined, 'no condition');
  assert.strictEqual(appliesWhenExclusion(vector(CONDITION), undefined), undefined, 'no capabilities');
});

test('appliesWhenExclusion: an expression outside the supported form never skips', () => {
  const capabilities = { webhook_signing: { legacy_hmac_fallback: false } };
  for (const condition of [
    'webhook_signing.legacy_hmac_fallback',
    'webhook_signing.legacy_hmac_fallback === true',
    'webhook_signing.legacy_hmac_fallback == yes',
    'webhook_signing.legacy_hmac_fallback == [true]',
    'webhook_signing[0] == true',
    'webhook_signing.legacy_hmac_fallback == true && request_signing.supported == true',
  ]) {
    assert.strictEqual(
      appliesWhenExclusion({ id: 'synthetic', applies_when: condition }, capabilities),
      undefined,
      `${condition} must stay graded`
    );
  }
});
