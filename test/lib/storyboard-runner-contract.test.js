/**
 * Runner-output contract conformance tests.
 *
 * Asserts the shape defined in
 * `static/compliance/source/universal/runner-output-contract.yaml`
 * (adcontextprotocol/adcp PR #2364). These tests verify validation results
 * and skip results carry the actionable detail implementors need to
 * diagnose failures — request/response bytes, RFC 6901 `json_pointer`,
 * machine-readable `expected`/`actual`, and for `response_schema` checks
 * the `schema_id` + resolvable `schema_url`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert');

const { runValidations } = require('../../dist/lib/testing/storyboard/validations');
const { toJsonPointer } = require('../../dist/lib/testing/storyboard/path');
const {
  __redactSecretsForTest: redactSecrets,
  __filterResponseHeadersForTest: filterResponseHeaders,
} = require('../../dist/lib/testing/storyboard/runner');

function runOne(validation, overrides = {}) {
  return runValidations([validation], {
    taskName: overrides.taskName ?? 'get_products',
    taskResult: overrides.taskResult,
    httpResult: overrides.httpResult,
    agentUrl: overrides.agentUrl ?? 'https://example.com/mcp',
    contributions: overrides.contributions ?? new Set(),
    responseSchemaRef: overrides.responseSchemaRef,
    request: overrides.request,
    response: overrides.response,
  })[0];
}

describe('runner-output contract: validation_result', () => {
  test('field_present failure carries json_pointer, expected, actual', () => {
    const result = runOne(
      { check: 'field_present', path: 'accounts[0].account_id', description: 'account_id is present' },
      { taskResult: { success: true, data: { accounts: [{}] } } }
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/accounts/0/account_id');
    assert.strictEqual(result.expected, 'accounts[0].account_id');
    assert.strictEqual(result.actual, null);
  });

  test('field_value failure carries json_pointer, structured expected/actual', () => {
    const result = runOne(
      { check: 'field_value', path: 'status', value: 'active', description: 'status == active' },
      { taskResult: { success: true, data: { status: 'paused' } } }
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, '/status');
    assert.strictEqual(result.expected, 'active');
    assert.strictEqual(result.actual, 'paused');
  });

  test('field_value allowed_values failure exposes the enumeration as expected', () => {
    const result = runOne(
      {
        check: 'field_value',
        path: 'status',
        allowed_values: ['active', 'paused'],
        description: 'status in active|paused',
      },
      { taskResult: { success: true, data: { status: 'canceled' } } }
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, ['active', 'paused']);
    assert.strictEqual(result.actual, 'canceled');
  });

  describe('field_value_or_absent', () => {
    test('passes when the field is absent', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'replayed',
          allowed_values: [false],
          description: 'replayed is either absent or false on fresh execution',
        },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.json_pointer, '/replayed');
      assert.strictEqual(result.check, 'field_value_or_absent');
    });

    test('passes when present and in allowed_values', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'replayed',
          allowed_values: [false],
          description: 'replayed is either absent or false on fresh execution',
        },
        { taskResult: { success: true, data: { replayed: false } } }
      );
      assert.strictEqual(result.passed, true);
    });

    test('fails when present with a disallowed value', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'replayed',
          allowed_values: [false],
          description: 'replayed is either absent or false on fresh execution',
        },
        { taskResult: { success: true, data: { replayed: true } } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.json_pointer, '/replayed');
      assert.deepStrictEqual(result.expected, [false]);
      assert.strictEqual(result.actual, true);
    });

    test('with scalar value fails only on present-mismatch', () => {
      const present = runOne(
        {
          check: 'field_value_or_absent',
          path: 'status',
          value: 'active',
          description: 'status is either absent or active',
        },
        { taskResult: { success: true, data: { status: 'paused' } } }
      );
      assert.strictEqual(present.passed, false);
      assert.strictEqual(present.expected, 'active');
      assert.strictEqual(present.actual, 'paused');

      const absent = runOne(
        {
          check: 'field_value_or_absent',
          path: 'status',
          value: 'active',
          description: 'status is either absent or active',
        },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(absent.passed, true);
    });

    test('with a null field fails (null is present, not absent)', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'replayed',
          allowed_values: [false],
          description: 'replayed is either absent or false',
        },
        { taskResult: { success: true, data: { replayed: null } } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.actual, null);
    });

    // `resolvePath` returns `undefined` whether the key is truly missing or
    // present with an explicit `undefined` value (JSON cannot encode this case
    // anyway, but native handlers can produce it). The matcher treats both
    // the same — absent semantics win. Pinning this disambiguates for any
    // implementor walking the runner against a non-JSON transport.
    test('treats an explicit `undefined` value the same as a missing key', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'replayed',
          allowed_values: [false],
          description: 'replayed is either absent or false',
        },
        { taskResult: { success: true, data: { replayed: undefined } } }
      );
      assert.strictEqual(result.passed, true);
    });

    // A broken chain mid-path (intermediate segment missing) resolves to
    // `undefined`, which the matcher routes to the absent-passes branch.
    // Same outcome as the leaf being missing — the whole chain "is absent."
    test('broken chain in the middle of the path is treated as absent', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'envelope.status.replayed',
          allowed_values: [false],
          description: 'envelope.status.replayed is either absent or false',
        },
        { taskResult: { success: true, data: { envelope: {} } } }
      );
      assert.strictEqual(result.passed, true);
    });

    // Empty `allowed_values` falls through to the scalar `value` branch, same
    // as `field_value`. With neither set, the matcher compares against
    // `undefined`. Storyboards shouldn't emit this shape, but pinning the
    // behavior means a silent authoring bug surfaces as a failing check
    // rather than silently passing.
    test('empty allowed_values falls through to `value` comparison (same as field_value)', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: 'status',
          allowed_values: [],
          value: 'active',
          description: 'status is either absent or active',
        },
        { taskResult: { success: true, data: { status: 'active' } } }
      );
      assert.strictEqual(result.passed, true);
    });

    test('missing `path` returns a structured error', () => {
      const result = runOne(
        { check: 'field_value_or_absent', allowed_values: [false], description: 'no path supplied' },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.json_pointer, null);
      assert.match(result.error, /No path specified for field_value_or_absent/);
    });
  });

  // Prototype-key guard on the scalar resolver: `__proto__`, `constructor`,
  // and `prototype` must not surface `Object.prototype` state into validation
  // results. Asserting through `field_present` / `field_value` / the tolerant
  // matcher exercises all three matchers' call into `resolvePath`, so a
  // regression here would fail on any of them.
  describe('resolvePath prototype-key guard', () => {
    test('field_present on __proto__ returns not-found', () => {
      const result = runOne(
        { check: 'field_present', path: '__proto__', description: 'prototype must not surface' },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.actual, null);
    });

    test('field_present on a nested __proto__ segment returns not-found', () => {
      const result = runOne(
        { check: 'field_present', path: 'accounts.__proto__.polluted', description: 'nested prototype' },
        { taskResult: { success: true, data: { accounts: {} } } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.actual, null);
    });

    test('field_value on constructor returns not-found, not Object itself', () => {
      const result = runOne(
        { check: 'field_value', path: 'constructor', value: 'anything', description: 'constructor ≠ Object' },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.actual, null);
    });

    test('field_value_or_absent on __proto__ passes (treated as absent)', () => {
      const result = runOne(
        {
          check: 'field_value_or_absent',
          path: '__proto__',
          allowed_values: [false],
          description: 'prototype chain is absent from the agent response',
        },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(result.passed, true);
    });

    // Inherited-but-own-named keys (e.g. `hasOwnProperty` on a plain object)
    // also must not surface — the guard is hasOwnProperty, not just the
    // forbidden-list.
    test('field_present on an inherited method name returns not-found', () => {
      const result = runOne(
        { check: 'field_present', path: 'hasOwnProperty', description: 'inherited methods must not surface' },
        { taskResult: { success: true, data: {} } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.actual, null);
    });

    // Own properties named like prototype accessors are also blocked by
    // FORBIDDEN_KEYS — the guard errs on the side of safety over an esoteric
    // "I literally have a field named __proto__" storyboard.
    test('field_value on an own-property `__proto__` is still blocked', () => {
      const data = Object.create(null);
      Object.defineProperty(data, '__proto__', { value: { x: 1 }, enumerable: true, configurable: true });
      const result = runOne(
        { check: 'field_value', path: '__proto__.x', value: 1, description: 'forbidden-key takes precedence' },
        { taskResult: { success: true, data } }
      );
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.actual, null);
    });
  });

  test('response_schema failure carries schema_id, schema_url, AJV-shaped actual', () => {
    const result = runOne(
      { check: 'response_schema', description: 'Response matches get-adcp-capabilities-response.json schema' },
      {
        taskName: 'get_adcp_capabilities',
        responseSchemaRef: 'protocol/get-adcp-capabilities-response.json',
        taskResult: { success: true, data: { adcp: {} /* missing required fields */ } },
      }
    );
    assert.strictEqual(result.passed, false);
    assert.ok(result.schema_id, 'schema_id must be set on response_schema failure');
    assert.ok(result.schema_id.endsWith('/protocol/get-adcp-capabilities-response.json'));
    assert.ok(
      result.schema_url && result.schema_url.startsWith('https://'),
      'schema_url must be a resolvable https URL'
    );
    assert.ok(Array.isArray(result.actual), 'actual must be an array of schema errors');
    for (const issue of result.actual) {
      assert.strictEqual(typeof issue.instance_path, 'string');
      assert.strictEqual(typeof issue.schema_path, 'string');
      // schema_path is a schema-pointer, not the raw keyword — prefix rules
      // out the bug where the two fields collapsed to the same value.
      assert.ok(issue.schema_path.startsWith('#/'), 'schema_path is a JSON pointer into the schema');
      assert.strictEqual(typeof issue.keyword, 'string');
      assert.strictEqual(typeof issue.message, 'string');
    }
  });

  test('response_schema with no registered schema returns structured actual', () => {
    const result = runOne(
      { check: 'response_schema', description: 'Response matches schema' },
      {
        taskName: 'totally_unknown_tool_xyz',
        responseSchemaRef: 'unknown/totally-unknown.json',
        taskResult: { success: true, data: {} },
      }
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.actual, { reason: 'no_schema_registered', task: 'totally_unknown_tool_xyz' });
  });

  test('http_status failure carries expected + actual status', () => {
    const result = runOne(
      { check: 'http_status', value: 401, description: 'unauth probe returns 401' },
      { httpResult: { url: 'https://example.com/mcp', status: 200, headers: {}, body: null } }
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.expected, 401);
    assert.strictEqual(result.actual, 200);
  });

  test('failed validation echoes request / response records', () => {
    const request = {
      transport: 'mcp',
      operation: 'get_products',
      payload: { brief: 'example' },
      url: 'https://example.com/mcp',
    };
    const response = { transport: 'mcp', payload: { accounts: [{}] }, duration_ms: 12 };
    const result = runOne(
      { check: 'field_present', path: 'accounts[0].account_id', description: 'id present' },
      { taskResult: { success: true, data: { accounts: [{}] } }, request, response }
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.request, request);
    assert.deepStrictEqual(result.response, response);
  });

  test('passed validation does not bloat payload with request/response', () => {
    const request = { transport: 'mcp', operation: 'get_products', payload: {} };
    const response = { transport: 'mcp', payload: {} };
    const result = runOne(
      { check: 'field_present', path: 'status', description: 'status present' },
      { taskResult: { success: true, data: { status: 'active' } }, request, response }
    );
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.request, undefined);
    assert.strictEqual(result.response, undefined);
  });
});

