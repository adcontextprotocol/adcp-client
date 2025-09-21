// Simple browser console debug - copy/paste this in browser console

console.log('🔍 Debugging Load Agent Data...');

// Check if functions exist
console.log('refreshAgentData exists:', typeof refreshAgentData);
console.log('callADCPTool exists:', typeof callADCPTool);
console.log('agents exists:', typeof agents, agents?.length);

// Simple fetch interceptor
const originalFetch = window.fetch;
const calls = [];
window.fetch = function(...args) {
  const call = { 
    url: args[0], 
    body: args[1]?.body ? JSON.parse(args[1].body) : null,
    timestamp: new Date().toISOString()
  };
  calls.push(call);
  console.log(`📤 FETCH #${calls.length}:`, call.body?.tool || 'NO_TOOL', 'to', call.url);
  return originalFetch.apply(this, args);
};

console.log('✅ Fetch interceptor ready. Now click "Load Agent Data" and see what gets logged.');
console.log('💡 To restore normal fetch: window.fetch = originalFetch');

// Auto-restore after 60 seconds
setTimeout(() => {
  window.fetch = originalFetch;
  console.log('🔄 Fetch interceptor auto-disabled after 60s');
  console.log(`📊 Total calls made: ${calls.length}`);
  calls.forEach((call, i) => console.log(`  ${i+1}. ${call.body?.tool || 'NO_TOOL'} at ${call.timestamp}`));
}, 60000);