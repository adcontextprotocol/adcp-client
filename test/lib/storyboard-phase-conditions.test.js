const { describe, test } = require('node:test');
const assert = require('node:assert');

const { parseStoryboard, validateStoryboardShape } = require('../../dist/lib/testing/storyboard/loader.js');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner.js');
const { evaluatePhaseCondition } = require('../../dist/lib/testing/storyboard/phase-condition.js');

function proposalGuardStoryboard(proposals) {
  const outputs = [
    { key: 'proposal_id_1', path: 'proposals[0].proposal_id' },
    { key: 'proposal_id_2', path: 'proposals[1].proposal_id' },
  ];
  return {
    id: 'runtime_context_phase_guard',
    version: '1.0.0',
    title: 'Runtime context phase guard',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'capture',
        title: 'Capture proposal ids',
        steps: [
          {
            id: 'capture_proposals',
            title: 'Capture proposals',
            task: 'get_products',
            sample_request: { buying_mode: 'brief', brief: 'Need a proposal' },
            context_outputs: outputs,
            validations: [],
          },
        ],
      },
      {
        id: 'multi_finalize',
        title: 'Multi-finalize branch',
        skip_if: '!context.proposal_id_2 || context.proposal_id_2 == context.proposal_id_1',
        steps: [
          {
            id: 'guarded_call',
            title: 'Guarded call',
            task: 'get_products',
            sample_request: { buying_mode: 'brief', brief: 'Guarded request' },
            validations: [],
          },
        ],
      },
    ],
  };
}

async function runProposalGuard(proposals) {
  const calls = [];
  const client = {
    getAgentInfo: async () => ({ name: 'phase-condition-stub', tools: [{ name: 'get_products' }] }),
    executeTask: async (task, params) => {
      calls.push({ task, params });
      return { success: true, status: 'completed', data: { proposals } };
    },
  };
  const result = await runStoryboard('https://stub.example/mcp', proposalGuardStoryboard(proposals), {
    protocol: 'mcp',
    allow_http: true,
    agentTools: ['get_products'],
    _profile: { name: 'phase-condition-stub', tools: [{ name: 'get_products' }] },
    _client: client,
  });
  return { calls, result };
}

describe('storyboard phase skip_if conditions', () => {
  test('absent second proposal skips the guarded multi-proposal phase', async () => {
    const { calls, result } = await runProposalGuard([{ proposal_id: 'proposal-1' }]);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(result.phases[0].steps[0].context.proposal_id_1, 'proposal-1');
    assert.deepStrictEqual(result.phases[1].steps, []);
  });

  test('duplicate proposal ids skip the guarded multi-proposal phase', async () => {
    const { calls, result } = await runProposalGuard([{ proposal_id: 'proposal-1' }, { proposal_id: 'proposal-1' }]);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(result.phases[0].steps[0].context.proposal_id_2, 'proposal-1');
    assert.deepStrictEqual(result.phases[1].steps, []);
  });

  test('distinct proposal ids run the guarded multi-proposal phase', async () => {
    const { calls, result } = await runProposalGuard([{ proposal_id: 'proposal-1' }, { proposal_id: 'proposal-2' }]);

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(
      result.phases[1].steps.map(step => step.step_id),
      ['guarded_call']
    );
  });

  test('preserves test_kit guards, including quoted string comparisons', async () => {
    const storyboard = proposalGuardStoryboard([{ proposal_id: 'proposal-1' }]);
    storyboard.phases[1].skip_if = "test_kit.commercial_relationship != 'passthrough_only'";
    const calls = [];
    const client = {
      getAgentInfo: async () => ({ name: 'phase-condition-stub', tools: [{ name: 'get_products' }] }),
      executeTask: async () => {
        calls.push('get_products');
        return { success: true, status: 'completed', data: { proposals: [{ proposal_id: 'proposal-1' }] } };
      },
    };

    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      protocol: 'mcp',
      allow_http: true,
      test_kit: { commercial_relationship: 'passthrough_only' },
      agentTools: ['get_products'],
      _profile: { name: 'phase-condition-stub', tools: [{ name: 'get_products' }] },
      _client: client,
    });

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(
      result.phases[1].steps.map(step => step.step_id),
      ['guarded_call']
    );
  });

  test('evaluates boolean literals and unary negation with conventional precedence', () => {
    assert.strictEqual(evaluatePhaseCondition('context.enabled != false', { context: { enabled: true } }), true);
    assert.strictEqual(evaluatePhaseCondition('!context.enabled == true', { context: { enabled: false } }), true);
  });

  test('preserves numeric-leading test-kit path segments', () => {
    assert.strictEqual(
      evaluatePhaseCondition('test_kit.formats.300x250', {
        test_kit: { formats: { '300x250': true } },
      }),
      true
    );
  });

  test('rejects malformed and unsupported expressions at authoring time', () => {
    const invalid = [
      'context.proposal_id_2 && context.proposal_id_1',
      'context.proposal_id_2 === context.proposal_id_1',
      'runtime.proposal_id_2',
      'context.proposal_id_2 ||',
      '',
    ];

    for (const skipIf of invalid) {
      const storyboard = proposalGuardStoryboard([]);
      storyboard.phases[1].skip_if = skipIf;
      assert.throws(
        () => validateStoryboardShape(storyboard),
        /phase 'multi_finalize': invalid skip_if expression/,
        skipIf
      );
    }
  });

  test('YAML loading rejects unsupported expressions instead of silently running the phase', () => {
    assert.throws(
      () =>
        parseStoryboard(`
id: invalid_skip_if
version: 1.0.0
title: Invalid guard
category: test
summary: ''
narrative: ''
agent: { interaction_model: '*', capabilities: [] }
caller: { role: buyer_agent }
phases:
  - id: guarded
    title: Guarded
    skip_if: "context.value && true"
    steps: []
`),
      /invalid skip_if expression/
    );
  });

  test('runner rejects an invalid programmatic guard before agent dispatch', async () => {
    const storyboard = proposalGuardStoryboard([]);
    storyboard.phases[1].skip_if = 'context.value && true';
    let calls = 0;

    await assert.rejects(
      runStoryboard('https://stub.example/mcp', storyboard, {
        protocol: 'mcp',
        agentTools: ['get_products'],
        _profile: { name: 'phase-condition-stub', tools: [{ name: 'get_products' }] },
        _client: {
          getAgentInfo: async () => ({ name: 'phase-condition-stub', tools: [{ name: 'get_products' }] }),
          executeTask: async () => {
            calls++;
            return { success: true, data: { proposals: [] } };
          },
        },
      }),
      /invalid skip_if expression/
    );
    assert.strictEqual(calls, 0);
  });
});
