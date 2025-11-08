// Basic A2A Client Example
import { ADCPClient, type AgentConfig } from '@adcp/client';

// Using ADCPClient with A2A protocol (recommended)
async function configuredA2AExample() {
  const agent: AgentConfig = {
    id: 'test-a2a-agent',
    name: 'Test A2A Agent',
    agent_uri: 'https://test-agent.adcontextprotocol.org',
    protocol: 'a2a',
    auth_token_env: 'A2A_AUTH_TOKEN',
    requiresAuth: true,
  };

  const client = new ADCPClient([agent]);

  try {
    const agentClient = client.agent('test-a2a-agent');
    const result = await agentClient.getProducts({
      brief: 'Sustainable fashion brands',
      promoted_offering: 'Eco-friendly clothing',
    });

    console.log('Test Result:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Multi-agent testing
async function multiAgentExample() {
  const agents: AgentConfig[] = [
    {
      id: 'mcp-agent',
      name: 'MCP Test Agent',
      agent_uri: 'https://test-agent.adcontextprotocol.org/mcp/',
      protocol: 'mcp',
      auth_token_env: 'MCP_AUTH_TOKEN',
      requiresAuth: true,
    },
    {
      id: 'a2a-agent',
      name: 'A2A Test Agent',
      agent_uri: 'https://test-agent.adcontextprotocol.org',
      protocol: 'a2a',
      auth_token_env: 'A2A_AUTH_TOKEN',
      requiresAuth: true,
    },
  ];

  const client = new ADCPClient(agents);

  try {
    const agentCollection = client.agents(['mcp-agent', 'a2a-agent']);
    const results = await agentCollection.getProducts({
      brief: 'Tech gadgets for remote work',
      promoted_offering: 'Ergonomic workspace solutions',
    });

    console.log('Results from both agents:', results);
    results.forEach(result => {
      if (result.status === 'completed') {
        console.log(`${result.agent.name}: Success`);
        console.log('  Data:', result.data);
      } else {
        console.log(`${result.agent.name}: Failed`);
        console.log('  Error:', result.error);
      }
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run examples
if (require.main === module) {
  configuredA2AExample();
  multiAgentExample();
}
