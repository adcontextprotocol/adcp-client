#!/usr/bin/env tsx
// Create a media buy on Wonderstruck with the synced creative

import { ADCPMultiAgentClient, type CreateMediaBuyRequest } from '../../src/lib';

async function createWonderstruckMediaBuy() {
  console.log('💰 Creating Media Buy on Wonderstruck Sales Agent');
  console.log('==================================================\n');

  // Initialize client from environment config
  const client = ADCPMultiAgentClient.fromEnv();

  // Get the Wonderstruck A2A agent
  const agent = client.agent('principal_8ac9e391_a2a');

  console.log(`✅ Connected to agent: ${agent.config.name}`);
  console.log(`   URI: ${agent.config.agent_uri}`);
  console.log(`   Protocol: ${agent.config.protocol}\n`);

  // Step 1: Get available products to find 300x250 options
  console.log('📋 Step 1: Getting available products...');

  const productsResult = await agent.getProducts({
    brief: 'Looking for 300x250 display advertising inventory',
    promoted_offering: 'Wonderstruck brand awareness'
  });

  if (!productsResult.success) {
    console.error('❌ Failed to get products:', productsResult.error);
    return;
  }

  console.log(`✅ Found ${productsResult.data.products?.length || 0} products\n`);

  // Find a product that supports 300x250
  const products = productsResult.data.products || [];
  let selected300x250Product = null;

  for (const product of products) {
    console.log(`\n📦 Product: ${product.name || product.product_id}`);
    if (product.description) {
      console.log(`   Description: ${product.description}`);
    }
    if (product.formats) {
      console.log(`   Formats: ${product.formats.join(', ')}`);
      // Check if this product supports 300x250
      if (product.formats.some((f: string) => f.includes('300x250') || f.includes('display'))) {
        selected300x250Product = product;
        console.log('   ✨ This product supports 300x250!');
      }
    }
    if (product.pricing) {
      console.log(`   Pricing: ${JSON.stringify(product.pricing)}`);
    }
  }

  if (!selected300x250Product) {
    console.log('\n⚠️  No product found that explicitly supports 300x250');
    console.log('   Using the first available product...');
    selected300x250Product = products[0];
  }

  if (!selected300x250Product) {
    console.error('\n❌ No products available to create media buy');
    return;
  }

  console.log(`\n✅ Selected product: ${selected300x250Product.name || selected300x250Product.product_id}`);

  // Step 2: Create the media buy with our synced creative
  console.log('\n💰 Step 2: Creating media buy...');

  // Get the creative ID - either from command line or list creatives
  let creativeId = process.argv[2]; // First command line argument

  if (!creativeId) {
    console.log('\n🔍 No creative ID provided, listing available creatives...');
    const creativesResult = await agent.listCreatives({});

    if (creativesResult.success && creativesResult.data.creatives && creativesResult.data.creatives.length > 0) {
      // Use the most recently created creative
      const sortedCreatives = creativesResult.data.creatives.sort((a: any, b: any) => {
        return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
      });

      creativeId = sortedCreatives[0].creative_id;
      console.log(`✅ Using most recent creative: ${creativeId}`);
      console.log(`   Name: ${sortedCreatives[0].name}`);
      console.log(`   Created: ${sortedCreatives[0].created_at}`);
    } else {
      console.error('❌ No creatives found. Please sync a creative first.');
      return;
    }
  } else {
    console.log(`\n✅ Using provided creative ID: ${creativeId}`);
  }

  const mediaBuyRequest: CreateMediaBuyRequest = {
    buyer_ref: `wonderstruck_buy_${Date.now()}`,
    po_number: `PO-${Date.now()}`, // Required by Wonderstruck
    promoted_offering: 'Wonderstruck brand awareness campaign with 300x250 display creative', // Required field per AdCP spec
    budget: {
      total: 5000,
      currency: 'USD'
    },
    start_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Tomorrow
    end_time: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(), // 31 days from now
    packages: [
      {
        buyer_ref: `pkg_ref_${Date.now()}`, // Required per AdCP spec
        products: [selected300x250Product.product_id], // Required: array of product IDs
        format_ids: ['display_300x250'], // Required: array of format IDs
        creative_ids: [creativeId], // Optional: creative IDs to assign at creation time
        budget: {
          total: 5000, // Budget uses 'total', not 'amount'
          currency: 'USD'
        }
      }
    ]
  };

  console.log(`\n📤 Creating media buy...`);
  console.log(`   Buyer Ref: ${mediaBuyRequest.buyer_ref}`);
  console.log(`   Product: ${selected300x250Product.product_id}`);
  console.log(`   Creative: ${creativeId}`);
  console.log(`   Budget: $${mediaBuyRequest.packages[0].budget?.total} USD`);
  console.log(`   Flight: ${mediaBuyRequest.start_time} to ${mediaBuyRequest.end_time}\n`);

  try {
    const result = await agent.createMediaBuy(mediaBuyRequest);

    console.log('\n' + '='.repeat(50));

    if (result.success) {
      console.log('✅ SUCCESS! Media buy created\n');
      console.log('Response Details:');
      console.log(`   Status: ${result.status}`);
      console.log(`   Response Time: ${result.metadata.responseTimeMs}ms`);
      console.log(`   Task ID: ${result.metadata.taskId}`);

      if (result.data) {
        console.log('\nMedia Buy Details:');
        if (result.data.media_buy_id) {
          console.log(`   Media Buy ID: ${result.data.media_buy_id}`);
        }
        if (result.data.status) {
          console.log(`   Status: ${result.data.status}`);
        }
        if (result.data.packages) {
          console.log(`\n   Packages (${result.data.packages.length}):`);
          result.data.packages.forEach((pkg: any, i: number) => {
            console.log(`     ${i + 1}. Package ID: ${pkg.package_id}`);
            if (pkg.status) {
              console.log(`        Status: ${pkg.status}`);
            }
            if (pkg.product_id) {
              console.log(`        Product: ${pkg.product_id}`);
            }
          });
        }
      }

      console.log('\n🎉 Media buy successfully created on Wonderstruck!');
      console.log('   Your 300x250 creative is now running.');

    } else {
      console.log('❌ FAILED to create media buy\n');
      console.log('Error Details:');
      console.log(`   Error: ${result.error}`);
      console.log(`   Status: ${result.status}`);

      if (result.metadata) {
        console.log(`   Response Time: ${result.metadata.responseTimeMs}ms`);
      }

      // Show debug logs if available
      if (result.debug_logs) {
        console.log('\n📝 Debug Logs:');
        result.debug_logs.slice(-5).forEach((log: any) => {
          console.log(`   [${log.type}] ${log.message}`);
          if (log.response) {
            console.log(`   Response: ${JSON.stringify(log.response, null, 2)}`);
          }
        });
      }

      // Show full result for debugging
      console.log('\n🔍 Full result:');
      console.log(JSON.stringify(result, null, 2));
    }

    console.log('='.repeat(50) + '\n');

  } catch (error: any) {
    console.error('\n❌ Exception occurred:');
    console.error(`   ${error.message}`);

    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
  }
}

// Run the media buy creation
if (require.main === module) {
  createWonderstruckMediaBuy()
    .then(() => {
      console.log('✨ Done!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { createWonderstruckMediaBuy };
