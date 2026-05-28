/**
 * Tests for the structured `notices: RunnerNotice[]` surface on StoryboardResult
 * and ComplianceResult (adcp-client#1704).
 *
 * Uses `_profile` injection so tests run without the schema cache or a live agent.
 * These notices are spec-grounded:
 *   - signed_requests_specialism_deprecated: universal/signed-requests.yaml
 *   - request_signing.required: get-adcp-capabilities-response.json:892
 *   - webhook_signing.legacy_hmac_fallback.removed: get-adcp-capabilities-response.json:966
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/index.js');

// ─────────────────────────────────────────────────────────────────────────────
// Storyboard fixtures
// ─────────────────────────────────────────────────────────────────────────────

function buildMinimalStoryboard(overrides = {}) {
  return {
    id: 'notices_test',
    version: '1.0.0',
    title: 'Notices test storyboard',
    category: 'test',
    summary: 'Used only to verify notice emission paths.',
    narrative: '',
    agent: { interaction_model: 'sync', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        steps: [
          {
            id: 'step1',
            title: 'A trivial read',
            task: 'get_products',
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** A storyboard whose id matches the signed_requests storyboard. */
function buildSignedRequestsStoryboard(overrides = {}) {
  return buildMinimalStoryboard({ id: 'signed_requests', ...overrides });
}

/** A storyboard with a request_signing_probe step (alternate detection path). */
function buildSigningProbeStoryboard() {
  return buildMinimalStoryboard({
    id: 'some_other_signing_storyboard',
    phases: [
      {
        id: 'p1',
        title: 'Phase 1',
        steps: [{ id: 's1', title: 'probe', task: 'request_signing_probe' }],
      },
    ],
  });
}

/**
 * A storyboard that exercises the webhook delivery path. Detection is by
 * step-task presence (`expect_webhook` family), not by storyboard id —
 * the authoring contract is "the storyboard asserts webhook delivery".
 * Matches the production detection in `collectCapabilityNotices`.
 */
function buildWebhookStoryboard(overrides = {}) {
  return buildMinimalStoryboard({
    id: 'webhook_delivery_conformance',
    phases: [
      {
        id: 'p1',
        title: 'Webhook delivery',
        steps: [{ id: 's1', title: 'await webhook', task: 'expect_webhook' }],
      },
    ],
    ...overrides,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile fixtures
// ─────────────────────────────────────────────────────────────────────────────

const profileWithoutSigning = {
  name: 'Test Agent (no signing)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    // No request_signing field
  },
};

const profileWithSigning = {
  name: 'Test Agent (signing declared)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    request_signing: { supported: true, required_for: [], supported_for: [] },
  },
};

const profileWithSignedRequestsSpecialism = {
  name: 'Test Agent (deprecated specialism)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    request_signing: { supported: true, required_for: [], supported_for: [] },
    specialisms: ['signed-requests'],
  },
};

const profileWithSignedRequestsSpecialismOnly = {
  name: 'Test Agent (deprecated specialism only)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    specialisms: ['signed-requests'],
  },
};

const profileWithLegacyHmac = {
  name: 'Test Agent (legacy hmac)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    webhook_signing: { legacy_hmac_fallback: true },
  },
};

const profileWithLegacyHmacAndSigning = {
  name: 'Test Agent (both)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    request_signing: { supported: true, required_for: [], supported_for: [] },
    webhook_signing: { legacy_hmac_fallback: true },
  },
};

const profileClean = {
  name: 'Test Agent (clean)',
  tools: ['get_adcp_capabilities', 'get_products'],
  raw_capabilities: {
    request_signing: { supported: true },
    webhook_signing: { legacy_hmac_fallback: false },
  },
};

