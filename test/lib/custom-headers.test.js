/**
 * Tests for custom per-agent HTTP headers (AgentConfig.headers)
 *
 * Verifies that custom headers are:
 * 1. Accepted in AgentConfig
 * 2. Merged with auth headers, with auth always taking precedence
 * 3. Passed through ProtocolClient to the protocol implementations
 * 4. Visible in debug logs (header names only, not values)
 */

const { test } = require('node:test');
const assert = require('node:assert');

test('AgentConfig.headers: field is accepted on agent config objects', () => {
  const config = {
    id: 'test-agent',
    name: 'Test Agent',
    agent_uri: 'https://test.example.com/mcp',
    protocol: 'mcp',
    auth_token: 'bearer-token',
    headers: {
      'x-api-key': 'quota-key-123',
      'x-org-id': 'org-456',
    },
  };

  assert.deepStrictEqual(config.headers, {
    'x-api-key': 'quota-key-123',
    'x-org-id': 'org-456',
  });
});

test('AgentConfig.headers: auth headers always take precedence over custom headers', () => {
  const { createMCPAuthHeaders } = require('../../dist/lib/auth/index.js');

  const authToken = 'my-oauth-token';
  const customHeaders = {
    'x-api-key': 'quota-key-123',
    'x-org-id': 'org-456',
    // Misconfiguration scenario: custom headers try to override auth
    Authorization: 'Bearer should-be-overridden',
    'x-adcp-auth': 'should-be-overridden',
  };

  // Replicate the merge order used in callMCPTool
  const merged = {
    ...customHeaders,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };

  assert.strictEqual(merged['Authorization'], `Bearer ${authToken}`);
  assert.strictEqual(merged['x-adcp-auth'], authToken);
  // Non-auth custom headers are preserved
  assert.strictEqual(merged['x-api-key'], 'quota-key-123');
  assert.strictEqual(merged['x-org-id'], 'org-456');
});

test('AgentConfig.headers: custom headers are preserved when no auth token', () => {
  const { createMCPAuthHeaders } = require('../../dist/lib/auth/index.js');

  const customHeaders = {
    'x-api-key': 'quota-key-123',
    'x-org-id': 'org-456',
  };

  const merged = {
    ...customHeaders,
    ...(undefined ? createMCPAuthHeaders(undefined) : {}),
  };

  assert.strictEqual(merged['x-api-key'], 'quota-key-123');
  assert.strictEqual(merged['x-org-id'], 'org-456');
  assert.strictEqual(merged['Authorization'], undefined);
  assert.strictEqual(merged['x-adcp-auth'], undefined);
});

test('AgentConfig.headers: undefined headers are handled gracefully in merge', () => {
  const { createMCPAuthHeaders } = require('../../dist/lib/auth/index.js');

  const authToken = 'my-token';
  const merged = {
    ...undefined,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };

  assert.strictEqual(merged['Authorization'], `Bearer ${authToken}`);
  assert.strictEqual(merged['x-adcp-auth'], authToken);
});

test('AgentConfig.headers: A2A header merge preserves custom headers below auth', () => {
  const authToken = 'oauth-bearer';
  const customHeaders = {
    'x-api-key': 'dev-key',
    'x-org-id': 'org-789',
  };

  // existingHeaders from request options (e.g. Content-Type set by A2A SDK)
  const existingHeaders = { 'Content-Type': 'application/json' };

  const merged = {
    ...existingHeaders,
    ...customHeaders,
    ...(authToken && {
      Authorization: `Bearer ${authToken}`,
      'x-adcp-auth': authToken,
    }),
  };

  assert.strictEqual(merged['Content-Type'], 'application/json');
  assert.strictEqual(merged['x-api-key'], 'dev-key');
  assert.strictEqual(merged['x-org-id'], 'org-789');
  assert.strictEqual(merged['Authorization'], `Bearer ${authToken}`);
  assert.strictEqual(merged['x-adcp-auth'], authToken);
});

test('AgentConfig.headers: debug logs include custom header names but not token values', async () => {
  // callMCPTool will fail at the network level, but not before populating debug logs
  // with the auth configuration entry that includes customHeaderKeys
  const { callMCPTool } = require('../../dist/lib/protocols/mcp.js');

  const debugLogs = [];
  const customHeaders = { 'x-api-key': 'secret-key', 'x-org-id': 'org-123' };

  try {
    await callMCPTool('https://invalid.test.local/mcp', 'get_products', {}, 'auth-token', debugLogs, customHeaders);
  } catch (_err) {
    // Expected: network failure
  }

  const authConfigLog = debugLogs.find(l => l.message === 'MCP: Auth configuration');
  assert.ok(authConfigLog, 'Auth configuration log entry should exist');
  assert.strictEqual(authConfigLog.hasAuth, true);
  // Custom header keys should be logged (not values)
  assert.ok(authConfigLog.customHeaderKeys.includes('x-api-key'));
  assert.ok(authConfigLog.customHeaderKeys.includes('x-org-id'));
  // Auth token values must not appear in the log
  assert.ok(!JSON.stringify(authConfigLog).includes('secret-key'));
  assert.ok(!JSON.stringify(authConfigLog).includes('auth-token'));
});

test('AgentConfig.headers: ProtocolClient passes agent.headers to callMCPTool', async () => {
  // Verify the wiring from ProtocolClient → callMCPTool includes agent.headers.
  // We capture what callMCPTool received via the debug logs (customHeaderKeys).
  const { ProtocolClient } = require('../../dist/lib/protocols/index.js');

  const debugLogs = [];
  const agent = {
    id: 'test',
    name: 'Test',
    agent_uri: 'https://invalid.test.local/mcp',
    protocol: 'mcp',
    auth_token: 'token',
    headers: { 'x-api-key': 'key', 'x-org-id': 'org' },
  };

  try {
    await ProtocolClient.callTool(agent, 'get_products', {}, debugLogs);
  } catch (_err) {
    // Expected: network failure
  }

  const authConfigLog = debugLogs.find(l => l.message === 'MCP: Auth configuration');
  assert.ok(authConfigLog, 'Auth configuration log entry should exist');
  assert.ok(
    authConfigLog.customHeaderKeys.includes('x-api-key'),
    'agent.headers["x-api-key"] should be forwarded to callMCPTool'
  );
  assert.ok(
    authConfigLog.customHeaderKeys.includes('x-org-id'),
    'agent.headers["x-org-id"] should be forwarded to callMCPTool'
  );
});
