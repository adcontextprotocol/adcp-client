#!/usr/bin/env tsx
// Easy Configuration Demo - Show how simple it is to configure ADCP agents

import {
  ADCPMultiAgentClient,
  ConfigurationManager,
  createFieldHandler
} from '../src/lib';

/**
 * Demo 1: Environment Variable Configuration
 */
async function envConfigDemo() {
  console.log('🌍 Environment Variable Configuration Demo');
  console.log('==========================================\n');

  // In real usage, you'd set this in your shell or .env file:
  // export SALES_AGENTS_CONFIG='{"agents":[{"id":"demo","name":"Demo Agent","agent_uri":"https://demo.example.com","protocol":"mcp"}]}'
  
  // For demo purposes, set it programmatically
  process.env.SALES_AGENTS_CONFIG = JSON.stringify({
    agents: [
      {
        id: 'demo-env-agent',
        name: 'Demo Environment Agent',
        agent_uri: 'https://demo-env.example.com',
        protocol: 'mcp'
      }
    ]
  });

  try {
    // Super simple - just one line!
    console.log('🚀 Creating client from environment...');
    const client = ADCPMultiAgentClient.fromEnv();
    
    console.log(`✅ Success! Loaded ${client.agentCount} agent(s)`);
    console.log(`   Available agents: ${client.getAgentIds().join(', ')}`);
    
    // Use the agent
    const agent = client.agent('demo-env-agent');
    console.log(`   Agent name: ${agent.getAgentName()}`);
    console.log(`   Protocol: ${agent.getProtocol()}\n`);
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Demo 2: One-Liner Simple Setup
 */
async function simpleConfigDemo() {
  console.log('⚡ One-Liner Simple Configuration Demo');
  console.log('====================================\n');

  try {
    // Simplest possible setup
    console.log('🚀 Creating client with one-liner...');
    const client = ADCPMultiAgentClient.simple('https://simple-agent.example.com');
    
    console.log(`✅ Success! Created client with default agent`);
    console.log(`   Agent ID: ${client.getAgentIds()[0]}`);
    console.log(`   Agent count: ${client.agentCount}`);
    
    // Access the default agent
    const agent = client.agent('default-agent');
    console.log(`   Agent name: ${agent.getAgentName()}`);
    console.log(`   Protocol: ${agent.getProtocol()} (default)\n`);
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Demo 3: Simple Setup with Options
 */
async function simpleWithOptionsDemo() {
  console.log('🔧 Simple Setup with Custom Options');
  console.log('=================================\n');

  try {
    console.log('🚀 Creating client with custom options...');
    const client = ADCPMultiAgentClient.simple('https://custom-agent.example.com', {
      agentId: 'my-custom-agent',
      agentName: 'My Custom Agent',
      protocol: 'a2a',
      requiresAuth: true,
      authTokenEnv: 'MY_AGENT_TOKEN',
      debug: true,
      timeout: 45000
    });
    
    console.log(`✅ Success! Created customized client`);
    console.log(`   Agent ID: ${client.getAgentIds()[0]}`);
    
    const agent = client.agent('my-custom-agent');
    console.log(`   Agent name: ${agent.getAgentName()}`);
    console.log(`   Protocol: ${agent.getProtocol()}`);
    console.log(`   Requires auth: true`);
    console.log(`   Debug enabled: true\n`);
  } catch (error) {
    console.log(`❌ Error: ${error.message}\n`);
  }
}

/**
 * Demo 4: Configuration Help
 */
async function configHelpDemo() {
  console.log('📚 Configuration Help Demo');
  console.log('=========================\n');

  console.log('💡 Configuration options available:');
  console.log('   Environment variables:', ConfigurationManager.getEnvVars().join(', '));
  console.log('   Config files:', ConfigurationManager.getConfigPaths().map(p => p.split('/').pop()).join(', '));
  
  console.log('\n📖 Full configuration help:');
  console.log(ConfigurationManager.getConfigurationHelp());
}

/**
 * Demo 5: Configuration Validation
 */
async function validationDemo() {
  console.log('🛡️  Configuration Validation Demo');
  console.log('================================\n');

  // Test invalid configuration
  try {
    console.log('🧪 Testing invalid agent configuration...');
    const client = ADCPMultiAgentClient.simple('not-a-valid-url');
  } catch (error) {
    console.log(`✅ Validation caught error: ${error.message}\n`);
  }

  // Test duplicate agent IDs
  try {
    console.log('🧪 Testing duplicate agent IDs...');
    const client = new ADCPMultiAgentClient([
      { id: 'agent1', name: 'Agent 1', agent_uri: 'https://agent1.example.com', protocol: 'mcp' },
      { id: 'agent1', name: 'Agent 1 Duplicate', agent_uri: 'https://agent1-dup.example.com', protocol: 'mcp' }
    ]);
  } catch (error) {
    console.log(`✅ Validation caught duplicate ID: ${error.message}\n`);
  }

  // Test missing required fields
  try {
    console.log('🧪 Testing missing required fields...');
    const client = new ADCPMultiAgentClient([
      { id: 'incomplete', name: 'Incomplete Agent' } as any
    ]);
  } catch (error) {
    console.log(`✅ Validation caught missing field: ${error.message}\n`);
  }
}

/**
 * Demo 6: Real-World Usage Pattern
 */
async function realWorldDemo() {
  console.log('🌟 Real-World Usage Pattern Demo');
  console.log('===============================\n');

  // This is how you'd typically use it in production
  try {
    console.log('🏭 Production-style setup...');
    
    // Option 1: Environment-based (recommended for production)
    let client;
    try {
      client = ADCPMultiAgentClient.fromConfig(); // Auto-discovers env or config file
      console.log('✅ Loaded configuration automatically');
    } catch (error) {
      // Fallback to simple setup for development
      console.log('⚠️  No configuration found, using development fallback');
      client = ADCPMultiAgentClient.simple(
        process.env.ADCP_AGENT_URL || 'https://dev-agent.example.com',
        {
          agentName: 'Development Agent',
          debug: true
        }
      );
    }

    console.log(`📊 Client stats:`);
    console.log(`   Agent count: ${client.agentCount}`);
    console.log(`   Agent IDs: ${client.getAgentIds().join(', ')}`);

    // Create a smart handler for production use
    const handler = createFieldHandler({
      budget: parseInt(process.env.DEFAULT_BUDGET || '25000'),
      targeting: (process.env.DEFAULT_TARGETING || 'US,CA').split(','),
      approval: process.env.AUTO_APPROVE === 'true'
    });

    console.log(`🎯 Created production-ready handler with defaults`);
    
    // Use the first available agent
    const agentId = client.getAgentIds()[0];
    const agent = client.agent(agentId);
    
    console.log(`🚀 Ready to use agent: ${agent.getAgentName()}`);
    console.log(`   Protocol: ${agent.getProtocol()}`);
    
    // In real usage, you'd make actual calls here:
    // const products = await agent.getProducts({ brief: 'Coffee brands' }, handler);
    
  } catch (error) {
    console.log(`❌ Setup failed: ${error.message}`);
  }
  
  console.log('\n🎉 Production setup complete!\n');
}

/**
 * Main demo runner
 */
async function main() {
  console.log('🎯 ADCP Easy Configuration Demo');
  console.log('===============================\n');
  
  console.log('This demo shows how easy it is to configure ADCP agents using the new configuration methods.\n');

  await envConfigDemo();
  await simpleConfigDemo(); 
  await simpleWithOptionsDemo();
  await configHelpDemo();
  await validationDemo();
  await realWorldDemo();

  console.log('🎓 Key Takeaways:');
  console.log('   • ADCPMultiAgentClient.fromConfig() - Auto-discovers configuration');
  console.log('   • ADCPMultiAgentClient.fromEnv() - Loads from environment variables');
  console.log('   • ADCPMultiAgentClient.simple(url) - One-liner setup');
  console.log('   • Automatic validation prevents configuration errors');
  console.log('   • Multiple configuration sources (env, files, programmatic)');
  console.log('   • Production-ready with fallback strategies');
  console.log('\n📚 See the README for more configuration examples!');
}

// Run demo if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { 
  envConfigDemo, 
  simpleConfigDemo, 
  simpleWithOptionsDemo, 
  configHelpDemo, 
  validationDemo, 
  realWorldDemo 
};