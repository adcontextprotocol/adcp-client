// Test the exact scenario we're seeing
// Run this in browser console to test the extractMethodName function

console.log('🧪 Testing extractMethodName function...');

// Simulate the exact request structure from your network call
const testRequest = {
  "url": "http://127.0.0.1:3000/api/sales/agents/principal_8ac9e391/query",
  "body": JSON.stringify({
    "agentConfig": {
      "id": "principal_8ac9e391",
      "name": "Wonderstruck (A2A)",
      "agent_uri": "https://adcp-sales-agent.fly.dev",
      "protocol": "a2a",
      "auth_token_env": "UhwoigyVKdd6GT8hS04cc51ckGfi8qXpZL6OvS2i2cU",
      "requiresAuth": true
    },
    "tool": "list_creatives"
  })
};

console.log('Test request:', testRequest);

// Test extractMethodName with this request
if (typeof extractMethodName === 'function') {
  const result = extractMethodName(testRequest);
  console.log('extractMethodName result:', result);
  
  // Also test the body parsing directly
  const body = JSON.parse(testRequest.body);
  console.log('Parsed body:', body);
  console.log('body.tool:', body.tool);
} else {
  console.log('❌ extractMethodName function not found');
}

// Test what the actual debugLogs contain
console.log('\n🔍 Testing debug logs structure...');

// Check what's in the debug logs (this should be available in the UI)
if (typeof window !== 'undefined' && window.lastDebugLogs) {
  console.log('Last debug logs:', window.lastDebugLogs);
  window.lastDebugLogs.forEach((log, i) => {
    console.log(`Log ${i}:`, log);
    if (log.request) {
      console.log(`  Request method name: ${extractMethodName(log.request)}`);
    }
  });
} else {
  console.log('No debug logs available. They should be populated after making a request.');
}

console.log('\n💡 After clicking "Load Agent Data", check what gets logged here.');