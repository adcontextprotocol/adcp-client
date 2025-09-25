#!/usr/bin/env node

/**
 * Production HITL Agents Test Script
 * Tests both A2A and MCP variants of sync/async HITL advertisers
 * 
 * Usage: node test-production-hitl-agents.js
 * 
 * Requires environment variables:
 * - ASYNC_HITL_ADVERTISER_TOKEN
 * - SYNC_HITL_ADVERTISER_TOKEN
 */

const { ADCPMultiAgentClient } = require('./dist/lib');

// Production HITL Configuration  
const PRODUCTION_HITL_AGENTS = {
  sync_a2a: {
    id: 'sync_hitl_advertiser_a2a',
    agent_uri: 'https://test-agent.sales-agent.scope3.com',
    protocol: 'a2a',
    auth_token: process.env.SYNC_HITL_ADVERTISER_TOKEN,
    expectedDelay: '~10s'
  },
  sync_mcp: {
    id: 'sync_hitl_advertiser_mcp', 
    agent_uri: 'https://test-agent.sales-agent.scope3.com/mcp/',
    protocol: 'mcp',
    auth_token: process.env.SYNC_HITL_ADVERTISER_TOKEN,
    expectedDelay: '~10s'
  },
  async_a2a: {
    id: 'async_hitl_advertiser_a2a',
    agent_uri: 'https://test-agent.sales-agent.scope3.com',
    protocol: 'a2a', 
    auth_token: process.env.ASYNC_HITL_ADVERTISER_TOKEN,
    expectedDelay: '~125s'
  },
  async_mcp: {
    id: 'async_hitl_advertiser_mcp',
    agent_uri: 'https://test-agent.sales-agent.scope3.com/mcp/',
    protocol: 'mcp',
    auth_token: process.env.ASYNC_HITL_ADVERTISER_TOKEN,
    expectedDelay: '~125s'
  }
};

async function testProductionHITLAgents() {
  console.log('🧪 Testing Production HITL Advertiser Agents\n');
  
  // Check environment variables
  if (!process.env.SYNC_HITL_ADVERTISER_TOKEN || !process.env.ASYNC_HITL_ADVERTISER_TOKEN) {
    console.error('❌ Missing required environment variables:');
    console.error('   SYNC_HITL_ADVERTISER_TOKEN');
    console.error('   ASYNC_HITL_ADVERTISER_TOKEN');
    console.error('\nCreate .env.production file or set environment variables.');
    process.exit(1);
  }
  
  const results = {
    sync: { a2a: null, mcp: null },
    async: { a2a: null, mcp: null },
    summary: { successes: 0, failures: 0, totalTime: 0 }
  };
  
  // Test each agent configuration
  for (const [key, config] of Object.entries(PRODUCTION_HITL_AGENTS)) {
    const startTime = Date.now();
    console.log(`🔧 Testing ${config.id}`);
    console.log(`   📡 Server: ${config.agent_uri}`);
    console.log(`   🔀 Protocol: ${config.protocol.toUpperCase()}`);
    console.log(`   ⏱️ Expected: ${config.expectedDelay}`);
    
    try {
      // Create client
      const client = new ADCPMultiAgentClient();
      await client.configureAgent(config.id, {
        agent_uri: config.agent_uri,
        protocol: config.protocol,
        auth_token: config.auth_token
      });
      
      // Test get_products call
      const result = await client.executeTask(
        'get_products',
        {
          brief: 'Production HITL test for advertiser agents',
          promoted_offering: 'Test offering for production validation'
        },
        async () => ({ defer: true })
      );
      
      const duration = Date.now() - startTime;
      const [type, protocol] = key.split('_');
      
      results[type][protocol] = {
        success: true,
        duration,
        status: result.status,
        hasData: !!result.data
      };
      
      results.summary.successes++;
      results.summary.totalTime += duration;
      
      console.log(`   ✅ Success (${duration}ms)`);
      console.log(`   📊 Status: ${result.status}`);
      console.log(`   💾 Has Data: ${result.data ? 'Yes' : 'No'}\n`);
      
    } catch (error) {
      const duration = Date.now() - startTime;
      const [type, protocol] = key.split('_');
      
      results[type][protocol] = {
        success: false,
        duration,
        error: error.message
      };
      
      results.summary.failures++;
      results.summary.totalTime += duration;
      
      console.log(`   ❌ Failed (${duration}ms)`);
      console.log(`   🚨 Error: ${error.message}\n`);
    }
  }
  
  // Generate summary report
  console.log('='=50);
  console.log('📊 PRODUCTION HITL AGENTS TEST REPORT');
  console.log('='=50);
  
  console.log(`\n🔢 OVERALL STATISTICS:`);
  console.log(`  ✅ Successes: ${results.summary.successes}`);
  console.log(`  ❌ Failures: ${results.summary.failures}`);
  console.log(`  📈 Success Rate: ${((results.summary.successes / 4) * 100).toFixed(1)}%`);
  console.log(`  ⏱️ Total Time: ${results.summary.totalTime}ms`);
  
  console.log(`\n📋 DETAILED RESULTS:`);
  
  console.log(`\n  Sync Agents (10s delay):`);
  console.log(`    A2A: ${results.sync.a2a?.success ? '✅' : '❌'} ${results.sync.a2a?.success ? results.sync.a2a.duration + 'ms' : results.sync.a2a?.error}`);
  console.log(`    MCP: ${results.sync.mcp?.success ? '✅' : '❌'} ${results.sync.mcp?.success ? results.sync.mcp.duration + 'ms' : results.sync.mcp?.error}`);
  
  console.log(`\n  Async Agents (125s timeout):`);
  console.log(`    A2A: ${results.async.a2a?.success ? '✅' : '❌'} ${results.async.a2a?.success ? results.async.a2a.duration + 'ms' : results.async.a2a?.error}`);
  console.log(`    MCP: ${results.async.mcp?.success ? '✅' : '❌'} ${results.async.mcp?.success ? results.async.mcp.duration + 'ms' : results.async.mcp?.error}`);
  
  if (results.summary.successes === 4) {
    console.log(`\n🏆 All Production HITL Agents Working! 🎉`);
  } else if (results.summary.successes > 0) {
    console.log(`\n🟡 Partial Success - ${results.summary.failures} agent(s) need attention`);
  } else {
    console.log(`\n❌ All agents failed - check configuration and tokens`);
  }
  
  console.log(`\n💡 NEXT STEPS:`);
  if (results.summary.failures > 0) {
    console.log(`  • Check auth tokens are valid and active`);
    console.log(`  • Verify agent endpoints are accessible`);
    console.log(`  • Review error messages above for specific issues`);
  } else {
    console.log(`  • Deploy to production with confidence!`);
    console.log(`  • Monitor agent performance in production dashboard`);
    console.log(`  • Document any timing differences vs expectations`);
  }
  
  console.log(`\n✨ Test completed successfully!`);
}

// Run the test if called directly
if (require.main === module) {
  testProductionHITLAgents().catch(error => {
    console.error('💥 Test runner failed:', error.message);
    process.exit(1);
  });
}

module.exports = { testProductionHITLAgents, PRODUCTION_HITL_AGENTS };