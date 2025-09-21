#!/usr/bin/env node

/**
 * Protocol Detection Demo - Simplified ADCP Compliance
 * 
 * Demonstrates simple, spec-compliant protocol detection
 * following ADCP spec PR #77
 */

import { ProtocolResponseParser, ADCP_STATUS } from '../src/lib/index';

function main() {
  console.log('🔍 Simple Protocol Detection Demo - ADCP Spec Compliant\n');

  const parser = new ProtocolResponseParser();

  // Test cases following ADCP spec exactly
  const testCases = [
    {
      name: 'ADCP Spec: input-required status',
      response: { 
        status: 'input-required', 
        message: 'What is your budget?',
        field: 'budget',
        expected_type: 'number'
      },
      expected: true
    },
    
    {
      name: 'ADCP Spec: completed status',
      response: {
        status: 'completed',
        result: { products: ['Product A', 'Product B'] }
      },
      expected: false
    },

    {
      name: 'ADCP Spec: failed status',
      response: {
        status: 'failed',
        error: 'Authentication failed'
      },
      expected: false
    },

    {
      name: 'Legacy: input_request type (backward compatibility)',
      response: {
        type: 'input_request',
        question: 'What audience should we target?',
        choices: ['18-24', '25-34', '35-44']
      },
      expected: true
    },

    {
      name: 'Legacy: question field (backward compatibility)',
      response: {
        question: 'Please select a creative format',
        options: ['display', 'video', 'native']
      },
      expected: true
    }
  ];

  console.log('📊 Testing Protocol Detection:\n');

  for (const testCase of testCases) {
    console.log(`🧪 ${testCase.name}`);
    console.log(`   Response: ${JSON.stringify(testCase.response, null, 6)}`);
    
    const needsInput = parser.isInputRequest(testCase.response);
    const status = parser.getStatus(testCase.response);
    
    const result = needsInput === testCase.expected ? '✅' : '❌';
    console.log(`   ${result} Needs Input: ${needsInput} (expected: ${testCase.expected})`);
    console.log(`   📋 ADCP Status: ${status || 'not provided'}`);
    
    if (needsInput) {
      const parsed = parser.parseInputRequest(testCase.response);
      console.log(`   📝 Parsed: ${JSON.stringify({
        question: parsed.question,
        field: parsed.field,
        expectedType: parsed.expectedType,
        suggestions: parsed.suggestions
      }, null, 6)}`);
    }
    
    console.log('');
  }

  console.log('🎯 ADCP Status Values:\n');
  Object.entries(ADCP_STATUS).forEach(([key, value]) => {
    console.log(`   ${key}: "${value}"`);
  });

  console.log('');
  console.log('🎉 Simple Protocol Detection Complete!');
  console.log('');
  console.log('Key Features:');
  console.log('• ✅ ADCP spec compliant (PR #77)');
  console.log('• ✅ Simple status check: response.status === "input-required"');
  console.log('• ✅ Backward compatibility with legacy patterns');
  console.log('• ✅ No complex configuration needed');
  console.log('• ✅ Clear, predictable behavior');
}

if (require.main === module) {
  main();
}