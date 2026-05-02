/**
 * Tests for runner-output-contract.yaml v2.0.0 behaviors:
 *   1. Forward-compat default — unknown check kinds grade `not_applicable`
 *   2. `capture_path_not_resolvable` — failures surfaced for null/""/absent paths
 *   3. `unresolved_substitution` — synthesized when consumer step skips
 *   4. `upstream_traffic` — controller-backed anti-façade assertion
 *
 * Tracking: adcp-client#1253 (spec PR adcontextprotocol/adcp#3816).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const { applyContextOutputsWithProvenance } = require('../../dist/lib/testing/storyboard/context');

// ────────────────────────────────────────────────────────────
// 1. Forward-compat default
// ────────────────────────────────────────────────────────────

describe('forward-compat default — unknown check kinds grade not_applicable', () => {
  test('unknown check kind grades passed: true with not_applicable: true', () => {
    const validations = [
      { check: 'some_future_check_added_in_a_later_spec', description: 'future check' },
    ];
    const ctx = {
      taskName: 'get_signals',
      taskResult: { success: true, data: {} },
      agentUrl: 'https://example.test',
      contributions: new Set(),
    };
    const [result] = runValidations(validations, ctx);
    assert.equal(result.passed, true);
    assert.equal(result.not_applicable, true);
    assert.equal(result.check, 'some_future_check_added_in_a_later_spec');
    assert.match(result.note, /forward compatibility/);
    assert.equal(result.json_pointer, null);
  });

  test('runner does not fail the step on unrecognized check', () => {
    const validations = [
      { check: 'response_schema', description: 'real check that should pass' },
      { check: 'unknown_check_xyz', description: 'forward-compat path' },
    ];
    // No response_schema_ref → response_schema check is graded as a no-op pass per existing semantics
    const ctx = {
      taskName: 'get_signals',
      taskResult: { success: true, data: { signals: [] } },
      agentUrl: 'https://example.test',
      contributions: new Set(),
    };
    const results = runValidations(validations, ctx);
    const unknown = results.find(r => r.check === 'unknown_check_xyz');
    assert.equal(unknown.passed, true);
    assert.equal(unknown.not_applicable, true);
  });
});

// ────────────────────────────────────────────────────────────
// 2. capture_path_not_resolvable
// ────────────────────────────────────────────────────────────

describe('applyContextOutputsWithProvenance — failures for null / "" / absent paths', () => {
  test('reports failure when path is structurally absent', () => {
    const outputs = [{ key: 'sid', path: 'signals[0].signal_agent_segment_id' }];
    const result = applyContextOutputsWithProvenance({ signals: [] }, outputs, 'step_1', 'get_signals');
    assert.equal(result.values.sid, undefined);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].key, 'sid');
    assert.equal(result.failures[0].path, 'signals[0].signal_agent_segment_id');
    assert.equal(result.failures[0].resolved, null);
  });

  test('reports failure when path resolves to null', () => {
    const outputs = [{ key: 'sid', path: 'signals[0].signal_agent_segment_id' }];
    const result = applyContextOutputsWithProvenance(
      { signals: [{ signal_agent_segment_id: null }] },
      outputs,
      'step_1',
      'get_signals'
    );
    assert.equal(result.values.sid, undefined);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].resolved, null);
  });

  test('reports failure when path resolves to empty string', () => {
    const outputs = [{ key: 'sid', path: 'signals[0].signal_agent_segment_id' }];
    const result = applyContextOutputsWithProvenance(
      { signals: [{ signal_agent_segment_id: '' }] },
      outputs,
      'step_1',
      'get_signals'
    );
    assert.equal(result.values.sid, undefined);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].resolved, '');
  });

  test('captures successfully when path resolves to a real value (no failures)', () => {
    const outputs = [{ key: 'sid', path: 'signals[0].signal_agent_segment_id' }];
    const result = applyContextOutputsWithProvenance(
      { signals: [{ signal_agent_segment_id: 'sas-1' }] },
      outputs,
      'step_1',
      'get_signals'
    );
    assert.equal(result.values.sid, 'sas-1');
    assert.equal(result.failures, undefined);
  });

  test('captures real value AND reports unrelated absent paths in same call', () => {
    const outputs = [
      { key: 'sid', path: 'signals[0].signal_agent_segment_id' },
      { key: 'missing', path: 'signals[0].does_not_exist' },
    ];
    const result = applyContextOutputsWithProvenance(
      { signals: [{ signal_agent_segment_id: 'sas-1' }] },
      outputs,
      'step_1',
      'get_signals'
    );
    assert.equal(result.values.sid, 'sas-1');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].key, 'missing');
  });

  test('generator entries do not appear in failures (cannot fail to resolve)', () => {
    const outputs = [{ key: 'opaque_id', generate: 'opaque_id' }];
    const ctx = {};
    const result = applyContextOutputsWithProvenance(undefined, outputs, 'step_1', 'create_x', ctx);
    assert.equal(typeof result.values.opaque_id, 'string');
    assert.equal(result.failures, undefined);
  });
});

// ────────────────────────────────────────────────────────────
// 3. upstream_traffic — controller-backed assertion
// ────────────────────────────────────────────────────────────

describe('upstream_traffic — controller-backed anti-façade assertion', () => {
  function makeCall(overrides = {}) {
    return {
      method: 'POST',
      endpoint: 'POST https://api.example.test/v1/audience/upload',
      url: 'https://api.example.test/v1/audience/upload',
      payload: {
        users: [{ hashed_email: 'a000000000000000000000000000000000000000000000000000000000000001' }],
      },
      timestamp: '2026-05-02T14:30:01.000Z',
      ...overrides,
    };
  }

  function ctxWithTraffic(payload, opts = {}) {
    return {
      taskName: 'sync_audiences',
      taskResult: { success: true, data: {} },
      agentUrl: 'https://example.test',
      contributions: new Set(),
      upstreamTraffic: {
        advertised: opts.advertised !== false,
        queries: new Map([['since', { request: { transport: 'mcp', operation: 'comply_test_controller', payload: {} }, response: { transport: 'mcp', payload }, payload }]]),
        thisStepSince: 'since',
      },
      ...(opts.storyboardStep && { storyboardStep: opts.storyboardStep }),
    };
  }

  test('grades not_applicable when controller does not advertise query_upstream_traffic', () => {
    const ctx = {
      taskName: 'sync_audiences',
      taskResult: { success: true, data: {} },
      agentUrl: 'https://example.test',
      contributions: new Set(),
      upstreamTraffic: {
        advertised: false,
        queries: new Map(),
        thisStepSince: 'since',
      },
    };
    const [result] = runValidations(
      [{ check: 'upstream_traffic', description: 'expects upstream traffic', min_count: 1 }],
      ctx
    );
    assert.equal(result.passed, true);
    assert.equal(result.not_applicable, true);
    assert.match(result.note, /query_upstream_traffic/);
  });

  test('passes when min_count satisfied and no other constraints', () => {
    const ctx = ctxWithTraffic({ success: true, recorded_calls: [makeCall()], total_count: 1 });
    const [result] = runValidations(
      [{ check: 'upstream_traffic', description: 'min 1 call', min_count: 1 }],
      ctx
    );
    assert.equal(result.passed, true);
    assert.equal(result.actual.matched_count, 1);
  });

  test('fails when zero recorded calls (façade signal — controller present, observed nothing)', () => {
    const ctx = ctxWithTraffic({ success: true, recorded_calls: [], total_count: 0 });
    const [result] = runValidations(
      [{ check: 'upstream_traffic', description: 'min 1 call', min_count: 1 }],
      ctx
    );
    assert.equal(result.passed, false);
    assert.equal(result.actual.matched_count, 0);
    assert.match(result.error, /at least 1 matching call/);
  });

  test('endpoint_pattern filters by glob', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 2,
      recorded_calls: [
        makeCall({ endpoint: 'GET https://api.example.test/v1/health' }),
        makeCall({ endpoint: 'POST https://api.example.test/v1/audience/upload' }),
      ],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'POST upload only',
          endpoint_pattern: 'POST *audience/upload',
          min_count: 1,
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
    assert.equal(result.actual.matched_count, 1);
    assert.equal(result.actual.total_calls, 2);
  });

  test('payload_must_contain present check fails when key absent in any matched call', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [makeCall({ payload: { users: [{ external_id: 'abc' }] } })],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'must carry hashed_email',
          payload_must_contain: [{ path: '$..hashed_email', match: 'present' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.actual.missing_payload_paths, ['$..hashed_email']);
  });

  test('payload_must_contain present check passes when at least one call carries the key', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [makeCall()],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'must carry hashed_email',
          payload_must_contain: [{ path: '$..hashed_email', match: 'present' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('buyer_identifier_echo fails when storyboard vector is not echoed', () => {
    const ctx = ctxWithTraffic(
      {
        success: true,
        total_count: 1,
        recorded_calls: [
          makeCall({ payload: { users: [{ hashed_email: 'placeholder_constant_not_from_storyboard' }] } }),
        ],
      },
      {
        storyboardStep: {
          sample_request: {
            users: [
              { hashed_email: 'a000000000000000000000000000000000000000000000000000000000000001' },
            ],
          },
        },
      }
    );
    const [result] = runValidations(
      [{ check: 'upstream_traffic', description: 'echo', buyer_identifier_echo: true }],
      ctx
    );
    assert.equal(result.passed, false);
    assert.equal(result.actual.identifier_echo_failures.length, 1);
  });

  test('buyer_identifier_echo passes when adapter echoes the storyboard vector', () => {
    const vector = 'a000000000000000000000000000000000000000000000000000000000000001';
    const ctx = ctxWithTraffic(
      {
        success: true,
        total_count: 1,
        recorded_calls: [makeCall({ payload: { users: [{ hashed_email: vector }] } })],
      },
      {
        storyboardStep: { sample_request: { users: [{ hashed_email: vector }] } },
      }
    );
    const [result] = runValidations(
      [{ check: 'upstream_traffic', description: 'echo', buyer_identifier_echo: true }],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('grades failed with controller request/response when controller-call errored', () => {
    const ctx = {
      taskName: 'sync_audiences',
      taskResult: { success: true, data: {} },
      agentUrl: 'https://example.test',
      contributions: new Set(),
      upstreamTraffic: {
        advertised: true,
        queries: new Map([
          [
            'since',
            {
              request: { transport: 'mcp', operation: 'comply_test_controller', payload: {} },
              response: { transport: 'mcp', payload: { error: 'INTERNAL_ERROR' } },
              payload: { error: 'INTERNAL_ERROR' },
            },
          ],
        ]),
        thisStepSince: 'since',
      },
    };
    const [result] = runValidations(
      [{ check: 'upstream_traffic', description: 'expect traffic', min_count: 1 }],
      ctx
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /query_upstream_traffic failed/);
    assert.ok(result.request);
    assert.ok(result.response);
  });

  test('expected echoes declared assertion fields', () => {
    const ctx = ctxWithTraffic({ success: true, recorded_calls: [makeCall()], total_count: 1 });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'declared',
          min_count: 2,
          endpoint_pattern: 'POST *',
          buyer_identifier_echo: true,
        },
      ],
      ctx
    );
    assert.equal(result.expected.min_count, 2);
    assert.equal(result.expected.endpoint_pattern, 'POST *');
    assert.equal(result.expected.buyer_identifier_echo, true);
  });
});
