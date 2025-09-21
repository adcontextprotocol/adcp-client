// Browser Console Debug Script for Load Agent Data
// Run this in your browser console while on the AdCP testing page

console.log('🧪 Starting Load Agent Data Debug...');

// Test function to see what's actually being sent
async function testToolCall(toolName) {
  console.log(`\n🔧 Testing ${toolName}...`);
  
  const selectedAgentId = document.getElementById('agent-selector').value;
  if (!selectedAgentId) {
    console.log('❌ No agent selected');
    return;
  }
  
  const selectedAgent = agents.find(a => a.id === selectedAgentId);
  if (!selectedAgent) {
    console.log('❌ Selected agent not found');
    return;
  }
  
  console.log(`📋 Agent: ${selectedAgent.name} (${selectedAgent.id})`);
  
  // Mock the callADCPTool function to see what's being sent
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    console.log(`📤 FETCH INTERCEPTED:`, args[0], args[1]);
    if (args[1] && args[1].body) {
      console.log(`📄 Request Body:`, JSON.parse(args[1].body));
    }
    return originalFetch.apply(this, args);
  };
  
  try {
    const result = await callADCPTool(selectedAgent, toolName, {});
    console.log(`✅ Result:`, result);
  } catch (error) {
    console.log(`❌ Error:`, error);
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

// Test the three tools individually
async function runDebugSequence() {
  console.log('\n🚀 Testing individual tool calls...');
  
  await testToolCall('list_creative_formats');
  await new Promise(r => setTimeout(r, 1000));
  
  await testToolCall('list_creatives');
  await new Promise(r => setTimeout(r, 1000));
  
  await testToolCall('get_products');
  
  console.log('\n✨ Debug sequence complete!');
}

// Also test the actual refreshAgentData function
async function testRefreshAgentData() {
  console.log('\n🔄 Testing actual refreshAgentData function...');
  
  // Intercept all fetch calls
  const originalFetch = window.fetch;
  const fetchCalls = [];
  
  window.fetch = function(...args) {
    const call = {
      url: args[0],
      options: args[1],
      body: args[1] && args[1].body ? JSON.parse(args[1].body) : null
    };
    fetchCalls.push(call);
    console.log(`📤 FETCH #${fetchCalls.length}:`, call);
    return originalFetch.apply(this, args);
  };
  
  try {
    await refreshAgentData();
    console.log(`\n📊 Summary: ${fetchCalls.length} fetch calls made`);
    fetchCalls.forEach((call, i) => {
      console.log(`Call ${i+1}: ${call.body?.tool || call.body?.toolName || 'UNKNOWN'}`);
    });
  } catch (error) {
    console.log(`❌ Error in refreshAgentData:`, error);
  } finally {
    window.fetch = originalFetch;
  }
}

console.log('🎯 Available debug functions:');
console.log('  - runDebugSequence() - Test individual tool calls');
console.log('  - testRefreshAgentData() - Test the actual Load Agent Data function');
console.log('  - testToolCall("toolName") - Test a specific tool');
console.log('\n💡 Run: testRefreshAgentData() to see what\'s being sent');