#!/usr/bin/env node

// Test script for Creative Management functionality
// Run this after starting the server on http://localhost:3006

const baseUrl = 'http://localhost:3006';

// Test agent configuration
const testAgent = {
  id: 'test_agent_1',
  name: 'Test Agent',
  protocol: 'a2a'
};

// Test data
const singleCreative = {
  name: 'Test Banner Ad',
  type: 'image',
  media_url: 'https://example.com/test-banner.jpg',
  format: '300x250',
  dimensions: { width: 300, height: 250 },
  tags: ['test', 'banner'],
  status: 'active'
};

const batchCreatives = [
  {
    name: 'Batch Banner 1',
    type: 'image',
    media_url: 'https://example.com/batch1.jpg',
    format: '728x90',
    dimensions: { width: 728, height: 90 },
    tags: ['batch', 'leaderboard']
  },
  {
    name: 'Batch Video',
    type: 'video',
    media_url: 'https://example.com/video.mp4',
    format: 'video',
    duration: 15,
    tags: ['batch', 'video']
  }
];

async function testAPI(endpoint, method, body) {
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });
    
    const result = await response.json();
    return { success: response.ok, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function runTests() {
  console.log('🧪 Testing Creative Management Functions\n');
  console.log('=====================================\n');
  
  // Test 1: Upload single creative
  console.log('1️⃣ Testing single creative upload...');
  const uploadResult = await testAPI('/api/sales/agents/principal_b7c46dd6/query', 'POST', {
    tool_name: 'manage_creative_assets',
    action: 'upload',
    assets: [singleCreative]
  });
  
  if (uploadResult.success && uploadResult.data.inventory_response) {
    console.log('✅ Single creative upload: PASSED');
    console.log('   - Response:', uploadResult.data.inventory_response.message || 'Success');
  } else {
    console.log('❌ Single creative upload: FAILED');
    console.log('   - Error:', uploadResult.error || uploadResult.data.error);
  }
  console.log();
  
  // Test 2: Batch upload
  console.log('2️⃣ Testing batch creative upload...');
  const batchResult = await testAPI('/api/sales/agents/principal_b7c46dd6/query', 'POST', {
    tool_name: 'manage_creative_assets',
    action: 'upload',
    assets: batchCreatives
  });
  
  if (batchResult.success && batchResult.data.inventory_response) {
    console.log('✅ Batch creative upload: PASSED');
    console.log('   - Response:', batchResult.data.inventory_response.message || 'Success');
  } else {
    console.log('❌ Batch creative upload: FAILED');
    console.log('   - Error:', batchResult.error || batchResult.data.error);
  }
  console.log();
  
  // Test 3: List creatives
  console.log('3️⃣ Testing list creatives...');
  const listResult = await testAPI('/api/sales/agents/principal_b7c46dd6/query', 'POST', {
    tool_name: 'list_creatives',
    include_assignments: true,
    include_performance: true
  });
  
  if (listResult.success && listResult.data.inventory_response) {
    const creatives = listResult.data.inventory_response.creatives || [];
    console.log('✅ List creatives: PASSED');
    console.log('   - Found', creatives.length, 'creatives');
    console.log('   - Response:', listResult.data.inventory_response.message || 'Success');
  } else {
    console.log('❌ List creatives: FAILED');
    console.log('   - Error:', listResult.error || listResult.data.error);
  }
  console.log();
  
  // Test 4: Sync creatives
  console.log('4️⃣ Testing sync creatives...');
  const syncResult = await testAPI('/api/sales/agents/principal_b7c46dd6/query', 'POST', {
    tool_name: 'sync_creatives',
    creatives: [
      { ...singleCreative, id: 'existing_creative_1' },
      { name: 'New Synced Creative', type: 'image', format: '320x50' }
    ]
  });
  
  if (syncResult.success && syncResult.data.inventory_response) {
    console.log('✅ Sync creatives: PASSED');
    console.log('   - Response:', syncResult.data.inventory_response.message || 'Success');
  } else {
    console.log('❌ Sync creatives: FAILED');
    console.log('   - Error:', syncResult.error || syncResult.data.error);
  }
  console.log();
  
  // Test 5: Assign creative to media buy
  console.log('5️⃣ Testing creative assignment to media buy...');
  const assignResult = await testAPI('/api/sales/agents/principal_b7c46dd6/query', 'POST', {
    tool_name: 'manage_creative_assets',
    action: 'assign',
    creative_ids: ['creative_001', 'creative_002'],
    media_buy_id: 'test_media_buy_123'
  });
  
  if (assignResult.success && assignResult.data.inventory_response) {
    console.log('✅ Creative assignment: PASSED');
    console.log('   - Response:', assignResult.data.inventory_response.message || 'Success');
  } else {
    console.log('❌ Creative assignment: FAILED');
    console.log('   - Error:', assignResult.error || assignResult.data.error);
  }
  console.log();
  
  // Test 6: Upload with immediate assignment
  console.log('6️⃣ Testing upload with immediate media buy assignment...');
  const uploadAssignResult = await testAPI('/api/sales/agents/principal_b7c46dd6/query', 'POST', {
    tool_name: 'manage_creative_assets',
    action: 'upload',
    assets: [{
      name: 'Direct Assignment Creative',
      type: 'image',
      media_url: 'https://example.com/direct.jpg',
      format: '300x250',
      dimensions: { width: 300, height: 250 }
    }],
    media_buy_id: 'direct_media_buy_456'
  });
  
  if (uploadAssignResult.success && uploadAssignResult.data.inventory_response) {
    console.log('✅ Upload with assignment: PASSED');
    console.log('   - Response:', uploadAssignResult.data.inventory_response.message || 'Success');
  } else {
    console.log('❌ Upload with assignment: FAILED');
    console.log('   - Error:', uploadAssignResult.error || uploadAssignResult.data.error);
  }
  console.log();
  
  console.log('=====================================');
  console.log('🏁 Creative Management Tests Complete!');
  console.log('\nℹ️  Note: These tests use mock data from the backend.');
  console.log('ℹ️  Open http://localhost:3006 to test the UI interactively.');
}

// Run tests
runTests().catch(console.error);