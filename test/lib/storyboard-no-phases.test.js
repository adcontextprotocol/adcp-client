/**
 * Regression test for #921 / PR #922.
 *
 * When a storyboard has `phases: []` the runner emits a synthetic
 * skipped phase. The shape must satisfy three invariants:
 *
 *   1. `overall_passed: true` — vacuous skip is not a failure
 *   2. `skip_reason: 'no_phases'` — value from the documented
 *      `RunnerSkipReason` vocabulary (not the `__no_phases__`
 *      sentinel that leaked in earlier versions)
 *   3. `requires_scenarios`-composed storyboards get a detail message
 *      that points at the composition mechanism, not a misleading
 *      "populate phases" hint
 *
 * Without these, agents look like they're failing compliance on
 * placeholder / scenario-composed storyboards even though they're
 * meant to skip cleanly.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

const FAKE_AGENT_URL = 'http://127.0.0.1:1/mcp'; // never reached — phases is empty
const FAKE_CLIENT = { getAgentInfo: async () => ({ name: 'Test', tools: [] }) };
const FAKE_PROFILE = { name: 'Test', tools: [] };

function emptyStoryboard(overrides = {}) {
  return {
    id: 'placeholder_sb',
    version: '1.0.0',
    title: 'Placeholder',
    category: 'compliance',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [],
    ...overrides,
  };
}

describe('runStoryboard: empty-phases storyboard (regression for #921)', () => {
  it('passes vacuously and exposes the documented `no_phases` skip reason', async () => {
    const result = await runStoryboard(FAKE_AGENT_URL, emptyStoryboard(), {
      protocol: 'mcp',
      allow_http: true,
      _client: FAKE_CLIENT,
      _profile: FAKE_PROFILE,
    });

    assert.strictEqual(result.overall_passed, true, 'empty-phases storyboard must not fail the agent');
    assert.strictEqual(result.passed_count, 0);
    assert.strictEqual(result.failed_count, 0);
    assert.strictEqual(result.skipped_count, 1, 'one synthetic skipped step');

    const phase = result.phases.find(p => p.phase_id === 'no_phases');
    assert.ok(phase, 'synthetic phase must use the documented `no_phases` id, not `__no_phases__`');
    assert.strictEqual(phase.passed, true, 'phase with only skipped steps must not be marked failed');
    assert.strictEqual(phase.steps.length, 1);

    const step = phase.steps[0];
    assert.strictEqual(step.step_id, 'no_phases');
    assert.strictEqual(step.skipped, true);
    assert.strictEqual(step.passed, true);
    assert.strictEqual(step.skip_reason, 'no_phases');
    // Default detail message for a placeholder storyboard.
    assert.match(step.skip?.detail ?? step.error ?? '', /populate `phases\[\]\.steps`|remove the storyboard/);
  });

  it('uses a scenario-composition detail when `requires_scenarios` is populated', async () => {
    const result = await runStoryboard(
      FAKE_AGENT_URL,
      emptyStoryboard({
        id: 'composed_sb',
        requires_scenarios: ['scenario_a', 'scenario_b'],
      }),
      { protocol: 'mcp', allow_http: true, _client: FAKE_CLIENT, _profile: FAKE_PROFILE }
    );

    assert.strictEqual(result.overall_passed, true);
    const step = result.phases[0]?.steps[0];
    assert.ok(step, 'synthetic step must exist');
    assert.strictEqual(step.skip_reason, 'no_phases');
    const detail = step.skip?.detail ?? step.error ?? '';
    assert.match(detail, /requires_scenarios/, 'detail must reference the composition mechanism');
    assert.doesNotMatch(
      detail,
      /populate `phases/,
      'must not echo the placeholder hint when scenarios compose the surface'
    );
  });
});
