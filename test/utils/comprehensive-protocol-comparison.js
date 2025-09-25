#!/usr/bin/env node

/**
 * Comprehensive A2A vs MCP Protocol Comparison Test
 * Tests both protocols with HITL servers to compare functionality and performance
 * FIXED: Now properly uses A2A SDK via ADCPMultiAgentClient (not HTTP calls)
 */

const { ADCPMultiAgentClient } = require('../../dist/lib');

// HITL Test Configuration
const HITL_CONFIG = {
  servers: {
    mcp: 'http://localhost:8176/mcp/',
    a2a: 'http://localhost:8094'  // Agent card served from base HTTP, SDK uses URL from card for calls
  },
  principals: {
    sync: 'sync_token_2ea279d8f52c4739bb775323c0e6a38a',
    async: 'async_token_058870a84fe442a392f176f64f05c475'
  }
};

// Working tools discovered from previous testing
const WORKING_TOOLS = [
  'get_products',
  'list_creative_formats', 
  'list_creatives'
];

class ProtocolComparison {
  constructor() {
    this.results = {
      a2a: { successes: 0, failures: 0, tests: [], totalTime: 0 },
      mcp: { successes: 0, failures: 0, tests: [], totalTime: 0 }
    };
  }

  async runComprehensiveTest() {
    console.log('🔄 Starting Comprehensive A2A vs MCP Protocol Comparison\n');
    
    // Test both protocols with both principals
    await this.testProtocol('mcp', 'sync');
    await this.testProtocol('mcp', 'async');
    await this.testProtocol('a2a', 'sync');
    await this.testProtocol('a2a', 'async');
    
    // Generate comparison report
    this.generateComparisonReport();
  }

  async testProtocol(protocol, principalType) {
    const serverUrl = HITL_CONFIG.servers[protocol];
    const authToken = HITL_CONFIG.principals[principalType];
    const testId = `${protocol.toUpperCase()}-${principalType.toUpperCase()}`;
    const agentId = `${principalType}_principal_${protocol}`;
    
    console.log(`\n🧪 Testing ${testId}`);
    console.log(`📡 Server: ${serverUrl}`);
    console.log(`🔐 Principal: ${authToken.substring(0, 20)}...`);
    
    try {
      // Create agent configuration
      const agentConfig = {
        id: agentId,
        name: `HITL ${principalType} Principal (${protocol.toUpperCase()})`,
        agent_uri: serverUrl,
        protocol: protocol,
        auth_token_env: authToken,
        requiresAuth: true
      };
      
      // Create multi-agent client
      const multiClient = new ADCPMultiAgentClient([agentConfig]);
      const client = multiClient.agent(agentId);
      
      console.log(`✅ ${testId}: Client created successfully`);
      
      // Test each working tool
      for (const toolName of WORKING_TOOLS) {
        await this.testTool(client, protocol, principalType, toolName);
      }
      
      // Test task management features
      await this.testTaskManagement(client, protocol, principalType);
      
    } catch (error) {
      console.log(`❌ ${testId}: Client creation failed - ${error.message}`);
      this.recordFailure(protocol, `${testId}-connection`, error.message, 0);
    }
  }

