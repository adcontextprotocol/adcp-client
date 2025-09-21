#!/usr/bin/env node

/**
 * Test script to verify Load Agent Data functionality
 * Tests the three API calls that should happen: list_creative_formats, list_creatives, get_products
 */

const http = require('http');

const SERVER_BASE = 'http://127.0.0.1:3000';

async function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, data, raw: true });
        }
      });
    });

    req.on('error', reject);
    
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function testAgentQuery(agentId, toolName, description) {
  console.log(`\n🔧 Testing ${description} (${toolName})...`);
  
  const requestBody = {
    tool: toolName,
    brief: 'Test query from script',
    params: {}
  };
  
  console.log(`📤 Request body:`, JSON.stringify(requestBody, null, 2));
  
  try {
    const result = await makeRequest(`/api/sales/agents/${agentId}/query`, 'POST', requestBody);
    console.log(`📥 Response status: ${result.status}`);
    
    if (result.status === 200) {
      console.log(`✅ Success: ${description}`);
      console.log(`📊 Response summary:`, {
        success: result.data.success,
        timestamp: result.data.timestamp,
        dataKeys: Object.keys(result.data.data || {}),
        debugLogsCount: result.data.debugLogs?.length || 0
      });
    } else {
      console.log(`❌ Failed: ${description}`);
      console.log(`📝 Error:`, result.data);
    }
  } catch (error) {
    console.log(`💥 Request failed: ${error.message}`);
  }
}

async function getAgents() {
  console.log('📋 Fetching available agents...');
  try {
    const result = await makeRequest('/api/sales/agents');
    if (result.status === 200 && result.data.success) {
      const agents = result.data.data.agents;
      console.log(`✅ Found ${agents.length} agents:`);
      agents.forEach(agent => {
        console.log(`  - ${agent.name} (${agent.id}) - ${agent.protocol.toUpperCase()}`);
      });
      return agents;
    } else {
      console.log('❌ Failed to fetch agents:', result.data);
      return [];
    }
  } catch (error) {
    console.log('💥 Failed to fetch agents:', error.message);
    return [];
  }
}

async function testLoadAgentDataSequence() {
  console.log('🚀 Starting Load Agent Data Test Sequence\n');
  
  // Get available agents
  const agents = await getAgents();
  if (agents.length === 0) {
    console.log('❌ No agents available for testing');
    return;
  }
  
  // Test with the first available agent
  const testAgent = agents[0];
  console.log(`\n🎯 Testing with agent: ${testAgent.name} (${testAgent.id})`);
  
  // This mimics the "Load Agent Data" button sequence
  const testSequence = [
    { toolName: 'list_creative_formats', description: 'List Creative Formats' },
    { toolName: 'list_creatives', description: 'List Creatives' },
    { toolName: 'get_products', description: 'Get Products' }
  ];
  
  for (const test of testSequence) {
    await testAgentQuery(testAgent.id, test.toolName, test.description);
    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between requests
  }
  
  console.log('\n✨ Test sequence complete!');
}

// Test variations of parameter names
async function testParameterVariations() {
  console.log('\n🔬 Testing parameter name variations...');
  
  const agents = await getAgents();
  if (agents.length === 0) return;
  
  const testAgent = agents[0];
  
  const variations = [
    { body: { tool: 'get_products' }, description: 'Using "tool"' },
    { body: { toolName: 'get_products' }, description: 'Using "toolName"' },
    { body: { tool_name: 'get_products' }, description: 'Using "tool_name"' },
    { body: { }, description: 'No tool specified (should fail)' }
  ];
  
  for (const variation of variations) {
    console.log(`\n🔧 ${variation.description}...`);
    console.log(`📤 Request body:`, JSON.stringify(variation.body, null, 2));
    
    try {
      const result = await makeRequest(`/api/sales/agents/${testAgent.id}/query`, 'POST', variation.body);
      console.log(`📥 Status: ${result.status}, Success: ${result.data.success}`);
      if (!result.data.success) {
        console.log(`📝 Error: ${result.data.error}`);
      }
    } catch (error) {
      console.log(`💥 Failed: ${error.message}`);
    }
  }
}

async function main() {
  console.log('🧪 AdCP Load Agent Data Testing Script\n');
  
  // Test the main sequence
  await testLoadAgentDataSequence();
  
  // Test parameter variations
  await testParameterVariations();
  
  console.log('\n🏁 All tests complete!');
}

if (require.main === module) {
  main().catch(console.error);
}