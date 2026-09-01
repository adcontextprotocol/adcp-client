#!/usr/bin/env node

/**
 * Simple Protocol Detection Demo
 *
 * Shows how easy it is to detect input requests with ADCP spec PR #77
 */

import { ProtocolResponseParser, ADCP_STATUS } from '@adcp/sdk';

function main() {
  console.log('🎯 Simple ADCP Protocol Detection\n');

  const parser = new ProtocolResponseParser();

  // Test cases showing the simplicity
  const testCases = [
    {
      name: 'ADCP Standard: input-required',
      response: {
        status: 'input-required',
        message: 'What is your budget?',
      },
      expected: true,
    },

    {
      name: 'ADCP Standard: completed',
      response: {
        status: 'completed',
        result: { products: ['Product A'] },
      },
      expected: false,
    },

    {
      name: 'Legacy fallback',
      response: {
        type: 'input_request',
        question: 'Select a format',
      },
      expected: true,
    },
  ];

  console.log('📊 Testing simplified detection:\n');

  testCases.forEach(testCase => {
    console.log(`🧪 ${testCase.name}`);
    console.log(`   Response: ${JSON.stringify(testCase.response, null, 4)}`);

    const needsInput = parser.isInputRequest(testCase.response);
    const status = parser.getStatus(testCase.response);

    console.log(`   ✅ Needs Input: ${needsInput} (expected: ${testCase.expected})`);
    console.log(`   📋 ADCP Status: ${status || 'null'}`);

    if (needsInput) {
      const parsed = parser.parseInputRequest(testCase.response);
      console.log(`   📝 Question: "${parsed.question}"`);
    }
    console.log('');
  });

  console.log('🎉 Key Takeaway: Just check status === "input-required"!');
  console.log('');
  console.log('ADCP Status Values:');
  Object.entries(ADCP_STATUS).forEach(([key, value]) => {
    console.log(`  • ${key}: "${value}"`);
  });
}

if (require.main === module) {
  main();
}
