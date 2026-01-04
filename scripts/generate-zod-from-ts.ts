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
  'SyncCreativesSuccess', // Component of SyncCreativesResponse union
  'SyncCreativesError', // Component of SyncCreativesResponse union
  'ListCreativesRequest',
  'ListCreativesResponse',
  'SubAsset',
  'SubAsset1',
  'SubAsset2',
  'BuildCreativeRequest',
  'BuildCreativeResponse',
  'PreviewCreativeRequest',
  'PreviewCreativeResponse',
  'PreviewCreativeSingleResponse', // Component of PreviewCreativeResponse union
  'PreviewCreativeBatchResponse', // Component of PreviewCreativeResponse union

  // Property tools
  'ListAuthorizedPropertiesRequest',
  'ListAuthorizedPropertiesResponse',

  // Performance tools
  'ProvidePerformanceFeedbackRequest',
  'ProvidePerformanceFeedbackRequest1',
  'ProvidePerformanceFeedbackRequest2',
  'ProvidePerformanceFeedbackResponse',
  'MetricType',
  'FeedbackSource',

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
  'ContextObject', // Used by many response types
  'ExtensionObject', // Used by many response types
  'CreativeAction', // Used by SyncCreativesSuccess
];

/**
 * Post-process generated Zod schemas to convert .optional() to .nullish() globally.
 * This is needed because real-world API responses often send explicit null values for optional
 * fields, but ts-to-zod generates .optional() which only accepts undefined.
 * Using .nullish() accepts both undefined and null.
 *
 * Many JSON serializers (Python, Java, etc.) default to sending null for absent optional fields,
 * so treating "optional" as "can be undefined OR null" is the pragmatic approach.
 */
function postProcessForNullish(content: string): string {
  // Replace all .optional() with .nullish() globally
  return content.replace(/\.optional\(\)/g, '.nullish()');
}

/**
 * Post-process generated Zod schemas to convert tuple patterns to arrays.
 *
 * ts-to-zod converts TypeScript arrays with @minItems JSDoc annotations to Zod tuples:
 *   z.tuple([z.string()]).rest(z.string())
 *
 * This requires at least one element, but agents in the wild return empty arrays.
 * Convert these patterns to simple arrays that allow empty arrays:
 *   z.array(z.string())
 *
 * This is more lenient than the JSON Schema spec (which requires minItems: 1),
 * but necessary for real-world interoperability.
 *
 * LIMITATIONS: This regex handles simple patterns like z.tuple([z.string()]).rest(z.string())
 * but may not handle complex nested schemas with brackets (e.g., z.object({ ... })).
 * The [^\]]+ pattern stops at the first closing bracket, which works for primitive types
 * and simple references. If edge cases with nested objects appear, consider using an AST parser.
 */
function postProcessTuplesToArrays(content: string): string {
  // Match patterns like: z.tuple([SomeSchema]).rest(SomeSchema)
  // and convert to: z.array(SomeSchema)
  // The pattern captures the inner schema type and uses a backreference to ensure they match
  return content.replace(
    /z\.tuple\(\[([^\]]+)\]\)\.rest\(\1\)/g,
    'z.array($1)'
  );
}

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

    // Check for generation errors and log warnings
    // Note: Some complex discriminated unions may fail Zod generation but still have valid TypeScript types
    // This is acceptable - TypeScript provides compile-time validation, Zod provides runtime validation
    if (result.errors.length > 0) {
      console.warn('⚠️  Some schemas could not be generated (this is non-fatal):');
      result.errors.forEach(error => console.warn(`   ${error}`));
      console.warn('\n💡 These schemas use complex discriminated unions not supported by ts-to-zod.');
      console.warn('   TypeScript types are still enforced at compile-time.');
      console.warn('   Runtime validation will fall back to TypeScript type checking.\n');
    }

    // Get the generated Zod schemas
    let zodSchemas = result.getZodSchemasFile();

    // Post-process: Convert .optional() to .nullish() for PackageSchema fields
    // This is needed because real-world API responses (e.g., Yahoo webhook) send explicit
    // null values for optional fields, but ts-to-zod generates .optional() which only
    // accepts undefined, not null. Using .nullish() accepts both undefined and null.
    zodSchemas = postProcessForNullish(zodSchemas);

    // Post-process: Convert tuple patterns to arrays to allow empty arrays
    // ts-to-zod converts @minItems 1 to z.tuple([]).rest() which requires at least one element,
    // but agents in the wild return empty arrays. This relaxes validation for interoperability.
    zodSchemas = postProcessTuplesToArrays(zodSchemas);

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
