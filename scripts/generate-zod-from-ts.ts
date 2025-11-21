#!/usr/bin/env tsx

import { generate } from 'ts-to-zod';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import path from 'path';

/**
 * Generate Zod v4 schemas from TypeScript types
 * Uses ts-to-zod to convert our generated TypeScript types to Zod schemas
 */

const CORE_SOURCE_FILE = path.join(__dirname, '../src/lib/types/core.generated.ts');
const TOOLS_SOURCE_FILE = path.join(__dirname, '../src/lib/types/tools.generated.ts');
const OUTPUT_FILE = path.join(__dirname, '../src/lib/types/schemas.generated.ts');

// Types to generate Zod schemas for
const TARGET_TYPES = [
  // Core data structures
  'MediaBuy',
  'Package',
  'CreativeAsset',
  'Product',
  'Product1',
  'Product2',
  'TargetingOverlay',
  'FrequencyCap',
  'CreativeAssignment',
  'FormatID',

  // Brand and offerings
  'BrandManifest',
  'BrandManifest1',
  'BrandManifest2',
  'BrandManifestReference',
  'PromotedOfferings',
  'PromotedProducts',

  // Asset types (core)
  'ImageAsset',
  'VideoAsset',
  'AudioAsset',
  'TextAsset',
  'HTMLAsset',
  'CSSAsset',
  'JavaScriptAsset',
  'VASTAsset',
  'VASTAsset1',
  'VASTAsset2',
  'DAASTAsset',
  'DAASTAsset1',
  'DAASTAsset2',
  'URLAsset',
  'WebhookAsset',

  // Supporting types
  'Property',
  'Measurement',
  'ReportingCapabilities',

  // Pricing options
  'CPMFixedRatePricingOption',
  'CPMAuctionPricingOption',
  'VCPMFixedRatePricingOption',
  'VCPMAuctionPricingOption',
  'CPCPricingOption',
  'CPCVPricingOption',
  'CPVPricingOption',
  'CPPPricingOption',
  'FlatRatePricingOption',

  // Enums/Unions
  'MediaBuyStatus',
  'Pacing',
  'PackageStatus',
  'DeliveryType',
  'PricingOption',
  'PropertyIdentifierTypes',
];

// Tool request/response types to generate
const TOOL_TYPES = [
  // Error type (needed by many responses)
  'Error',

  // Media Buy tools
  'GetProductsRequest',
  'GetProductsResponse',
  'ListCreativeFormatsRequest',
  'ListCreativeFormatsResponse',
  'Format', // Used by ListCreativeFormatsResponse
  'CreateMediaBuyRequest',
  'CreateMediaBuyResponse',
  'UpdateMediaBuyRequest',
  'UpdateMediaBuyRequest1',
  'UpdateMediaBuyRequest2',
  'UpdateMediaBuyResponse',
  'GetMediaBuyDeliveryRequest',
  'GetMediaBuyDeliveryResponse',

  // Creative tools
  'SyncCreativesRequest',
  'SyncCreativesResponse',
  'ListCreativesRequest',
  'ListCreativesResponse',
  'SubAsset',
  'SubAsset1',
  'SubAsset2',
  'BuildCreativeRequest',
  'BuildCreativeResponse',
  'PreviewCreativeRequest',
  'PreviewCreativeResponse',

  // Property tools
  'ListAuthorizedPropertiesRequest',
  'ListAuthorizedPropertiesResponse',

  // Performance tools
  'ProvidePerformanceFeedbackRequest',
  'ProvidePerformanceFeedbackResponse',

  // Signals tools
  'GetSignalsRequest',
  'GetSignalsResponse',
  'ActivateSignalRequest',
  'ActivateSignalResponse',
  'Destination', // Discriminated union: platform or agent destinations
  'Deployment', // Discriminated union: platform or agent deployments

  // Supporting types
  'PackageRequest',
  'CreativePolicy',
  'PushNotificationConfig',
  'CreativeFilters',
];

