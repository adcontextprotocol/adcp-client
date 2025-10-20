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
  // Media Buy tools
  'GetProductsRequest',
  'GetProductsResponse',
  'ListCreativeFormatsRequest',
  'ListCreativeFormatsResponse',
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

  // Supporting types
  'PackageRequest',
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

    // Generate Zod schemas for core types
    console.log(`📦 Generating core schemas for ${TARGET_TYPES.length} types...`);

    const coreResult = generate({
      sourceText: coreContent,
      nameFilter: (name) => TARGET_TYPES.includes(name),
      skipParseJSDoc: false,
      getSchemaName: (name) => `${name}Schema`,
    });

    // Generate Zod schemas for tool types
    console.log(`📦 Generating tool schemas for ${TOOL_TYPES.length} types...`);

    const toolsResult = generate({
      sourceText: toolsContent,
      nameFilter: (name) => TOOL_TYPES.includes(name),
      skipParseJSDoc: false,
      getSchemaName: (name) => `${name}Schema`,
    });

    const allErrors = [...coreResult.errors, ...toolsResult.errors];

    if (allErrors.length > 0) {
      console.error('⚠️  Errors during generation:');
      allErrors.forEach(error => console.error(`   - ${error}`));
    }

    // Get the generated Zod schemas
    const coreSchemas = coreResult.getZodSchemasFile();
    const toolSchemas = toolsResult.getZodSchemasFile();

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

    // Combine schemas (remove duplicate imports and duplicate exports)
    let combinedSchemas = coreSchemas;

    // Parse tool schemas to remove duplicates that already exist in core
    const coreSchemaNames = new Set(
      Array.from(coreSchemas.matchAll(/export const (\w+Schema) =/g)).map(m => m[1])
    );

    // Filter out duplicate schemas from tools - need to handle multi-line exports
    const toolSchemasWithoutImport = toolSchemas.replace(/^import \{ z \} from "zod";\s*/m, '');

    // Split by export statements and filter
    const exportStatements = toolSchemasWithoutImport.split(/(?=export const )/);
    const deduplicatedExports = exportStatements.filter(statement => {
      if (!statement.trim()) return false;

      const match = statement.match(/export const (\w+Schema) =/);
      if (match && coreSchemaNames.has(match[1])) {
        console.log(`   Skipping duplicate schema: ${match[1]}`);
        return false;
      }
      return true;
    });

    const deduplicatedToolSchemas = deduplicatedExports.join('');

    combinedSchemas += '\n// ====== TOOL SCHEMAS ======\n' + deduplicatedToolSchemas;

    const finalContent = header + combinedSchemas;

    // Write the output
    const changed = writeFileIfChanged(OUTPUT_FILE, finalContent);

    if (changed) {
      console.log(`✅ Generated Zod schemas: ${OUTPUT_FILE}`);
    } else {
      console.log(`✅ Zod schemas are up to date: ${OUTPUT_FILE}`);
    }

    const totalCount = TARGET_TYPES.length + TOOL_TYPES.length;
    console.log(`📊 Generated ${totalCount} Zod v4 schemas (${TARGET_TYPES.length} core + ${TOOL_TYPES.length} tools)`);

    if (allErrors.length === 0) {
      console.log('✨ No errors!');
    } else {
      console.log(`⚠️  Completed with ${allErrors.length} warnings`);
    }

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
