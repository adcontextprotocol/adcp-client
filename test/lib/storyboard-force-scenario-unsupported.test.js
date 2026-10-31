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

const { runStoryboard, runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');
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

async function runForceDependency({
  layout = 'downstream',
  controllerResponse = { success: false, error: 'UNKNOWN_SCENARIO' },
  observedStatus = 'completed',
  failBeforeForce = false,
  statefulForce = true,
  deferredSetup = null,
} = {}) {
  const force = structuredClone(storyboard.phases[0].steps[0]);
  force.stateful = statefulForce;
  const observe = id => ({
    id,
    title: 'Observe forced outcome',
    task: 'get_products',
    stateful: true,
    sample_request: { buying_mode: 'brief', brief: 'Display inventory' },
    validations: [{ check: 'field_value', path: 'status', value: 'rejected', description: 'Forced rejection' }],
  });
  const setup = { id: 'setup', title: 'Set up forced state', steps: [force] };
  if (deferredSetup) {
    setup.steps.unshift({
      id: 'missing_setup',
      title: 'Prepare account state',
      task: 'sync_accounts',
      stateful: true,
      sample_request: {},
    });
    setup.steps.push({ ...observe('substitute'), provides_state_for: 'missing_setup' });
  }
  const phases = [setup];
  if (failBeforeForce) {
    phases.unshift({ id: 'failure', title: 'Independent failure', depends_on: [], steps: [observe('real_failure')] });
    setup.depends_on = [];
  }
  if (layout === 'same_phase') setup.steps.push(observe('observe'));
  else {
    phases.push({
      id: 'observe',
      title: 'Observe forced state',
      depends_on: layout === 'independent' ? [] : failBeforeForce ? ['setup', 'failure'] : ['setup'],
      steps: [observe('observe')],
    });
    if (layout === 'chain') {
      phases.push({ id: 'readback', title: 'Read back', depends_on: ['observe'], steps: [observe('readback')] });
    }
  }
  const calls = [];
  const tools = ['comply_test_controller', 'get_products'];
  const client = {
    executeTask: async task => {
      calls.push(task);
      return {
        success: true,
        data: task === 'comply_test_controller' ? controllerResponse : { status: observedStatus },
      };
    },
  };
  const result = await runStoryboard(
    'https://stub.example/mcp',
    { ...storyboard, phases },
    {
      protocol: 'mcp',
      agentTools: tools,
      skip_controller_seeding: true,
      _client: client,
      _profile: {
        name: 'stub',
        tools,
        ...(deferredSetup === 'not_applicable' && {
          raw_capabilities: { account: { require_operator_auth: true } },
        }),
      },
    }
  );
  return { result, calls, steps: result.phases.flatMap(phase => phase.steps) };
}

describe('runStoryboard: unsupported force setup cascades (adcp-client#3549)', () => {
  for (const layout of ['same_phase', 'downstream', 'chain']) {
    test(`${layout}: observations skip without dispatch or seller failures`, async () => {
      const { result, calls, steps } = await runForceDependency({ layout });
      assert.deepEqual(calls, ['comply_test_controller'], 'unforced observations must never dispatch');
      assert.equal(steps[0].skip_reason, 'force_scenario_unsupported');
      for (const step of steps.slice(1)) {
        assert.equal(step.skipped, true);
        assert.equal(step.passed, true);
        assert.equal(step.skip.reason, 'not_applicable');
        assert.match(step.skip.detail, /force_creative.*force_scenario_unsupported/);
        assert.deepEqual(step.validations, []);
      }
      assert.equal(result.overall_passed, true, 'unavailable forcing is a coverage skip');
      assert.equal(result.failed_count, 0);
      assert.equal(result.passed_count, 0, 'skipped observations receive no passing-step credit');
    });
  }

  test('an independent phase still executes and its failure remains visible', async () => {
    const { result, calls, steps } = await runForceDependency({ layout: 'independent' });
    assert.deepEqual(calls, ['comply_test_controller', 'get_products']);
    assert.notEqual(steps[1].skipped, true);
    assert.equal(steps[1].passed, false);
    assert.equal(result.overall_passed, false);
  });

  test('non-stateful unsupported forcing does not create a state dependency', async () => {
    const { calls, steps } = await runForceDependency({ statefulForce: false });
    assert.deepEqual(calls, ['comply_test_controller', 'get_products']);
    assert.notEqual(steps[1].skipped, true);
  });

  test('successful forcing runs and validates the observation', async () => {
    const { result, calls, steps } = await runForceDependency({
      controllerResponse: { success: true },
      observedStatus: 'rejected',
    });
    assert.deepEqual(calls, ['comply_test_controller', 'get_products']);
    assert.ok(steps.every(step => step.passed && !step.skipped));
    assert.equal(result.overall_passed, true);
  });

  test('a wrong outcome after successful forcing still fails', async () => {
    const { result, calls, steps } = await runForceDependency({ controllerResponse: { success: true } });
    assert.deepEqual(calls, ['comply_test_controller', 'get_products']);
    assert.equal(steps[1].passed, false);
    assert.equal(result.overall_passed, false);
  });

  test('a real controller failure is not treated as unavailable forcing', async () => {
    const { result, steps } = await runForceDependency({
      controllerResponse: { success: false, error: 'INVALID_PARAMS' },
    });
    assert.equal(steps[0].passed, false);
    assert.equal(steps[1].skip_reason, 'prerequisite_failed');
    assert.equal(steps[1].passed, false);
    assert.equal(result.overall_passed, false);
  });

  test('a real earlier failure takes precedence over unavailable forcing', async () => {
    const { result, calls, steps } = await runForceDependency({ failBeforeForce: true });
    assert.deepEqual(calls, ['get_products', 'comply_test_controller']);
    assert.equal(steps[0].passed, false);
    assert.equal(steps[1].skip_reason, 'force_scenario_unsupported');
    assert.equal(steps[2].skip_reason, 'prerequisite_failed');
    assert.equal(steps[2].passed, false);
    assert.equal(result.overall_passed, false);
  });

  for (const deferredSetup of ['missing_tool', 'not_applicable']) {
    test(`unrescued ${deferredSetup} state takes precedence over unavailable forcing`, async () => {
      const { result, calls, steps } = await runForceDependency({ deferredSetup });
      assert.deepEqual(calls, ['comply_test_controller']);
      assert.equal(steps[0].skip_reason, deferredSetup);
      assert.equal(steps[1].skip_reason, 'force_scenario_unsupported');
      const dependent = steps.at(-1);
      assert.equal(dependent.skip_reason, 'prerequisite_failed');
      assert.match(dependent.skip.detail, /missing_setup/);
      assert.equal(dependent.passed, false);
      assert.equal(result.overall_passed, false);
    });
  }
});
