#!/usr/bin/env tsx

/**
 * Inspect card format definitions from creative agent
 *
 * This will help us understand:
 * 1. What format IDs are available for cards (product_card, format_card)
 * 2. What assets those formats expect (using new `assets` field or deprecated `assets_required`)
 * 3. How to properly structure creative_manifest for cards
 */

import { AdCPClient } from '../src/lib/core/AdCPClient';
import { getFormatAssets, getRequiredAssets, getOptionalAssets, usesDeprecatedAssetsField } from '../src/lib';

const CREATIVE_AGENT_URL = process.env.CREATIVE_AGENT_URL || 'https://creative.adcontextprotocol.org/mcp';
const CREATIVE_AGENT_PROTOCOL = (process.env.CREATIVE_AGENT_PROTOCOL || 'mcp') as 'mcp' | 'a2a';

async function main() {
  console.log('🔍 Inspecting Card Format Definitions\n');

  const creativeAgent = new AdCPClient({
    id: 'creative_agent',
    name: 'Creative Agent',
    agent_uri: CREATIVE_AGENT_URL,
    protocol: CREATIVE_AGENT_PROTOCOL,
  });

  console.log(`📡 Connected to: ${CREATIVE_AGENT_URL}\n`);

  // List all formats
  console.log('📋 Fetching all creative formats...');
  const result = await creativeAgent.listCreativeFormatsLegacy({});

  if (!result.success || !result.data) {
    console.error('❌ Failed to fetch formats:', result.error);
    process.exit(1);
  }

  const formats = result.data.formats || [];
  console.log(`✅ Found ${formats.length} formats\n`);

  // Look for card formats
  const cardFormats = formats.filter(
    f =>
      f.format_id.id.includes('card') ||
      f.name?.toLowerCase().includes('card') ||
      f.description?.toLowerCase().includes('card')
  );

  if (cardFormats.length === 0) {
    console.log('⚠️  No formats with "card" in name/description found');
    console.log('\n📋 All available format IDs:');
    formats.forEach(f => {
      console.log(`  - ${f.format_id.id}: ${f.name || 'Unnamed'}`);
    });
  } else {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('CARD FORMATS FOUND');
    console.log('═══════════════════════════════════════════════════════════\n');

    cardFormats.forEach((format, index) => {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`Format ${index + 1}: ${format.name || 'Unnamed'}`);
      console.log('─'.repeat(60));
      console.log(`Format ID: ${format.format_id.id}`);
      console.log(`Agent URL: ${format.format_id.agent_url}`);
      console.log(`Type: ${format.type || 'N/A'}`);
      console.log(`Description: ${format.description || 'N/A'}`);

      const assets = getFormatAssets(format);
      if (assets.length > 0) {
        const requiredAssets = getRequiredAssets(format);
        const optionalAssets = getOptionalAssets(format);
        console.log(
          `\n📦 Assets: ${assets.length} total (${requiredAssets.length} required, ${optionalAssets.length} optional)`
        );
        if (usesDeprecatedAssetsField(format)) {
          console.log('   ⚠️  Using deprecated assets_required field');
        }
        assets.forEach(asset => {
          if (asset.item_type === 'individual') {
            console.log(`\n  Asset: ${asset.asset_id}`);
            console.log(`  Type: ${asset.asset_type}`);
            console.log(`  Required: ${asset.required ? 'yes' : 'no'}`);
            if ((asset as any).description) {
              console.log(`  Description: ${(asset as any).description}`);
            }
            if ((asset as any).default_value) {
              console.log(`  Default: ${JSON.stringify((asset as any).default_value)}`);
            }
          } else {
            console.log(`\n  Asset Group: ${asset.asset_group_id}`);
            console.log(`  Required: ${asset.required ? 'yes' : 'no'}`);
            console.log(`  Count: ${asset.min_count}-${asset.max_count}`);
          }
        });
      } else {
        console.log('\n⚠️  No assets defined (flexible format)');
      }

      if (format.preview_image) {
        console.log(`\n🖼️  Preview Image: ${format.preview_image}`);
      }

      if (format.format_card) {
        console.log('\n🎴 This format has its own format_card:');
        console.log(`  Format ID: ${format.format_card.format_id.agent_url}/${format.format_card.format_id.id}`);
        console.log(`  Manifest: ${JSON.stringify(format.format_card.manifest, null, 2)}`);
      }
    });
  }

  // Also show what a typical format looks like
  console.log('\n\n═══════════════════════════════════════════════════════════');
  console.log('EXAMPLE: Standard Display Format (for reference)');
  console.log('═══════════════════════════════════════════════════════════\n');

  const displayFormat = formats.find(f => f.format_id.id.includes('display') && f.format_id.id.includes('300x250'));

  if (displayFormat) {
    console.log(`Format ID: ${displayFormat.format_id.id}`);
    console.log(`Name: ${displayFormat.name || 'Unnamed'}`);
    console.log(`Type: ${displayFormat.type || 'N/A'}`);

    const displayAssets = getFormatAssets(displayFormat);
    if (displayAssets.length > 0) {
      const requiredAssets = getRequiredAssets(displayFormat);
      const optionalAssets = getOptionalAssets(displayFormat);
      console.log(
        `\n📦 Assets: ${displayAssets.length} total (${requiredAssets.length} required, ${optionalAssets.length} optional)`
      );
      if (usesDeprecatedAssetsField(displayFormat)) {
        console.log('   ⚠️  Using deprecated assets_required field');
      }
      displayAssets.forEach(asset => {
        if (asset.item_type === 'individual') {
          console.log(`  - ${asset.asset_id} (${asset.asset_type})${asset.required ? ' *required*' : ' (optional)'}`);
        } else {
          console.log(
            `  - [Group] ${asset.asset_group_id} (${asset.min_count}-${asset.max_count})${asset.required ? ' *required*' : ' (optional)'}`
          );
        }
      });
    }
  } else {
    console.log('⚠️  No standard 300x250 display format found');
  }

  console.log('\n\n💡 Key Insights:');
  console.log('─'.repeat(60));
  console.log('1. Formats define their assets using `assets` field (v2.6+) or deprecated `assets_required`');
  console.log('2. Use getFormatAssets() helper to access assets with backward compatibility');
  console.log('3. creative_manifest.assets should map asset_id -> asset object');
  console.log("4. Each asset_id must match the format's assets definition");
  console.log('5. Asset types (ImageAsset, TextAsset, etc) depend on asset_type\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
