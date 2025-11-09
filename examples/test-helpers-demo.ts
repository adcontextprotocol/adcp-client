#!/usr/bin/env tsx
// Test Helpers Demo - Using Pre-configured Test Agents
// This example shows how to use the built-in test helpers for quick testing and examples

import { testAgent, testAgentA2A, testAgentClient, createTestAgent, ADCPMultiAgentClient } from '../src/lib';

/**
 * Example 1: Simplest Possible Usage
 * Use the pre-configured test agent directly - no setup needed!
 */
async function simplestExample() {
  console.log('🎯 Example 1: Simplest Usage with testAgent');
  console.log('===========================================\n');

  try {
    // Just import and use - that's it!
    const result = await testAgent.getProducts({
      brief: 'Premium coffee subscription service',
      promoted_offering: 'Artisan coffee deliveries',
    });

    if (result.success) {
      console.log(`✅ Success! Found ${result.data.products?.length || 0} products`);
      console.log(`   Response time: ${result.metadata.responseTimeMs}ms`);
      console.log(`   Protocol: MCP\n`);
    } else {
      console.log(`❌ Error: ${result.error}\n`);
    }
  } catch (error: any) {
    console.log(`❌ Network error: ${error.message}\n`);
  }
}

/**
 * Example 2: Testing Both Protocols
 * Use both A2A and MCP test agents to compare behavior
 */
async function protocolComparison() {
  console.log('🔄 Example 2: Protocol Comparison (A2A vs MCP)');
  console.log('==============================================\n');

  const request = {
    brief: 'Sustainable fashion brands',
    promoted_offering: 'Eco-friendly clothing',
  };

  try {
    console.log('Testing MCP protocol...');
    const mcpResult = await testAgent.getProducts(request);
    console.log(`  MCP: ${mcpResult.success ? '✅' : '❌'} ${mcpResult.metadata.responseTimeMs}ms`);

    console.log('Testing A2A protocol...');
    const a2aResult = await testAgentA2A.getProducts(request);
    console.log(`  A2A: ${a2aResult.success ? '✅' : '❌'} ${a2aResult.metadata.responseTimeMs}ms\n`);
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Example 3: Multi-Agent Testing
 * Use the testAgentClient for parallel operations
 */
async function multiAgentExample() {
  console.log('🌐 Example 3: Multi-Agent Operations');
  console.log('====================================\n');

  try {
    console.log(`Testing with ${testAgentClient.agentCount} agents in parallel...`);

    // Run the same query on both agents in parallel
    const results = await testAgentClient.allAgents().getProducts({
      brief: 'Tech gadgets for remote work',
      promoted_offering: 'Ergonomic workspace solutions',
    });

    console.log('\nResults:');
    results.forEach((result, i) => {
      console.log(`  ${i + 1}. ${result.success ? '✅' : '❌'} ${result.metadata.responseTimeMs}ms`);
    });
    console.log();
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Example 4: AI Test Orchestration
 * Use natural language instructions to control test behavior
 */
async function aiTestOrchestration() {
  console.log('🤖 Example 4: AI Test Orchestration');
  console.log('===================================\n');

  try {
    // Test with a delay instruction
    console.log('Testing delayed response...');
    const delayResult = await testAgent.createMediaBuy({
      brief: 'Test campaign',
      promoted_offering: 'Wait 10 seconds before responding', // AI understands this!
      products: ['prod_test_001'],
      budget: 10000,
    });

    console.log(`  Result: ${delayResult.success ? '✅ Success' : '❌ Failed'}`);
    console.log(`  Time: ${delayResult.metadata.responseTimeMs}ms`);

    // Test with a rejection instruction
    console.log('\nTesting rejection scenario...');
    const rejectResult = await testAgent.createMediaBuy({
      brief: 'Test campaign',
      promoted_offering: 'Reject this media buy with reason: Budget exceeds inventory',
      products: ['prod_test_001'],
      budget: 999999,
    });

    console.log(`  Result: ${rejectResult.success ? '✅ Success' : '❌ Failed'}`);
    if (!rejectResult.success) {
      console.log(`  Reason: ${rejectResult.error}`);
    }
    console.log();
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Example 5: Custom Test Agent Configuration
 * Create a custom test agent with modifications
 */
async function customTestAgent() {
  console.log('⚙️  Example 5: Custom Test Agent Configuration');
  console.log('==============================================\n');

  // Create a custom config with your own ID
  const customConfig = createTestAgent({
    id: 'my-custom-test',
    name: 'My Custom Test Agent',
  });

  console.log('Created custom config:');
  console.log(`  ID: ${customConfig.id}`);
  console.log(`  Name: ${customConfig.name}`);
  console.log(`  Protocol: ${customConfig.protocol}`);
  console.log(`  URI: ${customConfig.agent_uri}\n`);

  // Use it with a client
  const client = new ADCPMultiAgentClient([customConfig]);
  const agent = client.agent('my-custom-test');

  try {
    const result = await agent.getProducts({
      brief: 'Travel packages',
      promoted_offering: 'European vacations',
    });

    console.log(`Result: ${result.success ? '✅ Success' : '❌ Failed'}`);
    console.log();
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Example 6: Testing Different Operations
 * Show various ADCP operations with test agents
 */
async function variousOperations() {
  console.log('🎬 Example 6: Various ADCP Operations');
  console.log('=====================================\n');

  try {
    // Get products
    console.log('1. Getting products...');
    const products = await testAgent.getProducts({
      brief: 'Coffee brands',
      promoted_offering: 'Premium coffee',
    });
    console.log(`   ${products.success ? '✅' : '❌'} Products: ${products.data.products?.length || 0}`);

    // List creative formats
    console.log('2. Listing creative formats...');
    const formats = await testAgent.listCreativeFormats({});
    console.log(`   ${formats.success ? '✅' : '❌'} Formats: ${formats.data.formats?.length || 0}`);

    // Create a media buy
    console.log('3. Creating media buy...');
    const mediaBuy = await testAgent.createMediaBuy({
      brief: 'Test campaign',
      promoted_offering: 'Test offering',
      products: ['prod_test_001'],
      budget: 5000,
    });
    console.log(`   ${mediaBuy.success ? '✅' : '❌'} Media buy: ${mediaBuy.data.media_buy_id || 'none'}`);

    console.log();
  } catch (error: any) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Main function - run all examples
 */
async function main() {
  console.log('\n📚 ADCP Test Helpers - Demo Examples');
  console.log('=====================================');
  console.log('These examples show how to use pre-configured test agents\n');

  await simplestExample();
  await protocolComparison();
  await multiAgentExample();
  await aiTestOrchestration();
  await customTestAgent();
  await variousOperations();

  console.log('💡 Key Takeaways:');
  console.log('   • testAgent = Pre-configured MCP test agent (ready to use!)');
  console.log('   • testAgentA2A = Pre-configured A2A test agent');
  console.log('   • testAgentClient = Multi-agent client with both protocols');
  console.log('   • createTestAgent() = Create custom test configurations');
  console.log('   • Perfect for examples, docs, and quick testing');
  console.log('\n⚠️  Remember: Test agents are rate-limited and for testing only!');
  console.log('   DO NOT use in production applications.\n');
}

// Run examples if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export {
  simplestExample,
  protocolComparison,
  multiAgentExample,
  aiTestOrchestration,
  customTestAgent,
  variousOperations,
};
