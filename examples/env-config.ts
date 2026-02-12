// Environment Configuration Example
import { AdCPClient } from '@adcp/client';

async function envConfigExample() {
  // Load agents from environment using factory method
  // Set ADCP_AGENTS_CONFIG (or SALES_AGENTS_CONFIG) in your .env file like:
  // ADCP_AGENTS_CONFIG='[{"id":"test-agent","name":"Test Agent","agent_uri":"https://test-agent.example.com","protocol":"mcp","auth_token":"your-token"}]'

  const client = AdCPClient.fromEnv();

  if (client.agentCount === 0) {
    console.log('No agents configured. Set ADCP_AGENTS_CONFIG environment variable.');
    return;
  }

  console.log(`Loaded ${client.agentCount} agents from environment:`);
  client.getAgentConfigs().forEach(agent => {
    console.log(`  - ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
  });

  // Test all agents
  try {
    const agentCollection = client.allAgents();
    const results = await agentCollection.getProducts({
      brief: 'Looking for advertising inventory for Q4 campaigns',
      promoted_offering: 'Holiday season promotions',
    });

    console.log('\nTest Results:');
    results.forEach(result => {
      if (result.status === 'completed') {
        console.log(`${result.metadata.agent.name}: ✅ (${result.data?.products?.length || 0} products)`);
      } else {
        console.log(`${result.metadata.agent.name}: ❌ Error: ${result.error || 'Unknown error'}`);
      }
    });

    // Summary
    const successful = results.filter(r => r.status === 'completed').length;
    const failed = results.length - successful;

    console.log(`\nSummary: ${successful} successful, ${failed} failed`);
  } catch (error) {
    console.error('Error testing agents:', error);
  }
}

// Run example
if (require.main === module) {
  envConfigExample();
}
