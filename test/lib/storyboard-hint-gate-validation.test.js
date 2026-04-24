/**
 * Hint gate: fires on validation failure even when the task reports
 * success=200 (adcp-client#883).
 *
 * The original gate (adcp-client#870) checked task-level `passed` only.
 * Sellers that return 200 with an advisory `errors[]` + `available:` list
 * (success envelope with warnings) plus a schema-rejecting validation
 * silently missed hints. #883 widens the gate to fire on any step-level
 * failure — task-level OR validation-level. Uses the full `runStoryboard`
 * path so this test lands cleanly on main without depending on #880
 * (stateless-step provenance threading).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

function buildStubClient(handlers) {
  return {
    getAgentInfo: async () => ({
      name: 'stub',
      tools: Object.keys(handlers).map(name => ({ name })),
    }),
    getSignals: async params => handlers.get_signals?.(params) ?? { success: false, error: 'no handler' },
    activateSignal: async params => handlers.activate_signal?.(params) ?? { success: false, error: 'no handler' },
    executeTask: async (name, params) =>
      handlers[name]?.(params) ?? { success: false, error: `no handler for ${name}` },
  };
}

const stubProfile = {
  name: 'stub',
  tools: [{ name: 'get_signals' }, { name: 'activate_signal' }],
};

function buildStoryboard(validationsForActivate) {
  return {
    id: 'hint_gate_sb',
    version: '1.0.0',
    title: 'hint-gate',
    category: 'test',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases: [
      {
        id: 'p1',
        title: 'p1',
        steps: [
          {
            id: 'search',
            title: 'search',
            task: 'get_signals',
            sample_request: {},
            context_outputs: [
              {
                key: 'first_signal_pricing_option_id',
                path: 'signals[0].pricing_options[0].pricing_option_id',
              },
            ],
          },
          {
            id: 'activate',
            title: 'activate',
            task: 'activate_signal',
            sample_request: { pricing_option_id: '$context.first_signal_pricing_option_id' },
            validations: validationsForActivate,
          },
        ],
      },
    ],
  };
}

const searchResponse = {
  signals: [{ pricing_options: [{ pricing_option_id: 'po_old' }] }],
};

// Seller returned 200 (success envelope) but embedded an advisory
// errors[] + `available:` list and a non-activated status. The success
// is what keeps the task-level passed flag true; the validation catches
// the `status` mismatch. Classic 200-with-warnings shape.
const activate200WithWarnings = {
  status: 'rejected',
  errors: [
    {
      code: 'INVALID_PRICING_MODEL',
      message: 'Pricing option not found',
      field: 'pricing_option_id',
      details: { available: ['po_new'] },
    },
  ],
};

describe('hint gate: validation failures open the gate (#883)', () => {
  test('200-OK success + failing validation → hint fires', async () => {
    const storyboard = buildStoryboard([
      { check: 'field_value', path: 'status', value: 'activated', description: 'status is activated' },
    ]);
    const client = buildStubClient({
      get_signals: async () => ({ success: true, data: searchResponse }),
      // success=true → task-level `passed` stays true. The broader gate
      // re-opens through the validation check.
      activate_signal: async () => ({ success: true, data: activate200WithWarnings }),
    });
    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    const activateStep = result.phases[0].steps.find(s => s.step_id === 'activate');
    assert.ok(activateStep, 'activate step present in result');
    assert.equal(activateStep.passed, false, 'validation failure drives overall failure');
    assert.ok(Array.isArray(activateStep.hints), `hints array present, got ${JSON.stringify(activateStep.hints)}`);
    assert.equal(activateStep.hints.length, 1);
    assert.equal(activateStep.hints[0].context_key, 'first_signal_pricing_option_id');
    assert.equal(activateStep.hints[0].rejected_value, 'po_old');
    assert.deepEqual(activateStep.hints[0].accepted_values, ['po_new']);
  });

  test('200-OK success + all validations pass → no hint (advisory only)', async () => {
    // Same response shape but no validation that catches the issue —
    // overall step passes, gate stays shut. Confirms the gate key is
    // step-level failure, not presence of `errors[]` on the response.
    const storyboard = buildStoryboard([]);
    const client = buildStubClient({
      get_signals: async () => ({ success: true, data: searchResponse }),
      activate_signal: async () => ({ success: true, data: activate200WithWarnings }),
    });
    const result = await runStoryboard('https://stub.example/mcp', storyboard, {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    const activateStep = result.phases[0].steps.find(s => s.step_id === 'activate');
    assert.ok(activateStep, 'activate step present in result');
    assert.equal(activateStep.passed, true, 'step passes when no validation catches it');
    assert.equal(activateStep.hints, undefined, 'gate stays shut when step passes');
  });
});
