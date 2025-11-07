// Basic A2A Client Example
import { ADCPClient, type AgentConfig } from '@adcp/client';
import { createA2AClient } from '@adcp/client/advanced';

async function basicA2AExample() {
  // Direct A2A protocol client (advanced usage)
  const client = createA2AClient('https://test-agent.adcontextprotocol.org', 'your-auth-token');

  try {
    const result = await client.callTool('get_products', 'Looking for premium coffee brands', 'Artisan coffee blends');

    console.log('Products:', result);
  } catch (error) {
    console.error('Error calling A2A agent:', error);
  }
}

// Using ADCPClient (recommended)
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
  basicA2AExample();
  configuredA2AExample();
  multiAgentExample();
}
