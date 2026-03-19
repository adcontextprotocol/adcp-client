const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  extractAdcpErrorFromMcp,
  extractAdcpErrorFromTransport,
  resolveRecovery,
  getExpectedAction,
} = require('../dist/lib/utils/error-extraction');

describe('extractAdcpErrorFromMcp', () => {
  it('extracts from structuredContent.adcp_error (L3)', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: 'error text' }],
      structuredContent: {
        adcp_error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          recovery: 'transient',
          retry_after: 5,
        },
      },
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.message, 'Too many requests');
    assert.strictEqual(result.recovery, 'transient');
    assert.strictEqual(result.retry_after, 5);
    assert.strictEqual(result.source, 'structuredContent');
    assert.strictEqual(result.compliance_level, 3);
  });

  it('extracts from JSON text content (L2)', () => {
    const response = {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          adcp_error: {
            code: 'PRODUCT_NOT_FOUND',
            message: 'Not found',
            recovery: 'correctable',
            field: 'product_id',
          },
        }),
      }],
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.code, 'PRODUCT_NOT_FOUND');
    assert.strictEqual(result.field, 'product_id');
    assert.strictEqual(result.source, 'text_json');
    assert.strictEqual(result.compliance_level, 2);
  });

  it('extracts standard code from plain text (L1)', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: 'RATE_LIMITED: Too many requests' }],
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.source, 'text_pattern');
    assert.strictEqual(result.compliance_level, 1);
  });

  it('detects rate limit from lowercase pattern', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: 'Rate limit exceeded. Please try again later.' }],
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.compliance_level, 1);
  });

  it('returns null for non-error responses', () => {
    const response = {
      isError: false,
      content: [{ type: 'text', text: 'Success' }],
      structuredContent: { products: [] },
    };

    assert.strictEqual(extractAdcpErrorFromMcp(response), null);
  });

  it('returns null for null/undefined', () => {
    assert.strictEqual(extractAdcpErrorFromMcp(null), null);
    assert.strictEqual(extractAdcpErrorFromMcp(undefined), null);
  });

  it('returns null for error with no recognizable AdCP error', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: 'Something went wrong' }],
    };

    assert.strictEqual(extractAdcpErrorFromMcp(response), null);
  });

  it('prefers structuredContent over text fallback', () => {
    const response = {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({ adcp_error: { code: 'INVALID_REQUEST', message: 'text version' } }),
      }],
      structuredContent: {
        adcp_error: { code: 'PRODUCT_NOT_FOUND', message: 'structured version' },
      },
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.code, 'PRODUCT_NOT_FOUND');
    assert.strictEqual(result.source, 'structuredContent');
  });
});

describe('extractAdcpErrorFromTransport', () => {
  it('extracts from error.data.adcp_error', () => {
    const error = {
      code: -32029,
      message: 'Rate limit exceeded',
      data: {
        adcp_error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          recovery: 'transient',
          retry_after: 10,
        },
      },
    };

    const result = extractAdcpErrorFromTransport(error);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.retry_after, 10);
    assert.strictEqual(result.compliance_level, 3);
  });

  it('falls back to message pattern matching', () => {
    const error = new Error('Rate limit exceeded');

    const result = extractAdcpErrorFromTransport(error);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.compliance_level, 1);
  });

  it('returns null for unrecognized errors', () => {
    const error = new Error('Connection refused');
    assert.strictEqual(extractAdcpErrorFromTransport(error), null);
  });
});

describe('resolveRecovery', () => {
  it('uses explicit recovery field', () => {
    assert.strictEqual(resolveRecovery({ code: 'RATE_LIMITED', recovery: 'terminal' }), 'terminal');
  });

  it('falls back to standard code table', () => {
    assert.strictEqual(resolveRecovery({ code: 'RATE_LIMITED' }), 'transient');
    assert.strictEqual(resolveRecovery({ code: 'PRODUCT_NOT_FOUND' }), 'correctable');
    assert.strictEqual(resolveRecovery({ code: 'ACCOUNT_SUSPENDED' }), 'terminal');
  });

  it('returns terminal for unknown codes', () => {
    assert.strictEqual(resolveRecovery({ code: 'X_CUSTOM_ERROR' }), 'terminal');
  });
});

describe('getExpectedAction', () => {
  it('maps correctly', () => {
    assert.strictEqual(getExpectedAction('transient'), 'retry');
    assert.strictEqual(getExpectedAction('correctable'), 'fix_request');
    assert.strictEqual(getExpectedAction('terminal'), 'escalate');
  });
});
