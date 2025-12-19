/**
 * Canonical URL Tests
 *
 * Tests for URL canonicalization and agent comparison
 * See: https://github.com/adcontextprotocol/adcp-client/issues/175
 */

const test = require('node:test');
const assert = require('node:assert');
const { AdCPClient } = require('../../dist/lib/index.js');

/**
 * Helper to compute base URL (mirrors SingleAgentClient.computeBaseUrl)
 */
function computeBaseUrl(url) {
  let baseUrl = url;

  // Strip /.well-known/agent-card.json
  if (baseUrl.match(/\/\.well-known\/agent-card\.json$/i)) {
    baseUrl = baseUrl.replace(/\/\.well-known\/agent-card\.json$/i, '');
  }

  // Strip /mcp or /mcp/
  if (baseUrl.match(/\/mcp\/?$/i)) {
    baseUrl = baseUrl.replace(/\/mcp\/?$/i, '');
  }

  // Strip trailing slash for consistency
  baseUrl = baseUrl.replace(/\/$/, '');

  return baseUrl;
}

test('Canonical URL Computation', async t => {
  await t.test('strips .well-known/agent-card.json suffix', async () => {
    const testCases = [
      {
        input: 'https://example.com/.well-known/agent-card.json',
        expected: 'https://example.com',
      },
      {
        input: 'https://agent.example.com/.well-known/agent-card.json',
        expected: 'https://agent.example.com',
      },
      {
        input: 'http://localhost:3000/.well-known/agent-card.json',
        expected: 'http://localhost:3000',
      },
    ];

    for (const { input, expected } of testCases) {
      assert.strictEqual(computeBaseUrl(input), expected, `Should strip .well-known/agent-card.json from ${input}`);
    }
  });

  await t.test('strips /mcp suffix', async () => {
    const testCases = [
      {
        input: 'https://example.com/mcp',
        expected: 'https://example.com',
      },
      {
        input: 'https://example.com/mcp/',
        expected: 'https://example.com',
      },
      {
        input: 'https://agent.example.com/api/mcp',
        expected: 'https://agent.example.com/api',
      },
      {
        input: 'https://agent.example.com/api/mcp/',
        expected: 'https://agent.example.com/api',
      },
    ];

    for (const { input, expected } of testCases) {
      assert.strictEqual(computeBaseUrl(input), expected, `Should strip /mcp from ${input}`);
    }
  });

  await t.test('strips trailing slash', async () => {
    const testCases = [
      {
        input: 'https://example.com/',
        expected: 'https://example.com',
      },
      {
        input: 'https://agent.example.com/api/',
        expected: 'https://agent.example.com/api',
      },
    ];

    for (const { input, expected } of testCases) {
      assert.strictEqual(computeBaseUrl(input), expected, `Should strip trailing slash from ${input}`);
    }
  });

  await t.test('preserves URLs without suffixes', async () => {
    const testCases = [
      'https://example.com',
      'https://agent.example.com',
      'https://agent.example.com/api',
      'http://localhost:3000',
    ];

    for (const url of testCases) {
      assert.strictEqual(computeBaseUrl(url), url, `Should preserve ${url} as-is`);
    }
  });

  await t.test('case insensitive suffix matching', async () => {
    const testCases = [
      {
        input: 'https://example.com/.WELL-KNOWN/AGENT-CARD.JSON',
        expected: 'https://example.com',
      },
      {
        input: 'https://example.com/MCP',
        expected: 'https://example.com',
      },
      {
        input: 'https://example.com/MCP/',
        expected: 'https://example.com',
      },
    ];

    for (const { input, expected } of testCases) {
      assert.strictEqual(computeBaseUrl(input), expected, `Should handle case-insensitively: ${input}`);
    }
  });
});

