#!/usr/bin/env tsx
// Example: Using the new conversation-aware ADCP client library

import {
  ADCPMultiAgentClient,
  AgentClient,
  createFieldHandler,
  createConditionalHandler,
  autoApproveHandler,
  deferAllHandler,
  type AgentConfig,
  type InputHandler,
  type ConversationContext,
} from '@adcp/sdk';

// Example agent configurations
const agents: AgentConfig[] = [
  {
    id: 'premium-agent',
    name: 'Premium Ad Agent',
    agent_uri: 'https://premium-agent.example.com/mcp/',
    protocol: 'mcp',
    auth_token: process.env.PREMIUM_AGENT_TOKEN,
  },
  {
    id: 'budget-agent',
    name: 'Budget Ad Agent',
    agent_uri: 'https://budget-agent.example.com/a2a/',
    protocol: 'a2a',
  },
];

/**
 * Example 1: Single agent with conversation context
 */
async function singleAgentExample() {
  console.log('\n=== Single Agent Example ===');

  const client = new ADCPMultiAgentClient(agents);
  const agent = client.agent('premium-agent');

  // Create a smart input handler that can handle different fields
  const smartHandler: InputHandler = createFieldHandler(
    {
      budget: 50000,
      targeting: ['US', 'CA', 'UK'],
      approval: (context: ConversationContext) => {
        // Auto-approve on first attempt, defer on subsequent attempts
        return context.attempt === 1 ? true : context.deferToHuman();
      },
    },
    deferAllHandler
  ); // Default to defer for unmapped fields

  try {
    // Initial request
    console.log('🔍 Getting products...');
    const products = await agent.getProducts(
      {
        brief: 'Premium coffee brands for millennials',
        promoted_offering: 'Artisan coffee blends',
      },
      smartHandler
    );

    if (products.success) {
      console.log(`✅ Found ${products.data.products?.length || 0} products`);
      console.log(`⏱️  Response time: ${products.metadata.responseTimeMs}ms`);
      console.log(`🔄 Clarification rounds: ${products.metadata.clarificationRounds}`);

      // Continue the conversation
      console.log('\n💬 Continuing conversation...');
      const refined = await agent.continueConversation(
        'Focus only on premium organic brands with sustainability certifications',
        smartHandler
      );

      if (refined.success) {
        console.log(`✅ Refined search returned ${refined.data.products?.length || 0} products`);
      }
    } else {
      console.error(`❌ Error: ${products.error}`);
    }
  } catch (error) {
    console.error('❌ Failed:', error.message);
  }
}

/**
 * Example 2: Multi-agent parallel execution
 */
async function multiAgentExample() {
  console.log('\n=== Multi-Agent Example ===');

  const client = new ADCPMultiAgentClient(agents);

  // Simple auto-approve handler for bulk operations
  const autoHandler: InputHandler = context => {
    console.log(`🤖 Auto-responding to ${context.agent.name}: ${context.inputRequest.question}`);

    // Use suggestions if available, otherwise use sensible defaults
    if (context.inputRequest.suggestions?.length) {
      return context.inputRequest.suggestions[0];
    }

    // Field-specific defaults
    switch (context.inputRequest.field) {
      case 'budget':
        return 25000;
      case 'targeting':
        return ['US'];
      case 'approval':
        return true;
      default:
        return true;
    }
  };

  try {
    console.log('🚀 Querying all agents in parallel...');
    const results = await client.allAgents().getProducts(
      {
        brief: 'Tech gadgets for remote work',
        promoted_offering: 'Productivity tools and accessories',
      },
      autoHandler
    );

    console.log(`📊 Got ${results.length} responses:`);
    results.forEach(result => {
      if (result.success) {
        console.log(
          `  ✅ ${result.metadata.agent.name}: ${result.data.products?.length || 0} products (${
            result.metadata.responseTimeMs
          }ms)`
        );
      } else {
        console.log(`  ❌ ${result.metadata.agent.name}: ${result.error}`);
      }
    });

    // Find the best result
    const successful = results.filter(r => r.success);
    if (successful.length > 0) {
      const best = successful.sort((a, b) => (b.data.products?.length || 0) - (a.data.products?.length || 0))[0];
      console.log(`🏆 Best result: ${best.metadata.agent.name} with ${best.data.products?.length || 0} products`);
    }
  } catch (error) {
    console.error('❌ Multi-agent query failed:', error.message);
  }
}

