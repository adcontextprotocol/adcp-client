/**
 * runStoryboardStep: context-provenance threading across stateless calls
 * (adcp-client#880).
 *
 * The stateless single-step primitive is the core of LLM-friendly step-by-
 * step orchestration. Before #880 it initialized a fresh empty provenance
 * map each call, so hints from #870 / #875 never fired on that surface
 * even when the caller threaded `context` across calls. This test pins
 * the round-trip: `StoryboardRunOptions.context_provenance` in →
 * `StoryboardStepResult.context_provenance` out → feed back into the next
 * call → hints emit on the rejection step.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboardStep } = require('../../dist/lib/testing/storyboard/runner');

// Minimal stub that mimics the AdcpClient surface `executeStoryboardTask`
// expects: typed methods by camelCase name (TASK_TO_METHOD), a getAgentInfo
// for profile discovery if needed. Returns deterministic task results the
// test controls per invocation.
function buildStubClient(handlers) {
  return {
    getAgentInfo: async () => ({
      name: 'stub',
      tools: Object.keys(handlers).map(name => ({ name })),
    }),
    // Runner prefers typed methods when TASK_TO_METHOD has an entry; falls
    // back to executeTask otherwise. Covering both avoids branching on
    // whether the task we pick is in the map.
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

const twoStepStoryboard = {
  id: 'prov_threading_sb',
  version: '1.0.0',
  title: 'Provenance threading',
  category: 'test',
  summary: '',
  narrative: '',
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [
    {
      id: 'p1',
      title: 'phase 1',
      steps: [
        {
          id: 'search',
          title: 'search signals',
          task: 'get_signals',
          sample_request: { signal_spec: 'bogus' },
          context_outputs: [
            { key: 'first_signal_id', path: 'signals[0].signal_agent_segment_id' },
            { key: 'first_signal_pricing_option_id', path: 'signals[0].pricing_options[0].pricing_option_id' },
          ],
        },
        {
          id: 'activate',
          title: 'activate signal',
          task: 'activate_signal',
          sample_request: {
            signal_agent_segment_id: '$context.first_signal_id',
            pricing_option_id: '$context.first_signal_pricing_option_id',
          },
          // Note: deliberately NOT `expect_error` — we want the step to
          // fail so the hint gate (!passed) opens. An expect_error step
          // treats seller rejection as a PASS and silences hints by design.
        },
      ],
    },
  ],
};

const searchResponse = {
  signals: [
    {
      signal_agent_segment_id: 'sig_prism_abandoner',
      pricing_options: [{ pricing_option_id: 'po_prism_abandoner_cpm' }],
    },
  ],
};

const activateRejection = {
  errors: [
    {
      code: 'INVALID_PRICING_MODEL',
      message: 'Pricing option not found: po_prism_abandoner_cpm',
      field: 'pricing_option_id',
      details: { available: ['po_prism_cart_cpm'] },
    },
  ],
};

describe('runStoryboardStep: context-provenance threading (#880)', () => {
  test('step 1 result carries context_provenance shaped for threading', async () => {
    const client = buildStubClient({
      get_signals: async () => ({ success: true, data: searchResponse }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'search', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['get_signals', 'activate_signal'],
      _client: client,
      _profile: stubProfile,
    });
    assert.equal(r1.passed, true, 'step 1 should pass');
    assert.ok(r1.context_provenance, 'result carries context_provenance');
    assert.equal(r1.context_provenance.first_signal_pricing_option_id.source_step_id, 'search');
    assert.equal(r1.context_provenance.first_signal_pricing_option_id.source_kind, 'context_outputs');
    assert.equal(
      r1.context_provenance.first_signal_pricing_option_id.response_path,
      'signals[0].pricing_options[0].pricing_option_id'
    );
    assert.equal(r1.context.first_signal_pricing_option_id, 'po_prism_abandoner_cpm');
  });

  test('threading context + provenance → step 2 emits context_value_rejected hint', async () => {
    const client = buildStubClient({
      get_signals: async () => ({ success: true, data: searchResponse }),
      activate_signal: async () => ({ success: false, data: activateRejection }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'search', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['get_signals', 'activate_signal'],
      _client: client,
      _profile: stubProfile,
    });
    const r2 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'activate', {
      protocol: 'mcp',
      allow_http: true,
      agentTools: ['get_signals', 'activate_signal'],
      _client: client,
      _profile: stubProfile,
      context: r1.context,
      context_provenance: r1.context_provenance,
    });

    assert.ok(Array.isArray(r2.hints) && r2.hints.length === 1, `expected one hint, got ${JSON.stringify(r2.hints)}`);
    const [hint] = r2.hints;
    assert.equal(hint.kind, 'context_value_rejected');
    assert.equal(hint.context_key, 'first_signal_pricing_option_id');
    assert.equal(hint.source_step_id, 'search');
    assert.equal(hint.rejected_value, 'po_prism_abandoner_cpm');
    assert.deepEqual(hint.accepted_values, ['po_prism_cart_cpm']);
  });

  test('WITHOUT threading provenance → no hint even when context threaded', async () => {
    // Regression guard: proves the threading is load-bearing. Threading
    // only `context` (without `context_provenance`) matches how callers
    // wrote step-by-step orchestration before #880 — they shouldn't
    // silently lose hints once they migrate, but they won't GET hints
    // until they also thread provenance. Pinning that contract.
    const client = buildStubClient({
      get_signals: async () => ({ success: true, data: searchResponse }),
      activate_signal: async () => ({ success: false, data: activateRejection }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'search', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    const r2 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'activate', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      context: r1.context,
      // context_provenance intentionally omitted
    });
    assert.equal(r2.hints, undefined, 'no hints without provenance threading');
  });

  test('threaded provenance round-trips unchanged when this step writes nothing', async () => {
    // `runStoryboardStep` accumulates writes into its own map seeded from
    // the options, then emits the full accumulated map. If step 2 writes
    // nothing (common for mutating failures), the map should still reflect
    // what step 1 wrote — otherwise callers can't continue threading
    // across step 3+.
    const client = buildStubClient({
      get_signals: async () => ({ success: true, data: searchResponse }),
      activate_signal: async () => ({ success: false, data: activateRejection }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'search', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    const r2 = await runStoryboardStep('https://stub.example/mcp', twoStepStoryboard, 'activate', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      context: r1.context,
      context_provenance: r1.context_provenance,
    });
    assert.ok(r2.context_provenance, 'provenance is surfaced on step 2 result');
    assert.equal(
      r2.context_provenance.first_signal_pricing_option_id.source_step_id,
      'search',
      'step 1 provenance preserved through step 2'
    );
  });
});
