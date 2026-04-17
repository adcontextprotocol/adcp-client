const { describe, it } = require('node:test');
const assert = require('node:assert');
const { runValidations } = require('../../dist/lib/testing/storyboard/validations');

function errorCodeValidation(value) {
  return { check: 'error_code', value, description: `Expected ${value}` };
}

describe('validateErrorCode', () => {
  it('reads L3 structured code from data.adcp_error.code', () => {
    const taskResult = {
      success: false,
      data: { adcp_error: { code: 'MEDIA_BUY_NOT_FOUND', message: 'nope' } },
      error: 'MEDIA_BUY_NOT_FOUND: nope',
    };
    const [result] = runValidations([errorCodeValidation('MEDIA_BUY_NOT_FOUND')], 'update_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('falls back to data.error_code for agents that emit a flat field', () => {
    const taskResult = {
      success: false,
      data: { error_code: 'NOT_CANCELLABLE' },
      error: 'NOT_CANCELLABLE: already cancelled',
    };
    const [result] = runValidations([errorCodeValidation('NOT_CANCELLABLE')], 'cancel_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('strips the "CODE: message" prefix when only taskResult.error is present', () => {
    const taskResult = {
      success: false,
      data: undefined,
      error: 'VERSION_UNSUPPORTED: adcp_major_version 99 is not supported',
    };
    const [result] = runValidations([errorCodeValidation('VERSION_UNSUPPORTED')], 'get_adcp_capabilities', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('prefers structured code over taskResult.error', () => {
    const taskResult = {
      success: false,
      data: { adcp_error: { code: 'PACKAGE_NOT_FOUND' } },
      error: 'Some SDK-synthesized string that should NOT win',
    };
    const [result] = runValidations([errorCodeValidation('PACKAGE_NOT_FOUND')], 'update_media_buy', taskResult);
    assert.strictEqual(result.passed, true, result.error);
  });

  it('supports allowed_values with structured codes', () => {
    const taskResult = {
      success: false,
      data: { adcp_error: { code: 'INVALID_REQUEST' } },
      error: 'INVALID_REQUEST: bad input',
    };
    const [result] = runValidations(
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
