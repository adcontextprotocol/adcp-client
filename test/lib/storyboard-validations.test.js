const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');

function errorCodeValidation(value) {
  return { check: 'error_code', value, description: `Expected ${value}` };
}

function runOne(validations, taskName, taskResult) {
  return runValidations(validations, {
    taskName,
    taskResult,
    agentUrl: 'https://example.com/mcp',
    contributions: new Set(),
  });
}

describe('validateErrorCode', () => {
  it('reads spec-canonical code from data.errors[0].code', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [{ code: 'BUDGET_TOO_LOW', message: 'Minimum spend is $100' }],
        context: { request_id: 'abc' },
      },
      error: 'BUDGET_TOO_LOW: Minimum spend is $100',
    };
    const [result] = runOne([errorCodeValidation('BUDGET_TOO_LOW')], 'create_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.json_pointer, '/errors/0/code');
  });

  it('prefers data.errors[0].code over legacy adcp_error.code', () => {
    const taskResult = {
      success: false,
      data: {
        errors: [{ code: 'INVALID_REQUEST', message: 'bad input' }],
        adcp_error: { code: 'LEGACY_CODE' },
      },
      error: 'INVALID_REQUEST: bad input',
    };
    const [result] = runOne([errorCodeValidation('INVALID_REQUEST')], 'create_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.json_pointer, '/errors/0/code');
  });

  it('ignores advisory errors[0].code on a successful task (submitted/input-required envelopes)', () => {
    // AdCP permits an advisory `errors` array on non-failed async envelopes
    // (e.g., `create_media_buy` submitted with non-blocking warnings). A
    // `error_code` validation should not false-positive on these.
    const taskResult = {
      success: true,
      data: {
        media_buy_id: 'mb_123',
        status: 'submitted',
        errors: [{ code: 'WARN_RATE_LIMITED', message: 'slow response' }],
      },
      error: undefined,
    };
    const [result] = runOne([errorCodeValidation('WARN_RATE_LIMITED')], 'create_media_buy', taskResult);
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.json_pointer, null);
  });

  it('handles empty errors[] and non-object entries without throwing', () => {
    const taskResult = {
      success: false,
      data: { errors: [] },
      error: 'VALIDATION_ERROR: bad request',
    };
    const [result] = runOne([errorCodeValidation('VALIDATION_ERROR')], 'create_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);

    const stringEntry = {
      success: false,
      data: { errors: ['not an object'] },
      error: 'VALIDATION_ERROR: bad',
    };
    const [r2] = runOne([errorCodeValidation('VALIDATION_ERROR')], 'create_media_buy', stringEntry);
    assert.strictEqual(r2.passed, true, r2.error);
  });

  it('reads L3 structured code from data.adcp_error.code', () => {
    const taskResult = {
      success: false,
      data: { adcp_error: { code: 'MEDIA_BUY_NOT_FOUND', message: 'nope' } },
      error: 'MEDIA_BUY_NOT_FOUND: nope',
    };
    const [result] = runOne([errorCodeValidation('MEDIA_BUY_NOT_FOUND')], 'update_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('falls back to data.error_code for agents that emit a flat field', () => {
    const taskResult = {
      success: false,
      data: { error_code: 'NOT_CANCELLABLE' },
      error: 'NOT_CANCELLABLE: already cancelled',
    };
    const [result] = runOne([errorCodeValidation('NOT_CANCELLABLE')], 'cancel_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('strips the "CODE: message" prefix when only taskResult.error is present', () => {
    const taskResult = {
      success: false,
      data: undefined,
      error: 'VERSION_UNSUPPORTED: adcp_major_version 99 is not supported',
    };
    const [result] = runOne([errorCodeValidation('VERSION_UNSUPPORTED')], 'get_adcp_capabilities', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('prefers structured code over taskResult.error', () => {
    const taskResult = {
      success: false,
      data: { adcp_error: { code: 'PACKAGE_NOT_FOUND' } },
      error: 'Some SDK-synthesized string that should NOT win',
    };
    const [result] = runOne([errorCodeValidation('PACKAGE_NOT_FOUND')], 'update_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('supports allowed_values with structured codes', () => {
    const taskResult = {
      success: false,
      data: { adcp_error: { code: 'INVALID_REQUEST' } },
      error: 'INVALID_REQUEST: bad input',
    };
    const [result] = runOne(
      [
        {
          check: 'error_code',
          allowed_values: ['VALIDATION_ERROR', 'INVALID_REQUEST', 'BUDGET_TOO_LOW'],
          description: 'one of VALIDATION_ERROR/INVALID_REQUEST/BUDGET_TOO_LOW',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
  });
});

describe('envelope_field_value (adcp#3429)', () => {
  it('passes when the envelope field equals the expected value', () => {
    const taskResult = { success: true, data: { status: 'completed', task_id: 'task-1' } };
    const [result] = runOne(
      [{ check: 'envelope_field_value', path: 'status', value: 'completed', description: 'envelope status' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'envelope_field_value');
  });

  it('fails on mismatch and reports the envelope-scoped check name', () => {
    const taskResult = { success: true, data: { status: 'submitted' } };
    const [result] = runOne(
      [{ check: 'envelope_field_value', path: 'status', value: 'completed', description: 'envelope status' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.check, 'envelope_field_value');
    assert.match(result.error, /Expected "completed", got "submitted"/);
  });
});

describe('envelope_field_value_or_absent (adcp#3429)', () => {
  it('passes when the envelope field is absent (tolerant arm)', () => {
    const taskResult = { success: true, data: { task_id: 'task-1' } };
    const [result] = runOne(
      [{ check: 'envelope_field_value_or_absent', path: 'replayed', value: true, description: 'replayed marker' }],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'envelope_field_value_or_absent');
  });

  it('fails when the envelope field is present with a disallowed value', () => {
    const taskResult = { success: true, data: { replayed: false } };
    const [result] = runOne(
      [{ check: 'envelope_field_value_or_absent', path: 'replayed', value: true, description: 'replayed marker' }],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.check, 'envelope_field_value_or_absent');
    assert.match(result.error, /Expected absent or true, got false/);
  });
});

describe('field_pattern / envelope_field_pattern (adcp-client#2121)', () => {
  it('field_pattern passes when the payload field matches the pattern', () => {
    const taskResult = { success: true, data: { creative: { asset_url: 'https://cdn.example/ad-123.png' } } };
    const [result] = runOne(
      [
        {
          check: 'field_pattern',
          path: 'creative.asset_url',
          pattern: '^https://cdn\\.example/.+\\.png$',
          description: 'asset URL has expected host and extension',
        },
      ],
      'build_creative',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'field_pattern');
  });

  it('field_pattern fails with expected pattern and actual value on mismatch', () => {
    const taskResult = { success: true, data: { creative: { asset_url: 'http://cdn.example/ad-123.gif' } } };
    const [result] = runOne(
      [
        {
          check: 'field_pattern',
          path: 'creative.asset_url',
          pattern: '^https://cdn\\.example/.+\\.png$',
          description: 'asset URL has expected host and extension',
        },
      ],
      'build_creative',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '^https://cdn\\.example/.+\\.png$' });
    assert.strictEqual(result.actual, 'http://cdn.example/ad-123.gif');
  });

  it('field_pattern reports null actual when the payload field is missing', () => {
    const taskResult = { success: true, data: { creative: {} } };
    const [result] = runOne(
      [
        {
          check: 'field_pattern',
          path: 'creative.asset_url',
          pattern: '^https://',
          description: 'asset URL is present',
        },
      ],
      'build_creative',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '^https://' });
    assert.strictEqual(result.actual, null);
    assert.match(result.error, /Field not found at path: creative\.asset_url/);
  });

  it('field_pattern fails when the payload field is not a string', () => {
    const taskResult = { success: true, data: { creative: { asset_url: 123 } } };
    const [result] = runOne(
      [
        {
          check: 'field_pattern',
          path: 'creative.asset_url',
          pattern: '^https://',
          description: 'asset URL is string',
        },
      ],
      'build_creative',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '^https://' });
    assert.strictEqual(result.actual, 123);
    assert.match(result.error, /Expected string at path: creative\.asset_url, got number/);
  });

  it('field_pattern rejects missing pattern configuration', () => {
    const taskResult = { success: true, data: { creative: { asset_url: 'https://cdn.example/ad-123.png' } } };
    const [result] = runOne(
      [
        {
          check: 'field_pattern',
          path: 'creative.asset_url',
          description: 'asset URL is string',
        },
      ],
      'build_creative',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: 'non-empty JavaScript regular expression source' });
    assert.strictEqual(result.actual, null);
    assert.match(result.error, /field_pattern requires a non-empty `pattern` string/);
  });

  it('field_pattern rejects invalid regex sources', () => {
    const taskResult = { success: true, data: { creative: { asset_url: 'https://cdn.example/ad-123.png' } } };
    const [result] = runOne(
      [
        {
          check: 'field_pattern',
          path: 'creative.asset_url',
          pattern: '(',
          description: 'asset URL is string',
        },
      ],
      'build_creative',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '(' });
    assert.strictEqual(result.actual, '(');
    assert.match(result.error, /Invalid field_pattern pattern/);
  });

  it('envelope_field_pattern passes for adcp_version from the version envelope', () => {
    const taskResult = {
      success: true,
      data: {
        status: 'completed',
        adcp_version: '3.1-rc.3',
        adcp: { major_versions: [3], supported_versions: ['3.1-rc.3'] },
      },
    };
    const [result] = runOne(
      [
        {
          check: 'envelope_field_pattern',
          path: 'adcp_version',
          pattern: '^\\d+\\.\\d+(-[a-zA-Z0-9.-]+)?$',
          description: 'adcp_version has release precision',
        },
      ],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'envelope_field_pattern');
  });

  it('envelope_field_pattern fails with expected pattern and actual value on version-envelope mismatch', () => {
    const taskResult = {
      success: true,
      data: {
        status: 'completed',
        adcp_version: '3.1.0-rc.3',
        adcp: { major_versions: [3], supported_versions: ['3.1-rc.3'] },
      },
    };
    const [result] = runOne(
      [
        {
          check: 'envelope_field_pattern',
          path: 'adcp_version',
          pattern: '^\\d+\\.\\d+(-[a-zA-Z0-9.-]+)?$',
          description: 'adcp_version has release precision',
        },
      ],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '^\\d+\\.\\d+(-[a-zA-Z0-9.-]+)?$' });
    assert.strictEqual(result.actual, '3.1.0-rc.3');
  });

  it('envelope_field_pattern reports null actual when the envelope field is missing', () => {
    const taskResult = { success: true, data: { status: 'completed', adcp: { major_versions: [3] } } };
    const [result] = runOne(
      [
        {
          check: 'envelope_field_pattern',
          path: 'adcp_version',
          pattern: '^\\d+\\.\\d+',
          description: 'adcp_version is present',
        },
      ],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '^\\d+\\.\\d+' });
    assert.strictEqual(result.actual, null);
    assert.match(result.error, /Field not found at path: adcp_version/);
  });

  it('envelope_field_pattern fails when the version-envelope field is not a string', () => {
    const taskResult = { success: true, data: { status: 'completed', adcp_major_version: 3 } };
    const [result] = runOne(
      [
        {
          check: 'envelope_field_pattern',
          path: 'adcp_major_version',
          pattern: '^3$',
          description: 'adcp_major_version is string-shaped',
        },
      ],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.expected, { pattern: '^3$' });
    assert.strictEqual(result.actual, 3);
    assert.match(result.error, /Expected string at path: adcp_major_version, got number/);
  });
});

describe('field_value_or_absent media-buy status collision (adcp-client#1961)', () => {
  it('treats flat MCP envelope status completed as absent for the deprecated media-buy status field', () => {
    const taskResult = {
      success: true,
      data: {
        status: 'completed',
        media_buy_status: 'pending_creatives',
        media_buy_id: 'mb-1',
      },
    };
    const [result] = runOne(
      [
        {
          check: 'field_value_or_absent',
          path: 'status',
          value: 'pending_creatives',
          description: 'legacy media-buy status mirrors media_buy_status when present',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'field_value_or_absent');
  });

  it('still fails when a seller emits a mismatched legacy media-buy status', () => {
    const taskResult = {
      success: true,
      data: {
        status: 'active',
        media_buy_status: 'pending_creatives',
        media_buy_id: 'mb-1',
      },
    };
    const [result] = runOne(
      [
        {
          check: 'field_value_or_absent',
          path: 'status',
          value: 'pending_creatives',
          description: 'legacy media-buy status mirrors media_buy_status when present',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Expected absent or "pending_creatives", got "active"/);
  });

  it('does not change envelope-scoped status checks', () => {
    const taskResult = {
      success: true,
      data: {
        status: 'completed',
        media_buy_status: 'pending_creatives',
      },
    };
    const [result] = runOne(
      [
        {
          check: 'envelope_field_value_or_absent',
          path: 'status',
          value: 'pending_creatives',
          description: 'envelope status is still visible to envelope checks',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Expected absent or "pending_creatives", got "completed"/);
  });
});

describe('envelope_field_present (adcp#3429)', () => {
  // Runtime semantics are identical to field_present — TaskResult merges
  // envelope fields into its surface so `data.status` is the envelope's
  // status. The check exists to signal scope to static drift detection,
  // which walks the envelope schema instead of the inner response.
  it('passes when the asserted path resolves on the task data', () => {
    const taskResult = {
      success: true,
      data: { status: 'completed', task_id: 'task-1', context: { correlation_id: 'c1' } },
    };
    const [result] = runOne(
      [{ check: 'envelope_field_present', path: 'status', description: 'envelope carries status' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'envelope_field_present');
  });

  it('fails when the asserted envelope field is missing', () => {
    const taskResult = { success: true, data: { context: { correlation_id: 'c1' } } };
    const [result] = runOne(
      [{ check: 'envelope_field_present', path: 'status', description: 'envelope carries status' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.check, 'envelope_field_present');
    assert.match(result.error, /Field not found at path: status/);
  });

  it('rejects validation entries without a path', () => {
    const taskResult = { success: true, data: { status: 'completed' } };
    const [result] = runOne(
      [{ check: 'envelope_field_present', description: 'no path' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /No path specified for envelope_field_present/);
  });
});

describe('field_absent / envelope_field_absent (adcp#3429)', () => {
  it('passes when the asserted path is absent from the task data', () => {
    const taskResult = { success: true, data: { status: 'completed' } };
    const [result] = runOne(
      [{ check: 'field_absent', path: 'legacy_status', description: 'legacy_status must not appear' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'field_absent');
  });

  it('fails when the asserted path is present', () => {
    const taskResult = { success: true, data: { status: 'completed', legacy_status: 'active' } };
    const [result] = runOne(
      [{ check: 'field_absent', path: 'legacy_status', description: 'legacy_status must not appear' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.check, 'field_absent');
    assert.match(result.error, /Field found at path: legacy_status/);
  });

  it('fails with no-path error when path is missing', () => {
    const taskResult = { success: true, data: { status: 'completed' } };
    const [result] = runOne(
      [{ check: 'field_absent', description: 'no path given' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /No path specified for field_absent/);
  });

  it('envelope_field_absent passes when envelope field is absent', () => {
    const taskResult = { success: true, data: { task_id: 'task-1' } };
    const [result] = runOne(
      [{ check: 'envelope_field_absent', path: 'legacy_status', description: 'envelope must not carry legacy_status' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'envelope_field_absent');
  });

  it('envelope_field_absent fails when envelope field is present', () => {
    const taskResult = { success: true, data: { task_id: 'task-1', legacy_status: 'active' } };
    const [result] = runOne(
      [{ check: 'envelope_field_absent', path: 'legacy_status', description: 'envelope must not carry legacy_status' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.check, 'envelope_field_absent');
    assert.match(result.error, /Field found at path: legacy_status/);
  });

  it('envelope_field_absent fails with no-path error when path is missing', () => {
    const taskResult = { success: true, data: { status: 'completed' } };
    const [result] = runOne(
      [{ check: 'envelope_field_absent', description: 'no path given' }],
      'get_adcp_capabilities',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /No path specified for envelope_field_absent/);
  });
});

describe('field_contains (adcp#3803 item 2)', () => {
  it('passes when value matches any element via [*] wildcard', () => {
    const taskResult = {
      success: true,
      data: {
        creatives: [
          {
            errors: [
              { code: 'PROVENANCE_DISCLOSURE_MISSING', message: 'no disclosure' },
              { code: 'PROVENANCE_VERIFIER_NOT_ACCEPTED', message: 'verifier off-list' },
            ],
          },
        ],
      },
    };
    const [result] = runOne(
      [
        {
          check: 'field_contains',
          path: 'creatives[0].errors[*].code',
          value: 'PROVENANCE_VERIFIER_NOT_ACCEPTED',
          description: 'verifier-not-accepted appears regardless of cascade order',
        },
      ],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'field_contains');
  });

  it('passes when any allowed_values entry matches', () => {
    const taskResult = {
      success: true,
      data: {
        creatives: [{ errors: [{ code: 'PROVENANCE_DISCLOSURE_MISSING' }] }],
      },
    };
    const [result] = runOne(
      [
        {
          check: 'field_contains',
          path: 'creatives[0].errors[*].code',
          allowed_values: ['PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING', 'PROVENANCE_DISCLOSURE_MISSING'],
          description: 'either disclosure code is acceptable',
        },
      ],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('fails when no resolved value matches', () => {
    const taskResult = {
      success: true,
      data: {
        creatives: [{ errors: [{ code: 'PROVENANCE_DISCLOSURE_MISSING' }] }],
      },
    };
    const [result] = runOne(
      [
        {
          check: 'field_contains',
          path: 'creatives[0].errors[*].code',
          value: 'PROVENANCE_VERIFIER_NOT_ACCEPTED',
          description: 'expected verifier-not-accepted',
        },
      ],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /PROVENANCE_VERIFIER_NOT_ACCEPTED/);
    assert.deepStrictEqual(result.actual, ['PROVENANCE_DISCLOSURE_MISSING']);
  });

  it('fails when path resolves to empty (no array elements)', () => {
    const taskResult = { success: true, data: { creatives: [{ errors: [] }] } };
    const [result] = runOne(
      [
        {
          check: 'field_contains',
          path: 'creatives[0].errors[*].code',
          value: 'PROVENANCE_DISCLOSURE_MISSING',
          description: 'expected disclosure error',
        },
      ],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.deepStrictEqual(result.actual, []);
  });

  it('reduces to scalar equality when path has no wildcard', () => {
    const taskResult = { success: true, data: { status: 'completed' } };
    const [hit] = runOne(
      [{ check: 'field_contains', path: 'status', value: 'completed', description: 'status matches' }],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(hit.passed, true, hit.error);

    const [miss] = runOne(
      [{ check: 'field_contains', path: 'status', value: 'submitted', description: 'status mismatch' }],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(miss.passed, false);
  });

  it('reports an error when path is missing', () => {
    const [result] = runOne(
      [{ check: 'field_contains', value: 'X', description: 'no path given' }],
      'create_media_buy',
      { success: true, data: {} }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /No path specified for field_contains/);
  });

  it('reports an error when neither value nor allowed_values is set', () => {
    const [result] = runOne(
      [{ check: 'field_contains', path: 'errors[*].code', description: 'no expectations' }],
      'create_media_buy',
      { success: true, data: { errors: [] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /requires either `value` or `allowed_values`/);
  });

  it('emits the canonical JSON pointer for the path', () => {
    const [result] = runOne(
      [
        {
          check: 'field_contains',
          path: 'creatives[0].errors[*].code',
          value: 'X',
          description: 'pointer test',
        },
      ],
      'sync_creatives',
      { success: true, data: { creatives: [{ errors: [{ code: 'X' }] }] } }
    );
    assert.strictEqual(result.passed, true);
    // toJsonPointer renders [*] as /* (literal asterisk) — `*` isn't a
    // forbidden character in RFC 6901, so it round-trips unescaped.
    assert.strictEqual(result.json_pointer, '/creatives/0/errors/*/code');
  });
});

describe('array_length (adcp#4685 / adcp-client#1830)', () => {
  // Cardinality assertion that reads `array.length` directly. Necessary
  // because `field_present arr[N-1]` + `field_value_or_absent arr[N]
  // value: null` is unsound: it passes when the seller emits a literal
  // null pad at arr[N]. This check rejects non-array resolutions instead.
  it('passes with exact value match', () => {
    const taskResult = {
      success: true,
      data: { media_buys: [{ impairments: [{ id: 'a' }, { id: 'b' }] }] },
    };
    const [result] = runOne(
      [
        {
          check: 'array_length',
          path: 'media_buys[0].impairments',
          value: 2,
          description: 'exactly two impairments',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
    assert.strictEqual(result.check, 'array_length');
    assert.strictEqual(result.json_pointer, '/media_buys/0/impairments');
  });

  it('fails when exact value does not match', () => {
    const taskResult = {
      success: true,
      data: { media_buys: [{ impairments: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }] },
    };
    const [result] = runOne(
      [
        {
          check: 'array_length',
          path: 'media_buys[0].impairments',
          value: 2,
          description: 'exactly two impairments',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /Expected array length 2, got 3/);
    assert.strictEqual(result.expected, 2);
    assert.strictEqual(result.actual, 3);
  });

  it('refuses to false-pass on a literal null pad (the unsound workaround case)', () => {
    // Seller emits `[ {…}, null ]` — under the old workaround
    // (field_value_or_absent arr[1] value: null) this passes silently.
    // array_length value: 1 must fail because length is 2.
    const taskResult = {
      success: true,
      data: { media_buys: [{ impairments: [{ id: 'a' }, null] }] },
    };
    const [result] = runOne(
      [
        {
          check: 'array_length',
          path: 'media_buys[0].impairments',
          value: 1,
          description: 'exactly one impairment (null pad should be caught)',
        },
      ],
      'create_media_buy',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.strictEqual(result.actual, 2);
  });

  it('passes within inclusive min/max bounds', () => {
    const taskResult = { success: true, data: { items: [1, 2, 3] } };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', min: 1, max: 5, description: 'bounded' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('passes with only `min` set when length meets the lower bound', () => {
    const taskResult = { success: true, data: { items: [1, 2, 3] } };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', min: 3, description: 'at least three' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('passes with only `max` set when length meets the upper bound', () => {
    const taskResult = { success: true, data: { items: [] } };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', max: 0, description: 'at most zero' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, true, result.error);
  });

  it('fails when length is below `min`', () => {
    const taskResult = { success: true, data: { items: [1] } };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', min: 2, max: 5, description: 'bounded' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, />= 2, got 1/);
  });

  it('fails when length is above `max`', () => {
    const taskResult = { success: true, data: { items: [1, 2, 3, 4, 5, 6] } };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', min: 0, max: 5, description: 'bounded' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /<= 5, got 6/);
  });

  it('fails when the resolved path is not an array', () => {
    const taskResult = { success: true, data: { items: 'not-an-array' } };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', value: 0, description: 'wrong type' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /requires an array at path/);
  });

  it('fails when the resolved path is absent', () => {
    const taskResult = { success: true, data: {} };
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', value: 0, description: 'absent' }],
      'sync_creatives',
      taskResult
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /got undefined/);
  });

  it('fails when path is missing', () => {
    const [result] = runOne([{ check: 'array_length', value: 1, description: 'no path' }], 'sync_creatives', {
      success: true,
      data: { items: [1] },
    });
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /No path specified for array_length/);
  });

  it('rejects misconfigured check with no value/min/max', () => {
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', description: 'no expectation' }],
      'sync_creatives',
      { success: true, data: { items: [1] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /requires `value`.*or `min`\/`max`/);
  });

  it('rejects misconfigured check when both `value` and bounds are set', () => {
    const [result] = runOne(
      [
        {
          check: 'array_length',
          path: 'items',
          value: 2,
          min: 1,
          description: 'mutually exclusive',
        },
      ],
      'sync_creatives',
      { success: true, data: { items: [1, 2] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /either `value` OR `min`\/`max`, not both/);
  });

  it('rejects NaN operand at the config gate', () => {
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', value: NaN, description: 'NaN value' }],
      'sync_creatives',
      { success: true, data: { items: [1] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /must be a non-negative integer/);
    assert.match(result.error, /NaN/);
  });

  it('rejects fractional `value` at the config gate', () => {
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', value: 2.5, description: 'fractional value' }],
      'sync_creatives',
      { success: true, data: { items: [1, 2] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /must be a non-negative integer/);
  });

  it('rejects negative `min` at the config gate', () => {
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', min: -1, description: 'negative min' }],
      'sync_creatives',
      { success: true, data: { items: [1] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /`min` must be a non-negative integer/);
  });

  it('rejects impossible range when `min > max`', () => {
    const [result] = runOne(
      [{ check: 'array_length', path: 'items', min: 5, max: 1, description: 'impossible' }],
      'sync_creatives',
      { success: true, data: { items: [1, 2, 3] } }
    );
    assert.strictEqual(result.passed, false);
    assert.match(result.error, /impossible: min 5 > max 1/);
  });
});
