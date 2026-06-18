/**
 * Tests for the structured `notices: RunnerNotice[]` surface on StoryboardResult
 * and ComplianceResult (adcp-client#1704).
 *
 * Uses `_profile` injection so tests run without the schema cache or a live agent.
 * The two day-one notices tested here are both spec-grounded:
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
// Tests: input_schema_field_stripped
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnerNotice: input_schema_field_stripped (#5495)', () => {
  test('promotes structured field-strip debug logs to step and storyboard notices', async () => {
    const sb = buildMinimalStoryboard({ id: 'input_schema_strip_notice' });
    const client = {
      executeTask: async taskName => ({
        success: true,
        status: 'completed',
        data: { products: [] },
        metadata: {
          taskId: 'task-strip',
          taskName,
          agent: { id: 'partial-agent', name: 'Partial Agent', protocol: 'mcp' },
          responseTimeMs: 1,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'completed',
        },
        debug_logs: [
          {
            type: 'warning',
            message: 'Stripped fields not declared in agent tool input schema for get_products: max_width, max_height',
            timestamp: new Date().toISOString(),
            details: {
              code: 'input_schema_field_stripped',
              task: 'get_products',
              fields: ['max_width', 'max_height'],
              agent_id: 'partial-agent',
            },
          },
        ],
      }),
      resetContext: () => {},
    };

    const result = await runStoryboard('http://fake-local-99999', sb, {
      _client: client,
      _profile: profileClean,
      agentTools: ['get_products'],
    });

    const step = result.phases[0].steps[0];
    const stepNotice = step.notices?.find(n => n.code === 'input_schema_field_stripped');
    assert.ok(stepNotice, 'step_result.notices should include the stripped-field notice');
    assert.equal(stepNotice.severity, 'info');
    assert.match(stepNotice.message, /get_products/);
    assert.match(stepNotice.message, /max_width/);
    assert.match(stepNotice.message, /max_height/);

    const storyboardNotice = result.notices.find(n => n.code === 'input_schema_field_stripped');
    assert.ok(storyboardNotice, 'StoryboardResult.notices should aggregate the step notice');
    assert.deepEqual(storyboardNotice.storyboard_ids, ['input_schema_strip_notice']);
    assert.equal(result.overall_passed, true, 'notice should not affect pass/fail');
  });

  test('preserves field-strip notices through async waitForCompletion polling path', async () => {
    const sb = buildMinimalStoryboard({ id: 'input_schema_strip_async' });
    let polled = false;
    const client = {
      executeTask: async taskName => ({
        success: true,
        status: 'submitted',
        data: undefined,
        metadata: {
          taskId: 'task-async-strip',
          taskName,
          agent: { id: 'partial-agent', name: 'Partial Agent', protocol: 'mcp' },
          responseTimeMs: 1,
          timestamp: new Date().toISOString(),
          clarificationRounds: 0,
          status: 'submitted',
        },
        debug_logs: [
          {
            type: 'warning',
            message: 'Stripped fields not declared in agent tool input schema for get_products: max_width',
            timestamp: new Date().toISOString(),
            details: {
              code: 'input_schema_field_stripped',
              task: 'get_products',
              fields: ['max_width'],
              agent_id: 'partial-agent',
            },
          },
        ],
        submitted: {
          waitForCompletion: async () => {
            polled = true;
            return {
              success: true,
              status: 'completed',
              data: { products: [] },
              metadata: {
                taskId: 'task-async-strip',
                taskName,
                agent: { id: 'partial-agent', name: 'Partial Agent', protocol: 'mcp' },
                responseTimeMs: 2,
                timestamp: new Date().toISOString(),
                clarificationRounds: 0,
                status: 'completed',
              },
            };
          },
        },
      }),
      resetContext: () => {},
    };

    const result = await runStoryboard('http://fake-local-99999', sb, {
      _client: client,
      _profile: profileClean,
      agentTools: ['get_products'],
    });

    assert.ok(polled, 'waitForCompletion should have been called');
    const step = result.phases[0].steps[0];
    const stepNotice = step.notices?.find(n => n.code === 'input_schema_field_stripped');
    assert.ok(stepNotice, 'step_result.notices must survive the async polling replacement');

    const storyboardNotice = result.notices.find(n => n.code === 'input_schema_field_stripped');
    assert.ok(storyboardNotice, 'StoryboardResult.notices must aggregate pre-polling strip notices');
    assert.deepEqual(storyboardNotice.storyboard_ids, ['input_schema_strip_async']);
    assert.equal(result.overall_passed, true, 'notice must not affect pass/fail');
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
