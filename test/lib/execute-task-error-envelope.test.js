/**
 * Regression test for issue #1148:
 * executeTask('list_authorized_properties', {}) against a v2.5 MCP seller
 * threw "Cannot read properties of undefined (reading 'status')" instead of
 * returning a structured TaskResult.
 *
 * Root cause: SingleAgentClient.executeTask (public) had no top-level
 * try/catch, so pre-flight errors escaped as raw exceptions rather than
 * being wrapped in a TaskResult envelope.
 *
 * Fix: wrap the entire method body in try/catch; rethrow
 * AuthenticationRequiredError, TaskTimeoutError, VersionUnsupportedError,
 * and FeatureUnsupportedError (structured protocol errors callers handle
 * explicitly), convert unexpected errors to { success: false, status: 'failed' }.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  AdCPClient,
  AuthenticationRequiredError,
  VersionUnsupportedError,
  FeatureUnsupportedError,
} = require('../../dist/lib/index.js');

// Minimal v2-style capabilities that satisfy cachedCapabilities type checks.
const V2_CAPABILITIES = {
  version: 'v2',
  majorVersions: [2],
  protocols: ['media_buy'],
  features: {
    inlineCreativeManagement: false,
    conversionTracking: false,
    audienceTargeting: false,
    propertyListFiltering: false,
    contentStandards: false,
  },
  extensions: [],
  _synthetic: false,
};

function makeAgentClient(agentId = 'wonderstruck') {
  const mockAgent = {
    id: agentId,
    name: 'Wonderstruck v2.5',
    agent_uri: 'https://seller.wonderstruck.example/mcp',
    protocol: 'mcp',
  };
  const client = new AdCPClient([mockAgent]);
  const agent = client.agent(agentId);
  const inner = agent.client;

  // Skip endpoint discovery — pre-set the state that getCapabilities would normally
  // populate so the test focuses on the executeTask error-envelope path.
  inner.discoveredEndpoint = mockAgent.agent_uri;
  inner.cachedCapabilities = V2_CAPABILITIES;

  return { agent, inner };
}

describe('executeTask error envelope (issue #1148)', () => {
  test('returns structured TaskResult instead of throwing when a pre-flight step throws unexpectedly', async () => {
    const { agent, inner } = makeAgentClient();

    // Simulate the v2.5 seller scenario: detectServerVersion throws a TypeError
    // (e.g. the MCP response body is empty and something reads .status on undefined).
    // This is the class of error that escaped before the fix.
    const originalDetect = inner.detectServerVersion.bind(inner);
    inner.detectServerVersion = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'status')");
    };

    let result;
    try {
      result = await agent.executeTask('list_authorized_properties', {});
    } finally {
      inner.detectServerVersion = originalDetect;
    }

    // Before the fix, the line above would have thrown and 'result' would
    // be undefined.  After the fix it must return a structured envelope.
    assert.ok(result, 'executeTask must return a result, not throw');
    assert.strictEqual(result.success, false, 'success must be false');
    assert.strictEqual(result.status, 'failed', 'status must be failed');
    assert.ok(typeof result.error === 'string' && result.error.length > 0, 'error message must be present');
    assert.ok(
      result.error.includes('Cannot read properties of undefined'),
      `error message should propagate the original message; got: ${result.error}`
    );
    assert.ok(result.metadata, 'metadata must be present');
    assert.ok(typeof result.metadata.taskId === 'string', 'metadata.taskId must be a string');
    assert.strictEqual(result.metadata.taskName, 'list_authorized_properties');
    assert.ok(Array.isArray(result.conversation), 'conversation must be an array');
    assert.ok(Array.isArray(result.debug_logs), 'debug_logs must be an array');
    // fluent .match() must work on the error envelope (attachMatch coverage)
    assert.ok(typeof result.match === 'function', 'result.match must be a function');
  });

  test('auth errors still propagate as throws (backward-compat for OAuth flows)', async () => {
    const { agent, inner } = makeAgentClient('seller-auth');

    const originalDetect = inner.detectServerVersion.bind(inner);
    inner.detectServerVersion = async () => {
      throw new AuthenticationRequiredError('https://seller.wonderstruck.example/mcp', undefined);
    };

    try {
      await assert.rejects(
        () => agent.executeTask('list_authorized_properties', {}),
        err => {
          assert.ok(
            err instanceof AuthenticationRequiredError,
            `expected AuthenticationRequiredError, got ${err?.constructor?.name}: ${err?.message}`
          );
          return true;
        }
      );
    } finally {
      inner.detectServerVersion = originalDetect;
    }
  });

  test('VersionUnsupportedError still propagates as throw (structured fields must not be swallowed)', async () => {
    const { agent, inner } = makeAgentClient('seller-version');

    const originalDetect = inner.detectServerVersion.bind(inner);
    inner.detectServerVersion = async () => {
      throw new VersionUnsupportedError('create_media_buy', 'synthetic', 'v2', 'https://seller.example/mcp');
    };

    try {
      await assert.rejects(
        () => agent.executeTask('create_media_buy', { idempotency_key: 'k1' }),
        err => {
          assert.ok(
            err instanceof VersionUnsupportedError,
            `expected VersionUnsupportedError, got ${err?.constructor?.name}`
          );
          return true;
        }
      );
    } finally {
      inner.detectServerVersion = originalDetect;
    }
  });

  test('FeatureUnsupportedError still propagates as throw (structured fields must not be swallowed)', async () => {
    const { agent, inner } = makeAgentClient('seller-feature');

    const originalDetect = inner.detectServerVersion.bind(inner);
    inner.detectServerVersion = async () => {
      throw new FeatureUnsupportedError(['propertyListFiltering'], [], 'seller-feature');
    };

    try {
      await assert.rejects(
        () => agent.executeTask('list_authorized_properties', {}),
        err => {
          assert.ok(
            err instanceof FeatureUnsupportedError,
            `expected FeatureUnsupportedError, got ${err?.constructor?.name}`
          );
          return true;
        }
      );
    } finally {
      inner.detectServerVersion = originalDetect;
    }
  });

  test('list_authorized_properties with a well-behaved mock returns a result without throwing', async () => {
    const { AdCPClient, ProtocolClient } = require('../../dist/lib/index.js');

    const mockAgent = {
      id: 'seller-v2-ok',
      name: 'Well-behaved v2.5 seller',
      agent_uri: 'https://seller.example.com/mcp',
      protocol: 'mcp',
    };
    const client = new AdCPClient([mockAgent]);
    const agent = client.agent(mockAgent.id);
    const inner = agent.client;
    inner.discoveredEndpoint = mockAgent.agent_uri;
    inner.cachedCapabilities = V2_CAPABILITIES;

    const original = ProtocolClient.callTool;
    ProtocolClient.callTool = async (_cfg, name) => {
      if (name === 'list_authorized_properties') {
        return { structuredContent: { properties: [] } };
      }
      return { structuredContent: {} };
    };

    let result;
    try {
      result = await agent.executeTask('list_authorized_properties', {});
    } finally {
      ProtocolClient.callTool = original;
    }

    assert.ok(result, 'result must be defined');
    // May succeed or fail depending on response parsing — either way, no throw.
    assert.ok(typeof result.success === 'boolean', 'result.success must be a boolean');
    assert.ok(typeof result.status === 'string', 'result.status must be a string');
  });
});
