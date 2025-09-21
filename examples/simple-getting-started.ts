#!/usr/bin/env tsx
// Simple Getting Started Example - Your First ADCP Client
// This example shows the absolute simplest way to use the ADCP client library

import {
  ADCPMultiAgentClient,
  createFieldHandler,
  type AgentConfig
} from '../src/lib';

/**
 * Example 1: Absolute Simplest Usage
 * This shows how to make your first ADCP call with minimal setup
 */
async function gettingStarted() {
  console.log('🚀 ADCP Client Library - Getting Started');
  console.log('=====================================\n');

  // Step 1: Configure your ADCP agent
  console.log('Step 1: Setting up your ADCP agent...');
  
  const agents: AgentConfig[] = [
    {
      id: 'demo-agent',
      name: 'Demo Advertising Agent',
      agent_uri: 'https://demo-agent.adcontextprotocol.org', // This would be your real agent URL
      protocol: 'mcp'
    }
  ];

  const client = new ADCPMultiAgentClient(agents);
  console.log(`✅ Connected to ${client.agentCount} agent(s)\n`);

  // Step 2: Make your first ADCP call
  console.log('Step 2: Asking for advertising products...');
  
  try {
    const agent = client.agent('demo-agent');
    
    // This is the simplest possible ADCP call
    const result = await agent.getProducts({
      brief: 'Coffee subscription service targeting busy professionals',
      promoted_offering: 'Premium monthly coffee deliveries'
    });

    if (result.success) {
      console.log(`✅ Success! Found ${result.data.products?.length || 0} advertising products`);
      console.log(`   Response time: ${result.metadata.responseTimeMs}ms`);
      
      // Show first few products
      result.data.products?.slice(0, 3).forEach((product, i) => {
        console.log(`   ${i + 1}. ${product.name} - ${product.publisher}`);
      });
    } else {
      console.log(`❌ Error: ${result.error}`);
    }
  } catch (error) {
    console.log(`❌ Network error: ${error.message}`);
    console.log('\n💡 This is expected with demo URLs. In real usage, you\'d use actual agent endpoints.');
  }

  console.log('\n🎉 That\'s it! You\'ve made your first ADCP call.\n');
}

/**
 * Example 2: Adding Smart Responses
 * This shows how to handle agent clarifications automatically
 */
async function withSmartHandler() {
  console.log('📚 Example 2: Adding Smart Clarification Handling');
  console.log('===============================================\n');

  const client = new ADCPMultiAgentClient([
    {
      id: 'fashion-agent',
      name: 'Fashion Network Agent',
      agent_uri: 'https://fashion-network.example.com',
      protocol: 'mcp'
    }
  ]);

  // Create a handler for common agent questions
  const smartHandler = createFieldHandler({
    budget: 25000,                    // Auto-answer budget questions
    targeting: ['US', 'CA', 'UK'],    // Auto-answer geographic targeting
    approval: true,                   // Auto-approve when asked
    timeframe: '30 days'              // Campaign duration
  });

  console.log('✨ Created smart handler for automatic responses');
  console.log('   - Budget questions → $25,000');
  console.log('   - Targeting questions → US, CA, UK');
  console.log('   - Approval questions → Yes');
  console.log('   - Timeframe questions → 30 days\n');

  try {
    const agent = client.agent('fashion-agent');
    
    console.log('🎯 Requesting products with smart handler...');
    const result = await agent.getProducts({
      brief: 'Sustainable fashion brands for environmentally conscious millennials',
      promoted_offering: 'Eco-friendly clothing and accessories'
    }, smartHandler); // <-- Handler will auto-respond to agent clarifications

    if (result.success) {
      console.log(`✅ Smart handler success! ${result.metadata.clarificationRounds} clarifications handled automatically`);
      console.log(`   Found ${result.data.products?.length || 0} products`);
    }
  } catch (error) {
    console.log(`❌ Expected error with demo URL: ${error.message}`);
  }

  console.log('\n💡 In production, the agent might ask clarifying questions like:');
  console.log('   "What\'s your budget for this campaign?"');
  console.log('   "Which geographic regions should we target?"');
  console.log('   "Do you approve this targeting strategy?"');
  console.log('   → Your handler automatically provides the answers!\n');
}

/**
 * Example 3: Real-World Workflow
 * This shows a complete campaign planning workflow
 */
async function campaignWorkflow() {
  console.log('🏗️  Example 3: Complete Campaign Planning Workflow');
  console.log('================================================\n');

  const client = new ADCPMultiAgentClient([
    {
      id: 'travel-agent',
      name: 'Travel Industry Agent',
      agent_uri: 'https://travel-ads.example.com',
      protocol: 'mcp'
    }
  ]);

  const handler = createFieldHandler({
    budget: 75000,
    targeting: ['US', 'CA', 'UK', 'AU'],
    approval: true,
    objectives: ['brand_awareness', 'conversions']
  });

  console.log('🎯 Planning a travel campaign...');
  
  try {
    const agent = client.agent('travel-agent');

    // Step 1: Discover available advertising products
    console.log('\n1️⃣  Discovering available advertising products...');
    const products = await agent.getProducts({
      brief: 'Luxury European vacation packages for affluent travelers',
      promoted_offering: 'Premium guided tours and boutique accommodations'
    }, handler);

    console.log(`   Found ${products.data?.products?.length || 0} advertising products`);

    // Step 2: Check available creative formats
    console.log('\n2️⃣  Checking creative format options...');
    const formats = await agent.listCreativeFormats({
      type: 'video'
    }, handler);

    console.log(`   Found ${formats.data?.formats?.length || 0} video format options`);

    // Step 3: Continue the conversation to refine
    console.log('\n3️⃣  Refining search based on initial results...');
    const refined = await agent.continueConversation(
      'Focus on Mediterranean destinations, budget-friendly options under $3000 per person'
    );

    console.log(`   Refined search completed in ${refined.metadata.responseTimeMs}ms`);

    // Step 4: Show conversation history
    const history = agent.getHistory();
    console.log(`\n📜 Conversation summary:`);
    console.log(`   Total messages exchanged: ${history?.length || 0}`);
    console.log(`   Clarifications handled: ${products.metadata.clarificationRounds}`);

    console.log('\n✅ Campaign planning workflow completed!');

  } catch (error) {
    console.log(`❌ Expected error with demo URL: ${error.message}`);
  }

  console.log('\n💡 In a real scenario, you would:');
  console.log('   → Use actual ADCP agent endpoints');
  console.log('   → Create media buys from the discovered products');
  console.log('   → Monitor campaign performance');
  console.log('   → Optimize based on results\n');
}

/**
 * Main function - run all examples
 */
async function main() {
  console.log('🎯 ADCP TypeScript Client Library');
  console.log('Simple Getting Started Examples');
  console.log('================================\n');

  await gettingStarted();
  await withSmartHandler();
  await campaignWorkflow();

  console.log('🎓 Next Steps:');
  console.log('   1. Get ADCP agent credentials from your advertising partner');
  console.log('   2. Replace demo URLs with real agent endpoints');
  console.log('   3. Customize input handlers for your specific needs');
  console.log('   4. Explore multi-agent operations for price comparison');
  console.log('   5. Add error handling and logging for production use');
  console.log('\n📚 Learn more: Check the README.md for complete documentation');
}

// Run examples if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { gettingStarted, withSmartHandler, campaignWorkflow };