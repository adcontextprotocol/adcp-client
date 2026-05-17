/**
 * Regression test for AdCP 3.0.12 `force_scenario_unsupported` runner
 * detection (adcontextprotocol/adcp-client#1805).
 *
 * Spec (`compliance/cache/<ver>/universal/runner-output-contract.yaml` >
 * `skip_result.reasons.force_scenario_unsupported`): when a
 * comply_test_controller step calls a force_* scenario that the agent
 * advertises the controller for but does not implement, the agent returns
 * `{success: false, error: 'UNKNOWN_SCENARIO'}`. Runners MUST grade the
 * step `not_applicable` with detail `force_scenario_unsupported` BEFORE
 * applying the step's authored validations.
 *
 * Companion to fixture_seed_unsupported (already implemented in
 * src/lib/testing/storyboard/seeding.ts) — same shape but for force_*
 * scenarios in step phases, not seed_* scenarios in the fixtures phase.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
const { DETAILED_SKIP_TO_CANONICAL } = require('../../dist/lib/testing/storyboard/types');

function buildControllerStubClient(controllerResponse) {
  return {
    getAgentInfo: async () => ({
      name: 'stub',
      tools: [{ name: 'comply_test_controller' }],
    }),
    executeTask: async (name, _params) => {
      if (name !== 'comply_test_controller') {
        return { success: false, error: `no handler for ${name}` };
      }
      return { success: true, data: controllerResponse };
    },
  };
}

const stubProfile = {
  name: 'stub',
  tools: [{ name: 'comply_test_controller' }],
};

const storyboard = {
  id: 'force_unsupported_sb',
  version: '1.0.0',
  title: 'force_scenario_unsupported probe',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'p1',
      title: 'force creative status',
      steps: [
        {
          id: 'force_creative',
          title: 'force creative status',
          task: 'comply_test_controller',
          stateful: false,
          sample_request: {
            scenario: 'force_creative_status',
            params: { creative_id: 'c-1', status: 'approved' },
          },
          validations: [
            { check: 'field_value', path: 'success', allowed_values: [true], description: 'force succeeded' },
          ],
        },
      ],
    },
  ],
};

describe('runStoryboardStep: force_scenario_unsupported (adcp#1805)', () => {
  test('grades not_applicable when controller returns UNKNOWN_SCENARIO for a force_* scenario', async () => {
    const client = buildControllerStubClient({ success: false, error: 'UNKNOWN_SCENARIO' });
    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'force_creative', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['comply_test_controller'],
      _client: client,
      _profile: stubProfile,
    });

    assert.equal(result.skipped, true, `expected skipped: true, got ${JSON.stringify(result)}`);
    assert.equal(result.skip_reason, 'force_scenario_unsupported');
    assert.ok(result.skip, 'expected structured skip block');
    assert.equal(result.skip.reason, 'not_applicable', 'canonical reason MUST be not_applicable');
    assert.match(result.skip.detail, /force_scenario_unsupported/);
    assert.match(result.skip.detail, /force_creative_status/);

    // Authored validations MUST be skipped (no false-fail of the
    // `success === true` check the storyboard declared).
    assert.deepEqual(result.validations, [], 'authored validations must not run on a skipped force_unsupported step');
  });

  test('detail-skip-to-canonical mapping includes force_scenario_unsupported → not_applicable', () => {
    assert.equal(
      DETAILED_SKIP_TO_CANONICAL.force_scenario_unsupported,
      'not_applicable',
      'spec maps force_scenario_unsupported onto canonical not_applicable'
    );
  });

  test('does NOT trigger on non-force_* scenarios that return UNKNOWN_SCENARIO', async () => {
    // A seed_* scenario returning UNKNOWN_SCENARIO is a different code path
    // (fixture_seed_unsupported, seeding.ts). A list_scenarios call returning
    // UNKNOWN_SCENARIO is just a bad agent. Neither should land in the force_
    // skip branch.
    const client = buildControllerStubClient({ success: false, error: 'UNKNOWN_SCENARIO' });
    const seedSb = JSON.parse(JSON.stringify(storyboard));
    seedSb.phases[0].steps[0].id = 'seed_creative';
    seedSb.phases[0].steps[0].sample_request.scenario = 'seed_creative';
    seedSb.phases[0].steps[0].sample_request.params = { creative_id: 'c-1', status: 'approved' };

    const result = await runStoryboardStep('https://stub.example/mcp', seedSb, 'seed_creative', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['comply_test_controller'],
      _client: client,
      _profile: stubProfile,
    });

    // The step fails its declared `success: true` validation, as expected —
    // we did NOT inadvertently swallow non-force_* UNKNOWN_SCENARIO returns.
    assert.notEqual(
      result.skip_reason,
      'force_scenario_unsupported',
      'non-force_* scenarios must not trigger force_scenario_unsupported skip'
    );
  });

  test('does NOT trigger when force_* scenario succeeds', async () => {
    // Sanity: a force_* scenario that succeeds (`{success: true, ...}`)
    // grades normally. No skip path fires.
    const client = buildControllerStubClient({ success: true, previous_state: 'pending', new_state: 'approved' });
    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'force_creative', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['comply_test_controller'],
      _client: client,
      _profile: stubProfile,
    });

    assert.notEqual(result.skipped, true, 'successful force_* must not be skipped');
    assert.notEqual(result.skip_reason, 'force_scenario_unsupported');
  });
});
