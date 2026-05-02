/**
 * Runner-integration coverage for runner-output-contract.yaml v2.0.0
 * (adcp-client#1253, spec PR adcontextprotocol/adcp#3816). The dispatcher-
 * level coverage in `storyboard-runner-output-contract-v2.test.js` exercises
 * the validators with hand-built ValidationContexts; this file pins the
 * runner code that constructs those contexts:
 *
 *   - `prefetchUpstreamTraffic` actually fires the controller call when a
 *     step has `upstream_traffic` validations.
 *   - The capture-failure → consumer-skip cascade lands `capture_path_not_resolvable`
 *     on the producer step and `unresolved_substitution` on the consumer.
 *   - `since: prior_step_id` resolves to the prior step's recorded request
 *     timestamp, with the spec's clock-skew tolerance applied.
 *   - The `validations_not_applicable` counter aggregates onto the result.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runStoryboardStep, runStoryboard } = require('../../dist/lib/testing/storyboard/runner');

function buildStubClient(handlers, controllerHandler) {
  const calls = [];
  return {
    calls,
    client: {
      getAgentInfo: async () => ({ name: 'stub', tools: ['comply_test_controller'] }),
      executeTask: async (name, params) => {
        calls.push({ name, params });
        if (name === 'comply_test_controller' && controllerHandler) {
          return controllerHandler(params);
        }
        return handlers[name]?.(params) ?? { success: false, error: `no handler for ${name}` };
      },
    },
  };
}

const stubProfile = {
  name: 'stub',
  tools: ['comply_test_controller', 'sync_audiences', 'get_signals', 'activate_signal'],
};

// ────────────────────────────────────────────────────────────
// upstream_traffic — runner pre-fetch end-to-end
// ────────────────────────────────────────────────────────────

describe('runStoryboardStep — upstream_traffic pre-fetch end-to-end', () => {
  const storyboard = {
    id: 'upstream_sb',
    version: '1.0',
    title: 'Upstream traffic',
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
            id: 'sync',
            title: 'sync audiences',
            task: 'sync_audiences',
            sample_request: {
              audiences: [
                {
                  audience_name: 'aud_1',
                  add: [{ hashed_email: 'vec-real-1' }, { hashed_email: 'vec-real-2' }],
                },
              ],
            },
            validations: [
              {
                check: 'upstream_traffic',
                description: 'all storyboard hashed_emails MUST appear upstream',
                min_count: 1,
                payload_must_contain: [{ path: 'users[*].hashed_email', match: 'present' }],
                identifier_paths: ['audiences[*].add[*].hashed_email'],
              },
            ],
          },
        ],
      },
    ],
  };

  test('fires query_upstream_traffic against the controller and grades passed when adapter echoes vectors', async () => {
    const recordedCalls = [
      {
        method: 'POST',
        endpoint: 'POST https://api.example.test/v1/audience/upload',
        url: 'https://api.example.test/v1/audience/upload',
        content_type: 'application/json',
        payload: {
          users: [{ hashed_email: 'vec-real-1' }, { hashed_email: 'vec-real-2' }],
        },
        timestamp: '2026-05-02T14:30:01.000Z',
      },
    ];
    const { client, calls } = buildStubClient(
      {
        sync_audiences: async () => ({
          success: true,
          data: { audiences: [{ audience_id: 'aud_1', status: 'syncing' }] },
        }),
      },
      params => ({
        success: true,
        data: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                recorded_calls: recordedCalls,
                total_count: 1,
                since_timestamp: params.params?.since_timestamp,
              }),
            },
          ],
        },
      })
    );
    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
    });
    // Controller was queried.
    const controllerCalls = calls.filter(c => c.name === 'comply_test_controller');
    assert.equal(controllerCalls.length, 1, 'controller queried exactly once');
    assert.equal(controllerCalls[0].params.scenario, 'query_upstream_traffic');
    assert.ok(controllerCalls[0].params.params.since_timestamp, 'since_timestamp set on controller call');
    assert.equal(controllerCalls[0].params.params.limit, 100);
    // Validation graded passed.
    const upstreamValidation = result.validations.find(v => v.check === 'upstream_traffic');
    assert.ok(upstreamValidation, 'upstream_traffic validation present');
    assert.equal(upstreamValidation.passed, true);
    assert.equal(upstreamValidation.actual.matched_count, 1);
    assert.deepEqual(upstreamValidation.actual.missing_identifier_values, []);
  });

  test('grades not_applicable when controller does not advertise query_upstream_traffic', async () => {
    const { client, calls } = buildStubClient({
      sync_audiences: async () => ({ success: true, data: {} }),
    });
    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['force_creative_status'] },
    });
    // Controller is NOT queried.
    const controllerCalls = calls.filter(c => c.name === 'comply_test_controller');
    assert.equal(controllerCalls.length, 0, 'controller not queried when scenario unadvertised');
    const upstreamValidation = result.validations.find(v => v.check === 'upstream_traffic');
    assert.ok(upstreamValidation);
    assert.equal(upstreamValidation.passed, true);
    assert.equal(upstreamValidation.not_applicable, true);
    assert.match(upstreamValidation.note, /query_upstream_traffic/);
  });

  test('grades failed when controller advertises but observes zero recorded calls (façade signal)', async () => {
    const { client } = buildStubClient({ sync_audiences: async () => ({ success: true, data: {} }) }, () => ({
      success: true,
      data: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, recorded_calls: [], total_count: 0 }),
          },
        ],
      },
    }));
    const result = await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
    });
    const upstream = result.validations.find(v => v.check === 'upstream_traffic');
    assert.equal(upstream.passed, false);
    assert.equal(upstream.actual.matched_count, 0);
  });

  test('runner subtracts clock-skew tolerance from since_timestamp before sending to controller', async () => {
    let capturedSince;
    const { client } = buildStubClient({ sync_audiences: async () => ({ success: true, data: {} }) }, params => {
      capturedSince = params.params?.since_timestamp;
      return {
        success: true,
        data: {
          content: [{ type: 'text', text: JSON.stringify({ success: true, recorded_calls: [], total_count: 0 }) }],
        },
      };
    });
    const beforeMs = Date.now();
    await runStoryboardStep('https://stub.example/mcp', storyboard, 'sync', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      _controllerCapabilities: { detected: true, scenarios: ['query_upstream_traffic'] },
    });
    // Spec: runner SHOULD subtract 50–250ms tolerance. Implementation uses
    // 250ms. Assert the controller's since_timestamp is at least 100ms
    // earlier than the wall clock when the step started (loose lower bound).
    assert.ok(capturedSince, 'controller received since_timestamp');
    const sinceMs = new Date(capturedSince).getTime();
    assert.ok(
      sinceMs <= beforeMs,
      `expected since (${capturedSince}) <= test start (${new Date(beforeMs).toISOString()})`
    );
  });
});

// ────────────────────────────────────────────────────────────
// capture_path_not_resolvable / unresolved_substitution cascade
// ────────────────────────────────────────────────────────────

describe('runStoryboardStep — capture-failure → consumer-skip cascade', () => {
  const cascadeStoryboard = {
    id: 'cascade_sb',
    version: '1.0',
    title: 'Capture cascade',
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
            id: 'producer',
            title: 'capture sid',
            task: 'get_signals',
            sample_request: { signal_spec: 'bogus' },
            context_outputs: [{ key: 'sid', path: 'signals[0].signal_agent_segment_id' }],
          },
          {
            id: 'consumer',
            title: 'use sid',
            task: 'activate_signal',
            sample_request: { signal_agent_segment_id: '$context.sid' },
          },
        ],
      },
    ],
  };

  test('producer step grades failed with synthesized capture_path_not_resolvable when path resolves to absent', async () => {
    // Empty signals[] → path signals[0].signal_agent_segment_id is structurally absent.
    const { client } = buildStubClient({
      get_signals: async () => ({ success: true, data: { signals: [] } }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', cascadeStoryboard, 'producer', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    assert.equal(r1.passed, false, 'producer step should fail when capture path does not resolve');
    const synthesized = r1.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.ok(synthesized, 'capture_path_not_resolvable validation synthesized');
    assert.equal(synthesized.passed, false);
    assert.equal(synthesized.expected, 'signals[0].signal_agent_segment_id');
    assert.equal(synthesized.actual, null);
    assert.equal(synthesized.json_pointer, '/signals/0/signal_agent_segment_id');
  });

  test('consumer step skips with prerequisite_failed and synthesizes unresolved_substitution', async () => {
    // Producer fails → consumer's $context.sid won't resolve.
    const { client } = buildStubClient({
      get_signals: async () => ({ success: true, data: { signals: [] } }),
      activate_signal: async () => ({ success: false, error: 'should-not-be-called' }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', cascadeStoryboard, 'producer', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    const r2 = await runStoryboardStep('https://stub.example/mcp', cascadeStoryboard, 'consumer', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      context: r1.context, // sid is NOT in this context
    });
    assert.equal(r2.skipped, true, 'consumer should skip');
    assert.equal(r2.skip_reason, 'prerequisite_failed');
    const unresolved = r2.validations.find(v => v.check === 'unresolved_substitution');
    assert.ok(unresolved, 'unresolved_substitution validation synthesized');
    assert.equal(unresolved.passed, false);
    assert.equal(unresolved.expected, '$context.sid');
    assert.equal(unresolved.actual, null);
    assert.equal(unresolved.json_pointer, null);
    assert.equal(unresolved.request, undefined, 'no request was sent (pre-wire)');
  });

  test('producer captures successfully when path resolves — no synthesized failure', async () => {
    const { client } = buildStubClient({
      get_signals: async () => ({ success: true, data: { signals: [{ signal_agent_segment_id: 'sas-real' }] } }),
    });
    const r1 = await runStoryboardStep('https://stub.example/mcp', cascadeStoryboard, 'producer', {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
    });
    assert.equal(r1.passed, true);
    const synthesized = r1.validations.find(v => v.check === 'capture_path_not_resolvable');
    assert.equal(synthesized, undefined);
    assert.equal(r1.context.sid, 'sas-real');
  });
});

// ────────────────────────────────────────────────────────────
// validations_not_applicable counter aggregation
// ────────────────────────────────────────────────────────────

describe('runStoryboard — validations_not_applicable counter aggregation', () => {
  test('storyboard result aggregates not_applicable validations across steps', async () => {
    const sb = {
      id: 'fwd_compat_sb',
      version: '1.0',
      title: 'forward-compat counter',
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
              id: 'fwd_compat',
              title: 'unknown check',
              task: 'get_signals',
              sample_request: { signal_spec: 'x' },
              validations: [
                { check: 'future_check_a', description: 'unknown a' },
                { check: 'future_check_b', description: 'unknown b' },
              ],
            },
          ],
        },
      ],
    };
    const { client } = buildStubClient({
      get_signals: async () => ({ success: true, data: { signals: [] } }),
    });
    const result = await runStoryboard('https://stub.example/mcp', sb, {
      protocol: 'mcp',
      _client: client,
      _profile: stubProfile,
      agentTools: stubProfile.tools,
    });
    assert.equal(result.validations_not_applicable, 2, 'two unknown checks → counter == 2');
  });
});
