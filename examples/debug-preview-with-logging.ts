#!/usr/bin/env tsx

/**
 * Debug with detailed logging
 */

import { AdCPClient } from '../src/lib/core/AdCPClient';
import { batchPreviewProducts } from '../src/lib/utils/preview-utils';
import type { Product } from '../src/lib/types/tools.generated';

const CREATIVE_AGENT_URL = process.env.CREATIVE_AGENT_URL || 'https://creative.adcontextprotocol.org/mcp';

async function main() {
  const creativeAgent = new AdCPClient({
    id: 'creative_agent',
    name: 'Creative Agent',
    agent_uri: CREATIVE_AGENT_URL,
    protocol: 'mcp',
  });

  const testProduct: Product = {
    product_id: 'test1',
    name: 'Test Product',
    product_card: {
      format_id: {
        agent_url: 'https://creative.adcontextprotocol.org/',
        id: 'product_card_standard',
      },
      manifest: {
        product_image: {
          url: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=300',
        },
        product_name: {
          content: 'Test Product',
        },
        product_description: {
          content: 'A test product for debugging',
        },
      } as any,
    },
  };

  console.log('📦 Calling batchPreviewProducts...\n');
  const results = await batchPreviewProducts([testProduct], creativeAgent);

  console.log('\n📊 Results:');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
