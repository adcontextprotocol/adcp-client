#!/usr/bin/env tsx

/**
 * Debug: Inspect actual preview_creative response
 */

import { AdCPClient } from '../src/lib/core/AdCPClient';

const CREATIVE_AGENT_URL = process.env.CREATIVE_AGENT_URL || 'https://creative.adcontextprotocol.org/mcp';
const CREATIVE_AGENT_PROTOCOL = (process.env.CREATIVE_AGENT_PROTOCOL || 'mcp') as 'mcp' | 'a2a';

async function main() {
  console.log('🐛 Debugging Preview Creative Response\n');

  const creativeAgent = new AdCPClient({
    id: 'creative_agent',
    name: 'Creative Agent',
    agent_uri: CREATIVE_AGENT_URL,
    protocol: CREATIVE_AGENT_PROTOCOL,
  });

  // Simple preview_creative request
  // Note: Using type assertion to bypass strict TypeScript validation
  // The actual creative agent expects plain strings for text assets
  const response = await creativeAgent.previewCreative({
    format_id: {
      agent_url: 'https://creative.adcontextprotocol.org/',
      id: 'product_card_standard',
    },
    creative_manifest: {
      format_id: {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'product_card_standard',
      },
      assets: {
        product_image: {
          url: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=300',
        },
        product_name: {
          content: 'Premium Display Package',
        },
        product_description: {
          content: 'High-visibility display advertising with guaranteed impressions and premium placements',
        },
        pricing_model: {
          content: 'CPM',
        },
        pricing_amount: {
          content: '5,000',
        },
        pricing_currency: {
          content: 'USD',
        },
        delivery_type: {
          content: 'Guaranteed',
        },
        primary_asset_type: {
          content: 'Display Banners',
        },
      },
    },
  } as any);

  console.log('Response success:', response.success);
  console.log('Response error:', response.error);
  console.log('\nFull response data:');
  console.log(JSON.stringify(response.data, null, 2));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
