// Basic A2A Client Example
import { createA2AClient, AdCPClient, type AgentConfig } from '@adcp/client';

async function basicA2AExample() {
  // Simple A2A client usage
  const client = createA2AClient('https://test-agent.adcontextprotocol.org', 'your-auth-token');
  
  try {
    const result = await client.callTool('get_products', 'Looking for premium coffee brands', 'Artisan coffee blends');
    
    console.log('Products:', result);
  } catch (error) {
    console.error('Error calling A2A agent:', error);
  }
}

// Using AgentConfig with AdCPClient
async function configuredA2AExample() {
  const agent: AgentConfig = {
    id: 'test-a2a-agent',
    name: 'Test A2A Agent',
    agent_uri: 'https://test-agent.adcontextprotocol.org',
    protocol: 'a2a',
    auth_token_env: 'A2A_AUTH_TOKEN',
    requiresAuth: true
  };
  
  const client = new AdCPClient([agent]);
  
  try {
    const result = await client.callTool('test-a2a-agent', 'get_products', {
      brief: 'Sustainable fashion brands',
      promoted_offering: 'Eco-friendly clothing'
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
      requiresAuth: true
    },
    {
      id: 'a2a-agent',
      name: 'A2A Test Agent',
      agent_uri: 'https://test-agent.adcontextprotocol.org',
      protocol: 'a2a',
      auth_token_env: 'A2A_AUTH_TOKEN',
      requiresAuth: true
    }
  ];
  
  const client = new AdCPClient(agents);
  
  try {
    const results = await client.callToolOnAgents(
      ['mcp-agent', 'a2a-agent'], 
      'get_products',
      {
        brief: 'Tech gadgets for remote work',
        promoted_offering: 'Ergonomic workspace solutions'
      }
    );
    
    console.log('Results from both agents:', results);
    results.forEach(result => {
      console.log(`${result.agent_name}: ${result.success ? 'Success' : 'Failed'}`);
      if (result.success) {
        console.log('  Data:', result.data);
      } else {
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