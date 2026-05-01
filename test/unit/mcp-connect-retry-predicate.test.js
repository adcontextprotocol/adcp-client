/**
 * Unit tests for the connectMCPWithFallback retry predicate (issue #1246).
 *
 * The predicate was narrowed to `instanceof StreamableHTTPError`, missing
 * generic Error and McpError thrown during the initialize handshake.
 * Fix: retry on any first-connect failure except auth (is401Error).
 *
 * Replicates the retry-gate decision logic inline (same pattern as
 * mcp-discovery-sse-fallback.test.js) so the tests run without dist/.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Replicates is401Error() from src/lib/errors/index.ts.
// Keep in sync with the source; divergence is a test bug.
function is401Error(error) {
  if (!error) return false;
  const status = error?.status || error?.response?.status || error?.cause?.status || error?.code;
  if (status === 401) return true;
  const message = error?.message || '';
  return /\b401\b/.test(message) || /\bunauthorized\b/i.test(message);
}

// Replicates the retry gate from connectMCPWithFallbackImpl (mcp.ts ~line 374).
function shouldRetry(error) {
  return !is401Error(error);
}

/**
 * Minimal stand-in for connectMCPWithFallbackImpl's retry branch.
 * Returns 'retry-succeeded', 'retry-failed', or 'no-retry'.
 */
async function runRetryGate(firstConnectError, retryConnect) {
  if (!shouldRetry(firstConnectError)) {
    return 'no-retry';
  }
  try {
    await retryConnect();
    return 'retry-succeeded';
  } catch {
    return 'retry-failed';
  }
}

describe('connectMCPWithFallback: retry predicate (issue #1246)', () => {
  // --- Cases that SHOULD retry ---

  test('generic Error on first connect → retry fires', async () => {
    const err = new Error('Failed to read SSE stream');
    const result = await runRetryGate(err, async () => {
      /* retry succeeds */
    });
    assert.strictEqual(result, 'retry-succeeded');
  });

  test('ECONNRESET (cause.code) on first connect → retry fires', async () => {
    const err = Object.assign(new Error('socket hang up'), { cause: { code: 'ECONNRESET' } });
    const result = await runRetryGate(err, async () => {
      /* retry succeeds */
    });
    assert.strictEqual(result, 'retry-succeeded');
  });

  test('JSON parse error (generic Error) on first connect → retry fires', async () => {
    const err = new SyntaxError('Unexpected token < in JSON at position 0');
    const result = await runRetryGate(err, async () => {
      /* retry succeeds */
    });
    assert.strictEqual(result, 'retry-succeeded');
  });

  test('StreamableHTTPError 400 (session-not-found) still retries', async () => {
    // Regression guard: StreamableHTTPError was previously the *only* case that
    // retried. Widening must not remove this behavior.
    const err = Object.assign(new Error('Session not found'), { code: 400 });
    const result = await runRetryGate(err, async () => {
      /* retry succeeds */
    });
    assert.strictEqual(result, 'retry-succeeded');
  });

  test('generic Error on both first and retry → retry fires but propagates failure', async () => {
    const err = new Error('network timeout');
    const result = await runRetryGate(err, async () => {
      throw new Error('still failing');
    });
    assert.strictEqual(result, 'retry-failed');
  });

  // --- Cases that must NOT retry ---

  test('401 via StreamableHTTPError.code → no retry', async () => {
    // MCP SDK StreamableHTTPClientTransport sets .code to the HTTP status.
    const err = Object.assign(new Error('Unauthorized'), { code: 401 });
    let retryCalled = false;
    const result = await runRetryGate(err, async () => {
      retryCalled = true;
    });
    assert.strictEqual(result, 'no-retry');
    assert.strictEqual(retryCalled, false, 'retry must not fire on 401');
  });

  test('401 via error.status → no retry', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    let retryCalled = false;
    const result = await runRetryGate(err, async () => {
      retryCalled = true;
    });
    assert.strictEqual(result, 'no-retry');
    assert.strictEqual(retryCalled, false);
  });

  test('401 via message text → no retry', async () => {
    const err = new Error('HTTP 401 Unauthorized');
    let retryCalled = false;
    const result = await runRetryGate(err, async () => {
      retryCalled = true;
    });
    assert.strictEqual(result, 'no-retry');
    assert.strictEqual(retryCalled, false);
  });

  test('UnauthorizedError message → no retry', async () => {
    const err = new Error('unauthorized access');
    let retryCalled = false;
    const result = await runRetryGate(err, async () => {
      retryCalled = true;
    });
    assert.strictEqual(result, 'no-retry');
    assert.strictEqual(retryCalled, false);
  });
});
