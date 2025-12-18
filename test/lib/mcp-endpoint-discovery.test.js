/**
 * MCP Endpoint Discovery Tests
 *
 * Tests for MCP endpoint discovery with trailing slash handling
 */

const test = require('node:test');
const assert = require('node:assert');
const { AdCPClient } = require('../../dist/lib/index.js');

// Mock HTTP client for testing
class MockHTTPClient {
  constructor(validUrls = []) {
    this.validUrls = new Set(validUrls);
    this.attemptedUrls = [];
  }

  async testEndpoint(url) {
    this.attemptedUrls.push(url);
    return this.validUrls.has(url);
  }

  reset() {
    this.attemptedUrls = [];
  }
}

test('MCP Endpoint Discovery - Trailing Slash Handling', async t => {
  await t.test('preserves trailing slash when provided', async () => {
    // Test that https://example.com/mcp/ is tried first
    const mockClient = new MockHTTPClient(['https://example.com/mcp/']);

    // We can't directly test the private method, but we can verify behavior
    // through the public API by checking that the client accepts the URL
    const agent = {
      id: 'test-trailing-slash',
      name: 'Test Trailing Slash',
      agent_uri: 'https://example.com/mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs().length, 1);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com/mcp/');
  });

  await t.test('preserves no trailing slash when not provided', async () => {
    const agent = {
      id: 'test-no-trailing-slash',
      name: 'Test No Trailing Slash',
      agent_uri: 'https://example.com/mcp',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com/mcp');
  });

  await t.test('accepts URL with /mcp/ path', async () => {
    const agent = {
      id: 'test-mcp-path',
      name: 'Test MCP Path',
      agent_uri: 'https://audience-agent.fly.dev/mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://audience-agent.fly.dev/mcp/');
  });

  await t.test('accepts URL without /mcp path', async () => {
    const agent = {
      id: 'test-root-path',
      name: 'Test Root Path',
      agent_uri: 'https://test-agent.adcontextprotocol.org',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://test-agent.adcontextprotocol.org');
  });

  await t.test('handles various URL patterns', async () => {
    const testCases = [
      'https://example.com/mcp/',
      'https://example.com/mcp',
      'https://example.com/',
      'https://example.com',
      'http://localhost:3000/mcp/',
      'http://localhost:3000/mcp',
    ];

    for (const uri of testCases) {
      const agent = {
        id: `test-${uri}`,
        name: 'Test Agent',
        agent_uri: uri,
        protocol: 'mcp',
        requiresAuth: false,
      };

      const client = new AdCPClient([agent]);
      assert.strictEqual(client.getAgentConfigs()[0].agent_uri, uri, `URL should be preserved as-is: ${uri}`);
    }
  });
});

test('MCP Endpoint Discovery - URL Normalization', async t => {
  await t.test('does not strip trailing slashes during initialization', async () => {
    const urlsWithTrailingSlash = ['https://example.com/mcp/', 'https://example.com/', 'http://localhost:3000/mcp/'];

    for (const uri of urlsWithTrailingSlash) {
      const agent = {
        id: `test-${uri}`,
        name: 'Test Agent',
        agent_uri: uri,
        protocol: 'mcp',
        requiresAuth: false,
      };

      const client = new AdCPClient([agent]);
      const storedUri = client.getAgentConfigs()[0].agent_uri;

      assert.ok(storedUri.endsWith('/'), `Trailing slash should be preserved in ${uri}, got ${storedUri}`);
    }
  });

  await t.test('does not add trailing slashes where not provided', async () => {
    const urlsWithoutTrailingSlash = ['https://example.com/mcp', 'https://example.com', 'http://localhost:3000/mcp'];

    for (const uri of urlsWithoutTrailingSlash) {
      const agent = {
        id: `test-${uri}`,
        name: 'Test Agent',
        agent_uri: uri,
        protocol: 'mcp',
        requiresAuth: false,
      };

      const client = new AdCPClient([agent]);
      const storedUri = client.getAgentConfigs()[0].agent_uri;

      assert.strictEqual(storedUri, uri, `URL should not be modified: ${uri}, got ${storedUri}`);
    }
  });
});

test('MCP Endpoint Discovery - Edge Cases', async t => {
  await t.test('handles double slashes in path', async () => {
    // Should preserve as-is, even if unusual
    const agent = {
      id: 'test-double-slash',
      name: 'Test Double Slash',
      agent_uri: 'https://example.com//mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com//mcp/');
  });

  await t.test('handles URLs with query parameters', async () => {
    const agent = {
      id: 'test-query',
      name: 'Test Query',
      agent_uri: 'https://example.com/mcp/?foo=bar',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com/mcp/?foo=bar');
  });

  await t.test('handles URLs with fragments', async () => {
    const agent = {
      id: 'test-fragment',
      name: 'Test Fragment',
      agent_uri: 'https://example.com/mcp/#section',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com/mcp/#section');
  });

  await t.test('handles URLs with port numbers', async () => {
    const agent = {
      id: 'test-port',
      name: 'Test Port',
      agent_uri: 'https://example.com:8080/mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com:8080/mcp/');
  });
});

test('MCP Endpoint Discovery - Well-Known URL Handling', async t => {
  await t.test('switches .well-known/agent-card.json URLs to A2A protocol', async () => {
    // Well-known agent card URLs are A2A discovery URLs - should switch to A2A
    const agent = {
      id: 'test-well-known',
      name: 'Test Well Known',
      agent_uri: 'https://example.com/.well-known/agent-card.json',
      protocol: 'mcp', // Even if MCP is specified...
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const configs = client.getAgentConfigs();
    assert.strictEqual(configs.length, 1);
    // ...it should be normalized to A2A because it's an agent card URL
    assert.strictEqual(configs[0].protocol, 'a2a');
    // URL should be preserved as-is (A2A handler knows how to use it)
    assert.strictEqual(configs[0].agent_uri, 'https://example.com/.well-known/agent-card.json');
  });

  await t.test('normalizes various well-known URL patterns to A2A', async () => {
    const wellKnownUrls = [
      'https://example.com/.well-known/agent-card.json',
      'https://agentic-sales.pbs.yahoo.com/.well-known/agent-card.json',
      'http://localhost:3000/.well-known/agent-card.json',
      'https://example.com:8080/.well-known/agent-card.json',
    ];

    for (const uri of wellKnownUrls) {
      const agent = {
        id: `test-${uri}`,
        name: 'Test Agent',
        agent_uri: uri,
        protocol: 'mcp',
        requiresAuth: false,
      };

      const client = new AdCPClient([agent]);
      const configs = client.getAgentConfigs();
      assert.strictEqual(configs[0].protocol, 'a2a', `${uri} should be normalized to A2A`);
    }
  });

  await t.test('preserves A2A protocol for well-known URLs', async () => {
    // If already A2A, should stay A2A
    const agent = {
      id: 'test-a2a-wellknown',
      name: 'Test A2A',
      agent_uri: 'https://example.com/.well-known/agent-card.json',
      protocol: 'a2a',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].protocol, 'a2a');
  });
});

test('MCP Endpoint Discovery - Real-World Scenarios', async t => {
  await t.test('supports Fly.io style endpoints with trailing slash', async () => {
    // This is the real-world case that prompted the fix
    const agent = {
      id: 'flyio-example',
      name: 'Fly.io Example',
      agent_uri: 'https://audience-agent.fly.dev/mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://audience-agent.fly.dev/mcp/');
  });

  await t.test('supports root MCP endpoints', async () => {
    // Some servers serve MCP at the root path
    const agent = {
      id: 'root-example',
      name: 'Root Example',
      agent_uri: 'https://test-agent.adcontextprotocol.org',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://test-agent.adcontextprotocol.org');
  });

  await t.test('supports nested paths with trailing slash', async () => {
    const agent = {
      id: 'nested-example',
      name: 'Nested Example',
      agent_uri: 'https://example.com/api/v1/mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    assert.strictEqual(client.getAgentConfigs()[0].agent_uri, 'https://example.com/api/v1/mcp/');
  });

  await t.test('supports localhost development URLs', async () => {
    const localUrls = ['http://localhost:3000/mcp/', 'http://localhost:8080/mcp', 'http://127.0.0.1:3000/mcp/'];

    for (const uri of localUrls) {
      const agent = {
        id: `test-${uri}`,
        name: 'Test Agent',
        agent_uri: uri,
        protocol: 'mcp',
        requiresAuth: false,
      };

      const client = new AdCPClient([agent]);
      assert.strictEqual(client.getAgentConfigs()[0].agent_uri, uri);
    }
  });
});
