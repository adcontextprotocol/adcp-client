/**
 * Regression tests for ERA_NEGOTIATION_FAILED handling in mcp-modern.ts.
 *
 * When a legacy MCP server responds to the server/discover probe with a
 * malformed envelope (e.g. id: null), @modelcontextprotocol/client throws
 * SdkError(EraNegotiationFailed). The three catch sites in mcp-modern.ts
 * must treat this as a legacy-era signal rather than rethrowing, so the
 * caller falls back to the v1 transport.
 *
 * Tests replicate the catch-block classifier logic in isolation — same
 * approach as mcp-discovery-sse-fallback.test.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { SdkError, SdkErrorCode } = require('@modelcontextprotocol/client');

function isEraNegotiationFailed(error) {
  return SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed;
}

// Replicates the probeModernMCPConnection catch classifier.
function probeClassify(error) {
  if (isEraNegotiationFailed(error)) return { connected: false };
  throw error;
}

// Replicates the attemptModernCall catch classifier (after the 404/405 branch).
function attemptClassify(error) {
  const status = error?.status;
  if (status === 404 || status === 405) return { handled: false };
  if (isEraNegotiationFailed(error)) return { handled: false };
  throw error;
}

// Replicates the tryListModernMCPTools catch classifier (after the 404/405 branch).
function listClassify(error) {
  const status = error?.status;
  if (status === 404 || status === 405) return { handled: false };
  if (isEraNegotiationFailed(error)) return { handled: false };
  throw error;
}

describe('mcp-modern: ERA_NEGOTIATION_FAILED treated as legacy-era signal', () => {
  const eraError = new SdkError(SdkErrorCode.EraNegotiationFailed, 'id: null in server/discover response');

  describe('probeModernMCPConnection catch', () => {
    test('ERA_NEGOTIATION_FAILED returns { connected: false }', () => {
      const result = probeClassify(eraError);
      assert.deepStrictEqual(result, { connected: false });
    });

    test('generic network error is rethrown', () => {
      const networkErr = new Error('ECONNREFUSED');
      assert.throws(() => probeClassify(networkErr), { message: 'ECONNREFUSED' });
    });
  });

  describe('attemptModernCall catch', () => {
    test('ERA_NEGOTIATION_FAILED returns { handled: false }', () => {
      const result = attemptClassify(eraError);
      assert.deepStrictEqual(result, { handled: false });
    });

    test('404 still returns { handled: false } (existing behavior preserved)', () => {
      const result = attemptClassify(Object.assign(new Error('Not Found'), { status: 404 }));
      assert.deepStrictEqual(result, { handled: false });
    });

    test('generic network error is rethrown', () => {
      const networkErr = new Error('timeout');
      assert.throws(() => attemptClassify(networkErr), { message: 'timeout' });
    });
  });

  describe('tryListModernMCPTools catch', () => {
    test('ERA_NEGOTIATION_FAILED returns { handled: false }', () => {
      const result = listClassify(eraError);
      assert.deepStrictEqual(result, { handled: false });
    });

    test('405 still returns { handled: false } (existing behavior preserved)', () => {
      const result = listClassify(Object.assign(new Error('Method Not Allowed'), { status: 405 }));
      assert.deepStrictEqual(result, { handled: false });
    });

    test('generic network error is rethrown', () => {
      const networkErr = new Error('ETIMEDOUT');
      assert.throws(() => listClassify(networkErr), { message: 'ETIMEDOUT' });
    });
  });
});