describe('runner-output contract: JSON Pointer conversion', () => {
  test('toJsonPointer handles dot and bracket notation', () => {
    assert.strictEqual(toJsonPointer('status'), '/status');
    assert.strictEqual(toJsonPointer('accounts[0].account_id'), '/accounts/0/account_id');
    assert.strictEqual(toJsonPointer('formats[2].format_id.id'), '/formats/2/format_id/id');
  });

  test('toJsonPointer escapes ~ and / per RFC 6901', () => {
    assert.strictEqual(toJsonPointer('a/b'), '/a~1b');
    assert.strictEqual(toJsonPointer('a~b'), '/a~0b');
  });

  test('toJsonPointer returns empty string for the root', () => {
    assert.strictEqual(toJsonPointer(''), '');
  });
});

describe('runner-output contract: secret redaction', () => {
  test('redactSecrets scrubs bearer tokens, api keys, and credentials by key name', () => {
    const out = redactSecrets({
      brand: 'nike',
      authorization: 'Bearer sk-live-123',
      api_key: 'apk_abc',
      nested: {
        credentials: 'hunter2',
        push_notification_config: { authentication: { credentials: 'secret-bearer' } },
      },
      benign: 'keep me',
    });
    assert.strictEqual(out.authorization, '[redacted]');
    assert.strictEqual(out.api_key, '[redacted]');
    assert.strictEqual(out.nested.credentials, '[redacted]');
    assert.strictEqual(out.nested.push_notification_config.authentication.credentials, '[redacted]');
    assert.strictEqual(out.benign, 'keep me');
    assert.strictEqual(out.brand, 'nike');
  });

  test('redactSecrets preserves arrays and non-matching keys', () => {
    const out = redactSecrets({ tokens: ['a', 'b'], list: [{ name: 'x' }] });
    // "tokens" matches the secret pattern — plural is allowed.
    // The value is an array so the whole array is preserved (we only redact
    // scalar values at matching keys); document that behaviour here.
    assert.deepStrictEqual(out.list, [{ name: 'x' }]);
  });

  test('filterResponseHeaders allowlists safe headers and drops the rest', () => {
    const out = filterResponseHeaders({
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="agent"',
      'set-cookie': 'session=abc; HttpOnly',
      authorization: 'Bearer leaked',
      'x-amzn-request-id': 'abc',
      'x-internal-tenant': 'acme',
    });
    assert.deepStrictEqual(out, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="agent"',
    });
  });
});

