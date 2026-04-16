const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  extractAdcpErrorFromMcp,
  extractAdcpErrorFromTransport,
  extractAdcpErrorInfo,
  extractCorrelationId,
  resolveRecovery,
  getExpectedAction,
} = require('../dist/lib/utils/error-extraction');
const { isRetryable, getRetryDelay } = require('../dist/lib/utils/retry');

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
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            adcp_error: {
              code: 'PRODUCT_NOT_FOUND',
              message: 'Not found',
              recovery: 'correctable',
              field: 'product_id',
            },
          }),
        },
      ],
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

  it('does not match CONFLICT in plain text (too ambiguous)', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: 'There was a conflict with the existing resource' }],
    };

    assert.strictEqual(extractAdcpErrorFromMcp(response), null);
  });

  it('skips non-JSON content items and finds JSON in later items', () => {
    const response = {
      isError: true,
      content: [
        { type: 'text', text: 'plain error message' },
        { type: 'text', text: JSON.stringify({ adcp_error: { code: 'RATE_LIMITED', message: 'slow down' } }) },
      ],
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.source, 'text_json');
  });

  it('falls through when JSON has no adcp_error key', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: 'something' }) }],
    };

    assert.strictEqual(extractAdcpErrorFromMcp(response), null);
  });

  it('falls through when adcp_error.code is not a string', () => {
    const response = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ adcp_error: { code: 42 } }) }],
    };

    assert.strictEqual(extractAdcpErrorFromMcp(response), null);
  });

  it('preserves retry_after: 0 from structuredContent', () => {
    const response = {
      isError: true,
      structuredContent: {
        adcp_error: {
          code: 'RATE_LIMITED',
          message: 'Rate limited',
          recovery: 'transient',
          retry_after: 0,
        },
      },
      content: [{ type: 'text', text: 'error' }],
    };

    const result = extractAdcpErrorFromMcp(response);
    assert.ok(result);
    assert.strictEqual(result.retry_after, 0);
  });

  it('prefers structuredContent over text fallback', () => {
    const response = {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ adcp_error: { code: 'INVALID_REQUEST', message: 'text version' } }),
        },
      ],
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

  it('extracts from plain JSON-RPC error object (not Error instance)', () => {
    const error = {
      code: -32029,
      message: 'Rate limit exceeded',
    };

    const result = extractAdcpErrorFromTransport(error);
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
    assert.strictEqual(result.compliance_level, 1);
  });

  it('handles String(error) fallback for non-Error, non-object input', () => {
    const result = extractAdcpErrorFromTransport('RATE_LIMITED: slow down');
    assert.ok(result);
    assert.strictEqual(result.code, 'RATE_LIMITED');
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

  it('ignores invalid recovery strings and falls back to code table', () => {
    assert.strictEqual(resolveRecovery({ code: 'RATE_LIMITED', recovery: 'bogus' }), 'transient');
  });
});

describe('getExpectedAction', () => {
  it('maps correctly', () => {
    assert.strictEqual(getExpectedAction('transient'), 'retry');
    assert.strictEqual(getExpectedAction('correctable'), 'fix_request');
    assert.strictEqual(getExpectedAction('terminal'), 'escalate');
  });
});

describe('extractAdcpErrorInfo', () => {
  it('extracts from adcp_error shape', () => {
    const data = {
      adcp_error: { code: 'RATE_LIMITED', message: 'Too fast', recovery: 'transient', retry_after: 5 },
      context: { correlation_id: 'abc' },
    };
    const info = extractAdcpErrorInfo(data);
    assert.ok(info);
    assert.strictEqual(info.code, 'RATE_LIMITED');
    assert.strictEqual(info.message, 'Too fast');
    assert.strictEqual(info.recovery, 'transient');
    assert.strictEqual(info.retry_after, 5);
    assert.strictEqual(info.retryAfterMs, 5000);
    assert.strictEqual(info.synthetic, undefined);
  });

  it('extracts from errors array shape', () => {
    const data = { errors: [{ code: 'INVALID_REQUEST', message: 'Bad field' }] };
    const info = extractAdcpErrorInfo(data);
    assert.ok(info);
    assert.strictEqual(info.code, 'INVALID_REQUEST');
    assert.strictEqual(info.message, 'Bad field');
  });

  it('marks synthetic errors', () => {
    const data = { adcp_error: { code: 'mcp_error', message: 'raw text', synthetic: true } };
    const info = extractAdcpErrorInfo(data);
    assert.ok(info);
    assert.strictEqual(info.synthetic, true);
  });

  it('resolves recovery from standard code table', () => {
    const data = { adcp_error: { code: 'RATE_LIMITED', message: 'slow' } };
    const info = extractAdcpErrorInfo(data);
    assert.ok(info);
    assert.strictEqual(info.recovery, 'transient');
  });

  it('returns undefined for null/undefined', () => {
    assert.strictEqual(extractAdcpErrorInfo(null), undefined);
    assert.strictEqual(extractAdcpErrorInfo(undefined), undefined);
  });

  it('returns undefined for non-error data', () => {
    assert.strictEqual(extractAdcpErrorInfo({ products: [] }), undefined);
  });
});

describe('extractCorrelationId', () => {
  it('extracts from context.correlation_id', () => {
    assert.strictEqual(extractCorrelationId({ context: { correlation_id: 'abc-123' } }), 'abc-123');
  });

  it('returns undefined when no context', () => {
    assert.strictEqual(extractCorrelationId({}), undefined);
    assert.strictEqual(extractCorrelationId(null), undefined);
  });
});

describe('isRetryable', () => {
  it('returns true for transient errors', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Rate limited',
      adcpError: { code: 'RATE_LIMITED', recovery: 'transient', retryAfterMs: 5000 },
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(isRetryable(result), true);
  });

  it('returns false for correctable errors', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Bad field',
      adcpError: { code: 'INVALID_REQUEST', recovery: 'correctable' },
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(isRetryable(result), false);
  });

  it('returns false for terminal errors', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Suspended',
      adcpError: { code: 'ACCOUNT_SUSPENDED', recovery: 'terminal' },
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(isRetryable(result), false);
  });

  it('returns false for success results', () => {
    const result = {
      success: true,
      status: 'completed',
      data: {},
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'completed' },
    };
    assert.strictEqual(isRetryable(result), false);
  });

  it('returns false when no adcpError', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Network error',
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(isRetryable(result), false);
  });
});

describe('getRetryDelay', () => {
  it('returns retryAfterMs when present', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Rate limited',
      adcpError: { code: 'RATE_LIMITED', recovery: 'transient', retryAfterMs: 10000 },
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(getRetryDelay(result), 10000);
  });

  it('returns default when no retryAfterMs', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Rate limited',
      adcpError: { code: 'RATE_LIMITED', recovery: 'transient' },
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(getRetryDelay(result), 5000);
    assert.strictEqual(getRetryDelay(result, 3000), 3000);
  });

  it('returns 0 for non-retryable results', () => {
    const result = {
      success: false,
      status: 'failed',
      error: 'Terminal',
      adcpError: { code: 'ACCOUNT_SUSPENDED', recovery: 'terminal' },
      metadata: { taskId: 'x', taskName: 'y', agent: { id: 'a', name: 'b', protocol: 'mcp' }, responseTimeMs: 0, timestamp: '', clarificationRounds: 0, status: 'failed' },
    };
    assert.strictEqual(getRetryDelay(result), 0);
  });
});