test('Agent Canonical URL via AdCPClient', async t => {
  await t.test('getCanonicalUrl returns base URL for well-known URLs', async () => {
    const agent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://example.com/.well-known/agent-card.json',
      protocol: 'mcp', // Will be normalized to a2a
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const agentClient = client.agent('test-agent');

    // Protocol should be normalized to a2a
    assert.strictEqual(agentClient.getProtocol(), 'a2a');

    // Canonical URL should strip .well-known/agent-card.json
    assert.strictEqual(agentClient.getCanonicalUrl(), 'https://example.com');
  });

  await t.test('getCanonicalUrl returns base URL for MCP URLs', async () => {
    const agent = {
      id: 'test-mcp',
      name: 'Test MCP Agent',
      agent_uri: 'https://example.com/mcp',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const agentClient = client.agent('test-mcp');

    // Canonical URL should strip /mcp
    assert.strictEqual(agentClient.getCanonicalUrl(), 'https://example.com');
  });

  await t.test('getCanonicalUrl handles trailing slash', async () => {
    const agent = {
      id: 'test-trailing',
      name: 'Test Trailing Slash',
      agent_uri: 'https://example.com/mcp/',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const agentClient = client.agent('test-trailing');

    // Canonical URL should strip /mcp/ (with trailing slash)
    assert.strictEqual(agentClient.getCanonicalUrl(), 'https://example.com');
  });
});

test('Agent Comparison - isSameAgent', async t => {
  await t.test('identifies same agent with different URL formats', async () => {
    const agents = [
      {
        id: 'agent-base',
        name: 'Agent Base',
        agent_uri: 'https://example.com',
        protocol: 'a2a',
        requiresAuth: false,
      },
      {
        id: 'agent-mcp',
        name: 'Agent MCP',
        agent_uri: 'https://example.com/mcp',
        protocol: 'mcp',
        requiresAuth: false,
      },
      {
        id: 'agent-wellknown',
        name: 'Agent Well-Known',
        agent_uri: 'https://example.com/.well-known/agent-card.json',
        protocol: 'a2a',
        requiresAuth: false,
      },
    ];

    const client = new AdCPClient(agents);

    const baseClient = client.agent('agent-base');
    const mcpClient = client.agent('agent-mcp');
    const wellknownClient = client.agent('agent-wellknown');

    // All should be considered the same agent
    assert.strictEqual(baseClient.isSameAgent(mcpClient), true, 'base and mcp should be same agent');
    assert.strictEqual(baseClient.isSameAgent(wellknownClient), true, 'base and wellknown should be same agent');
    assert.strictEqual(mcpClient.isSameAgent(wellknownClient), true, 'mcp and wellknown should be same agent');
  });

  await t.test('distinguishes different agents', async () => {
    const agents = [
      {
        id: 'agent-one',
        name: 'Agent One',
        agent_uri: 'https://agent-one.example.com',
        protocol: 'a2a',
        requiresAuth: false,
      },
      {
        id: 'agent-two',
        name: 'Agent Two',
        agent_uri: 'https://agent-two.example.com',
        protocol: 'a2a',
        requiresAuth: false,
      },
    ];

    const client = new AdCPClient(agents);

    const oneClient = client.agent('agent-one');
    const twoClient = client.agent('agent-two');

    assert.strictEqual(oneClient.isSameAgent(twoClient), false, 'Different agents should not be same');
  });

  await t.test('handles case-insensitive comparison', async () => {
    const agents = [
      {
        id: 'agent-lower',
        name: 'Agent Lower',
        agent_uri: 'https://example.com',
        protocol: 'a2a',
        requiresAuth: false,
      },
      {
        id: 'agent-upper',
        name: 'Agent Upper',
        agent_uri: 'https://EXAMPLE.COM',
        protocol: 'a2a',
        requiresAuth: false,
      },
    ];

    const client = new AdCPClient(agents);

    const lowerClient = client.agent('agent-lower');
    const upperClient = client.agent('agent-upper');

    assert.strictEqual(lowerClient.isSameAgent(upperClient), true, 'URL comparison should be case-insensitive');
  });

  await t.test('compares with raw AgentConfig', async () => {
    const agent = {
      id: 'test-agent',
      name: 'Test Agent',
      agent_uri: 'https://example.com',
      protocol: 'a2a',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const agentClient = client.agent('test-agent');

    // Compare with raw config using different URL format
    const otherConfig = {
      id: 'other-agent',
      name: 'Other Agent',
      agent_uri: 'https://example.com/mcp',
      protocol: 'mcp',
      requiresAuth: false,
    };

    assert.strictEqual(
      agentClient.isSameAgent(otherConfig),
      true,
      'Should compare with raw AgentConfig by canonical URL'
    );
  });
});

test('getAgent returns clean config without internal flags', async t => {
  await t.test('does not include _needsDiscovery flag', async () => {
    const agent = {
      id: 'test-mcp',
      name: 'Test MCP',
      agent_uri: 'https://example.com',
      protocol: 'mcp',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const agentConfig = client.agent('test-mcp').getAgent();

    assert.strictEqual('_needsDiscovery' in agentConfig, false, 'getAgent() should not include _needsDiscovery');
  });

  await t.test('does not include _needsCanonicalUrl flag', async () => {
    const agent = {
      id: 'test-a2a',
      name: 'Test A2A',
      agent_uri: 'https://example.com',
      protocol: 'a2a',
      requiresAuth: false,
    };

    const client = new AdCPClient([agent]);
    const agentConfig = client.agent('test-a2a').getAgent();

    assert.strictEqual('_needsCanonicalUrl' in agentConfig, false, 'getAgent() should not include _needsCanonicalUrl');
  });
});
