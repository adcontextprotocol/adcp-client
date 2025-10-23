import { ADCPClient } from './src/lib/core/ADCPClient.js';

async function testListAuthorizedProperties() {
  console.log('Testing list_authorized_properties via MCP...\n');

  const agentConfig = {
    id: 'test-agent',
    name: 'AdCP Test Agent',
    agent_uri: 'https://test-agent.adcontextprotocol.org/mcp',
    protocol: 'mcp' as const,
    auth_token_env: process.env.ADCP_AUTH_TOKEN || 'test-token',
    requiresAuth: true
  };

  const client = new ADCPClient(agentConfig, { debug: true });

  try {
    console.log('Calling list_authorized_properties...');
    const result = await client.listAuthorizedProperties({});

    console.log('\n✅ Success!');
    console.log('Properties:', JSON.stringify(result, null, 2));

    if (result.properties && result.properties.length > 0) {
      console.log(`\nFound ${result.properties.length} properties`);
      result.properties.forEach((prop: any, i: number) => {
        console.log(`  ${i + 1}. ${prop.property_name || prop.name} (${prop.property_id || prop.id})`);
      });
    } else {
      console.log('\nNo properties returned (this may be expected)');
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }
  }
}

testListAuthorizedProperties();
