/**
 * Unit tests for getAgentInfo() StreamableHTTP session retry logic (issue #1231).
 *
 * FastMCP and other stateful StreamableHTTP servers return 400 "Missing session
 * ID" when a tool call arrives before the session is established. The fix adds a
 * single retry with a fresh connectMCP() call inside getAgentInfo(). These tests
 * replicate the retry loop in isolation (same technique as mcp-discovery-sse-fallback.test.js).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

// Mirror StreamableHTTPError shape — tests do NOT import from the SDK directly
// so this file stays a pure unit test with no real HTTP.
class StreamableHTTPError extends Error {
  constructor(code, message) {
    super(message ?? `StreamableHTTP error: HTTP ${code}`);
    this.name = 'StreamableHTTPError';
    this.code = code;
  }
}

/**
 * Replicates the listTools-with-session-retry block from getAgentInfo().
 * Injectable so we can exercise the decision logic without a real MCPClient.
 */
async function listToolsWithSessionRetry(mcpClient, connectMCP, connectOptions, debugLogs) {
  const logs = debugLogs ?? [];
  let toolsList;
  try {
    toolsList = await mcpClient.listTools();
  } catch (sessionErr) {
    if (!(sessionErr instanceof StreamableHTTPError)) throw sessionErr;
    // Auth/authz failures won't be fixed by reconnecting — fast-fail
    if (sessionErr.code === 401 || sessionErr.code === 403) throw sessionErr;
    logs.push({
      type: 'info',
      message: `MCP: getAgentInfo StreamableHTTP session error (${sessionErr.code}), reconnecting`,
      timestamp: new Date().toISOString(),
    });
    const { client: retryClient } = await connectMCP(connectOptions);
    try {
      toolsList = await retryClient.listTools();
    } catch (retryErr) {
      if (retryErr instanceof Error && sessionErr instanceof Error) {
        retryErr.cause = sessionErr;
      }
      throw retryErr;
    } finally {
      retryClient.close().catch(() => {});
    }
  }
  return toolsList;
}

