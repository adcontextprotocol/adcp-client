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
const { buildComplianceBundleResults } = require('../../dist/lib/testing/compliance/comply.js');

// A non-stateful setup phase still produces context consumed by an
// expect_error vector. A safe stateful peer proves that only consumers of the
// unavailable key are blocked; the final phases prove explicit dependency
// declarations remain authoritative.
const phaseGatedStoryboard = {
  id: 'phase_capability_cascade_test',
  version: '1.0.0',
  title: 'Phase-level capability gate cascade',
  category: 'test',
  summary: 'Downstream stateful steps cascade-skip when a capability-gated setup phase is skipped.',
  narrative: '',
  agent: { interaction_model: 'media_buy_seller', capabilities: [] },
  caller: { role: 'buyer_agent' },
  invariants: {
    disable: [
      'idempotency.conflict_no_payload_leak',
      'context.no_secret_echo',
      'governance.denial_blocks_mutation',
      'status.monotonic',
      'impairment.coherence',
    ],
  },
  phases: [
    {
      id: 'setup',
      title: 'Create a media buy',
      requires_capability: { path: 'creative.has_creative_library', equals: true },
      steps: [
        {
          id: 'create_buy',
          title: 'Create media buy',
          task: '__test_context_producer',
          stateful: false,
          sample_request: { brand_id: 'test' },
          context_outputs: [{ key: 'media_buy_id', path: 'media_buy_id' }],
        },
      ],
    },
    {
      id: 'dependent_consumers',
      title: 'Consumers of capability-gated state',
      depends_on: ['setup'],
      steps: [
        {
          id: 'reject_unavailable_context',
          title: 'Must not send an unresolved context token, even as expect_error',
          task: '__test_expect_error',
          stateful: false,
          expect_error: true,
          sample_request: { media_buy_id: '$context.media_buy_id' },
        },
        {
          id: 'reject_unavailable_context_input',
          title: 'Must not dispatch an unavailable explicit context input',
          task: '__test_expect_error_input',
          stateful: false,
          expect_error: true,
          sample_request: {},
          context_inputs: [{ key: 'media_buy_id', inject_at: 'media_buy_id' }],
        },
        {
          id: 'safe_stateful_peer',
          title: 'Unrelated stateful step still runs',
          task: '__test_safe_stateful',
          stateful: true,
          sample_request: { safe: true },
        },
      ],
    },
    {
      id: 'independent',
      title: 'Independent phase',
      depends_on: [],
      steps: [
        {
          id: 'independent_step',
          title: 'Explicitly independent malformed vector still runs',
          task: '__test_independent',
          expect_error: true,
          sample_request: { media_buy_id: '$context.media_buy_id' },
        },
      ],
    },
    {
      id: 'unrelated_source',
      title: 'Unrelated source',
      depends_on: [],
      steps: [
        {
          id: 'unrelated_source_step',
          title: 'Establish unrelated state',
          task: '__test_unrelated_source',
          sample_request: { unrelated: true },
        },
      ],
    },
    {
      id: 'targeted_unrelated_consumer',
      title: 'Targeted unrelated consumer',
      depends_on: ['unrelated_source'],
      steps: [
        {
          id: 'targeted_unrelated_step',
          title: 'Targeted dependency does not inherit the gated phase',
          task: '__test_targeted_unrelated',
          expect_error: true,
          sample_request: { media_buy_id: '$context.media_buy_id' },
        },
      ],
    },
  ],
};