// Write file only if content differs (excluding timestamp)
function writeFileIfChanged(filePath: string, newContent: string): boolean {
  const contentWithoutTimestamp = (content: string) => {
    return content.replace(/\/\/ Generated at: .*?\n/, '// Generated at: [TIMESTAMP]\n');
  };

  let hasChanged = true;
  if (existsSync(filePath)) {
    const existingContent = readFileSync(filePath, 'utf8');
    const existingWithoutTimestamp = contentWithoutTimestamp(existingContent);
    const newWithoutTimestamp = contentWithoutTimestamp(newContent);

    if (existingWithoutTimestamp === newWithoutTimestamp) {
      hasChanged = false;
    }
  }

  if (hasChanged) {
    writeFileSync(filePath, newContent);
  }

  return hasChanged;
}

async function generateZodSchemas() {
  console.log('🔄 Generating Zod v4 schemas from TypeScript types...');
  console.log(`📥 Core source: ${CORE_SOURCE_FILE}`);
  console.log(`📥 Tools source: ${TOOLS_SOURCE_FILE}`);
  console.log(`📤 Output: ${OUTPUT_FILE}`);

  if (!existsSync(CORE_SOURCE_FILE)) {
    console.error(`❌ Core source file not found: ${CORE_SOURCE_FILE}`);
    console.error('   Please run "npm run generate-types" first.');
    process.exit(1);
  }

  if (!existsSync(TOOLS_SOURCE_FILE)) {
    console.error(`❌ Tools source file not found: ${TOOLS_SOURCE_FILE}`);
    console.error('   Please run "npm run generate-types" first.');
    process.exit(1);
  }

  try {
    // Read the TypeScript sources
    const coreContent = readFileSync(CORE_SOURCE_FILE, 'utf8');
    const toolsContent = readFileSync(TOOLS_SOURCE_FILE, 'utf8');

    // Merge both sources so cross-file type dependencies can be resolved
    const combinedSource = `${coreContent}\n\n// ====== TOOL TYPES ======\n\n${toolsContent}`;
    const allTypes = [...TARGET_TYPES, ...TOOL_TYPES];

    console.log(
      `📦 Generating ${allTypes.length} schemas from combined source (${TARGET_TYPES.length} core + ${TOOL_TYPES.length} tools)...`
    );

    const result = generate({
      sourceText: combinedSource,
      nameFilter: name => allTypes.includes(name),
      skipParseJSDoc: false,
      getSchemaName: name => `${name}Schema`,
    });

    // Check for generation errors and fail hard if any exist
    if (result.errors.length > 0) {
      console.error('❌ Schema generation failed with errors:');
      result.errors.forEach(error => console.error(`   ${error}`));
      console.error('\n💡 If schemas are missing due to dependencies:');
      console.error('   1. Add the missing types to TARGET_TYPES or TOOL_TYPES in this script');
      console.error('   2. Ensure all dependent types are also included');
      console.error('   3. Re-run: npm run generate-zod-schemas\n');
      process.exit(1);
    }

    // Get the generated Zod schemas
    const zodSchemas = result.getZodSchemasFile();

    // Create header with metadata
    const header = `// Generated Zod v4 schemas from TypeScript types
// Generated at: ${new Date().toISOString()}
// Sources:
//   - ${path.basename(CORE_SOURCE_FILE)} (core types)
//   - ${path.basename(TOOLS_SOURCE_FILE)} (tool types)
//
// These schemas provide runtime validation for AdCP data structures
// Generated using ts-to-zod from TypeScript type definitions

`;

    const finalContent = header + zodSchemas;

    // Write the output
    const changed = writeFileIfChanged(OUTPUT_FILE, finalContent);

    if (changed) {
      console.log(`✅ Generated Zod schemas: ${OUTPUT_FILE}`);
    } else {
      console.log(`✅ Zod schemas are up to date: ${OUTPUT_FILE}`);
    }

    const totalCount = allTypes.length;
    console.log(`📊 Generated ${totalCount} Zod v4 schemas`);
    console.log('✨ No errors!');
  } catch (error) {
    console.error('❌ Failed to generate Zod schemas:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  generateZodSchemas().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

export { generateZodSchemas };