describe('getAgentInfo: StreamableHTTP session retry', () => {
  const noopConnect = async () => { throw new Error('should not reconnect'); };

  test('returns tools on first try when listTools succeeds', async () => {
    const mockTools = { tools: [{ name: 'get_adcp_capabilities' }] };
    const mcpClient = {
      listTools: async () => mockTools,
      close: async () => {},
    };

    const result = await listToolsWithSessionRetry(mcpClient, noopConnect, {});
    assert.deepStrictEqual(result, mockTools);
  });

  test('retries with fresh connection on StreamableHTTPError(400) "Missing session ID"', async () => {
    const mockTools = { tools: [{ name: 'get_products', description: 'List products' }] };
    let reconnectCount = 0;

    const mcpClient = {
      listTools: async () => {
        throw new StreamableHTTPError(400, 'Missing session ID');
      },
      close: async () => {},
    };

    const retryClient = {
      listTools: async () => mockTools,
      close: async () => {},
    };

    const connectMCP = async () => {
      reconnectCount++;
      return { client: retryClient };
    };

    const result = await listToolsWithSessionRetry(mcpClient, connectMCP, {});
    assert.deepStrictEqual(result, mockTools);
    assert.strictEqual(reconnectCount, 1, 'should reconnect exactly once');
  });

  test('retries on any StreamableHTTPError code, not only 400', async () => {
    const mockTools = { tools: [] };
    let reconnected = false;

    const mcpClient = {
      listTools: async () => {
        throw new StreamableHTTPError(404, 'Session not found');
      },
      close: async () => {},
    };

    const retryClient = {
      listTools: async () => mockTools,
      close: async () => {},
    };

    const connectMCP = async () => {
      reconnected = true;
      return { client: retryClient };
    };

    await listToolsWithSessionRetry(mcpClient, connectMCP, {});
    assert.strictEqual(reconnected, true, 'should reconnect on 404 as well');
  });

  test('propagates non-StreamableHTTPError without retrying', async () => {
    const networkErr = new Error('ECONNREFUSED');
    let connectCalled = false;

    const mcpClient = {
      listTools: async () => {
        throw networkErr;
      },
      close: async () => {},
    };

    const connectMCP = async () => {
      connectCalled = true;
      return { client: { listTools: async () => ({ tools: [] }), close: async () => {} } };
    };

    await assert.rejects(() => listToolsWithSessionRetry(mcpClient, connectMCP, {}), networkErr);
    assert.strictEqual(connectCalled, false, 'should not reconnect for non-StreamableHTTPError');
  });

  test('propagates error when retry also fails', async () => {
    const retryErr = new StreamableHTTPError(400, 'Missing session ID');

    const mcpClient = {
      listTools: async () => {
        throw new StreamableHTTPError(400, 'Missing session ID');
      },
      close: async () => {},
    };

    const retryClient = {
      listTools: async () => {
        throw retryErr;
      },
      close: async () => {},
    };

    const connectMCP = async () => ({ client: retryClient });

    await assert.rejects(() => listToolsWithSessionRetry(mcpClient, connectMCP, {}), {
      message: 'Missing session ID',
    });
  });

  test('debug log is emitted on session retry', async () => {
    const logs = [];

    const mcpClient = {
      listTools: async () => {
        throw new StreamableHTTPError(400, 'Missing session ID');
      },
      close: async () => {},
    };

    const retryClient = {
      listTools: async () => ({ tools: [] }),
      close: async () => {},
    };

    const connectMCP = async () => ({ client: retryClient });

    await listToolsWithSessionRetry(mcpClient, connectMCP, {}, logs);
    assert.strictEqual(logs.length, 1);
    assert.ok(logs[0].message.includes('reconnecting'), 'log should mention reconnecting');
    assert.ok(logs[0].message.includes('400'), 'log should include the status code');
  });

  test('does not retry on 401 StreamableHTTPError (auth failure)', async () => {
    let connectCalled = false;
    const mcpClient = {
      listTools: async () => { throw new StreamableHTTPError(401, 'Unauthorized'); },
      close: async () => {},
    };
    const connectMCP = async () => { connectCalled = true; return { client: null }; };

    await assert.rejects(
      () => listToolsWithSessionRetry(mcpClient, connectMCP, {}),
      { message: 'Unauthorized' }
    );
    assert.strictEqual(connectCalled, false, '401 should not trigger reconnect');
  });

  test('does not retry on 403 StreamableHTTPError (authorization failure)', async () => {
    let connectCalled = false;
    const mcpClient = {
      listTools: async () => { throw new StreamableHTTPError(403, 'Forbidden'); },
      close: async () => {},
    };
    const connectMCP = async () => { connectCalled = true; return { client: null }; };

    await assert.rejects(
      () => listToolsWithSessionRetry(mcpClient, connectMCP, {}),
      { message: 'Forbidden' }
    );
    assert.strictEqual(connectCalled, false, '403 should not trigger reconnect');
  });

  test('chains original sessionErr as .cause when retry also fails', async () => {
    const firstErr = new StreamableHTTPError(400, 'Missing session ID');
    const secondErr = new StreamableHTTPError(400, 'Missing session ID again');

    const mcpClient = {
      listTools: async () => { throw firstErr; },
      close: async () => {},
    };
    const retryClient = {
      listTools: async () => { throw secondErr; },
      close: async () => {},
    };
    const connectMCP = async () => ({ client: retryClient });

    let thrown;
    try {
      await listToolsWithSessionRetry(mcpClient, connectMCP, {});
    } catch (e) {
      thrown = e;
    }
    assert.strictEqual(thrown, secondErr);
    assert.strictEqual(thrown.cause, firstErr, 'retry error should have original as .cause');
  });

  test('connectOptions are forwarded to the retry connectMCP call', async () => {
    let receivedOptions;
    const opts = { agentUrl: 'https://example.com', authToken: 'tok', customHeaders: { 'x-org': '1' } };

    const mcpClient = {
      listTools: async () => {
        throw new StreamableHTTPError(400, 'Missing session ID');
      },
      close: async () => {},
    };

    const retryClient = {
      listTools: async () => ({ tools: [] }),
      close: async () => {},
    };

    const connectMCP = async options => {
      receivedOptions = options;
      return { client: retryClient };
    };

    await listToolsWithSessionRetry(mcpClient, connectMCP, opts);
    assert.deepStrictEqual(receivedOptions, opts, 'retry should use the same connectOptions');
  });
});
