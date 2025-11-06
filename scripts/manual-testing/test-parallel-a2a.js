// Test script to reproduce parallel A2A auth issue
const { callA2ATool } = require('./dist/lib/protocols/a2a.js');

// Get agent config from SALES_AGENTS_CONFIG
const config = JSON.parse(process.env.SALES_AGENTS_CONFIG);
const a2aAgent = config.agents.find(a => a.protocol === 'a2a');

if (!a2aAgent) {
  console.error('No A2A agent found in SALES_AGENTS_CONFIG');
  process.exit(1);
}

const AGENT_URL = a2aAgent.agent_uri;
const AUTH_TOKEN = a2aAgent.auth_token_env;

async function testParallelCalls() {
  console.log('\n=== Testing Parallel A2A Calls ===\n');
  console.log(`Agent URL: ${AGENT_URL}`);
  console.log(`Auth Token: ${AUTH_TOKEN ? `${AUTH_TOKEN.substring(0, 20)}...` : 'NONE'}\n`);

  const debugLogs1 = [];
  const debugLogs2 = [];
  const debugLogs3 = [];

  // Make 3 parallel calls just like the frontend does
  const calls = [
    callA2ATool(AGENT_URL, 'get_products', { brief: 'Test products' }, AUTH_TOKEN, debugLogs1),
    callA2ATool(AGENT_URL, 'list_creative_formats', {}, AUTH_TOKEN, debugLogs2),
    callA2ATool(AGENT_URL, 'list_creatives', {}, AUTH_TOKEN, debugLogs3),
  ];

  try {
    const results = await Promise.allSettled(calls);

    console.log('\n=== Results ===\n');
    results.forEach((result, idx) => {
      const toolNames = ['get_products', 'list_creative_formats', 'list_creatives'];
      console.log(`\nCall ${idx + 1} (${toolNames[idx]}):`);
      if (result.status === 'fulfilled') {
        console.log('  ✅ SUCCESS');
      } else {
        console.log(`  ❌ ERROR: ${result.reason.message}`);
      }
    });

    console.log('\n=== Debug Logs ===\n');
    console.log('\nCall 1 (get_products):');
    debugLogs1.forEach(log => console.log(`  ${log.message}`));

    console.log('\nCall 2 (list_creative_formats):');
    debugLogs2.forEach(log => console.log(`  ${log.message}`));

    console.log('\nCall 3 (list_creatives):');
    debugLogs3.forEach(log => console.log(`  ${log.message}`));
  } catch (error) {
    console.error('Unexpected error:', error);
  }
}

testParallelCalls()
  .then(() => {
    console.log('\n=== Test Complete ===\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n=== Test Failed ===\n', err);
    process.exit(1);
  });