describe('phase-level capability gate cascades to downstream stateful steps (adcp#7115)', () => {
  test('blocks only dependent unavailable context without dispatching expect_error vectors', async () => {
    const calls = [];
    const client = {
      getAgentInfo: async () => ({ name: 'Test Agent', tools: [] }),
      executeTask: async (task, params) => {
        calls.push({ task, params });
        if (task === '__test_independent' || task === '__test_targeted_unrelated') {
          return { success: false, error: 'intentional malformed-vector rejection' };
        }
        return { success: true, status: 'completed', data: { ok: true } };
      },
    };
    const result = await runStoryboard('http://fake-local-7115', phaseGatedStoryboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: [
        '__test_context_producer',
        '__test_expect_error',
        '__test_expect_error_input',
        '__test_safe_stateful',
        '__test_independent',
        '__test_unrelated_source',
        '__test_targeted_unrelated',
      ],
      _profile: {
        name: 'Test Agent (no creative library)',
        tools: [
          '__test_context_producer',
          '__test_expect_error',
          '__test_expect_error_input',
          '__test_safe_stateful',
          '__test_independent',
          '__test_unrelated_source',
          '__test_targeted_unrelated',
        ],
        raw_capabilities: { creative: {} },
      },
      _client: client,
    });

    assert.equal(result.failed_count, 0, 'capability applicability is not a hard failure');
    assert.equal(result.overall_passed, true);

    // Setup phase: capability-skipped
    const setupPhase = result.phases.find(p => p.phase_id === 'setup');
    assert.ok(setupPhase, 'setup phase present');
    assert.equal(setupPhase.passed, true);
    assert.equal(setupPhase.steps.length, 1);
    assert.equal(setupPhase.steps[0].skipped, true);
    assert.equal(setupPhase.steps[0].skip_reason, 'not_applicable');

    const consumerPhase = result.phases.find(p => p.phase_id === 'dependent_consumers');
    assert.ok(consumerPhase, 'dependent consumer phase present');
    const unavailableConsumer = consumerPhase.steps.find(step => step.step_id === 'reject_unavailable_context');
    assert.equal(unavailableConsumer.skipped, true);
    assert.equal(unavailableConsumer.skip_reason, 'capability_prerequisite_unavailable');
    const unavailableInput = consumerPhase.steps.find(step => step.step_id === 'reject_unavailable_context_input');
    assert.equal(unavailableInput.skipped, true);
    assert.equal(unavailableInput.skip_reason, 'capability_prerequisite_unavailable');

    // No literal $context value crossed the wire. The unrelated stateful step
    // in this dependent phase and the explicitly independent phase still run.
    assert.deepEqual(
      calls.map(call => call.task),
      ['__test_safe_stateful', '__test_independent', '__test_unrelated_source', '__test_targeted_unrelated']
    );
    assert.equal(calls[1].params.media_buy_id, '$context.media_buy_id');
    assert.equal(calls[3].params.media_buy_id, '$context.media_buy_id');

    const assessment = buildComplianceBundleResults(
      [{ ref: { kind: 'specialism', id: 'test', path: '/unused' }, storyboards: [phaseGatedStoryboard] }],
      [result]
    );
    assert.equal(
      assessment[0].status,
      'passing',
      'capability gate and its dependent skips are complete applicability evidence'
    );
  });

  test('downstream phase runs normally when the capability gate is satisfied', async () => {
    const calls = [];
    const client = {
      getAgentInfo: async () => ({ name: 'Test Agent', tools: [] }),
      executeTask: async (task, params) => {
        calls.push({ task, params });
        if (task === '__test_context_producer') {
          return { success: true, status: 'completed', data: { media_buy_id: 'mb_123' } };
        }
        if (
          task === '__test_expect_error' ||
          task === '__test_expect_error_input' ||
          task === '__test_independent' ||
          task === '__test_targeted_unrelated'
        ) {
          return { success: false, error: 'intentional rejection' };
        }
        return { success: true, status: 'completed', data: { ok: true } };
      },
    };
    const result = await runStoryboard('http://fake-local-7115-pass', phaseGatedStoryboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: [
        '__test_context_producer',
        '__test_expect_error',
        '__test_expect_error_input',
        '__test_safe_stateful',
        '__test_independent',
        '__test_unrelated_source',
        '__test_targeted_unrelated',
      ],
      _profile: {
        name: 'Test Agent (has creative library)',
        tools: [
          '__test_context_producer',
          '__test_expect_error',
          '__test_expect_error_input',
          '__test_safe_stateful',
          '__test_independent',
          '__test_unrelated_source',
          '__test_targeted_unrelated',
        ],
        raw_capabilities: { creative: { has_creative_library: true } },
      },
      _client: client,
    });

    const setupPhase = result.phases.find(p => p.phase_id === 'setup');
    assert.ok(setupPhase, 'setup phase present');
    const setupStep = setupPhase.steps[0];
    assert.notEqual(
      setupStep.skip_reason,
      'not_applicable',
      'setup step should not be capability-skipped when gate is satisfied'
    );
    assert.equal(result.overall_passed, true);
    assert.deepEqual(
      calls.map(call => call.task),
      [
        '__test_context_producer',
        '__test_expect_error',
        '__test_expect_error_input',
        '__test_safe_stateful',
        '__test_independent',
        '__test_unrelated_source',
        '__test_targeted_unrelated',
      ]
    );
    assert.equal(calls[1].params.media_buy_id, 'mb_123');
    assert.equal(calls[2].params.media_buy_id, 'mb_123');
    assert.equal(calls[4].params.media_buy_id, 'mb_123');
    assert.equal(calls[6].params.media_buy_id, 'mb_123');
  });

  test('capability-gated stateful setup cascades even without declared context outputs', async () => {
    const calls = [];
    const client = {
      getAgentInfo: async () => ({ name: 'Test Agent', tools: [] }),
      executeTask: async (task, params) => {
        calls.push({ task, params });
        return { success: true, status: 'completed', data: { ok: true } };
      },
    };
    const storyboard = {
      ...phaseGatedStoryboard,
      id: 'stateful_capability_cascade',
      phases: [
        {
          id: 'setup',
          title: 'Capability-gated stateful setup',
          requires_capability: { path: 'creative.has_creative_library', equals: true },
          steps: [
            {
              id: 'stateful_setup',
              title: 'Create implicit state',
              task: '__test_stateful_setup',
              stateful: true,
              sample_request: {},
            },
          ],
        },
        {
          id: 'consumer',
          title: 'Stateful consumer',
          depends_on: ['setup'],
          steps: [
            {
              id: 'stateful_consumer',
              title: 'Consume implicit state',
              task: '__test_stateful_consumer',
              stateful: true,
              sample_request: {},
            },
          ],
        },
      ],
    };

    const result = await runStoryboard('http://fake-local-7115-stateful', storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['__test_stateful_setup', '__test_stateful_consumer'],
      _profile: {
        name: 'Test Agent (no creative library)',
        tools: ['__test_stateful_setup', '__test_stateful_consumer'],
        raw_capabilities: { creative: {} },
      },
      _client: client,
    });

    assert.deepEqual(calls, []);
    const consumer = result.phases[1].steps[0];
    assert.equal(consumer.skipped, true);
    assert.equal(consumer.skip_reason, 'capability_prerequisite_unavailable');
    assert.equal(consumer.skip.reason, 'not_applicable');
    assert.equal(consumer.passed, true);
  });

  test('does not cascade capability-unavailable state across any_of branch peers', async () => {
    const calls = [];
    const client = {
      getAgentInfo: async () => ({ name: 'Test Agent', tools: [] }),
      executeTask: async (task, params) => {
        calls.push({ task, params });
        return { success: false, error: 'intentional fallback-branch rejection' };
      },
    };
    const storyboard = {
      ...phaseGatedStoryboard,
      id: 'capability_gated_any_of_peer',
      phases: [
        {
          id: 'unavailable_branch',
          title: 'Capability-gated branch',
          optional: true,
          branch_set: { id: 'handled', semantics: 'any_of' },
          requires_capability: { path: 'creative.has_creative_library', equals: true },
          steps: [
            {
              id: 'unavailable_branch_step',
              title: 'Produce state on the unavailable branch',
              task: '__test_unavailable_branch',
              stateful: true,
              sample_request: {},
              context_outputs: [{ key: 'media_buy_id', path: 'media_buy_id' }],
            },
          ],
        },
        {
          id: 'fallback_branch',
          title: 'Fallback branch',
          optional: true,
          branch_set: { id: 'handled', semantics: 'any_of' },
          steps: [
            {
              id: 'fallback_branch_step',
              title: 'Run independently of the unavailable peer',
              task: '__test_any_of_fallback',
              stateful: true,
              expect_error: true,
              contributes_to: 'handled',
              sample_request: { media_buy_id: '$context.media_buy_id' },
            },
          ],
        },
        {
          id: 'gate',
          title: 'Branch gate',
          steps: [
            {
              id: 'assert_handled',
              title: 'A branch handled the scenario',
              task: 'assert_contribution',
              validations: [{ check: 'any_of', allowed_values: ['handled'], description: '' }],
            },
          ],
        },
      ],
    };

    const result = await runStoryboard('http://fake-local-7115-any-of', storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['__test_unavailable_branch', '__test_any_of_fallback'],
      _profile: {
        name: 'Test Agent (no creative library)',
        tools: ['__test_unavailable_branch', '__test_any_of_fallback'],
        raw_capabilities: { creative: {} },
      },
      _client: client,
    });

    assert.equal(result.overall_passed, true);
    assert.equal(result.phases[0].steps[0].skipped, true);
    assert.notEqual(result.phases[1].steps[0].skipped, true);
    assert.deepEqual(calls, [{ task: '__test_any_of_fallback', params: { media_buy_id: '$context.media_buy_id' } }]);
  });

  test('keeps unrelated expect_error context literals available to malformed-vector tests', async () => {
    const calls = [];
    const client = {
      getAgentInfo: async () => ({ name: 'Test Agent', tools: [] }),
      executeTask: async (task, params) => {
        calls.push({ task, params });
        return { success: false, error: 'intentionally invalid request' };
      },
    };
    const storyboard = {
      ...phaseGatedStoryboard,
      id: 'intentional_expect_error_context_literal',
      phases: [
        {
          id: 'malformed_vector',
          title: 'Malformed vector',
          steps: [
            {
              id: 'intentional_literal',
              title: 'Intentional malformed context literal',
              task: '__test_intentional_malformed',
              expect_error: true,
              sample_request: { media_buy_id: '$context.intentional_literal' },
            },
          ],
        },
      ],
    };

    const result = await runStoryboard('http://fake-local-7115-literal', storyboard, {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['__test_intentional_malformed'],
      _profile: { name: 'Test Agent', tools: [{ name: '__test_intentional_malformed' }] },
      _client: client,
    });

    assert.equal(result.phases[0].steps[0].passed, true);
    assert.deepEqual(calls, [
      { task: '__test_intentional_malformed', params: { media_buy_id: '$context.intentional_literal' } },
    ]);
  });
});
