// Unit tests for AdCPClient core functionality
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the library - in real tests this would be: const { AdCPClient } = require('@adcp/client');
const { AdCPClient, ConfigurationManager, createAdCPClient } = require('../../dist/lib/index.js');

describe('AdCPClient', () => {
  
  describe('constructor', () => {
    test('should create empty client when no agents provided', () => {
      const client = new AdCPClient();
      assert.strictEqual(client.getAgents().length, 0);
    });

    test('should initialize with provided agents', () => {
      const agents = [
        {
          id: 'test-agent',
          name: 'Test Agent',
          agent_uri: 'https://test.example.com',
          protocol: 'mcp',
          requiresAuth: false
        }
      ];
      
      const client = new AdCPClient(agents);
      assert.strictEqual(client.getAgents().length, 1);
      assert.strictEqual(client.getAgents()[0].id, 'test-agent');
    });
  });

  describe('addAgent', () => {
    test('should add agent to empty client', () => {
      const client = new AdCPClient();
      const agent = {
        id: 'new-agent',
        name: 'New Agent',
        agent_uri: 'https://new.example.com',
        protocol: 'a2a',
        requiresAuth: true,
        auth_token_env: 'TEST_TOKEN'
      };
      
      client.addAgent(agent);
      assert.strictEqual(client.getAgents().length, 1);
      assert.strictEqual(client.getAgents()[0].id, 'new-agent');
    });

    test('should add agent to existing agents', () => {
      const client = new AdCPClient([
        {
          id: 'existing',
          name: 'Existing',
          agent_uri: 'https://existing.example.com',
          protocol: 'mcp',
          requiresAuth: false
        }
      ]);
      
      client.addAgent({
        id: 'new',
        name: 'New',
        agent_uri: 'https://new.example.com',
        protocol: 'a2a',
        requiresAuth: false
      });
      
      assert.strictEqual(client.getAgents().length, 2);
      assert.strictEqual(client.getAgents()[1].id, 'new');
    });
  });

  describe('getAgents', () => {
    test('should return defensive copy of agents', () => {
      const originalAgent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://test.example.com',
        protocol: 'mcp',
        requiresAuth: false
      };
      
      const client = new AdCPClient([originalAgent]);
      const agents = client.getAgents();
      
      // Modify the returned array
      agents.push({
        id: 'hacker',
        name: 'Hacker',
        agent_uri: 'https://evil.example.com',
        protocol: 'mcp',
        requiresAuth: false
      });
      
      // Original client should be unchanged
      assert.strictEqual(client.getAgents().length, 1);
      assert.strictEqual(client.getAgents()[0].id, 'test');
    });
  });

  describe('fluent API', () => {
    test('should throw error for non-existent agent', () => {
      const client = new AdCPClient();
      
      assert.throws(() => {
        client.agent('non-existent');
      }, {
        message: "Agent 'non-existent' not found. Available agents: "
      });
    });

    test('should return Agent instance for valid agent', () => {
      const client = new AdCPClient([
        {
          id: 'test-agent',
          name: 'Test Agent',
          agent_uri: 'https://test.example.com',
          protocol: 'mcp',
          requiresAuth: false
        }
      ]);
      
      const agent = client.agent('test-agent');
      assert.ok(agent);
      // Verify agent has fluent API methods
      assert.ok(typeof agent.getProducts === 'function');
      assert.ok(typeof agent.listCreativeFormats === 'function');
      assert.ok(typeof agent.createMediaBuy === 'function');
    });

    test('should return AgentCollection for multiple agents', () => {
      const client = new AdCPClient([
        {
          id: 'agent1',
          name: 'Agent 1',
          agent_uri: 'https://agent1.example.com',
          protocol: 'mcp',
          requiresAuth: false
        },
        {
          id: 'agent2',
          name: 'Agent 2',
          agent_uri: 'https://agent2.example.com',
          protocol: 'a2a',
          requiresAuth: false
        }
      ]);
      
      const agents = client.agents(['agent1', 'agent2']);
      assert.ok(agents);
      // Verify collection has fluent API methods
      assert.ok(typeof agents.getProducts === 'function');
      assert.ok(typeof agents.listCreativeFormats === 'function');
    });

    test('should return AgentCollection for all agents', () => {
      const client = new AdCPClient([
        {
          id: 'agent1',
          name: 'Agent 1', 
          agent_uri: 'https://agent1.example.com',
          protocol: 'mcp',
          requiresAuth: false
        }
      ]);
      
      const allAgents = client.allAgents();
      assert.ok(allAgents);
      assert.ok(typeof allAgents.getProducts === 'function');
    });

    test('should throw error when calling allAgents on empty client', () => {
      const client = new AdCPClient();
      
      assert.throws(() => {
        client.allAgents();
      }, {
        message: 'No agents configured. Add agents to the client first.'
      });
    });
  });

  describe('getStandardFormats', () => {
    test('should return array of creative formats', () => {
      const client = new AdCPClient();
      const formats = client.getStandardFormats();
      
      assert.ok(Array.isArray(formats));
      assert.ok(formats.length > 0);
      
      // Check first format has required fields
      const firstFormat = formats[0];
      assert.ok(firstFormat.format_id);
      assert.ok(firstFormat.name);
      assert.ok(firstFormat.dimensions);
      assert.ok(typeof firstFormat.dimensions.width === 'number');
      assert.ok(typeof firstFormat.dimensions.height === 'number');
      assert.ok(Array.isArray(firstFormat.file_types));
      assert.ok(typeof firstFormat.max_file_size === 'number');
    });
  });
});

