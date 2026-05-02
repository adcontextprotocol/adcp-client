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
      [{
        check: 'field_contains',
        path: 'creatives[0].errors[*].code',
        value: 'PROVENANCE_VERIFIER_NOT_ACCEPTED',
        description: 'verifier-not-accepted appears regardless of cascade order',
      }],
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
      [{
        check: 'field_contains',
        path: 'creatives[0].errors[*].code',
        allowed_values: ['PROVENANCE_DIGITAL_SOURCE_TYPE_MISSING', 'PROVENANCE_DISCLOSURE_MISSING'],
        description: 'either disclosure code is acceptable',
      }],
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
      [{
        check: 'field_contains',
        path: 'creatives[0].errors[*].code',
        value: 'PROVENANCE_VERIFIER_NOT_ACCEPTED',
        description: 'expected verifier-not-accepted',
      }],
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
      [{
        check: 'field_contains',
        path: 'creatives[0].errors[*].code',
        value: 'PROVENANCE_DISCLOSURE_MISSING',
        description: 'expected disclosure error',
      }],
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
      [{
        check: 'field_contains',
        path: 'creatives[0].errors[*].code',
        value: 'X',
        description: 'pointer test',
      }],
      'sync_creatives',
      { success: true, data: { creatives: [{ errors: [{ code: 'X' }] }] } }
    );
    assert.strictEqual(result.passed, true);
    // toJsonPointer renders [*] as /* per RFC 6901 string-encoding rules
    assert.match(result.json_pointer, /^\/creatives\/0\/errors\/.*\/code$/);
  });
});
