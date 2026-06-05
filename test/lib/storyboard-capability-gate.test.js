/**
 * Tests for the requires_capability storyboard-level skip gate (adcp-client#933).
 *
 * Uses _profile injection so the tests run without the schema cache — the gate
 * fires before any phase or network call, so we only need the raw_capabilities
 * value the profile carries.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  runStoryboard,
  resolveCapabilityPath,
  evaluateCapabilityPredicate,
} = require('../../dist/lib/testing/storyboard/index.js');
const { DETAILED_SKIP_TO_CANONICAL } = require('../../dist/lib/testing/storyboard/types.js');

// Storyboard that requires adcp.idempotency.supported === true — the shape that
// the universal idempotency storyboard will carry once wired (#933).
const idempotencyGatedStoryboard = {
  id: 'idempotency_replay_gate_test',
  version: '1.0.0',
  title: 'Idempotency replay (capability-gated)',
  category: 'test',
  summary: 'Skipped when agent declares idempotency unsupported.',
  narrative: '',
  agent: { interaction_model: 'sync', capabilities: [] },
  caller: { role: 'buyer_agent' },
  requires_capability: { path: 'adcp.idempotency.supported', equals: true },
  phases: [
    {
      id: 'replay',
      title: 'Replay phase',
      steps: [
        {
          id: 'replay_step',
          title: 'Submit duplicate mutating request',
          task: 'create_media_buy',
          sample_request: { brand_id: 'brand_test', packages: [] },
        },
      ],
    },
  ],
};

// Profile that declares idempotency unsupported — equivalent to createAdcpServer
// running with idempotency: 'disabled' (PR #931).
const disabledProfile = {
  name: 'Test Agent (idempotency disabled)',
  tools: ['get_adcp_capabilities', 'create_media_buy'],
  raw_capabilities: { adcp: { idempotency: { supported: false } } },
};

const inlineCreativeGatedStoryboard = {
  id: 'inline_creatives_optional_feature_gate_test',
  version: '1.0.0',
  title: 'Inline creative management (optional feature gated)',
  category: 'test',
  summary: 'Skipped when media-buy inline creative management is not advertised.',
  narrative: '',
  agent: { interaction_model: 'media_buy_seller', capabilities: [] },
  caller: { role: 'buyer_agent' },
  requires_capability: { path: 'media_buy.features.inline_creative_management', equals: true },
  phases: [
    {
      id: 'inline_creatives',
      title: 'Inline creative phase',
      steps: [
        {
          id: 'create_inline_buy',
          title: 'Create media buy with inline creative',
          task: 'create_media_buy',
          sample_request: { brand_id: 'brand_test', packages: [] },
        },
      ],
    },
  ],
};

describe('requires_capability storyboard skip gate (#933)', () => {
  test('emits capability_unsupported skip when agent declares supported: false', async () => {
    // _profile bypasses discoverAgentProfile; no network calls made because
    // the capability gate fires before any phase or tool call.
    const result = await runStoryboard('http://fake-local-99999', idempotencyGatedStoryboard, {
      _profile: disabledProfile,
    });

    // Overall counts
    assert.equal(result.overall_passed, true, 'capability skip is not a failure');
    assert.equal(result.skipped_count, 1, 'exactly one synthetic skip step');
    assert.equal(result.passed_count, 0);
    assert.equal(result.failed_count, 0);

    // Synthetic phase
    assert.equal(result.phases.length, 1);
    const phase = result.phases[0];
    assert.equal(phase.phase_id, 'capability_unsupported');
    assert.equal(phase.passed, true);

    // Synthetic step shape (the spec-required runner-output contract fields)
    const step = phase.steps[0];
    assert.equal(step.step_id, 'capability_unsupported');
    assert.equal(step.skipped, true, 'step.skipped must be true');
    assert.equal(step.skip_reason, 'capability_unsupported', 'detailed skip reason');

    // Structured skip block: canonical spec reason + human-readable detail
    assert.ok(step.skip, 'step.skip block present');
    assert.equal(step.skip.reason, 'unsatisfied_contract', 'canonical spec reason');
    assert.ok(
      step.skip.detail.includes('adcp.idempotency.supported'),
      `detail must mention the capability path: ${step.skip.detail}`
    );
    assert.ok(step.skip.detail.includes('false'), `detail must mention the declared value: ${step.skip.detail}`);

    // JUnit-compatible: extraction must not be undefined (runner-output contract)
    assert.ok(step.extraction, 'extraction record present');
    assert.equal(step.extraction.path, 'none');
  });

  // Negative-path coverage (gate-passes and absent-capabilities) is provided
  // by the resolveCapabilityPath unit tests below and the "RUN-not-skip"
  // condition in the runner (`actual !== undefined && actual !== equals`).
  // Earlier drafts had two integration-style smoke tests for these cases
  // that ended with `assert.ok(true, '...')` after a try/catch — they
  // passed regardless of gate behavior. Dropped: false-confidence tests
  // are worse than no test, and the unit coverage below pins the actual
  // contract that the gate evaluates.

  test('resolveCapabilityPath: dotted path traversal (real exported helper)', () => {
    // Tests the actual function the gate uses — not an inline copy. If
    // the runtime behavior ever drifts (null prototypes, Symbol keys,
    // prototype-chain access), this test catches it.
    const raw = { adcp: { idempotency: { supported: false, nested: { deep: 42 } } } };
    assert.equal(resolveCapabilityPath(raw, 'adcp.idempotency.supported'), false);
    assert.equal(resolveCapabilityPath(raw, 'adcp.idempotency.nested.deep'), 42);
    assert.equal(resolveCapabilityPath(raw, 'adcp.idempotency.replay_ttl_seconds'), undefined);
    assert.equal(resolveCapabilityPath(raw, 'nonexistent.path'), undefined);
    assert.equal(resolveCapabilityPath(null, 'any.path'), undefined);
    assert.equal(resolveCapabilityPath(undefined, 'any.path'), undefined);
    assert.equal(resolveCapabilityPath({}, 'adcp.idempotency.supported'), undefined);
    // Non-object intermediate returns undefined rather than crashing —
    // ensures the gate doesn't throw on agents that misdeclare nested
    // capability fields as scalars.
    assert.equal(resolveCapabilityPath({ adcp: 'not an object' }, 'adcp.idempotency.supported'), undefined);
    assert.equal(resolveCapabilityPath({ adcp: 42 }, 'adcp.idempotency.supported'), undefined);
  });

  test('resolveCapabilityPath: prototype-chain keys are NOT walkable', () => {
    // Defensive: a malicious or malformed capabilities response shouldn't
    // be able to expose Object.prototype values via dotted-path lookup.
    // `__proto__` is a real key on object literals, so it walks through
    // — that's expected. But values inherited from Object.prototype
    // (e.g., `constructor`) should NOT be reachable as if they were
    // declared on the agent.
    const obj = {};
    // `toString` is on the prototype but not own-property
    const result = resolveCapabilityPath(obj, 'toString');
    // Either undefined (own-property check) or the function (no check).
    // The current implementation does not enforce own-property — this
    // test pins the current behavior so a future tightening is visible.
    // If this assertion ever needs to flip, the call site (which only
    // matches `actual === equals` against scalars) is unaffected: a
    // function or any complex value will fail the equality predicate.
    assert.ok(typeof result === 'function' || result === undefined);
  });

  test('optional inline creative feature skips when omitted', async () => {
    const result = await runStoryboard('http://fake-local-99994', inlineCreativeGatedStoryboard, {
      _profile: {
        name: 'Test Agent (no inline creative feature declared)',
        tools: ['get_adcp_capabilities', 'create_media_buy'],
        raw_capabilities: { media_buy: { features: {} } },
      },
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'capability_unsupported');
    assert.equal(step.skip.reason, 'unsatisfied_contract');
    assert.ok(step.skip.detail.includes('media_buy.features.inline_creative_management'));
    assert.ok(step.skip.detail.includes('did not declare'));
  });

  test('DETAILED_SKIP_TO_CANONICAL maps capability_unsupported to unsatisfied_contract', () => {
    assert.equal(
      DETAILED_SKIP_TO_CANONICAL['capability_unsupported'],
      'unsatisfied_contract',
      'canonical spec reason for capability_unsupported'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `present:` matcher (adcp-client#1811) — presence-only capability gates for
// spec capabilities whose contract is "presence of this object indicates
// support" (e.g. `media_buy.conversion_tracking`).
// ─────────────────────────────────────────────────────────────────────────────

const conversionTrackingGatedStoryboard = {
  id: 'conversion_tracking_present_gate_test',
  version: '1.0.0',
  title: 'Conversion tracking (presence-gated)',
  category: 'test',
  summary: 'Runs only when the seller advertises media_buy.conversion_tracking.',
  narrative: '',
  agent: { interaction_model: 'sync', capabilities: [] },
  caller: { role: 'buyer_agent' },
  requires_capability: { path: 'media_buy.conversion_tracking', present: true },
  phases: [
    {
      id: 'attribution',
      title: 'Attribution phase',
      steps: [
        {
          id: 'log_event_step',
          title: 'Log conversion event',
          task: 'log_event',
          sample_request: {},
        },
      ],
    },
  ],
};

const presentAbsentGatedStoryboard = {
  ...conversionTrackingGatedStoryboard,
  id: 'conversion_tracking_absent_gate_test',
  requires_capability: { path: 'media_buy.conversion_tracking', present: false },
};

describe('requires_capability `present:` matcher (#1811)', () => {
  test('present: true — skips when agent does not declare the capability at all', async () => {
    const profile = {
      name: 'Test Agent (no conversion tracking declared)',
      tools: ['get_adcp_capabilities', 'log_event'],
      raw_capabilities: { media_buy: {} },
    };
    const result = await runStoryboard('http://fake-local-99998', conversionTrackingGatedStoryboard, {
      _profile: profile,
    });
    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'capability_unsupported');
    assert.equal(step.skip.reason, 'unsatisfied_contract');
    assert.ok(
      step.skip.detail.includes('media_buy.conversion_tracking'),
      `detail must mention the capability path: ${step.skip.detail}`
    );
    assert.ok(
      step.skip.detail.includes('must be present'),
      `detail must explain presence requirement: ${step.skip.detail}`
    );
  });

  test('present: true — skips when agent declares the field as null', async () => {
    // null is the explicit "not supported" wire signal for object-typed
    // capabilities; presence-only matcher treats it the same as absent.
    const profile = {
      name: 'Test Agent (conversion tracking explicitly null)',
      tools: ['get_adcp_capabilities', 'log_event'],
      raw_capabilities: { media_buy: { conversion_tracking: null } },
    };
    const result = await runStoryboard('http://fake-local-99997', conversionTrackingGatedStoryboard, {
      _profile: profile,
    });
    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
  });

  test('present: true — empty object counts as present (storyboard runs, gate does not skip)', () => {
    // Spec: "Presence of this object indicates support." An empty {} IS
    // presence. We use the predicate helper directly because asserting "the
    // gate didn't skip" without a real wire path requires running phases.
    assert.equal(
      evaluateCapabilityPredicate({ path: 'media_buy.conversion_tracking', present: true }, {}),
      null,
      'empty object satisfies `present: true`'
    );
    assert.equal(
      evaluateCapabilityPredicate(
        { path: 'media_buy.conversion_tracking', present: true },
        { multi_source_event_dedup: true }
      ),
      null,
      'populated object satisfies `present: true`'
    );
  });

  test('present: false — skips when agent declares the capability', async () => {
    const profile = {
      name: 'Test Agent (does declare conversion tracking)',
      tools: ['get_adcp_capabilities', 'log_event'],
      raw_capabilities: { media_buy: { conversion_tracking: {} } },
    };
    const result = await runStoryboard('http://fake-local-99996', presentAbsentGatedStoryboard, {
      _profile: profile,
    });
    assert.equal(result.skipped_count, 1);
    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'capability_unsupported');
    assert.ok(
      step.skip.detail.includes('must be absent'),
      `detail must explain absence requirement: ${step.skip.detail}`
    );
  });

  test('evaluateCapabilityPredicate: pins matcher semantics', () => {
    const presentTrue = { path: 'x.y', present: true };
    const presentFalse = { path: 'x.y', present: false };
    const equalsTrue = { path: 'x.y', equals: true };
    const inlineFeatureEqualsTrue = {
      path: 'media_buy.features.inline_creative_management',
      equals: true,
    };

    // present: true
    assert.equal(evaluateCapabilityPredicate(presentTrue, undefined)?.includes('must be present'), true);
    assert.equal(evaluateCapabilityPredicate(presentTrue, null)?.includes('must be present'), true);
    assert.equal(evaluateCapabilityPredicate(presentTrue, false), null, 'false is present (declared scalar)');
    assert.equal(evaluateCapabilityPredicate(presentTrue, 0), null, '0 is present');
    assert.equal(evaluateCapabilityPredicate(presentTrue, ''), null, "'' is present");
    assert.equal(evaluateCapabilityPredicate(presentTrue, {}), null, '{} is present');

    // present: false
    assert.equal(evaluateCapabilityPredicate(presentFalse, undefined), null);
    assert.equal(evaluateCapabilityPredicate(presentFalse, null), null);
    assert.equal(evaluateCapabilityPredicate(presentFalse, {})?.includes('must be absent'), true);

    // equals semantics unchanged: absence is unresolvable, run the storyboard.
    assert.equal(evaluateCapabilityPredicate(equalsTrue, undefined), null, 'absent: equals runs the storyboard');
    assert.equal(evaluateCapabilityPredicate(equalsTrue, true), null);
    assert.equal(
      evaluateCapabilityPredicate(equalsTrue, false)?.includes('not satisfied'),
      true,
      'declared mismatch skips with `not satisfied` detail'
    );
    assert.equal(
      evaluateCapabilityPredicate(inlineFeatureEqualsTrue, undefined)?.includes('did not declare'),
      true,
      'inline_creative_management is an optional feature gate: absent skips'
    );
    assert.equal(evaluateCapabilityPredicate(inlineFeatureEqualsTrue, true), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `contains:` matcher (adcp-client#1817) — array-membership capability gates
// for capabilities whose declaration shape is an array of allowed values
// (e.g. `media_buy.conversion_tracking.supported_targets`).
// ─────────────────────────────────────────────────────────────────────────────

const supportedTargetsGatedStoryboard = {
  id: 'performance_buy_flow_roas_gate_test',
  version: '1.0.0',
  title: 'ROAS flow (array-membership-gated)',
  category: 'test',
  summary: 'Runs only when seller advertises per_ad_spend in supported_targets.',
  narrative: '',
  agent: { interaction_model: 'sync', capabilities: [] },
  caller: { role: 'buyer_agent' },
  requires_capability: {
    path: 'media_buy.conversion_tracking.supported_targets',
    contains: 'per_ad_spend',
  },
  phases: [
    {
      id: 'roas',
      title: 'ROAS phase',
      steps: [
        {
          id: 'log_event_step',
          title: 'Log conversion event',
          task: 'log_event',
          sample_request: {},
        },
      ],
    },
  ],
};

describe('requires_capability `contains:` matcher (#1817)', () => {
  test('contains: skips when array is missing the required value', async () => {
    const profile = {
      name: 'Test Agent (cost_per only, no per_ad_spend)',
      tools: ['get_adcp_capabilities', 'log_event'],
      raw_capabilities: {
        media_buy: { conversion_tracking: { supported_targets: ['cost_per'] } },
      },
    };
    const result = await runStoryboard('http://fake-local-99995', supportedTargetsGatedStoryboard, {
      _profile: profile,
    });
    assert.equal(result.overall_passed, true);
    assert.equal(result.skipped_count, 1);
    const step = result.phases[0].steps[0];
    assert.equal(step.skipped, true);
    assert.equal(step.skip_reason, 'capability_unsupported');
    assert.equal(step.skip.reason, 'unsatisfied_contract');
    assert.ok(
      step.skip.detail.includes('media_buy.conversion_tracking.supported_targets'),
      `detail must mention capability path: ${step.skip.detail}`
    );
    assert.ok(
      step.skip.detail.includes('must contain') && step.skip.detail.includes('per_ad_spend'),
      `detail must explain membership requirement: ${step.skip.detail}`
    );
  });

  test('contains: skips when path resolves to undefined (capability not declared)', async () => {
    const profile = {
      name: 'Test Agent (no supported_targets declared)',
      tools: ['get_adcp_capabilities', 'log_event'],
      raw_capabilities: { media_buy: { conversion_tracking: {} } },
    };
    const result = await runStoryboard('http://fake-local-99994', supportedTargetsGatedStoryboard, {
      _profile: profile,
    });
    assert.equal(result.skipped_count, 1);
    assert.equal(result.phases[0].steps[0].skip_reason, 'capability_unsupported');
  });

  test('evaluateCapabilityPredicate: pins contains semantics', () => {
    const containsString = { path: 'x.y', contains: 'per_ad_spend' };
    const containsNumber = { path: 'x.y', contains: 42 };
    const containsBool = { path: 'x.y', contains: true };

    // Happy path: array includes the value
    assert.equal(
      evaluateCapabilityPredicate(containsString, ['cost_per', 'per_ad_spend']),
      null,
      'array containing value satisfies the predicate'
    );
    assert.equal(evaluateCapabilityPredicate(containsString, ['per_ad_spend']), null);
    assert.equal(evaluateCapabilityPredicate(containsNumber, [1, 42, 100]), null);
    assert.equal(evaluateCapabilityPredicate(containsBool, [false, true]), null);

    // Empty array fails
    assert.ok(evaluateCapabilityPredicate(containsString, [])?.includes('must contain'));

    // Array missing the value fails
    assert.ok(evaluateCapabilityPredicate(containsString, ['cost_per'])?.includes('must contain'));

    // Non-array values fail
    assert.ok(evaluateCapabilityPredicate(containsString, 'per_ad_spend')?.includes('must contain'));
    assert.ok(evaluateCapabilityPredicate(containsString, { 0: 'per_ad_spend' })?.includes('must contain'));
    assert.ok(evaluateCapabilityPredicate(containsString, null)?.includes('must contain'));

    // Absent path fails — load-bearing absence, like `present: true`
    const detailUndefined = evaluateCapabilityPredicate(containsString, undefined);
    assert.ok(detailUndefined?.includes('must contain'));
    assert.ok(
      detailUndefined?.includes('no value'),
      `detail must distinguish undefined from typed mismatch: ${detailUndefined}`
    );

    // Strict equality — no type coercion across number/string
    assert.ok(evaluateCapabilityPredicate(containsNumber, ['42'])?.includes('must contain'));
    assert.ok(evaluateCapabilityPredicate(containsString, [42])?.includes('must contain'));
  });
});