const profileNoRawCaps = {
  name: 'Test Agent (no raw_capabilities)',
  tools: ['get_adcp_capabilities'],
  // raw_capabilities absent — standalone runner before profile fetch
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function runWith(storyboard, profile) {
  return runStoryboard('http://fake-local-99999', storyboard, {
    _profile: profile,
    agentTools: profile.tools,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: notices field is always present on StoryboardResult
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice — notices field always present (#1704)', () => {
  test('notices is an array even when empty', async () => {
    const sb = buildMinimalStoryboard();
    const result = await runWith(sb, profileClean);
    assert.ok(Array.isArray(result.notices), 'notices must be an array');
  });

  test('notices is an array on capability-unsupported early-return results', async () => {
    const sb = buildMinimalStoryboard({
      requires_capability: { path: 'nonexistent_capability.supported', equals: true },
    });
    const profile = {
      name: 'Test',
      tools: ['get_adcp_capabilities'],
      raw_capabilities: { nonexistent_capability: { supported: false } },
    };
    const result = await runWith(sb, profile);
    assert.ok(result.overall_passed, 'capability-unsupported is a skip, not a failure');
    assert.ok(Array.isArray(result.notices), 'notices must be an array on early-return paths');
    assert.equal(result.notices.length, 0, 'no notices on a non-webhook, non-signing storyboard');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: signed_requests_specialism_deprecated
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice: signed_requests_specialism_deprecated (#2082)', () => {
  test('emits notice on signed_requests storyboard when specialisms includes signed-requests', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runWith(sb, profileWithSignedRequestsSpecialism);
    const notice = result.notices.find(n => n.code === 'signed_requests_specialism_deprecated');
    assert.ok(notice, 'notice should be present');
    assert.equal(notice.severity, 'deprecation');
    assert.equal(notice.effective_version, '4.0');
    assert.equal(notice.capability_path, 'specialisms');
    assert.equal(typeof notice.docs_url, 'string', 'docs_url populated for click-through');
    assert.deepEqual(notice.storyboard_ids, ['signed_requests'], 'storyboard_ids carries the source');
    assert.ok(notice.message.length > 0, 'message non-empty for human consumption');
  });

  test('does NOT emit notice when request_signing.supported is true without deprecated specialism', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runWith(sb, profileWithSigning);
    const notice = result.notices.find(n => n.code === 'signed_requests_specialism_deprecated');
    assert.equal(notice, undefined, 'request_signing.supported alone is the desired capability shape');
  });

  test('does NOT emit notice when deprecated specialism is declared without request_signing.supported', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runWith(sb, profileWithSignedRequestsSpecialismOnly);
    const deprecation = result.notices.find(n => n.code === 'signed_requests_specialism_deprecated');
    const required = result.notices.find(n => n.code === 'request_signing.required');
    assert.equal(deprecation, undefined, 'deprecated specialism is only redundant once request_signing is declared');
    assert.ok(required, 'missing request_signing.supported still emits the future-required notice');
  });

  test('does NOT emit notice on unrelated storyboard even when deprecated specialism is declared', async () => {
    const sb = buildMinimalStoryboard({ id: 'some_other_storyboard' });
    const result = await runWith(sb, profileWithSignedRequestsSpecialism);
    const notice = result.notices.find(n => n.code === 'signed_requests_specialism_deprecated');
    assert.equal(notice, undefined, 'notice is scoped to signed_requests storyboards only');
  });

  test('does NOT emit notice on probe-only storyboard even when deprecated specialism is declared', async () => {
    const sb = buildSigningProbeStoryboard();
    const result = await runWith(sb, profileWithSignedRequestsSpecialism);
    const deprecation = result.notices.find(n => n.code === 'signed_requests_specialism_deprecated');
    const required = result.notices.find(n => n.code === 'request_signing.required');
    assert.equal(deprecation, undefined, 'deprecated-specialism notice is scoped to the signed_requests storyboard id');
    assert.equal(required, undefined, 'request signing is declared, so the probe-only storyboard has no required notice');
  });

  test('dedupes notice code across multi-pass runs', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runStoryboard(['http://fake-local-99999', 'http://fake-local-99998'], sb, {
      _profile: profileWithSignedRequestsSpecialism,
      agentTools: profileWithSignedRequestsSpecialism.tools,
      multi_instance_strategy: 'multi-pass',
    });
    const notices = result.notices.filter(n => n.code === 'signed_requests_specialism_deprecated');
    assert.equal(notices.length, 1, 'multi-pass result should dedupe by notice code');
    assert.deepEqual(notices[0].storyboard_ids, ['signed_requests']);
  });

  test('notice does not affect pass/fail/skipped counters', async () => {
    const sb = buildSignedRequestsStoryboard();
    const baseline = await runWith(sb, profileWithSigning);
    const withNotice = await runWith(sb, profileWithSignedRequestsSpecialism);

    assert.equal(withNotice.passed_count, baseline.passed_count, 'passed counter unchanged');
    assert.equal(withNotice.failed_count, baseline.failed_count, 'failed counter unchanged');
    assert.equal(withNotice.skipped_count, baseline.skipped_count, 'skipped counter unchanged');
    assert.equal(withNotice.overall_passed, baseline.overall_passed, 'overall pass/fail unchanged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: request_signing.required
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice: request_signing.required (#1704)', () => {
  test('emits notice on signed_requests storyboard when request_signing.supported absent', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runWith(sb, profileWithoutSigning);
    const notice = result.notices.find(n => n.code === 'request_signing.required');
    assert.ok(notice, 'notice should be present');
    assert.equal(notice.severity, 'future_required');
    assert.equal(notice.effective_version, '4.0');
    assert.equal(notice.capability_path, 'request_signing.supported');
    assert.equal(typeof notice.docs_url, 'string', 'docs_url populated for click-through');
    assert.deepEqual(notice.storyboard_ids, ['signed_requests'], 'storyboard_ids carries the source');
    assert.ok(notice.message.length > 0, 'message non-empty for human consumption');
  });

  test('emits notice on storyboard with request_signing_probe step', async () => {
    const sb = buildSigningProbeStoryboard();
    const result = await runWith(sb, profileWithoutSigning);
    const notice = result.notices.find(n => n.code === 'request_signing.required');
    assert.ok(notice, 'probe-step storyboard should also trigger the notice');
  });

  test('does NOT emit notice when request_signing.supported is true', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runWith(sb, profileWithSigning);
    const notice = result.notices.find(n => n.code === 'request_signing.required');
    assert.equal(notice, undefined, 'no notice when signing is already declared');
  });

  test('does NOT emit notice on unrelated storyboard', async () => {
    const sb = buildMinimalStoryboard({ id: 'some_other_storyboard' });
    const result = await runWith(sb, profileWithoutSigning);
    const notice = result.notices.find(n => n.code === 'request_signing.required');
    assert.equal(notice, undefined, 'notice should not fire on unrelated storyboards');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: webhook_signing.legacy_hmac_fallback.removed
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice: webhook_signing.legacy_hmac_fallback.removed (#1704)', () => {
  test('emits notice on webhook storyboard when webhook_signing.legacy_hmac_fallback is true', async () => {
    const sb = buildWebhookStoryboard();
    const result = await runWith(sb, profileWithLegacyHmac);
    const notice = result.notices.find(n => n.code === 'webhook_signing.legacy_hmac_fallback.removed');
    assert.ok(notice, 'notice should be present on a webhook-scoped storyboard');
    assert.equal(notice.severity, 'deprecation');
    assert.equal(notice.effective_version, '4.0');
    assert.equal(notice.capability_path, 'webhook_signing.legacy_hmac_fallback');
    assert.equal(typeof notice.docs_url, 'string', 'docs_url populated for click-through');
  });

  test('does NOT emit notice on non-webhook storyboard even when legacy_hmac_fallback is true', async () => {
    const sb = buildMinimalStoryboard();
    const result = await runWith(sb, profileWithLegacyHmac);
    const notice = result.notices.find(n => n.code === 'webhook_signing.legacy_hmac_fallback.removed');
    assert.equal(notice, undefined, 'notice is scoped to webhook storyboards only');
  });

  test('does NOT emit notice when legacy_hmac_fallback is false', async () => {
    const sb = buildWebhookStoryboard();
    const result = await runWith(sb, profileClean);
    const notice = result.notices.find(n => n.code === 'webhook_signing.legacy_hmac_fallback.removed');
    assert.equal(notice, undefined);
  });

  test('does NOT emit notice when webhook_signing is absent', async () => {
    const sb = buildWebhookStoryboard();
    const result = await runWith(sb, profileWithoutSigning);
    const notice = result.notices.find(n => n.code === 'webhook_signing.legacy_hmac_fallback.removed');
    assert.equal(notice, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: multiple notices in one run
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice — multiple notices (#1704)', () => {
  test('emits both notices across their respective storyboard types', async () => {
    const profile = {
      name: 'Test',
      tools: ['get_adcp_capabilities'],
      raw_capabilities: {
        // no request_signing — triggers request_signing.required on signed_requests sb
        webhook_signing: { legacy_hmac_fallback: true }, // triggers legacy_hmac notice on webhook sb
      },
    };
    const signingResult = await runWith(buildSignedRequestsStoryboard(), profile);
    const webhookResult = await runWith(buildWebhookStoryboard(), profile);
    assert.ok(
      signingResult.notices.some(n => n.code === 'request_signing.required'),
      'request_signing notice on signed_requests storyboard'
    );
    assert.ok(
      webhookResult.notices.some(n => n.code === 'webhook_signing.legacy_hmac_fallback.removed'),
      'legacy_hmac notice on webhook storyboard'
    );
  });

  test('notice codes are unique within a single storyboard result', async () => {
    const sb = buildWebhookStoryboard();
    const result = await runWith(sb, profileWithLegacyHmac);
    const codes = result.notices.map(n => n.code);
    const unique = new Set(codes);
    assert.equal(codes.length, unique.size, 'each notice code should appear at most once');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: no raw_capabilities — notices is empty, no crash
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice — absent raw_capabilities (#1704)', () => {
  test('notices is empty array when profile has no raw_capabilities', async () => {
    const sb = buildSignedRequestsStoryboard();
    const result = await runWith(sb, profileNoRawCaps);
    assert.ok(Array.isArray(result.notices), 'notices is still an array');
    assert.equal(result.notices.length, 0, 'no notices without raw_capabilities');
  });
});
