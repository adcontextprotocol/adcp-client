#!/usr/bin/env tsx
// Sync a 300x250 creative to Wonderstruck Sales Agent

import { ADCPMultiAgentClient, type SyncCreativesRequest } from '../../src/lib';

async function syncWonderstruckCreative() {
  console.log('🎨 Syncing creative to Wonderstruck Sales Agent');
  console.log('===============================================\n');

  // Initialize client from environment config
  const client = ADCPMultiAgentClient.fromEnv();

  // Get the Wonderstruck A2A agent
  const agent = client.agent('principal_8ac9e391_a2a');

  console.log(`✅ Connected to agent: ${agent.config.name}`);
  console.log(`   URI: ${agent.config.agent_uri}`);
  console.log(`   Protocol: ${agent.config.protocol}\n`);

  // Prepare the creative sync request using new AdCP v1.7.0 format
  const syncRequest: SyncCreativesRequest = {
    creatives: [
      {
        creative_id: `wonderstruck_display_${Date.now()}`,
        name: 'Wonderstruck Display 300x250',
        format_id: {
          agent_url: 'https://creatives.adcontextprotocol.org',
          id: 'display_300x250'
        },
        assets: {
          image: {
            asset_type: 'image',
            url: 'https://storage.googleapis.com/scope3-assets-swift-catfish/customers/1/brand-agents/48/assets/079fadf7-ec79-4fcc-81b1-f3c6df585d5b.jpg',
            width: 300,
            height: 250
          },
          click_url: {
            asset_type: 'url',
            url: 'https://wonderstruck.org',
            description: 'Wonderstruck organization website'
          }
        },
        tags: ['display', 'banner', '300x250', 'wonderstruck']
      }
    ]
  };

  console.log('📤 Syncing creative asset...');
  console.log(`   Creative ID: ${syncRequest.creatives[0].creative_id}`);
  console.log(`   Name: ${syncRequest.creatives[0].name}`);
  console.log(`   Format ID: ${syncRequest.creatives[0].format_id.agent_url}/${syncRequest.creatives[0].format_id.id}`);
  console.log(`   Image URL: ${syncRequest.creatives[0].assets.image.asset_type === 'image' ? syncRequest.creatives[0].assets.image.url : 'N/A'}`);
  console.log(`   Click URL: ${syncRequest.creatives[0].assets.click_url.asset_type === 'url' ? syncRequest.creatives[0].assets.click_url.url : 'N/A'}\n`);

  try {
    const result = await agent.syncCreatives(syncRequest);

    console.log('\n' + '='.repeat(50));

    // Debug: Log the full result
    console.log('\n🔍 DEBUG: Full result object:');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n' + '='.repeat(50));

    if (result.success) {
      console.log('✅ SUCCESS! Creative synced successfully\n');
      console.log('Response Details:');
      console.log(`   Status: ${result.status}`);
      console.log(`   Response Time: ${result.metadata.responseTimeMs}ms`);
      console.log(`   Task ID: ${result.metadata.taskId}`);

      if (result.data) {
        console.log('\nSync Results:');
        console.log(`   Created: ${result.data.created?.length || 0} creatives`);
        console.log(`   Updated: ${result.data.updated?.length || 0} creatives`);
        console.log(`   Failed: ${result.data.failed?.length || 0} creatives`);

        if (result.data.created && result.data.created.length > 0) {
          console.log('\n📦 Created Creatives:');
          result.data.created.forEach((creative: any) => {
            console.log(`   - ${creative.creative_id}: ${creative.name}`);
            if (creative.status) {
              console.log(`     Status: ${creative.status}`);
            }
          });
        }

        if (result.data.errors && result.data.errors.length > 0) {
          console.log('\n⚠️  Warnings/Errors:');
          result.data.errors.forEach((error: any) => {
            console.log(`   - ${error.message || error}`);
          });
        }
      }

      console.log('\n🎉 Creative successfully synced to Wonderstruck!');
      console.log('   You can now use this creative in media buys.');

    } else {
      console.log('❌ FAILED to sync creative\n');
      console.log('Error Details:');
      console.log(`   Error: ${result.error}`);
      console.log(`   Status: ${result.status}`);

      if (result.metadata) {
        console.log(`   Response Time: ${result.metadata.responseTimeMs}ms`);
      }
    }

    console.log('='.repeat(50) + '\n');

  } catch (error: any) {
    console.error('\n❌ Exception occurred during sync:');
    console.error(`   ${error.message}`);

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
  }
}

// Run the sync
if (require.main === module) {
  syncWonderstruckCreative()
    .then(() => {
      console.log('✨ Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { syncWonderstruckCreative };
