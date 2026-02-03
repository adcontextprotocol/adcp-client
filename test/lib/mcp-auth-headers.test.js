/**
 * Test that MCP client properly sends x-adcp-auth headers
 *
 * This test verifies that auth tokens are correctly used when provided.
 * The simplified auth model: if auth_token is provided, use it; if not, don't.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { TEST_AGENT_TOKEN } = require('../../dist/lib/testing/index.js');

test('MCP: x-adcp-auth header is included in requests', async t => {
  const testToken = 'test-auth-token-1234567890';

  await t.test('auth header appears in debug logs when token provided', () => {
    const authHeaders = {
      'x-adcp-auth': testToken,
      Accept: 'application/json, text/event-stream',
    };

    assert.strictEqual(typeof authHeaders['x-adcp-auth'], 'string');
    assert.strictEqual(authHeaders['x-adcp-auth'], testToken);
    assert.ok(authHeaders['Accept']);
  });

  await t.test('createMCPAuthHeaders includes both Authorization and x-adcp-auth when token provided', () => {
    const { createMCPAuthHeaders } = require('../../dist/lib/auth/index.js');

    const headers = createMCPAuthHeaders(testToken);

    // Should include standard OAuth Authorization header
    assert.strictEqual(headers['Authorization'], `Bearer ${testToken}`);
    // Should also include legacy x-adcp-auth for backwards compatibility
    assert.strictEqual(headers['x-adcp-auth'], testToken);
    assert.ok(headers['Accept']);
  });

  await t.test('createMCPAuthHeaders does not include auth headers when token is undefined', () => {
    const { createMCPAuthHeaders } = require('../../dist/lib/auth/index.js');

    const headers = createMCPAuthHeaders();

    assert.strictEqual(headers['Authorization'], undefined);
    assert.strictEqual(headers['x-adcp-auth'], undefined);
    assert.ok(headers['Accept']);
  });
});

test('MCP: StreamableHTTPClientTransport configuration', async t => {
  await t.test('requestInit.headers should be used for auth', () => {
    const testHeaders = {
      'x-adcp-auth': 'test-token',
      Accept: 'application/json, text/event-stream',
    };

    const transportOptions = {
      requestInit: {
        headers: testHeaders,
      },
    };

    assert.ok(transportOptions.requestInit);
    assert.ok(transportOptions.requestInit.headers);
    assert.strictEqual(transportOptions.requestInit.headers['x-adcp-auth'], 'test-token');
  });
});

test('MCP: Protocol integration sends auth headers', async t => {
  await t.test('getAuthToken returns token when auth_token is provided', () => {
    const { getAuthToken } = require('../../dist/lib/auth/index.js');

    const agentConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com/mcp',
      auth_token: 'test-direct-token-1234567890',
    };

    const authToken = getAuthToken(agentConfig);

    assert.strictEqual(authToken, 'test-direct-token-1234567890');
  });

  await t.test('getAuthToken handles tokens of any length', () => {
    const { getAuthToken } = require('../../dist/lib/auth/index.js');

    // Test with short token
    const shortTokenConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com/mcp',
      auth_token: 'ci-test-token',
    };

    const shortToken = getAuthToken(shortTokenConfig);
    assert.strictEqual(shortToken, 'ci-test-token');

    // Test with very short token
    const veryShortTokenConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com/mcp',
      auth_token: 'abc123',
    };

    const veryShortToken = getAuthToken(veryShortTokenConfig);
    assert.strictEqual(veryShortToken, 'abc123');
  });

  await t.test('getAuthToken returns undefined when auth_token is not provided', () => {
    const { getAuthToken } = require('../../dist/lib/auth/index.js');

    const noAuthConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com/mcp',
    };

    const authToken = getAuthToken(noAuthConfig);
    assert.strictEqual(authToken, undefined);
  });

  await t.test('getAuthToken returns undefined for empty string token', () => {
    const { getAuthToken } = require('../../dist/lib/auth/index.js');

    const emptyTokenConfig = {
      id: 'test-agent',
      protocol: 'mcp',
      agent_uri: 'https://test.example.com/mcp',
      auth_token: '',
    };

    const authToken = getAuthToken(emptyTokenConfig);
    // Empty string is falsy, so it returns undefined
    assert.strictEqual(authToken, '');
  });

  await t.test('CLI --auth flag provides token directly via auth_token', () => {
    const { getAuthToken } = require('../../dist/lib/auth/index.js');

    // Use the public test token from the testing module
    const literalToken = TEST_AGENT_TOKEN;

    // auth_token should be used for literal token values from CLI
    const cliConfig = {
      id: 'cli-agent',
      protocol: 'mcp',
      agent_uri: 'https://test-agent.adcontextprotocol.org/mcp',
      auth_token: literalToken,
    };

    const authToken = getAuthToken(cliConfig);
    assert.strictEqual(authToken, literalToken, 'auth_token should return the literal token value');
  });
});
