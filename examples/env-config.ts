// Environment Configuration Example
import { ConfigurationManager, AdCPClient } from '@adcp/client';

async function envConfigExample() {
  // Load agents from environment variables
  // Set SALES_AGENTS_CONFIG in your .env file like:
  // SALES_AGENTS_CONFIG='{"agents":[{"id":"test-agent","name":"Test Agent","agent_uri":"https://test-agent.example.com","protocol":"mcp","auth_token_env":"TEST_AUTH_TOKEN","requiresAuth":true}]}'

  const agents = ConfigurationManager.loadAgentsFromEnv();

  if (agents.length === 0) {
    console.log('No agents configured. Set SALES_AGENTS_CONFIG environment variable.');
    return;
  }

  console.log(`Loaded ${agents.length} agents from environment:`);
  agents.forEach(agent => {
    console.log(`  - ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
  });

  // Create client with loaded agents
  const client = new AdCPClient(agents);

  // Test all agents
  const agentIds = agents.map(a => a.id);

  try {
    const results = await client.callToolOnAgents(agentIds, 'get_products', {
      brief: 'Looking for advertising inventory for Q4 campaigns',
      promoted_offering: 'Holiday season promotions',
    });

    console.log('\nTest Results:');
    results.forEach(result => {
      console.log(`${result.agent_name}: ${result.success ? '✅' : '❌'} (${result.response_time_ms}ms)`);
      if (!result.success) {
        console.log(`  Error: ${result.error}`);
      }
    });

    // Summary
    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;
    const avgResponseTime =
      results.length > 0 ? results.reduce((sum, r) => sum + r.response_time_ms, 0) / results.length : 0;

    console.log(
      `\nSummary: ${successful} successful, ${failed} failed, ${Math.round(avgResponseTime)}ms avg response time`
    );
  } catch (error) {
    console.error('Error testing agents:', error);
  }
}

// Run example
if (require.main === module) {
  envConfigExample();
}
