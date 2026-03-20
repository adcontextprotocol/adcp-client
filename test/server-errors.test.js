const { describe, it } = require('node:test');
const assert = require('node:assert');
const { adcpError } = require('../dist/lib/server/errors');

describe('adcpError', () => {
  it('returns correct shape with auto-populated correctable recovery', () => {
    const result = adcpError('PRODUCT_NOT_FOUND', {
      message: 'No products match query',
    });

    assert.strictEqual(result.isError, true);
    assert.strictEqual(result.content.length, 1);
    assert.strictEqual(result.content[0].type, 'text');
    assert.strictEqual(result.structuredContent.adcp_error.code, 'PRODUCT_NOT_FOUND');
    assert.strictEqual(result.structuredContent.adcp_error.message, 'No products match query');
    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'correctable');
  });

  it('auto-populates transient recovery for RATE_LIMITED', () => {
    const result = adcpError('RATE_LIMITED', {
      message: 'Too many requests',
      retry_after: 5,
    });

    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'transient');
    assert.strictEqual(result.structuredContent.adcp_error.retry_after, 5);
  });

  it('auto-populates terminal recovery for ACCOUNT_SUSPENDED', () => {
    const result = adcpError('ACCOUNT_SUSPENDED', {
      message: 'Account suspended',
    });

    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'terminal');
  });

  it('respects explicitly provided recovery override', () => {
    const result = adcpError('PRODUCT_NOT_FOUND', {
      message: 'Not found',
      recovery: 'terminal',
    });

    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'terminal');
  });

  it('includes optional fields only when provided', () => {
    const result = adcpError('INVALID_REQUEST', {
      message: 'Bad request',
      field: 'packages[0].budget',
      suggestion: 'Increase budget',
      details: { minimum_budget: 500 },
    });

    const error = result.structuredContent.adcp_error;
    assert.strictEqual(error.field, 'packages[0].budget');
    assert.strictEqual(error.suggestion, 'Increase budget');
    assert.deepStrictEqual(error.details, { minimum_budget: 500 });
  });

  it('omits optional fields when not provided', () => {
    const result = adcpError('PRODUCT_NOT_FOUND', {
      message: 'Not found',
    });

    const error = result.structuredContent.adcp_error;
    assert.strictEqual('field' in error, false);
    assert.strictEqual('suggestion' in error, false);
    assert.strictEqual('retry_after' in error, false);
    assert.strictEqual('details' in error, false);
  });

  it('includes retry_after: 0 (falsy but valid)', () => {
    const result = adcpError('RATE_LIMITED', {
      message: 'Rate limited',
      retry_after: 0,
    });

    assert.strictEqual(result.structuredContent.adcp_error.retry_after, 0);
  });

  it('structuredContent matches parsed JSON from content text', () => {
    const result = adcpError('BUDGET_TOO_LOW', {
      message: 'Budget below minimum',
      field: 'packages[0].budget',
      suggestion: 'Increase to $500',
      details: { minimum_budget: 500, currency: 'USD' },
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(parsed.adcp_error, result.structuredContent.adcp_error);
  });

  it('unknown non-standard code gets terminal recovery', () => {
    const result = adcpError('X_VENDOR_CUSTOM_ERROR', {
      message: 'Custom error',
    });

    assert.strictEqual(result.structuredContent.adcp_error.recovery, 'terminal');
    assert.strictEqual(result.structuredContent.adcp_error.code, 'X_VENDOR_CUSTOM_ERROR');
  });
});