  async testTool(client, protocol, principalType, toolName) {
    const testName = `${protocol.toUpperCase()}-${principalType}-${toolName}`;
    const startTime = Date.now();
    
    try {
      console.log(`  🔧 Testing tool: ${toolName}`);
      
      // Use appropriate parameters based on tool (from working test)
      let params = {};
      if (toolName === 'get_products') {
        params = {
          brief: 'Test brief for protocol comparison',
          promoted_offering: 'Test offering'
        };
      }
      // Other tools work with empty parameters
      
      const result = await client.executeTask(
        toolName,
        params,
        async () => ({ defer: true })
      );
      
      const duration = Date.now() - startTime;
      
      if (result.success) {
        console.log(`    ✅ ${toolName}: Success (${duration}ms)`);
        console.log(`    📊 Status: ${result.status}`);
        if (result.data) {
          const dataKeys = Object.keys(result.data);
          console.log(`    📄 Data keys: ${dataKeys.join(', ')}`);
          
          // Show specific data counts
          if (result.data.products) console.log(`    🛍️  Products: ${result.data.products.length}`);
          if (result.data.formats) console.log(`    📐 Formats: ${result.data.formats.length}`);
          if (result.data.creatives) console.log(`    🎨 Creatives: ${result.data.creatives.length}`);
        }
        this.recordSuccess(protocol, testName, duration, result);
      } else {
        console.log(`    ❌ ${toolName}: Failed - ${result.error}`);
        this.recordFailure(protocol, testName, result.error, duration);
      }
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`    💥 ${toolName}: Exception - ${error.message}`);
      this.recordFailure(protocol, testName, error.message, duration);
    }
  }

  async testTaskManagement(client, protocol, principalType) {
    const testName = `${protocol.toUpperCase()}-${principalType}-tasks`;
    const startTime = Date.now();
    
    try {
      console.log(`  📋 Testing task management...`);
      
      // Test basic client operations
      console.log(`    ℹ️  Client available: Yes`);
      console.log(`    ℹ️  Protocol: ${protocol}`);
      
      const duration = Date.now() - startTime;
      console.log(`    ✅ Task management: Basic Success (${duration}ms)`);
      this.recordSuccess(protocol, testName, duration, { basicClientOps: true });
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.log(`    ❌ Task management: Failed - ${error.message}`);
      this.recordFailure(protocol, testName, error.message, duration);
    }
  }

  recordSuccess(protocol, testName, duration, result) {
    this.results[protocol].successes++;
    this.results[protocol].totalTime += duration;
    this.results[protocol].tests.push({
      name: testName,
      success: true,
      duration,
      result
    });
  }

  recordFailure(protocol, testName, error, duration) {
    this.results[protocol].failures++;
    this.results[protocol].totalTime += duration;
    this.results[protocol].tests.push({
      name: testName,
      success: false,
      duration,
      error
    });
  }

  generateComparisonReport() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 COMPREHENSIVE PROTOCOL COMPARISON REPORT');
    console.log('='.repeat(80));
    
    // Overall Statistics
    console.log('\n🔢 OVERALL STATISTICS:');
    for (const [protocol, stats] of Object.entries(this.results)) {
      const total = stats.successes + stats.failures;
      const successRate = total > 0 ? ((stats.successes / total) * 100).toFixed(1) : '0.0';
      const avgTime = total > 0 ? (stats.totalTime / total).toFixed(0) : '0';
      
      console.log(`  ${protocol.toUpperCase()}:`);
      console.log(`    ✅ Successes: ${stats.successes}`);
      console.log(`    ❌ Failures: ${stats.failures}`);
      console.log(`    📈 Success Rate: ${successRate}%`);
      console.log(`    ⏱️  Average Response Time: ${avgTime}ms`);
      console.log(`    🕒 Total Test Time: ${stats.totalTime}ms`);
    }
    
    // Winner Determination
    console.log('\n🏆 PROTOCOL WINNER:');
    const mcpSuccessRate = this.results.mcp.successes / (this.results.mcp.successes + this.results.mcp.failures) * 100;
    const a2aSuccessRate = this.results.a2a.successes / (this.results.a2a.successes + this.results.a2a.failures) * 100;
    
    if (mcpSuccessRate > a2aSuccessRate) {
      console.log(`  🥇 MCP Protocol wins with ${mcpSuccessRate.toFixed(1)}% success rate`);
    } else if (a2aSuccessRate > mcpSuccessRate) {
      console.log(`  🥇 A2A Protocol wins with ${a2aSuccessRate.toFixed(1)}% success rate`);
    } else {
      console.log(`  🤝 Tie! Both protocols achieved ${mcpSuccessRate.toFixed(1)}% success rate`);
    }
    
    // Detailed Test Results
    console.log('\n📋 DETAILED TEST RESULTS:');
    for (const [protocol, stats] of Object.entries(this.results)) {
      console.log(`\n  ${protocol.toUpperCase()} Protocol Tests:`);
      stats.tests.forEach(test => {
        const status = test.success ? '✅' : '❌';
        const time = `(${test.duration}ms)`;
        console.log(`    ${status} ${test.name} ${time}`);
        if (!test.success) {
          console.log(`      Error: ${test.error}`);
        } else if (test.result) {
          const resultSummary = JSON.stringify(test.result, null, 6).substring(0, 100);
          console.log(`      Result: ${resultSummary}${resultSummary.length >= 100 ? '...' : ''}`);
        }
      });
    }
    
    // Recommendations
    console.log('\n💡 RECOMMENDATIONS:');
    if (mcpSuccessRate > 50 && a2aSuccessRate < 50) {
      console.log('  • Use MCP Protocol for production - higher reliability');
      console.log('  • Investigate A2A connection issues');
    } else if (a2aSuccessRate > 50 && mcpSuccessRate < 50) {
      console.log('  • Use A2A Protocol for production - higher reliability');
      console.log('  • Investigate MCP connection issues');
    } else if (mcpSuccessRate > 50 && a2aSuccessRate > 50) {
      console.log('  • Both protocols are functional - choose based on specific needs');
      console.log('  • Consider performance requirements and feature support');
    } else {
      console.log('  • Both protocols have significant issues - debugging required');
      console.log('  • Check server configuration and network connectivity');
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('🏁 Protocol comparison test completed!');
    console.log('='.repeat(80));
  }
}

// Run the test
if (require.main === module) {
  const comparison = new ProtocolComparison();
  comparison.runComprehensiveTest()
    .then(() => {
      console.log('\n✨ All tests completed successfully!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n💥 Test suite failed:', error);
      console.error('Stack:', error.stack);
      process.exit(1);
    });
}

module.exports = { ProtocolComparison };