/**
 * Example 3: Advanced input handling patterns
 */
async function advancedHandlersExample() {
  console.log('\n=== Advanced Input Handlers Example ===');

  const client = new ADCPMultiAgentClient(agents);
  const agent = client.agent('premium-agent');

  // Conditional handler based on agent type and context
  const conditionalHandler = createConditionalHandler(
    [
      {
        condition: ctx => ctx.agent.name.includes('Premium'),
        handler: createFieldHandler({
          budget: 100000, // Higher budget for premium agents
          targeting: ['US', 'CA', 'UK', 'AU'],
          approval: true,
        }),
      },
      {
        condition: ctx => ctx.attempt > 2,
        handler: deferAllHandler, // Defer if too many clarifications
      },
    ],
    autoApproveHandler
  );

  try {
    console.log('🎯 Testing advanced input handling...');
    const result = await agent.listCreativeFormats(
      {
        type: 'video',
      },
      conditionalHandler
    );

    if (result.success) {
      console.log(`✅ Got ${result.data.formats?.length || 0} video formats`);
      console.log(`🔄 Clarifications: ${result.metadata.clarificationRounds}`);
    } else {
      console.log(`❌ Error: ${result.error}`);
    }
  } catch (error) {
    console.error('❌ Advanced handler failed:', error.message);
  }
}

/**
 * Example 4: Conversation history and context management
 */
async function conversationHistoryExample() {
  console.log('\n=== Conversation History Example ===');

  const client = new ADCPMultiAgentClient(agents);
  const agent = client.agent('budget-agent');

  // Handler that uses conversation history
  const historyAwareHandler: InputHandler = context => {
    console.log(`📜 Conversation has ${context.messages.length} messages`);

    // Check if budget was previously discussed
    if (context.wasFieldDiscussed('budget')) {
      const previousBudget = context.getPreviousResponse('budget');
      console.log(`💰 Previously discussed budget: ${previousBudget}`);
      return previousBudget;
    }

    return context.inputRequest.field === 'budget' ? 15000 : true;
  };

  try {
    console.log('📖 Starting conversation with history tracking...');

    // First request
    await agent.getProducts(
      {
        brief: 'Affordable marketing tools',
      },
      historyAwareHandler
    );

    console.log('📝 Conversation history:');
    const history = agent.getHistory();
    history?.forEach((msg, i) => {
      console.log(`  ${i + 1}. ${msg.role}: ${JSON.stringify(msg.content).slice(0, 100)}...`);
    });

    // Second request in same conversation
    await agent.listCreativeFormats(
      {
        type: 'display',
      },
      historyAwareHandler
    );

    console.log(`📊 Total messages in conversation: ${agent.getHistory()?.length || 0}`);
  } catch (error) {
    console.error('❌ History example failed:', error.message);
  }
}

/**
 * Main example runner
 */
async function main() {
  console.log('🎯 ADCP Conversation-Aware Client Library Examples');
  console.log('================================================');

  // Note: These examples will fail with real network calls since we're using example URLs
  // In a real scenario, you'd have actual agent endpoints

  try {
    await singleAgentExample();
    await multiAgentExample();
    await advancedHandlersExample();
    await conversationHistoryExample();
  } catch (error) {
    console.log('\n💡 Note: Examples use mock URLs and will fail with real network calls');
    console.log('   In production, configure with real agent endpoints');
    console.log(`   Error: ${error.message}`);
  }

  console.log('\n✨ Examples completed! Check the source code for implementation details.');
  console.log('\n📚 Key Features Demonstrated:');
  console.log('   • Conversation-aware single agent operations');
  console.log('   • Parallel multi-agent execution');
  console.log('   • Smart input handlers with field mapping');
  console.log('   • Conditional logic and retry patterns');
  console.log('   • Conversation history and context preservation');
  console.log('   • Type-safe task execution with full IntelliSense');
}

// Run examples if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { singleAgentExample, multiAgentExample, advancedHandlersExample, conversationHistoryExample };
