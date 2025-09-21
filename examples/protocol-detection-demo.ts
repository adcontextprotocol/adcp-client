#!/usr/bin/env node

/**
 * Protocol Detection Demo
 * 
 * Demonstrates the improved protocol detection capabilities
 * with standardized status field support (ADCP spec PR #77)
 */

import { ProtocolResponseParser, ResponseStatus } from '../src/lib/index';

function main() {
  console.log('🔍 Protocol Detection Demo - ADCP Spec PR #77 Compliance\n');

  const parser = new ProtocolResponseParser();

  // Test cases for standardized status field
  const testCases = [
    // Standardized ADCP status format
    {
      name: 'Standard needs_input',
      response: { 
        status: 'needs_input', 
        question: 'What is your budget?',
        field: 'budget',
        expected_type: 'number'
      },
      protocol: 'mcp' as const,
      expected: true
    },
    
    // New standardized input_request format
    {
      name: 'Standardized input_request object',
      response: {
        status: 'needs_input',
        input_request: {
          question: 'Please select a creative format',
          field: 'format',
          type: 'string',
          suggestions: ['display', 'video', 'native']
        }
      },
      protocol: 'a2a' as const,
      expected: true
    },

    // Legacy pattern compatibility
    {
      name: 'Legacy MCP pattern',
      response: {
        type: 'input_request',
        question: 'What audience should we target?',
        choices: ['18-24', '25-34', '35-44']
      },
      protocol: 'mcp' as const,
      expected: true
    },

    // Completed status
    {
      name: 'Completed task',
      response: {
        status: 'completed',
        result: {
          products: ['Product A', 'Product B']
        }
      },
      protocol: 'a2a' as const,
      expected: false
    },

    // Failed status
    {
      name: 'Failed task',
      response: {
        status: 'failed',
        error: 'Authentication failed'
      },
      protocol: 'mcp' as const,
      expected: false
    }
  ];

  console.log('📊 Testing Protocol Detection:\n');

  for (const testCase of testCases) {
    console.log(`🧪 Test: ${testCase.name}`);
    console.log(`   Protocol: ${testCase.protocol}`);
    console.log(`   Response: ${JSON.stringify(testCase.response, null, 6)}`);
    
    const isInput = parser.isInputRequest(testCase.response, testCase.protocol);
    const status = parser.getResponseStatus(testCase.response, testCase.protocol);
    
    console.log(`   ✅ Needs Input: ${isInput} (expected: ${testCase.expected})`);
    console.log(`   📋 Status: ${status}`);
    
    if (isInput) {
      const parsed = parser.parseInputRequest(testCase.response, testCase.protocol);
      console.log(`   📝 Parsed Request:`, JSON.stringify(parsed, null, 6));
    }
    
    console.log('');
  }

  // Test agent-specific configuration
  console.log('🎯 Testing Agent-Specific Configuration:\n');
  
  // Register custom config for a specific agent
  parser.registerAgentConfig('custom-agent-123', {
    statusFields: ['state', 'task_status'],
    inputIndicators: ['awaiting_user_input'],
    useLegacyPatterns: false,
    customParser: (response) => {
      return response.custom_needs_input === true;
    }
  });

  const customResponse = {
    state: 'awaiting_user_input',
    prompt: 'Please confirm your campaign settings'
  };

  console.log('🧪 Custom Agent Response:');
  console.log(`   Response: ${JSON.stringify(customResponse, null, 4)}`);
  
  const customResult = parser.isInputRequest(customResponse, 'mcp', 'custom-agent-123');
  console.log(`   ✅ Custom Agent Needs Input: ${customResult}`);
  
  // Test with same response but default agent (should be different)
  const defaultResult = parser.isInputRequest(customResponse, 'mcp');
  console.log(`   ✅ Default Agent Needs Input: ${defaultResult}`);
  console.log('');

  // Test protocol-specific configuration
  console.log('🌐 Testing Protocol-Specific Configuration:\n');
  
  parser.registerProtocolConfig('a2a', {
    statusFields: ['execution_status', 'agent_state'],
    inputIndicators: ['user_interaction_required']
  });

  const protocolResponse = {
    execution_status: 'user_interaction_required',
    message: 'Please provide additional information'
  };

  console.log('🧪 Protocol-Specific Response:');
  console.log(`   Response: ${JSON.stringify(protocolResponse, null, 4)}`);
  
  const protocolResult = parser.isInputRequest(protocolResponse, 'a2a');
  console.log(`   ✅ A2A Protocol Needs Input: ${protocolResult}`);
  
  const mcpResult = parser.isInputRequest(protocolResponse, 'mcp');
  console.log(`   ✅ MCP Protocol Needs Input: ${mcpResult}`);
  console.log('');

  console.log('🎉 Protocol Detection Demo Complete!');
  console.log('');
  console.log('Key Features Demonstrated:');
  console.log('• ✅ Standardized status field support (ADCP spec PR #77)');
  console.log('• ✅ Agent-specific parser configuration');
  console.log('• ✅ Protocol-specific parser configuration');
  console.log('• ✅ Legacy pattern compatibility');
  console.log('• ✅ Custom parser functions');
  console.log('• ✅ Robust input request parsing');
}

if (require.main === module) {
  main();
}