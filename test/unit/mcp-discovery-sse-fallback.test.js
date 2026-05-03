/**
 * Unit tests for MCP endpoint discovery SSE fallback logic
 *
 * discoverMCPEndpoint() probes candidate URLs using StreamableHTTPClientTransport
 * first, then falls back to SSEClientTransport if StreamableHTTP fails for a
 * non-auth reason — mirroring the fallback already present in callMCPTool().
 *
 * These tests replicate the testEndpoint() decision logic in isolation,
 * the same way mcp-sse-auth-fallback.test.js replicates buildAuthHeaders().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Replicates is401Error() from SingleAgentClient.ts
function is401Error(error) {
  if (!error) return false;
  const status = error?.status || error?.response?.status || error?.cause?.status;
  return status === 401;
}

/**
 * Replicates the testEndpoint() logic introduced in discoverMCPEndpoint().
 * Accepts injectable connect functions so the decision logic can be exercised
 * without real HTTP connections.
 */
async function testEndpoint(url, tryStreamable, trySSE) {
  try {
    await tryStreamable(url);
    return { success: true };
  } catch (streamableError) {
    // 401 → server exists but requires auth; skip SSE, propagate status
    if (is401Error(streamableError)) {
      return { success: false, status: 401, error: streamableError };
    }

    // Non-auth failure → fall back to SSE
    try {
      await trySSE(url);
      return { success: true };
    } catch (sseError) {
      const streamableStatus =
        streamableError?.status || streamableError?.response?.status || streamableError?.cause?.status;
      const sseStatus = sseError?.status || sseError?.response?.status || sseError?.cause?.status;
      const status = is401Error(sseError) ? 401 : sseStatus || streamableStatus;
      return { success: false, status, error: streamableError };
    }
  }
}

describe('discoverMCPEndpoint: SSE fallback decision logic', () => {
  test('StreamableHTTP success → returns success without trying SSE', async () => {
    let sseAttempted = false;

    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        /* StreamableHTTP succeeds */
      },
      async () => {
        sseAttempted = true;
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(sseAttempted, false, 'SSE should not be tried when StreamableHTTP succeeds');
  });

  test('StreamableHTTP fails (non-401), SSE succeeds → returns success', async () => {
    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        throw new Error('Connection refused');
      },
      async () => {
        /* SSE succeeds */
      }
    );

    assert.strictEqual(result.success, true);
  });

  test('StreamableHTTP 401 → returns 401 without trying SSE', async () => {
    let sseAttempted = false;
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });

    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        throw err;
      },
      async () => {
        sseAttempted = true;
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(sseAttempted, false, 'SSE should not be tried after a 401');
  });

  test('both transports fail → returns failure with StreamableHTTP status', async () => {
    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        throw Object.assign(new Error('Not Acceptable'), { status: 405 });
      },
      async () => {
        throw new Error('SSE not supported');
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 405);
  });

  test('SSE 401 after StreamableHTTP failure → returns 401', async () => {
    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        throw new Error('Protocol not supported');
      },
      async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 401);
  });

  test('both fail with no status codes → returns failure with undefined status', async () => {
    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        throw new Error('Network error');
      },
      async () => {
        throw new Error('SSE also failed');
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, undefined);
  });

  test('SSE status preferred over undefined StreamableHTTP status', async () => {
    const result = await testEndpoint(
      'https://example.com/mcp',
      async () => {
        throw new Error('No status on this error');
      },
      async () => {
        throw Object.assign(new Error('Service unavailable'), { status: 503 });
      }
    );

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.status, 503);
  });

  // Regression for #1438: loopback/private addresses must also attempt SSE fallback.
  // The 6.7.0 isPrivateAddress gate skipped SSE for 127.x.x.x addresses, breaking
  // training-agent discovery. SSE fallback must be attempted regardless of address type.
  test('loopback address (127.0.0.1): SSE is attempted when StreamableHTTP fails', async () => {
    let sseAttempted = false;

    const result = await testEndpoint(
      'http://127.0.0.1:8080/mcp',
      async () => {
        throw new Error('StreamableHTTP not supported');
      },
      async () => {
        sseAttempted = true;
        /* SSE succeeds */
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(sseAttempted, true, 'SSE must be tried for loopback addresses too');
  });

  test('localhost: SSE is attempted when StreamableHTTP fails', async () => {
    let sseAttempted = false;

    const result = await testEndpoint(
      'http://localhost:3000/mcp',
      async () => {
        throw new Error('StreamableHTTP not supported');
      },
      async () => {
        sseAttempted = true;
      }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(sseAttempted, true, 'SSE must be tried for localhost too');
  });
});