describe('ConfigurationManager', () => {
  
  describe('loadAgentsFromEnv', () => {
    test('should return empty array when no config env var', () => {
      // Save original env var
      const originalConfig = process.env.SALES_AGENTS_CONFIG;
      delete process.env.SALES_AGENTS_CONFIG;
      
      const agents = ConfigurationManager.loadAgentsFromEnv();
      
      assert.ok(Array.isArray(agents));
      assert.strictEqual(agents.length, 0);
      
      // Restore original env var
      if (originalConfig) {
        process.env.SALES_AGENTS_CONFIG = originalConfig;
      }
    });

    test('should parse valid JSON config', () => {
      // Save original env var
      const originalConfig = process.env.SALES_AGENTS_CONFIG;
      
      process.env.SALES_AGENTS_CONFIG = JSON.stringify({
        agents: [
          {
            id: 'env-test',
            name: 'Env Test Agent',
            agent_uri: 'https://env-test.example.com',
            protocol: 'mcp',
            requiresAuth: true,
            auth_token_env: 'TEST_TOKEN'
          }
        ]
      });
      
      const agents = ConfigurationManager.loadAgentsFromEnv();
      
      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].id, 'env-test');
      assert.strictEqual(agents[0].protocol, 'mcp');
      assert.strictEqual(agents[0].requiresAuth, true);
      
      // Restore original env var
      if (originalConfig) {
        process.env.SALES_AGENTS_CONFIG = originalConfig;
      } else {
        delete process.env.SALES_AGENTS_CONFIG;
      }
    });

    test('should handle invalid JSON gracefully', () => {
      // Save original env var
      const originalConfig = process.env.SALES_AGENTS_CONFIG;
      
      process.env.SALES_AGENTS_CONFIG = 'invalid json {';
      
      assert.throws(() => {
        ConfigurationManager.loadAgentsFromEnv();
      }, {
        name: 'ConfigurationError'
      });
      
      // Restore original env var
      if (originalConfig) {
        process.env.SALES_AGENTS_CONFIG = originalConfig;
      } else {
        delete process.env.SALES_AGENTS_CONFIG;
      }
    });
  });
});

describe('convenience functions', () => {
  
  test('createAdCPClient should create AdCPClient instance', () => {
    const client = createAdCPClient();
    assert.ok(client instanceof AdCPClient);
    assert.strictEqual(client.getAgents().length, 0);
  });

  test('createAdCPClient should accept agents parameter', () => {
    const agents = [
      {
        id: 'convenience-test',
        name: 'Convenience Test',
        agent_uri: 'https://convenience.example.com',
        protocol: 'mcp',
        requiresAuth: false
      }
    ];
    
    const client = createAdCPClient(agents);
    assert.ok(client instanceof AdCPClient);
    assert.strictEqual(client.getAgents().length, 1);
    assert.strictEqual(client.getAgents()[0].id, 'convenience-test');
  });
});