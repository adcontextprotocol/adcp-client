// Basic MCP Client Example
import { createMCPClient, type AgentConfig } from '@adcp/client';

async function basicMCPExample() {
  // Simple MCP client usage
  const client = createMCPClient('https://test-agent.adcontextprotocol.org/mcp/', 'your-auth-token');

  try {
    const result = await client.callTool('get_products', {
      brief: 'Looking for premium coffee brands',
      promoted_offering: 'Artisan coffee blends',
    });

    console.log('Products:', result);
  } catch (error) {
    console.error('Error calling MCP agent:', error);
  }
}

// Using AgentConfig with AdCPClient
import { AdCPClient } from '@adcp/client';

async function configuredMCPExample() {
  const agent: AgentConfig = {
    id: 'test-mcp-agent',
    name: 'Test MCP Agent',
    agent_uri: 'https://test-agent.adcontextprotocol.org/mcp/',
    protocol: 'mcp',
    auth_token: process.env.MCP_AUTH_TOKEN,
  };

  const client = new AdCPClient([agent]);

  try {
    const agentClient = client.agent('test-mcp-agent');
    const result = await agentClient.getProducts({
      brief: 'Sustainable fashion brands',
    });

    console.log('Test Result:', result);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run examples
if (require.main === module) {
  basicMCPExample();
  configuredMCPExample();
}
