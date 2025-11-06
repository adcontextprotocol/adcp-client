#!/usr/bin/env node

/**
 * E2E Tests for AdCP Client Library
 * Tests both A2A and MCP protocol implementations
 *
 * Run with: node test/e2e/adcp-e2e.test.js
 */

const http = require('http');
const assert = require('assert');

const SERVER_BASE = 'http://127.0.0.1:3000';

class AdCPE2ETest {
  constructor() {
    this.results = [];
    this.agents = [];
  }

  async makeRequest(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, SERVER_BASE);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = http.request(options, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, data, raw: true });
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const icons = { info: 'ℹ️', success: '✅', error: '❌', warning: '⚠️' };
    console.log(`${icons[type] || 'ℹ️'} [${timestamp}] ${message}`);
  }

  async test(name, fn) {
    try {
      this.log(`Starting test: ${name}`);
      await fn();
      this.results.push({ name, status: 'PASS' });
      this.log(`Test PASSED: ${name}`, 'success');
    } catch (error) {
      this.results.push({ name, status: 'FAIL', error: error.message });
      this.log(`Test FAILED: ${name} - ${error.message}`, 'error');
    }
  }

  async setup() {
    this.log('Setting up E2E tests...');

    // Fetch available agents
    const result = await this.makeRequest('/api/sales/agents');
    assert.strictEqual(result.status, 200, 'Failed to fetch agents');
    assert.strictEqual(result.data.success, true, 'Agents API returned failure');

    this.agents = result.data.data.agents;
    this.log(`Found ${this.agents.length} agents for testing`);

    for (const agent of this.agents) {
      this.log(`  - ${agent.name} (${agent.protocol.toUpperCase()}): ${agent.id}`);
    }
  }

  async testServerHealth() {
    const result = await this.makeRequest('/api/health');
    assert.strictEqual(result.status, 200, 'Health check failed');
    this.log('Server health check passed');
  }

  async testAgentsEndpoint() {
    const result = await this.makeRequest('/api/sales/agents');
    assert.strictEqual(result.status, 200, 'Agents endpoint failed');
    assert.strictEqual(result.data.success, true, 'Agents response not successful');
    assert(Array.isArray(result.data.data.agents), 'Agents not returned as array');
    assert(result.data.data.agents.length > 0, 'No agents returned');
  }

  async testToolCall(agent, toolName, params = {}) {
    const requestBody = {
      tool: toolName,
      brief: `E2E test call for ${toolName}`,
      params,
    };

    const result = await this.makeRequest(`/api/sales/agents/${agent.id}/query`, 'POST', requestBody);

    assert.strictEqual(result.status, 200, `Tool call ${toolName} failed with status ${result.status}`);
    assert.strictEqual(result.data.success, true, `Tool call ${toolName} returned failure response`);

    this.log(`Tool call ${toolName} successful for ${agent.name} (${agent.protocol})`);
    return result.data;
  }

  async testAllToolsForAgent(agent) {
    const tools = ['get_products', 'list_creative_formats', 'list_creatives'];
    const results = {};

    for (const tool of tools) {
      try {
        results[tool] = await this.testToolCall(agent, tool);
      } catch (error) {
        this.log(`Tool ${tool} failed for ${agent.name}: ${error.message}`, 'warning');
        results[tool] = { error: error.message };
      }
    }

    return results;
  }

  async testLoadAgentDataSequence() {
    for (const agent of this.agents) {
      await this.test(`Load Agent Data Sequence - ${agent.name} (${agent.protocol})`, async () => {
        this.log(`Testing Load Agent Data sequence for ${agent.name}`);

        // Simulate the exact sequence that "Load Agent Data" button triggers
        const tools = [
          { name: 'list_creative_formats', description: 'Creative Formats' },
          { name: 'list_creatives', description: 'Creatives' },
          { name: 'get_products', description: 'Products' },
        ];

        const results = [];

        for (const tool of tools) {
          this.log(`  Calling ${tool.description} (${tool.name})...`);
          const result = await this.testToolCall(agent, tool.name);
          results.push({ tool: tool.name, result });

          // Small delay to simulate real usage
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Verify all calls were made with correct tool names
        assert.strictEqual(results.length, 3, 'Expected 3 tool calls');
        assert.strictEqual(results[0].tool, 'list_creative_formats', 'First call should be list_creative_formats');
        assert.strictEqual(results[1].tool, 'list_creatives', 'Second call should be list_creatives');
        assert.strictEqual(results[2].tool, 'get_products', 'Third call should be get_products');

        this.log(`  All 3 tools called successfully for ${agent.name}`, 'success');
      });
    }
  }

  async testProtocolSpecificFeatures() {
    const a2aAgents = this.agents.filter(a => a.protocol === 'a2a');
    const mcpAgents = this.agents.filter(a => a.protocol === 'mcp');

    await this.test('A2A Protocol Support', async () => {
      assert(a2aAgents.length > 0, 'No A2A agents available for testing');

      for (const agent of a2aAgents) {
        await this.testToolCall(agent, 'get_products');
        this.log(`A2A agent ${agent.name} responded correctly`);
      }
    });

    await this.test('MCP Protocol Support', async () => {
      assert(mcpAgents.length > 0, 'No MCP agents available for testing');

      for (const agent of mcpAgents) {
        await this.testToolCall(agent, 'get_products');
        this.log(`MCP agent ${agent.name} responded correctly`);
      }
    });
  }

  async testParameterVariations() {
    const agent = this.agents[0];

    await this.test('Parameter Name Variations', async () => {
      // Test different parameter names
      const variations = [
        { body: { tool: 'get_products' }, description: 'tool parameter' },
        { body: { toolName: 'get_products' }, description: 'toolName parameter' },
        { body: { tool_name: 'get_products' }, description: 'tool_name parameter' },
      ];

      for (const variation of variations) {
        const result = await this.makeRequest(`/api/sales/agents/${agent.id}/query`, 'POST', variation.body);
        assert.strictEqual(result.status, 200, `Failed with ${variation.description}`);
        assert.strictEqual(result.data.success, true, `Unsuccessful response with ${variation.description}`);
        this.log(`  ${variation.description} works correctly`);
      }
    });

    await this.test('Missing Tool Parameter Error', async () => {
      const result = await this.makeRequest(`/api/sales/agents/${agent.id}/query`, 'POST', {});
      assert.strictEqual(result.status, 400, 'Should return 400 for missing tool parameter');
      assert.strictEqual(result.data.success, false, 'Should return failure for missing tool parameter');
      assert(
        result.data.error.includes('Missing required parameter'),
        'Error message should mention missing parameter'
      );
    });
  }

  async testErrorHandling() {
    await this.test('Invalid Agent ID', async () => {
      const result = await this.makeRequest('/api/sales/agents/invalid-agent-id/query', 'POST', {
        tool: 'get_products',
      });
      // Should handle gracefully, either 404 or error response
      assert(
        result.status === 404 || (result.status === 200 && result.data.success === false),
        'Should handle invalid agent ID gracefully'
      );
    });

    await this.test('Invalid Tool Name', async () => {
      const agent = this.agents[0];
      const result = await this.makeRequest(`/api/sales/agents/${agent.id}/query`, 'POST', {
        tool: 'invalid_tool_name',
      });
      // Should return an error for unknown tools
      assert(
        result.status >= 400 || (result.status === 200 && result.data.success === false),
        'Should handle invalid tool names gracefully'
      );
    });
  }

  async runAllTests() {
    this.log('🚀 Starting AdCP E2E Test Suite');

    try {
      await this.setup();

      await this.test('Server Health Check', () => this.testServerHealth());
      await this.test('Agents Endpoint', () => this.testAgentsEndpoint());

      await this.testLoadAgentDataSequence();
      await this.testProtocolSpecificFeatures();
      await this.testParameterVariations();
      await this.testErrorHandling();
    } catch (error) {
      this.log(`Setup failed: ${error.message}`, 'error');
      return;
    }

    this.printResults();
  }

  printResults() {
    this.log('\n📊 Test Results Summary:');
    console.log('='.repeat(60));

    const passed = this.results.filter(r => r.status === 'PASS').length;
    const failed = this.results.filter(r => r.status === 'FAIL').length;

    this.results.forEach(result => {
      const icon = result.status === 'PASS' ? '✅' : '❌';
      console.log(`${icon} ${result.name}`);
      if (result.error) {
        console.log(`     Error: ${result.error}`);
      }
    });

    console.log('='.repeat(60));
    console.log(`📈 Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

    if (failed === 0) {
      this.log('🎉 All tests passed!', 'success');
    } else {
      this.log(`⚠️ ${failed} test(s) failed`, 'warning');
      process.exit(1);
    }
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  const testSuite = new AdCPE2ETest();
  testSuite.runAllTests().catch(console.error);
}

module.exports = AdCPE2ETest;