describe('runner-output contract: MCP extraction provenance', () => {
  const { unwrapProtocolResponse, readExtractionPath } = require('../../dist/lib/utils/response-unwrapper');

  test('structuredContent response tags structured_content', () => {
    const unwrapped = unwrapProtocolResponse(
      {
        structuredContent: { tools: [{ name: 'get_products' }], adcp_major_versions: [3] },
        content: [],
      },
      undefined,
      'mcp'
    );
    assert.strictEqual(readExtractionPath(unwrapped), 'structured_content');
  });

  test('text-only JSON response tags text_fallback', () => {
    const unwrapped = unwrapProtocolResponse(
      {
        content: [{ type: 'text', text: JSON.stringify({ tools: [{ name: 'get_products' }] }) }],
      },
      undefined,
      'mcp'
    );
    assert.strictEqual(readExtractionPath(unwrapped), 'text_fallback');
  });

  test('isError response tags error', () => {
    const unwrapped = unwrapProtocolResponse(
      {
        isError: true,
        structuredContent: { adcp_error: { code: 'VALIDATION_ERROR', message: 'bad input' } },
      },
      undefined,
      'mcp'
    );
    assert.strictEqual(readExtractionPath(unwrapped), 'error');
  });

  test('extraction tag is non-enumerable (does not pollute JSON output)', () => {
    const unwrapped = unwrapProtocolResponse(
      {
        structuredContent: { tools: [], adcp_major_versions: [3] },
      },
      undefined,
      'mcp'
    );
    assert.strictEqual(readExtractionPath(unwrapped), 'structured_content');
    // JSON.stringify MUST NOT include _extraction_path
    const serialized = JSON.parse(JSON.stringify(unwrapped));
    assert.strictEqual(serialized._extraction_path, undefined);
    // Object.keys MUST NOT include _extraction_path
    assert.ok(!Object.keys(unwrapped).includes('_extraction_path'));
  });
});

