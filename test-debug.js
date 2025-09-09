const { testSingleAgent } = require('./dist/protocols.js');

async function test() {
  const result = await testSingleAgent(
    'principal_b7c46dd6',
    'Test campaign',
    undefined,
    'get_products'
  );
  
  console.log('Debug logs count:', result.debug_logs ? result.debug_logs.length : 0);
  if (result.debug_logs && result.debug_logs.length > 0) {
    console.log('First debug log:', JSON.stringify(result.debug_logs[0], null, 2));
  }
}

test().catch(console.error);
