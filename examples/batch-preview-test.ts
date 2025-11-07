#!/usr/bin/env tsx

/**
 * Test batch preview functionality with creative agent
 *
 * This example demonstrates:
 * 1. Creating mock products/formats with product_card/format_card manifests
 * 2. Using batchPreviewProducts/batchPreviewFormats to render cards
 * 3. Caching behavior
 */

import { ADCPClient } from '../src/lib/core/ADCPClient';
import { batchPreviewProducts, batchPreviewFormats, clearPreviewCache } from '../src/lib/utils/preview-utils';
import type { Product, Format } from '../src/lib/types/tools.generated';

// Configuration
const CREATIVE_AGENT_URL = process.env.CREATIVE_AGENT_URL || 'https://creative.adcontextprotocol.org/mcp';
const CREATIVE_AGENT_PROTOCOL = (process.env.CREATIVE_AGENT_PROTOCOL || 'mcp') as 'mcp' | 'a2a';

async function main() {
  console.log('🧪 Testing Batch Preview Functionality\n');

  // Create ADCPClient for creative agent
  const creativeAgent = new ADCPClient({
    id: 'creative_agent',
    name: 'Creative Agent',
    agent_uri: CREATIVE_AGENT_URL,
    protocol: CREATIVE_AGENT_PROTOCOL,
  });

  console.log(`📡 Connected to creative agent: ${CREATIVE_AGENT_URL}`);
  console.log(`🔌 Using protocol: ${CREATIVE_AGENT_PROTOCOL}\n`);

  // Test 1: Batch preview products with product_card
  console.log('═══════════════════════════════════════════════════════════');
  console.log('Test 1: Batch Preview Products');
  console.log('═══════════════════════════════════════════════════════════\n');

  const testProducts: Product[] = [
    {
      product_id: 'test_product_1',
      name: 'Premium Display Package',
      description: 'High-visibility display advertising',
      product_card: {
        format_id: {
          agent_url: CREATIVE_AGENT_URL.replace('/mcp', ''),
          id: 'product_card_standard',
        },
        manifest: {
          product_image: {
            url: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&h=300',
          },
          product_name: {
            text: 'Premium Display Package',
          },
          product_description: {
            text: 'High-visibility display advertising with guaranteed impressions and premium placements across our network.',
          },
          pricing_model: {
            text: 'CPM',
          },
          pricing_amount: {
            text: '5000',
          },
          pricing_currency: {
            text: 'USD',
          },
        },
      },
    },
    {
      product_id: 'test_product_2',
      name: 'Video Advertising',
      description: 'Engaging video ad placements',
      product_card: {
        format_id: {
          agent_url: CREATIVE_AGENT_URL.replace('/mcp', ''),
          id: 'product_card_standard',
        },
        manifest: {
          product_image: {
            url: 'https://images.unsplash.com/photo-1536240478700-b869070f9279?w=400&h=300',
          },
          product_name: {
            text: 'Video Advertising',
          },
          product_description: {
            text: 'Pre-roll and mid-roll video inventory with 15s and 30s spots in HD quality.',
          },
          pricing_model: {
            text: 'CPCV',
          },
          pricing_amount: {
            text: '10000',
          },
          pricing_currency: {
            text: 'USD',
          },
        },
      },
    },
    {
      product_id: 'test_product_3',
      name: 'Sponsored Content',
      description: 'Native advertising opportunities',
      // No product_card - should return without preview
    },
  ];

  try {
    console.log(`📦 Testing with ${testProducts.length} products...`);
    const startTime = Date.now();

    const productPreviews = await batchPreviewProducts(testProducts, creativeAgent);

    const elapsed = Date.now() - startTime;
    console.log(`✅ Batch preview completed in ${elapsed}ms\n`);

    console.log('Results:');
    productPreviews.forEach((preview, index) => {
      const product = preview.item as Product;
      console.log(`\n  Product ${index + 1}: ${product.name}`);
      if (preview.previewUrl) {
        console.log(`    ✅ Preview URL: ${preview.previewUrl}`);
        console.log(`    📝 Preview ID: ${preview.previewId}`);
      } else if (preview.error) {
        console.log(`    ❌ Error: ${preview.error}`);
      } else {
        console.log(`    ⚠️  No product_card provided`);
      }
    });

    // Test caching
    console.log('\n─────────────────────────────────────────────────────────');
    console.log('Testing cache...\n');

    const cacheStartTime = Date.now();
    const cachedPreviews = await batchPreviewProducts(testProducts, creativeAgent);
    const cacheElapsed = Date.now() - cacheStartTime;

    console.log(`✅ Cached preview completed in ${cacheElapsed}ms`);
    console.log(`⚡ Speed improvement: ${Math.round((elapsed / cacheElapsed) * 100) / 100}x faster\n`);
  } catch (error) {
    console.error('❌ Product preview test failed:', error);
  }

  // Test 2: Batch preview formats with format_card
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Test 2: Batch Preview Formats');
  console.log('═══════════════════════════════════════════════════════════\n');

  const format1 = {
    format_id: {
      agent_url: 'https://example.com',
      id: 'display_300x250',
    },
    name: 'Medium Rectangle',
    description: '300x250 display banner',
    type: 'display' as const,
  };

  const format2 = {
    format_id: {
      agent_url: 'https://example.com',
      id: 'video_1920x1080',
    },
    name: 'HD Video',
    description: '1920x1080 video format',
    type: 'video' as const,
  };

  const testFormats: Format[] = [
    {
      ...format1,
      format_card: {
        format_id: {
          agent_url: CREATIVE_AGENT_URL.replace('/mcp', ''),
          id: 'format_card_standard',
        },
        manifest: {
          format: {
            text: JSON.stringify(format1),
          },
        },
      },
    },
    {
      ...format2,
      format_card: {
        format_id: {
          agent_url: CREATIVE_AGENT_URL.replace('/mcp', ''),
          id: 'format_card_standard',
        },
        manifest: {
          format: {
            text: JSON.stringify(format2),
          },
        },
      },
    },
  ];

  try {
    console.log(`📦 Testing with ${testFormats.length} formats...`);
    const startTime = Date.now();

    const formatPreviews = await batchPreviewFormats(testFormats, creativeAgent);

    const elapsed = Date.now() - startTime;
    console.log(`✅ Batch preview completed in ${elapsed}ms\n`);

    console.log('Results:');
    formatPreviews.forEach((preview, index) => {
      const format = preview.item as Format;
      console.log(`\n  Format ${index + 1}: ${format.name}`);
      if (preview.previewUrl) {
        console.log(`    ✅ Preview URL: ${preview.previewUrl}`);
        console.log(`    📝 Preview ID: ${preview.previewId}`);
      } else if (preview.error) {
        console.log(`    ❌ Error: ${preview.error}`);
      } else {
        console.log(`    ⚠️  No format_card provided`);
      }
    });
  } catch (error) {
    console.error('❌ Format preview test failed:', error);
  }

  // Test 3: Cache clearing
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('Test 3: Cache Management');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('🗑️  Clearing preview cache...');
  clearPreviewCache();
  console.log('✅ Cache cleared\n');

  console.log('📦 Re-fetching products (should be slower now)...');
  const noCacheStartTime = Date.now();
  await batchPreviewProducts(testProducts.slice(0, 2), creativeAgent);
  const noCacheElapsed = Date.now() - noCacheStartTime;
  console.log(`✅ Completed in ${noCacheElapsed}ms (cache was cleared)\n`);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ All tests completed!');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run tests
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
