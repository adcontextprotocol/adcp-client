// Unit tests for AdCPClient core functionality
const { test, describe } = require('node:test');
const assert = require('node:assert');

// Import the library - in real tests this would be: const { AdCPClient } = require('@adcp/sdk');
const { AdCPClient, ConfigurationManager, SingleAgentClient } = require('../../dist/lib/index.js');

describe('AdCPClient', () => {
  describe('constructor', () => {
    test('should create empty client when no agents provided', () => {
      const client = new AdCPClient();
      assert.strictEqual(client.getAgentConfigs().length, 0);
    });

    test('should initialize with provided agents', () => {
      const agents = [
        {
          id: 'test-agent',
          name: 'Test Agent',
          agent_uri: 'https://test.example',
          protocol: 'mcp',
        },
      ];

      const client = new AdCPClient(agents);
      assert.strictEqual(client.getAgentConfigs().length, 1);
      assert.strictEqual(client.getAgentConfigs()[0].id, 'test-agent');
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
        auth_token: 'TEST_TOKEN',
      };

      client.addAgent(agent);
      assert.strictEqual(client.getAgentConfigs().length, 1);
      assert.strictEqual(client.getAgentConfigs()[0].id, 'new-agent');
    });

    test('should add agent to existing agents', () => {
      const client = new AdCPClient([
        {
          id: 'existing',
          name: 'Existing',
          agent_uri: 'https://existing.example.com',
          protocol: 'mcp',
        },
      ]);

      client.addAgent({
        id: 'new',
        name: 'New',
        agent_uri: 'https://new.example.com',
        protocol: 'a2a',
      });

      assert.strictEqual(client.getAgentConfigs().length, 2);
      assert.strictEqual(client.getAgentConfigs()[1].id, 'new');
    });
  });

  describe('getAgentConfigs', () => {
    test('should return defensive copy of agents', () => {
      const originalAgent = {
        id: 'test',
        name: 'Test',
        agent_uri: 'https://test.example',
        protocol: 'mcp',
      };

      const client = new AdCPClient([originalAgent]);
      const agents = client.getAgentConfigs();

      // Modify the returned array
      agents.push({
        id: 'hacker',
        name: 'Hacker',
        agent_uri: 'https://evil.example.com',
        protocol: 'mcp',
      });

      // Original client should be unchanged
      assert.strictEqual(client.getAgentConfigs().length, 1);
      assert.strictEqual(client.getAgentConfigs()[0].id, 'test');
    });
  });

  describe('fluent API', () => {
    test('should throw error for non-existent agent', () => {
      const client = new AdCPClient();

      assert.throws(
        () => {
          client.agent('non-existent');
        },
        {
          message: "Agent 'non-existent' not found. Available agents: ",
        }
      );
    });

    test('should return agent client for valid agent', () => {
      const client = new AdCPClient([
        {
          id: 'test-agent',
          name: 'Test Agent',
          agent_uri: 'https://test.example',
          protocol: 'mcp',
        },
      ]);

      const agent = client.agent('test-agent');
      assert.ok(agent);
      // Verify agent has fluent API methods
      assert.ok(typeof agent.getProducts === 'function');
      assert.ok(typeof agent.listCreativeFormatsLegacy === 'function');
      assert.strictEqual(agent.listCreativeFormats, undefined);
      assert.strictEqual(agent.previewCreative, undefined);
      assert.strictEqual(agent.buildCreative, undefined);
      assert.strictEqual(agent.listTransformers, undefined);
      assert.ok(typeof agent.previewCreativeLegacy === 'function');
      assert.ok(typeof agent.buildCreativeLegacy === 'function');
      assert.ok(typeof agent.listTransformersLegacy === 'function');
      assert.strictEqual(agent.listContentStandards, undefined);
      assert.strictEqual(agent.getContentStandards, undefined);
      assert.strictEqual(agent.calibrateContent, undefined);
      assert.strictEqual(agent.validateContentDelivery, undefined);
      assert.ok(typeof agent.listContentStandardsLegacy === 'function');
      assert.ok(typeof agent.getContentStandardsLegacy === 'function');
      assert.ok(typeof agent.calibrateContentLegacy === 'function');
      assert.ok(typeof agent.validateContentDeliveryLegacy === 'function');
      assert.ok(typeof agent.createMediaBuy === 'function');
    });

    test('custom task execution rejects standard and legacy-only AdCP tools before transport', async () => {
      const config = {
        id: 'test-agent',
        name: 'Test Agent',
        agent_uri: 'https://test.example/mcp',
        protocol: 'mcp',
      };
      const client = new AdCPClient([config]);
      const agent = client.agent(config.id);
      const single = new SingleAgentClient(config);

      for (const taskName of [
        'get_products',
        'sync_plans',
        'list_creative_formats',
        'list_transformers',
        'preview_creative',
        'build_creative',
        'list_content_standards',
        'get_content_standards',
        'create_content_standards',
        'update_content_standards',
        'calibrate_content',
        'validate_content_delivery',
        'get_media_buy_artifacts',
        'get_creative_features',
        'get_rights',
        'acquire_rights',
        'update_rights',
      ]) {
        await assert.rejects(
          () => agent.executeCustomTask(taskName, {}),
          /executeCustomTask\(\) cannot execute standard AdCP task/
        );
        await assert.rejects(
          () => single.executeCustomTask(taskName, {}),
          /executeCustomTask\(\) cannot execute standard AdCP task/
        );
      }
    });

    test('should return AgentCollection for multiple agents', () => {
      const client = new AdCPClient([
        {
          id: 'agent1',
          name: 'Agent 1',
          agent_uri: 'https://agent1.example.com',
          protocol: 'mcp',
        },
        {
          id: 'agent2',
          name: 'Agent 2',
          agent_uri: 'https://agent2.example.com',
          protocol: 'a2a',
        },
      ]);

      const agents = client.agents(['agent1', 'agent2']);
      assert.ok(agents);
      // Verify collection has fluent API methods
      assert.ok(typeof agents.getProducts === 'function');
      assert.ok(typeof agents.listCreativeFormatsLegacy === 'function');
      assert.strictEqual(agents.listCreativeFormats, undefined);
    });

    test('should return AgentCollection for all agents', () => {
      const client = new AdCPClient([
        {
          id: 'agent1',
          name: 'Agent 1',
          agent_uri: 'https://agent1.example.com',
          protocol: 'mcp',
        },
      ]);

      const allAgents = client.allAgents();
      assert.ok(allAgents);
      assert.ok(typeof allAgents.getProducts === 'function');
    });

    test('should throw error when calling allAgents on empty client', () => {
      const client = new AdCPClient();

      assert.throws(
        () => {
          client.allAgents();
        },
        {
          message: 'No agents configured. Add agents to the client first.',
        }
      );
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
            agent_uri: 'https://env-test.example',
            protocol: 'mcp',
            auth_token: 'TEST_TOKEN',
          },
        ],
      });

      const agents = ConfigurationManager.loadAgentsFromEnv();

      assert.strictEqual(agents.length, 1);
      assert.strictEqual(agents[0].id, 'env-test');
      assert.strictEqual(agents[0].protocol, 'mcp');
      assert.strictEqual(agents[0].auth_token, 'TEST_TOKEN');

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

      assert.throws(
        () => {
          ConfigurationManager.loadAgentsFromEnv();
        },
        {
          name: 'ConfigurationError',
        }
      );

      // Restore original env var
      if (originalConfig) {
        process.env.SALES_AGENTS_CONFIG = originalConfig;
      } else {
        delete process.env.SALES_AGENTS_CONFIG;
      }
    });
  });
});

describe('factory methods', () => {
  test('fromEnv should create client from environment', () => {
    // Save original env var
    const originalConfig = process.env.SALES_AGENTS_CONFIG;

    process.env.SALES_AGENTS_CONFIG = JSON.stringify({
      agents: [
        {
          id: 'env-agent',
          name: 'Env Agent',
          agent_uri: 'https://env.example.com',
          protocol: 'mcp',
        },
      ],
    });

    const client = AdCPClient.fromEnv();
    assert.ok(client instanceof AdCPClient);
    assert.strictEqual(client.getAgentConfigs().length, 1);
    assert.strictEqual(client.getAgentConfigs()[0].id, 'env-agent');

    // Restore original env var
    if (originalConfig) {
      process.env.SALES_AGENTS_CONFIG = originalConfig;
    } else {
      delete process.env.SALES_AGENTS_CONFIG;
    }
  });
});
