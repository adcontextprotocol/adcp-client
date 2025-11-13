#!/usr/bin/env tsx
// Full Wonderstruck test: Brand Card → Get Products → Create Media Buy → Sync Creatives → Update Media Buy

import { readFileSync } from 'fs';
import {
  ADCPMultiAgentClient,
  type CreateMediaBuyRequest,
  type SyncCreativesRequest,
  type UpdateMediaBuyRequest,
} from '../../src/lib';
import path from 'path';

async function fullWonderstruckTest() {
  console.log('🎯 Full Wonderstruck Test Workflow');
  console.log('===================================\n');

  // Initialize client from environment config
  const client = ADCPMultiAgentClient.fromEnv();

  // Get the test sales agent for products
  // (Wonderstruck is a brand, not a sales agent with inventory)
  const agentId = process.env.TEST_AGENT_ID || 'principal_3bd0d4a8';
  const agent = client.agent(agentId);
  const agentConfig = agent.getAgent();

  console.log(`✅ Connected to agent: ${agentConfig.name}`);
  console.log(`   URI: ${agentConfig.agent_uri}`);
  console.log(`   Protocol: ${agentConfig.protocol}\n`);

  // STEP 1: Load Brand Card
  console.log('📋 STEP 1: Loading Wonderstruck Brand Card');
  console.log('='.repeat(50));

  const brandCardPath = path.join(__dirname, 'wonderstruck-brand-card.json');
  const brandCard = JSON.parse(readFileSync(brandCardPath, 'utf8'));

  console.log(`✅ Brand Card Loaded:`);
  console.log(`   Brand: ${brandCard.brand_name}`);
  console.log(`   Tagline: ${brandCard.tagline}`);
  console.log(`   Colors: ${brandCard.visual_identity.primary_colors.map((c: any) => c.name).join(', ')}`);
  console.log(`   Assets: ${brandCard.asset_library.length} items\n`);

  // STEP 2: Get Products from ALL agents
  console.log('📦 STEP 2: Getting Products from ALL Sales Agents');
  console.log('='.repeat(50));

  const brief = `Looking for 300x250 display advertising inventory for ${brandCard.brand_name}, a consciousness and spirituality podcast. Target audience includes spiritually curious adults, consciousness researchers, and philosophy enthusiasts interested in transformative experiences and extraordinary phenomena.`;

  // Query all agents in parallel using our multi-agent client
  const allAgentIds = client.getAgentIds();
  console.log(`\n🔍 Querying ${allAgentIds.length} agents: ${allAgentIds.join(', ')}\n`);

  const productResults = await Promise.all(
    allAgentIds.map(async id => {
      const agentClient = client.agent(id);
      const agentConfig = agentClient.getAgent();
      try {
        console.log(`   Querying ${agentConfig.name}...`);
        const result = await agentClient.getProducts({
          brief,
          promoted_offering: `${brandCard.brand_name}: ${brandCard.mission}`,
        });
        if (!result.success) {
          console.log(`   ⚠️  ${agentConfig.name} returned error: ${result.error}`);
          console.log(`      Status: ${result.status}, Data: ${JSON.stringify(result.data)}`);
        } else {
          const count = result.data?.products?.length || 0;
          console.log(`   ✅ ${agentConfig.name}: ${count} products`);
        }
        return { agentId: id, agentName: agentConfig.name, result };
      } catch (error: any) {
        console.log(`   ❌ ${agentConfig.name} exception: ${error.message}`);
        console.log(`      Stack: ${error.stack?.split('\n')[0]}`);
        return { agentId: id, agentName: agentConfig.name, result: null };
      }
    })
  );

  // Collect all products from all agents
  const allProducts: Array<{ product: any; agentId: string; agentName: string }> = [];
  productResults.forEach(({ agentId, agentName, result }) => {
    if (result?.success && result.data?.products) {
      result.data.products.forEach((product: any) => {
        allProducts.push({ product, agentId, agentName });
      });
    }
  });

  console.log(`\n✅ Found ${allProducts.length} total products across all agents`);

  if (allProducts.length === 0) {
    console.error('❌ No products available');
    return;
  }

  // Display products grouped by agent
  allProducts.forEach(({ product, agentName }, i: number) => {
    console.log(`\n${i + 1}. ${product.name || product.product_id} [${agentName}]`);
    if (product.description) {
      console.log(`   Description: ${product.description}`);
    }
    if (product.formats) {
      console.log(`   Formats: ${product.formats.join(', ')}`);
    }
    if (product.pricing_options) {
      console.log(`   Pricing Options: ${product.pricing_options.length} available`);
      product.pricing_options.forEach((po: any, j: number) => {
        console.log(`      ${j + 1}. ${po.pricing_option_id}: ${po.pricing_model} (${po.currency || 'N/A'})`);
      });
    }
  });

  // STEP 3: Choose a Product that supports 300x250
  console.log('\n📌 STEP 3: Choosing Product');
  console.log('='.repeat(50));

  // First, try to find the Wonderstruck "Live 300x250" product
  let selectedProductEntry = allProducts.find(
    ({ product, agentName }) =>
      agentName.toLowerCase().includes('wonderstruck') &&
      (product.name?.includes('300x250') || product.description?.includes('300x250'))
  );

  if (selectedProductEntry) {
    console.log('✅ Found Wonderstruck 300x250 product!');
  }

  // Fallback: Look for any product that explicitly supports 300x250
  if (!selectedProductEntry) {
    selectedProductEntry = allProducts.find(({ product }) =>
      product.formats?.some((f: string) => f.includes('300x250') || f === 'display_300x250')
    );
  }

  // Last resort: Any display product
  if (!selectedProductEntry) {
    console.log('⚠️  No product explicitly supports 300x250, checking for display products...');
    selectedProductEntry = allProducts.find(
      ({ product }) =>
        product.name?.toLowerCase().includes('display') || product.description?.toLowerCase().includes('display')
    );
  }

  // Use any product from Wonderstruck if available
  if (!selectedProductEntry) {
    console.log('⚠️  No display product found, using first available Wonderstruck product...');
    selectedProductEntry = allProducts.find(({ agentName }) => agentName.toLowerCase().includes('wonderstruck'));
  }

  if (!selectedProductEntry) {
    console.error('❌ No suitable product found');
    return;
  }

  const selectedProduct = selectedProductEntry.product;
  const selectedAgent = client.agent(selectedProductEntry.agentId);

  console.log(`✅ Selected: ${selectedProduct.name || selectedProduct.product_id} [${selectedProductEntry.agentName}]`);
  console.log(`   Product ID: ${selectedProduct.product_id}`);
  if (selectedProduct.formats) {
    console.log(`   Formats: ${selectedProduct.formats.join(', ')}`);
  }

  // Select first available pricing option (preferably CPM)
  const pricingOptions = selectedProduct.pricing_options || [];
  let selectedPricingOption = pricingOptions.find((po: any) => po.pricing_model === 'cpm') || pricingOptions[0];

  if (selectedPricingOption) {
    console.log(`   Selected Pricing Option: ${selectedPricingOption.pricing_option_id}`);
    console.log(`   Model: ${selectedPricingOption.pricing_model}`);
    console.log(`   Currency: ${selectedPricingOption.currency}`);
  } else {
    console.log(`   ⚠️  No pricing options available - using legacy format`);
  }
  console.log();

  // STEP 4: Create Media Buy
  console.log('💰 STEP 4: Creating Media Buy');
  console.log('='.repeat(50));

  const buyerRef = `wonderstruck_${Date.now()}`;

  // Use our library to intelligently find compatible formats
  console.log('\n🎨 Discovering creative formats using CreativeAgentClient...');

  // Get the standard creative agent
  const creativeAgent = client.getStandardCreativeAgent();
  console.log(`📡 Connected to: ${creativeAgent.getAgentUrl()}`);

  // Get all display formats
  const displayFormats = await client.findFormatsByType('display');
  console.log(`\n✅ Found ${displayFormats.length} display formats total`);

  // Choose the best format: prefer image over generative
  // The format's renders array contains the actual dimensions
  const selectedFormat = displayFormats.find(f => f.format_id.id.includes('image')) || displayFormats[0];

  if (!selectedFormat) {
    throw new Error('No display format found in creative agent');
  }

  // Get dimensions from the format's renders (per AdCP v2.0.0 spec)
  const primaryRender = selectedFormat.renders?.[0];
  const width = primaryRender?.dimensions?.width || 300;
  const height = primaryRender?.dimensions?.height || 250;

  console.log(`\n📐 Selected format: ${selectedFormat.format_id.id}`);
  console.log(`   Name: ${selectedFormat.name}`);
  console.log(`   Type: ${selectedFormat.type}`);
  console.log(`   Dimensions: ${width}x${height} (from format spec)`);
  console.log(`   Agent: ${selectedFormat.agent_url}`);
  if (selectedFormat.description) {
    console.log(`   Description: ${selectedFormat.description}`);
  }

  // Use structured format IDs per AdCP v1.8.0 spec (creative agent already returns them structured)
  const formatIds = [
    {
      agent_url: selectedFormat.format_id.agent_url,
      id: selectedFormat.format_id.id,
    },
  ];

  const mediaBuyRequest: CreateMediaBuyRequest = {
    buyer_ref: buyerRef,
    po_number: `PO-${Date.now()}`,
    brand_manifest: brandCard, // NEW in PR #88: Use full brand card as brand_manifest
    promoted_offering: `${brandCard.brand_name}: ${brandCard.mission}`, // DEPRECATED in v1.8.0 but still required by v2.4 servers
    budget: 5000, // NEW in PR #88: Simplified to just a number (currency from pricing_option_id)
    start_time: 'asap', // Using the ASAP feature from PR #84
    end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    packages: [
      {
        buyer_ref: `pkg_${Date.now()}`,
        product_id: selectedProduct.product_id, // NEW in v1.8.0: Use product_id instead of products array
        format_ids: formatIds,
        ...(selectedPricingOption && { pricing_option_id: selectedPricingOption.pricing_option_id }), // NEW in PR #88: Select pricing model
        budget: 5000, // NEW in PR #88: Package budget is now just a number
      },
    ],
  };

  console.log(`📤 Creating media buy with ASAP start time...`);
  console.log(`   Buyer Ref: ${buyerRef}`);
  console.log(`   Brand: ${brandCard.brand_name}`);
  console.log(`   Product: ${selectedProduct.product_id}`);
  console.log(`   Agent: ${selectedProductEntry.agentName}`);
  if (selectedPricingOption) {
    console.log(`   Pricing Model: ${selectedPricingOption.pricing_model}`);
    console.log(`   Budget: ${mediaBuyRequest.budget} ${selectedPricingOption.currency}`);
  } else {
    console.log(`   Budget: ${mediaBuyRequest.budget} (currency TBD)`);
  }
  console.log(`   Start: ASAP\n`);

  const mediaBuyResult = await selectedAgent.createMediaBuy(mediaBuyRequest);

  if (!mediaBuyResult.success) {
    console.error('❌ Failed to create media buy:', mediaBuyResult.error);
    console.error('Full result:', JSON.stringify(mediaBuyResult, null, 2));
    return;
  }

  const mediaBuyId = mediaBuyResult.data.media_buy_id;
  console.log(`✅ Media Buy Created!`);
  console.log(`   Media Buy ID: ${mediaBuyId}`);
  console.log(`   Status: ${mediaBuyResult.data.status}\n`);

  // STEP 5: Sync Creatives with Brand Card
  console.log('🎨 STEP 5: Syncing Creatives with Brand Card');
  console.log('='.repeat(50));

  const assetId = `display_${width}x${height}`;
  const displayAsset = brandCard.asset_library.find((a: any) => a.asset_id === assetId);

  if (!displayAsset) {
    console.error(`❌ No ${width}x${height} asset found in brand card (expected asset_id: ${assetId})`);
    console.log('   Available assets:', brandCard.asset_library.map((a: any) => a.asset_id).join(', '));
    return;
  }

  const creativeId = `wonderstruck_${width}x${height}_${Date.now()}`;
  const syncRequest: SyncCreativesRequest = {
    creatives: [
      {
        creative_id: creativeId,
        name: `${brandCard.brand_name} - ${width}x${height} Display`,
        format_id: {
          agent_url: 'https://creatives.adcontextprotocol.org',
          id: `display_${width}x${height}`,
        },
        assets: {},
        media_url: displayAsset.url,
        click_url: brandCard.website,
        width: displayAsset.dimensions.width,
        height: displayAsset.dimensions.height,
        tags: ['wonderstruck', 'podcast', 'consciousness', `${width}x${height}`],
      },
    ],
  };

  console.log(`📤 Syncing creative...`);
  console.log(`   Creative ID: ${creativeId}`);
  console.log(`   Name: ${syncRequest.creatives[0].name}`);
  console.log(`   Media URL: ${syncRequest.creatives[0].media_url}`);
  console.log(`   Click URL: ${syncRequest.creatives[0].click_url}\n`);

  const syncResult = await selectedAgent.syncCreatives(syncRequest);

  if (!syncResult.success) {
    console.error('❌ Failed to sync creatives:', syncResult.error);
    console.error('Full result:', JSON.stringify(syncResult, null, 2));
    return;
  }

  console.log(`✅ Creative Synced!`);
  console.log(`   Created: ${syncResult.data.created?.length || 0}`);
  console.log(`   Updated: ${syncResult.data.updated?.length || 0}`);
  console.log(`   Failed: ${syncResult.data.failed?.length || 0}\n`);

  // STEP 6: Update Media Buy to attach the creative
  console.log('🔄 STEP 6: Updating Media Buy to Attach Creative');
  console.log('='.repeat(50));

  const updateRequest: UpdateMediaBuyRequest = {
    media_buy_id: mediaBuyId,
    packages: [
      {
        package_id: mediaBuyResult.data.packages?.[0]?.package_id,
        creative_ids: [creativeId],
      },
    ],
  };

  console.log(`📤 Updating media buy...`);
  console.log(`   Media Buy ID: ${mediaBuyId}`);
  console.log(`   Adding Creative: ${creativeId}\n`);

  const updateResult = await selectedAgent.updateMediaBuy(updateRequest);

  if (!updateResult.success) {
    console.error('❌ Failed to update media buy:', updateResult.error);
    console.error('Full result:', JSON.stringify(updateResult, null, 2));
    return;
  }

  console.log(`✅ Media Buy Updated!`);
  console.log(`   Status: ${updateResult.data.status}`);

  // FINAL SUMMARY
  console.log('\n' + '='.repeat(50));
  console.log('🎉 SUCCESS! Full Workflow Completed');
  console.log('='.repeat(50));
  console.log('\n📊 Summary:');
  console.log(`   ✅ Brand Card: ${brandCard.brand_name}`);
  console.log(`   ✅ Products Retrieved: ${allProducts.length}`);
  console.log(`   ✅ Media Buy Created: ${mediaBuyId}`);
  console.log(`   ✅ Creative Synced: ${creativeId}`);
  console.log(`   ✅ Media Buy Updated with Creative`);
  console.log('\n🚀 Creative should now be live on wonderstruck.org!');
  console.log(`   Format: ${width}x${height} display banner`);
  console.log(`   Click URL: ${brandCard.website}`);
  console.log(`   Creative URL: ${displayAsset.url}\n`);
}

// Run the full test
if (require.main === module) {
  fullWonderstruckTest()
    .then(() => {
      console.log('✨ Test completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Fatal error:', error);
      console.error(error.stack);
      process.exit(1);
    });
}

export { fullWonderstruckTest };
