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
const { applyContextOutputs, applyContextOutputsWithProvenance } = require('../../dist/lib/testing/storyboard/context');
const { isJsonContentType } = require('../../dist/lib/testing/test-controller');

// ────────────────────────────────────────────────────────────
// 1. Forward-compat default
// ────────────────────────────────────────────────────────────

describe('forward-compat default — unknown check kinds grade not_applicable', () => {
  test('unknown check kind grades passed: true with not_applicable: true', () => {
    const validations = [{ check: 'some_future_check_added_in_a_later_spec', description: 'future check' }];
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
// 2. capture_path_not_resolvable / null / "" / absent
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

describe('applyContextOutputs (non-provenance) — semantics aligned with v2.0.0', () => {
  test('drops null, undefined, AND "" — same gate as the provenance form', () => {
    const outputs = [
      { key: 'a', path: 'a' },
      { key: 'b', path: 'b' },
      { key: 'c', path: 'c' },
      { key: 'd', path: 'd' },
    ];
    const data = { a: 'real', b: null, c: '', d: undefined };
    const result = applyContextOutputs(data, outputs);
    assert.deepEqual(result, { a: 'real' });
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
      content_type: 'application/json',
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
        queries: new Map([
          [
            'since',
            {
              request: { transport: 'mcp', operation: 'comply_test_controller', payload: {} },
              response: { transport: 'mcp', payload },
              payload,
            },
          ],
        ]),
        thisStepSince: 'since',
        ...(opts.unresolvedSinceRefs && { unresolvedSinceRefs: opts.unresolvedSinceRefs }),
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
    const [result] = runValidations([{ check: 'upstream_traffic', description: 'min 1 call', min_count: 1 }], ctx);
    assert.equal(result.passed, true);
    assert.equal(result.actual.matched_count, 1);
  });

  test('fails when zero recorded calls (façade signal — controller present, observed nothing)', () => {
    const ctx = ctxWithTraffic({ success: true, recorded_calls: [], total_count: 0 });
    const [result] = runValidations([{ check: 'upstream_traffic', description: 'min 1 call', min_count: 1 }], ctx);
    assert.equal(result.passed, false);
    assert.equal(result.actual.matched_count, 0);
    assert.match(result.error, /at least 1 matching call/);
  });

  test('endpoint_pattern filters by glob (* matches /)', () => {
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

  test('endpoint_pattern escapes ? as a literal (not 0-or-1 quantifier)', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 2,
      recorded_calls: [
        makeCall({ endpoint: 'POST https://api.example.test/v1/audience/uploadcohort=1' }),
        makeCall({ endpoint: 'POST https://api.example.test/v1/audience/upload?cohort=1' }),
      ],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'literal ? in pattern',
          endpoint_pattern: 'POST *audience/upload?cohort=1',
          min_count: 1,
        },
      ],
      ctx
    );
    // The literal-? pattern should match exactly one call (the one with `?`),
    // not both (which would be the broken regex-quantifier behavior).
    assert.equal(result.actual.matched_count, 1);
  });

  test('payload_must_contain match: present — fails when key absent in any matched call', () => {
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
          payload_must_contain: [{ path: 'users[*].hashed_email', match: 'present' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.actual.missing_payload_paths, ['users[*].hashed_email']);
  });

  test('payload_must_contain match: present — passes when at least one call carries the key', () => {
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
          payload_must_contain: [{ path: 'users[*].hashed_email', match: 'present' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('payload_must_contain match: equals — passes on JSON content_type when path resolves to expected value', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [makeCall({ payload: { advertiser_id: '1234567890', users: [] } })],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'advertiser id equals',
          payload_must_contain: [{ path: 'advertiser_id', match: 'equals', value: '1234567890' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('payload_must_contain match: equals — fails when value differs', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [makeCall({ payload: { advertiser_id: 'wrong-id', users: [] } })],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'advertiser id equals',
          payload_must_contain: [{ path: 'advertiser_id', match: 'equals', value: '1234567890' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.actual.missing_payload_paths, ['advertiser_id']);
  });

  test('payload_must_contain match: contains_any — passes when one of allowed_values matches', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [makeCall({ payload: { region: 'us-east', users: [] } })],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'region in allowlist',
          payload_must_contain: [{ path: 'region', match: 'contains_any', allowed_values: ['us-east', 'us-west'] }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('payload_must_contain match: contains_any — fails when none of allowed_values match', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [makeCall({ payload: { region: 'eu-central', users: [] } })],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'region in allowlist',
          payload_must_contain: [{ path: 'region', match: 'contains_any', allowed_values: ['us-east', 'us-west'] }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
  });

  test('non-JSON content_type + match: present — substring fallback against terminal path key', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [
        makeCall({
          content_type: 'application/x-www-form-urlencoded',
          payload: 'advertiser_id=123&hashed_email=abc',
        }),
      ],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'present in form-encoded body',
          payload_must_contain: [{ path: 'users[*].hashed_email', match: 'present' }],
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('non-JSON content_type + match: equals — grades not_applicable, validation passes overall', () => {
    const ctx = ctxWithTraffic({
      success: true,
      total_count: 1,
      recorded_calls: [
        makeCall({
          content_type: 'application/x-www-form-urlencoded',
          payload: 'advertiser_id=123',
        }),
      ],
    });
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'equals impossible on non-JSON',
          payload_must_contain: [{ path: 'advertiser_id', match: 'equals', value: '123' }],
        },
      ],
      ctx
    );
    // The whole validation is graded not_applicable when every declared
    // path-based assertion downgraded to non-JSON-skip and count + echo passed.
    assert.equal(result.passed, true);
    assert.equal(result.not_applicable, true);
    assert.match(result.note, /non-JSON content_types/);
  });

  test('identifier_paths fails when storyboard vector is not echoed', () => {
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
            audiences: [
              {
                add: [{ hashed_email: 'a000000000000000000000000000000000000000000000000000000000000001' }],
              },
            ],
          },
        },
      }
    );
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'echo identifier paths',
          identifier_paths: ['audiences[*].add[*].hashed_email'],
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
    assert.equal(result.actual.missing_identifier_values.length, 1);
    assert.equal(
      result.actual.missing_identifier_values[0],
      'a000000000000000000000000000000000000000000000000000000000000001'
    );
  });

  test('identifier_paths passes when adapter echoes the storyboard vector', () => {
    const vector = 'a000000000000000000000000000000000000000000000000000000000000001';
    const ctx = ctxWithTraffic(
      {
        success: true,
        total_count: 1,
        recorded_calls: [makeCall({ payload: { users: [{ hashed_email: vector }] } })],
      },
      {
        storyboardStep: {
          sample_request: { audiences: [{ add: [{ hashed_email: vector }] }] },
        },
      }
    );
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'echo identifier paths',
          identifier_paths: ['audiences[*].add[*].hashed_email'],
        },
      ],
      ctx
    );
    assert.equal(result.passed, true);
  });

  test('identifier_paths fails when ANY resolved value is missing (anti-fabrication)', () => {
    const v1 = 'vec_real_1';
    const v2 = 'vec_real_2';
    const ctx = ctxWithTraffic(
      {
        success: true,
        total_count: 1,
        recorded_calls: [
          makeCall({ payload: { users: [{ hashed_email: v1 }] } }), // only v1, not v2
        ],
      },
      {
        storyboardStep: {
          sample_request: {
            audiences: [{ add: [{ hashed_email: v1 }, { hashed_email: v2 }] }],
          },
        },
      }
    );
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'all values must echo',
          identifier_paths: ['audiences[*].add[*].hashed_email'],
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
    assert.deepEqual(result.actual.missing_identifier_values, [v2]);
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
    const [result] = runValidations([{ check: 'upstream_traffic', description: 'expect traffic', min_count: 1 }], ctx);
    assert.equal(result.passed, false);
    assert.match(result.error, /query_upstream_traffic failed/);
    assert.ok(result.request);
    assert.ok(result.response);
  });

  test('truncates oversized controller error in validation_result.error', () => {
    const huge = 'x'.repeat(5000);
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
              response: { transport: 'mcp', payload: { error: huge } },
              payload: { error: huge },
            },
          ],
        ]),
        thisStepSince: 'since',
      },
    };
    const [result] = runValidations([{ check: 'upstream_traffic', description: 'expect traffic', min_count: 1 }], ctx);
    assert.ok(result.error.length <= 2050);
    assert.match(result.error, /\[truncated\]/);
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
          identifier_paths: ['audiences[*].hashed_email'],
        },
      ],
      ctx
    );
    assert.equal(result.expected.min_count, 2);
    assert.equal(result.expected.endpoint_pattern, 'POST *');
    assert.deepEqual(result.expected.identifier_paths, ['audiences[*].hashed_email']);
  });

  test('unresolved since: prior_step_id grades failed loudly (not silent fallback)', () => {
    const ctx = ctxWithTraffic(
      { success: true, recorded_calls: [makeCall()], total_count: 1 },
      { unresolvedSinceRefs: new Set(['nonexistent_step']) }
    );
    const [result] = runValidations(
      [
        {
          check: 'upstream_traffic',
          description: 'cumulative since prior step',
          since: 'nonexistent_step',
          min_count: 1,
        },
      ],
      ctx
    );
    assert.equal(result.passed, false);
    assert.match(result.error, /nonexistent_step/);
    assert.match(result.error, /did not resolve/);
  });
});

// ────────────────────────────────────────────────────────────
// 4. isJsonContentType helper
// ────────────────────────────────────────────────────────────

describe('isJsonContentType — JSON content_type gate', () => {
  test('accepts application/json', () => {
    assert.equal(isJsonContentType('application/json'), true);
  });
  test('accepts application/json with charset', () => {
    assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
  });
  test('accepts +json suffixed types (e.g. ld+json, vnd.api+json)', () => {
    assert.equal(isJsonContentType('application/ld+json'), true);
    assert.equal(isJsonContentType('application/vnd.api+json'), true);
  });
  test('rejects form-urlencoded', () => {
    assert.equal(isJsonContentType('application/x-www-form-urlencoded'), false);
  });
  test('rejects multipart/form-data', () => {
    assert.equal(isJsonContentType('multipart/form-data; boundary=---'), false);
  });
  test('rejects undefined / empty', () => {
    assert.equal(isJsonContentType(undefined), false);
    assert.equal(isJsonContentType(''), false);
  });
});