describe('runner-output contract: top-level summary', () => {
  const { mapStoryboardResultsToTrackResult } = require('../../dist/lib/testing/compliance/storyboard-tracks.js');

  test('skip detail surfaces through warnings regardless of reason', () => {
    const reasons = [
      ['not_applicable', 'Not applicable: agent did not declare this protocol'],
      ['prerequisite_failed', 'Skipped: a prerequisite did not pass'],
      ['missing_tool', 'Required tool get_signals not advertised.'],
      ['missing_test_controller', 'Deterministic-testing phase requires comply_test_controller.'],
      ['unsatisfied_contract', 'Skipped: signed-requests-runner contract is out of scope'],
    ];
    for (const [reason, detail] of reasons) {
      const trackResult = mapStoryboardResultsToTrackResult(
        'core',
        [
          {
            storyboard_id: 'sb',
            storyboard_title: 'sb',
            agent_url: 'https://example.com/mcp',
            overall_passed: true,
            phases: [
              {
                phase_id: 'phase-1',
                phase_title: 'phase-1',
                passed: true,
                steps: [
                  {
                    step_id: 'step-1',
                    phase_id: 'phase-1',
                    title: 'step-1',
                    task: 'get_products',
                    passed: true,
                    skipped: true,
                    skip_reason: reason,
                    skip: { reason, detail },
                    duration_ms: 0,
                    validations: [],
                    context: {},
                    extraction: { path: 'none' },
                  },
                ],
                duration_ms: 0,
              },
            ],
            context: {},
            total_duration_ms: 0,
            passed_count: 1,
            failed_count: 0,
            skipped_count: 1,
            tested_at: '2026-04-19T00:00:00.000Z',
          },
        ],
        { name: 'Test Agent', tools: [] }
      );
      const skipped = trackResult.scenarios[0].steps[0];
      assert.deepStrictEqual(skipped.warnings, [detail], `warning for ${reason} should echo the detail`);
    }
  });
});
