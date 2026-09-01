/**
 * Phase-level capability gate must cascade-skip downstream stateful steps.
 *
 * When a phase declares `requires_capability` and the agent doesn't satisfy
 * the gate, the phase is skipped. Downstream stateful steps in later phases
 * that consume `$context.*` values produced by the skipped phase must also
 * cascade-skip with `prerequisite_failed` — not execute with unresolved
 * placeholder strings on the wire.
 *
 * Regression test for adcontextprotocol/adcp#7115.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');

// Storyboard with a capability-gated setup phase and a downstream phase
// whose stateful steps reference $context.media_buy_id from the gated phase.
const phaseGatedStoryboard = {
  id: 'phase_capability_cascade_test',
  version: '1.0.0',
  title: 'Phase-level capability gate cascade',
  category: 'test',
  summary: 'Downstream stateful steps cascade-skip when a capability-gated setup phase is skipped.',
  narrative: '',
  agent: { interaction_model: 'media_buy_seller', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'setup',
      title: 'Create a media buy',
      requires_capability: { path: 'creative.has_creative_library', equals: true },
      steps: [
        {
          id: 'create_buy',
          title: 'Create media buy',
          task: 'create_media_buy',
          stateful: true,
          sample_request: { brand_id: 'test' },
          context_outputs: [{ key: 'media_buy_id', path: 'media_buy_id' }],
        },
      ],
    },
    {
      id: 'state_transitions',
      title: 'Valid state transitions',
      steps: [
        {
          id: 'pause_buy',
          title: 'Pause the media buy',
          task: 'update_media_buy',
          stateful: true,
          sample_request: { media_buy_id: '$context.media_buy_id', paused: true },
        },
        {
          id: 'resume_buy',
          title: 'Resume the media buy',
          task: 'update_media_buy',
          stateful: true,
          sample_request: { media_buy_id: '$context.media_buy_id', paused: false },
        },
      ],
    },
  ],
};

describe('phase-level capability gate cascades to downstream stateful steps (adcp#7115)', () => {
  test('downstream stateful steps cascade-skip when setup phase is capability-gated', async () => {
    const result = await runStoryboard('http://fake-local-7115', phaseGatedStoryboard, {
      agentTools: ['create_media_buy', 'update_media_buy', 'get_adcp_capabilities'],
      _profile: {
        name: 'Test Agent (no creative library)',
        tools: ['create_media_buy', 'update_media_buy', 'get_adcp_capabilities'],
        raw_capabilities: { creative: {} },
      },
    });

    // Runner marks cascade-skipped steps as not-passed; the scoring layer
    // in compliance-testing.ts handles neutral accounting for applicability
    // skips. What matters here: steps cascade-skip, not execute with
    // unresolved $context.* placeholders.
    assert.equal(result.failed_count, 0, 'no hard failures');

    // Setup phase: capability-skipped
    const setupPhase = result.phases.find(p => p.phase_id === 'setup');
    assert.ok(setupPhase, 'setup phase present');
    assert.equal(setupPhase.passed, true);
    assert.equal(setupPhase.steps.length, 1);
    assert.equal(setupPhase.steps[0].skipped, true);
    assert.equal(setupPhase.steps[0].skip_reason, 'not_applicable');

    // Downstream phase: stateful steps must cascade-skip
    const transitionsPhase = result.phases.find(p => p.phase_id === 'state_transitions');
    assert.ok(transitionsPhase, 'state_transitions phase present');
    for (const step of transitionsPhase.steps) {
      assert.equal(step.skipped, true, `step "${step.step_id}" must be skipped`);
      assert.equal(
        step.skip_reason,
        'prerequisite_failed',
        `step "${step.step_id}" must cascade-skip with prerequisite_failed, not execute with unresolved $context placeholder`
      );
    }
  });

  test('downstream phase runs normally when the capability gate is satisfied', async () => {
    // When the gate passes, the downstream phase should attempt execution
    // (it will fail here because there's no real agent, but it should NOT
    // be cascade-skipped).
    const result = await runStoryboard('http://fake-local-7115-pass', phaseGatedStoryboard, {
      agentTools: ['create_media_buy', 'update_media_buy', 'get_adcp_capabilities'],
      _profile: {
        name: 'Test Agent (has creative library)',
        tools: ['create_media_buy', 'update_media_buy', 'get_adcp_capabilities'],
        raw_capabilities: { creative: { has_creative_library: true } },
      },
    });

    // Setup phase should NOT be capability-skipped
    const setupPhase = result.phases.find(p => p.phase_id === 'setup');
    assert.ok(setupPhase, 'setup phase present');
    const setupStep = setupPhase.steps[0];
    assert.notEqual(
      setupStep.skip_reason,
      'not_applicable',
      'setup step should not be capability-skipped when gate is satisfied'
    );
  });
});
