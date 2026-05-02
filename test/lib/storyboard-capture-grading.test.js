/**
 * Tests for runner-output-contract v1.2.0 grading codes:
 *   - capture_path_not_resolvable (issue #1251)
 *   - unresolved_substitution (issue #1251)
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  applyContextOutputsWithProvenance,
  extractContextWithProvenance,
} = require('../../dist/lib/testing/storyboard/context');
const { runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

// ─── Stub client factory (mirrors storyboard-step-provenance-threading pattern) ─

function buildStubClient(taskResponses = {}) {
  const tools = Object.keys(taskResponses).map(name => ({ name }));
  return {
    getAgentInfo: async () => ({ name: 'stub-agent', tools }),
    // Runner dispatches typed methods by camelCase name when available.
    getSignals: async params => taskResponses.get_signals?.(params) ?? { success: false, error: 'no handler' },
    activateSignal: async params => taskResponses.activate_signal?.(params) ?? { success: false, error: 'no handler' },
    getAdcpCapabilities: async () =>
      taskResponses.get_adcp_capabilities?.() ?? { success: true, data: { version: '1.0' } },
    executeTask: async (name, params) =>
      taskResponses[name]?.(params) ?? { success: false, error: `no handler for ${name}` },
  };
}

function makeStoryboard(phases) {
  return {
    id: 'capture_grading_sb',
    version: '1.0.0',
    title: 'Capture grading test',
    category: 'testing',
    summary: '',
    narrative: '',
    agent: { interaction_model: '*', capabilities: [] },
    caller: { role: 'buyer_agent' },
    phases,
  };
}

// Stub profile used for agentTools so the runner skips tool-presence checks
// against discovery and proceeds directly to executing steps.
function makeStubProfile(taskNames) {
  return { name: 'stub-agent', tools: taskNames.map(n => ({ name: n })) };
}

// ─── Unit: applyContextOutputsWithProvenance failures field ───────────────────

describe('applyContextOutputsWithProvenance — failures field', () => {
  test('absent path produces a failure entry with actual null', () => {
    const data = { signals: [] };
    const outputs = [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }];
    const { values, failures } = applyContextOutputsWithProvenance(data, outputs, 'step1', 'get_signals');
    assert.deepEqual(values, {});
    assert.equal(failures.length, 1);
    assert.equal(failures[0].key, 'seg_id');
    assert.equal(failures[0].path, 'signals[0].signal_agent_segment_id');
    assert.equal(failures[0].actual, null);
  });

  test('null value produces a failure entry with actual null', () => {
    const data = { result: { id: null } };
    const outputs = [{ key: 'the_id', path: 'result.id' }];
    const { values, failures } = applyContextOutputsWithProvenance(data, outputs, 'step1', 'some_task');
    assert.deepEqual(values, {});
    assert.equal(failures.length, 1);
    assert.equal(failures[0].actual, null);
  });

  test('empty string value produces a failure entry with actual ""', () => {
    const data = { result: { id: '' } };
    const outputs = [{ key: 'the_id', path: 'result.id' }];
    const { values, failures } = applyContextOutputsWithProvenance(data, outputs, 'step1', 'some_task');
    assert.deepEqual(values, {});
    assert.equal(failures.length, 1);
    assert.equal(failures[0].actual, '');
  });

  test('resolved non-empty value produces no failure', () => {
    const data = { signals: [{ signal_agent_segment_id: 'seg_abc' }] };
    const outputs = [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }];
    const { values, failures } = applyContextOutputsWithProvenance(data, outputs, 'step1', 'get_signals');
    assert.equal(values.seg_id, 'seg_abc');
    assert.equal(failures.length, 0);
  });

  test('mixed outputs: one resolves, one fails', () => {
    const data = { signals: [{ signal_agent_segment_id: 'seg_x' }] };
    const outputs = [
      { key: 'seg_id', path: 'signals[0].signal_agent_segment_id' },
      { key: 'missing', path: 'signals[0].nonexistent_field' },
    ];
    const { values, failures } = applyContextOutputsWithProvenance(data, outputs, 'step1', 'get_signals');
    assert.equal(values.seg_id, 'seg_x');
    assert.equal(Object.keys(values).length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].key, 'missing');
  });

  test('extractContextWithProvenance returns empty failures array', () => {
    const { failures } = extractContextWithProvenance('get_products', { products: [{ product_id: 'p1' }] }, 'step1');
    assert.ok(Array.isArray(failures));
    assert.equal(failures.length, 0);
  });
});

// ─── Integration: capture_path_not_resolvable ─────────────────────────────────

describe('runStoryboard: capture_path_not_resolvable grading', () => {
  const taskNames = ['get_signals'];
  const stubOpts = client => ({
    protocol: 'mcp',
    _client: client,
    agentTools: taskNames,
    _profile: makeStubProfile(taskNames),
  });

  test('absent path (empty array) grades step failed with capture_path_not_resolvable', async () => {
    const client = buildStubClient({
      get_signals: () => ({ success: true, data: { signals: [] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            context_outputs: [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }],
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    const step = result.phases[0].steps[0];
    assert.equal(step.step_id, 'get_sigs');
    assert.equal(step.passed, false, 'step with unresolvable capture path should fail');
    const captureResult = step.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.ok(captureResult, 'should emit capture_path_not_resolvable ValidationResult');
    assert.equal(captureResult.passed, false);
    assert.equal(captureResult.expected, 'signals[0].signal_agent_segment_id');
    assert.equal(captureResult.json_pointer, '/signals/0/signal_agent_segment_id');
    assert.equal(captureResult.schema_id, null);
    assert.equal(captureResult.schema_url, null);
  });

  test('null response value grades failed with capture_path_not_resolvable', async () => {
    const client = buildStubClient({
      get_signals: () => ({ success: true, data: { signals: [{ signal_agent_segment_id: null }] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            context_outputs: [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }],
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    const step = result.phases[0].steps[0];
    assert.equal(step.passed, false);
    const captureResult = step.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.ok(captureResult, 'null value should emit capture_path_not_resolvable');
    assert.equal(captureResult.actual, null);
  });

  test('empty-string response value grades failed with capture_path_not_resolvable', async () => {
    const client = buildStubClient({
      get_signals: () => ({ success: true, data: { signals: [{ signal_agent_segment_id: '' }] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            context_outputs: [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }],
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    const step = result.phases[0].steps[0];
    assert.equal(step.passed, false);
    const captureResult = step.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.ok(captureResult, 'empty string should emit capture_path_not_resolvable');
    assert.equal(captureResult.actual, '');
  });

  test('capture failure increments failed_count not skipped_count', async () => {
    const client = buildStubClient({
      get_signals: () => ({ success: true, data: { signals: [] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            context_outputs: [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }],
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    assert.equal(result.failed_count, 1, 'capture failure should increment failed_count');
    assert.equal(result.skipped_count, 0);
  });

  test('successfully resolved path emits no capture_path_not_resolvable and passes', async () => {
    const client = buildStubClient({
      get_signals: () => ({ success: true, data: { signals: [{ signal_agent_segment_id: 'seg_abc' }] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            context_outputs: [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }],
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    const step = result.phases[0].steps[0];
    assert.equal(step.passed, true);
    const captureResult = step.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.equal(captureResult, undefined, 'resolved path should not emit capture_path_not_resolvable');
    assert.equal(result.failed_count, 0);
  });
});

// ─── Integration: unresolved_substitution ────────────────────────────────────

describe('runStoryboard: unresolved_substitution grading', () => {
  const taskNames = ['get_signals', 'activate_signal'];
  const stubOpts = client => ({
    protocol: 'mcp',
    _client: client,
    agentTools: taskNames,
    _profile: makeStubProfile(taskNames),
  });

  test('step with unresolved $context.* emits unresolved_substitution ValidationResult', async () => {
    const client = buildStubClient({
      // get_signals succeeds but uses a different key than the consumer step expects
      get_signals: () => ({ success: true, data: { signals: [{ signal_agent_segment_id: 'seg_x' }] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            // context_outputs writes 'seg_id' key via convention extractor (get_signals)
            // but the consumer step below references 'nonexistent_key' which is never set.
          },
          {
            id: 'activate_sig',
            title: 'Activate with missing key',
            task: 'activate_signal',
            sample_request: { signal_id: '$context.nonexistent_key' },
            stateful: true,
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    const skipStep = result.phases[0].steps.find(s => s.step_id === 'activate_sig');
    assert.ok(skipStep, 'activate_sig step should be present');
    assert.equal(skipStep.skipped, true, 'step with unresolved token should be skipped');
    assert.equal(skipStep.skip?.reason, 'prerequisite_failed');
    const subResult = skipStep.validations.find(v => v.check === 'unresolved_substitution');
    assert.ok(subResult, 'should emit unresolved_substitution ValidationResult');
    assert.equal(subResult.passed, false);
    assert.equal(subResult.expected, '$context.nonexistent_key');
    assert.equal(subResult.actual, null);
    assert.equal(subResult.json_pointer, null);
    assert.equal(subResult.schema_id, null);
    assert.equal(subResult.schema_url, null);
  });

  test('unresolved_substitution step contributes to skipped_count not failed_count', async () => {
    const client = buildStubClient({
      get_signals: () => ({ success: true, data: { signals: [] } }),
    });
    const sb = makeStoryboard([
      {
        id: 'phase_capture',
        title: 'Capture',
        steps: [
          {
            id: 'get_sigs',
            title: 'Get signals',
            task: 'get_signals',
            sample_request: {},
            // capture_path_not_resolvable: signals[0] absent → seg_id never set
            context_outputs: [{ key: 'seg_id', path: 'signals[0].signal_agent_segment_id' }],
          },
          {
            id: 'activate_sig',
            title: 'Activate',
            task: 'activate_signal',
            sample_request: { signal_id: '$context.seg_id' },
            stateful: true,
          },
        ],
      },
    ]);
    const result = await runStoryboard('http://stub', sb, stubOpts(client));
    const captureStep = result.phases[0].steps.find(s => s.step_id === 'get_sigs');
    const skipStep = result.phases[0].steps.find(s => s.step_id === 'activate_sig');
    // Capture step grades failed (capture_path_not_resolvable)
    assert.equal(captureStep.passed, false);
    assert.ok(captureStep.validations.find(v => v.check === 'capture_path_not_resolvable'));
    // Consumer step grades skipped (unresolved_substitution)
    assert.equal(skipStep.skipped, true);
    assert.ok(skipStep.validations.find(v => v.check === 'unresolved_substitution'));
    // failed_count = 1 (capture step only), skipped_count = 1 (consumer step)
    assert.equal(result.failed_count, 1, 'only capture step should count as failed');
    assert.equal(result.skipped_count, 1, 'consumer step should count as skipped');
  });
});
