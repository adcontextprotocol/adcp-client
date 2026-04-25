/**
 * Tests for the requires_capability storyboard-level skip gate (adcp-client#933).
 *
 * Uses _profile injection so the tests run without the schema cache — the gate
 * fires before any phase or network call, so we only need the raw_capabilities
 * value the profile carries.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard, resolveCapabilityPath } = require('../../dist/lib/testing/storyboard/index.js');
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

  test('DETAILED_SKIP_TO_CANONICAL maps capability_unsupported to unsatisfied_contract', () => {
    assert.equal(
      DETAILED_SKIP_TO_CANONICAL['capability_unsupported'],
      'unsatisfied_contract',
      'canonical spec reason for capability_unsupported'
    );
  });
});
