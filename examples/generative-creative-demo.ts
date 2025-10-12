#!/usr/bin/env tsx
// Demonstrates the new generative creative format support introduced in AdCP v1.7.0
// This example shows how to use the new format_id and assets structure for both
// static and generative creative workflows

import { ADCPMultiAgentClient, type SyncCreativesRequest } from '../src/lib';

async function demonstrateGenerativeCreatives() {
  console.log('🎨 Generative Creative Format Demo');
  console.log('===================================\n');

  // Initialize client from environment config
  const client = ADCPMultiAgentClient.fromEnv();

  // Get first available agent (just for demo purposes)
  const agentIds = client.getAgentIds();
  if (agentIds.length === 0) {
    throw new Error('No agents configured. Please set SALES_AGENTS_CONFIG environment variable.');
  }

  const agent = client.agent(agentIds[0]);
  console.log(`✅ Using agent: ${agent.config.name}`);
  console.log(`   URI: ${agent.config.agent_uri}`);
  console.log(`   Protocol: ${agent.config.protocol}\n`);

  // Example 1: Traditional static creative with new format
  console.log('📝 Example 1: Static Creative with new format_id structure\n');

  const staticCreativeRequest: SyncCreativesRequest = {
    creatives: [
      {
        creative_id: `static_banner_${Date.now()}`,
        name: 'Static Display Banner 300x250',
        format_id: {
          agent_url: 'https://creatives.adcontextprotocol.org',
          id: 'display_300x250'
        },
        assets: {
          image: {
            asset_type: 'image',
            url: 'https://example.com/banner-300x250.jpg',
            width: 300,
            height: 250,
            alt_text: 'Summer sale banner'
          },
          click_url: {
            asset_type: 'url',
            url: 'https://example.com/summer-sale',
            description: 'Landing page for summer sale campaign'
          }
        },
        tags: ['display', 'static', 'summer-sale']
      }
    ]
  };

  console.log('Static Creative Structure:');
  console.log(JSON.stringify(staticCreativeRequest, null, 2));
  console.log('\n' + '-'.repeat(50) + '\n');

  // Example 2: Generative creative with brand context
  console.log('📝 Example 2: Generative Creative with brand_manifest\n');

  const generativeCreativeRequest: SyncCreativesRequest = {
    creatives: [
      {
        creative_id: `gen_banner_${Date.now()}`,
        name: 'AI-Generated Display Banner',
        format_id: {
          agent_url: 'https://creatives.adcontextprotocol.org',
          id: 'display_300x250_generative'
        },
        assets: {
          brand_context: {
            asset_type: 'url',
            url: 'https://example.com',
            description: 'Brand website for context extraction'
          },
          generation_prompt: {
            asset_type: 'text',
            content: 'Create a vibrant summer sale banner highlighting 30% off outdoor furniture'
          },
          logo: {
            asset_type: 'image',
            url: 'https://example.com/logo.png',
            width: 100,
            height: 100
          }
        },
        inputs: [
          {
            name: 'Desktop View',
            macros: {
              DEVICE_TYPE: 'desktop'
            },
            context_description: 'Preview for desktop browsers at 1920x1080'
          },
          {
            name: 'Mobile View',
            macros: {
              DEVICE_TYPE: 'mobile'
            },
            context_description: 'Preview for mobile devices at 375x667'
          }
        ],
        tags: ['display', 'generative', 'ai', 'summer-sale']
      }
    ]
  };

  console.log('Generative Creative Structure:');
  console.log(JSON.stringify(generativeCreativeRequest, null, 2));
  console.log('\n' + '-'.repeat(50) + '\n');

  // Example 3: Approval workflow for generative creative
  console.log('📝 Example 3: Approving a Generative Creative\n');

  const approvalRequest: SyncCreativesRequest = {
    creatives: [
      {
        creative_id: 'gen_banner_12345', // Existing creative ID from previous sync
        name: 'AI-Generated Display Banner',
        format_id: {
          agent_url: 'https://creatives.adcontextprotocol.org',
          id: 'display_300x250_generative'
        },
        assets: {
          brand_context: {
            asset_type: 'url',
            url: 'https://example.com',
            description: 'Brand website for context extraction'
          },
          generation_prompt: {
            asset_type: 'text',
            content: 'Create a vibrant summer sale banner highlighting 30% off outdoor furniture'
          }
        },
        approved: true // Approve the generated preview
      }
    ],
    patch: true // Only update the approval status
  };

  console.log('Approval Request Structure:');
  console.log(JSON.stringify(approvalRequest, null, 2));
  console.log('\n' + '-'.repeat(50) + '\n');

  // Example 4: Request regeneration with updated prompt
  console.log('📝 Example 4: Request Regeneration\n');

  const regenerationRequest: SyncCreativesRequest = {
    creatives: [
      {
        creative_id: 'gen_banner_12345',
        name: 'AI-Generated Display Banner',
        format_id: {
          agent_url: 'https://creatives.adcontextprotocol.org',
          id: 'display_300x250_generative'
        },
        assets: {
          brand_context: {
            asset_type: 'url',
            url: 'https://example.com',
            description: 'Brand website for context extraction'
          },
          generation_prompt: {
            asset_type: 'text',
            content: 'Create a warm, inviting summer sale banner with emphasis on comfort and quality. Show 30% off outdoor furniture with natural colors.'
          }
        },
        approved: false // Request regeneration with updated prompt
      }
    ],
    patch: true
  };

  console.log('Regeneration Request Structure:');
  console.log(JSON.stringify(regenerationRequest, null, 2));
  console.log('\n' + '-'.repeat(50) + '\n');

  console.log('🎉 Demo complete!');
  console.log('\n📚 Key Changes in AdCP v1.7.0:');
  console.log('   ✓ format_id is now an object with agent_url and id');
  console.log('   ✓ assets is now a flexible object keyed by asset_role');
  console.log('   ✓ New asset types: url and brand_manifest');
  console.log('   ✓ inputs array for defining preview contexts');
  console.log('   ✓ approved field for generative creative workflows');
  console.log('   ✓ context_description for AI-generated content guidance');
}

// Run the demo
if (require.main === module) {
  demonstrateGenerativeCreatives()
    .then(() => {
      console.log('\n✨ Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { demonstrateGenerativeCreatives };
