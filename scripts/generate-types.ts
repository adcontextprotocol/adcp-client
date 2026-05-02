#!/usr/bin/env tsx

import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { compile } from 'json-schema-to-typescript';
import path from 'path';
import { removeArrayLengthConstraints } from './schema-utils';

// Write file only if content differs (excluding timestamp)
function writeFileIfChanged(filePath: string, newContent: string): boolean {
  // Extract content without timestamp for comparison
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

// Schema cache configuration
const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const LATEST_CACHE_DIR = path.join(SCHEMA_CACHE_DIR, 'latest');

// Core AdCP schemas to generate
const ADCP_CORE_SCHEMAS = ['media-buy', 'creative-asset', 'product', 'targeting', 'property', 'mcp-webhook-payload'];

// Additional standalone schemas (not in core/ directory)
// NOTE: 'adagents' commented out due to duplicate PropertyIdentifierTypes causing TS errors
// The adagents schema re-declares types that are already in property schema
const STANDALONE_SCHEMAS: string[] = []; // ['adagents']

// Load schema from cache - handles both /schemas/v1/ and /schemas/X.Y.Z/ paths
function loadCachedSchema(schemaRef: string): any {
  try {
    // Strip any /schemas/ prefix (versioned or v1) to get the relative path
    // e.g., /schemas/2.4.0/core/product.json -> core/product.json
    //       /schemas/v1/core/product.json -> core/product.json
    let relativePath = schemaRef;
    if (relativePath.startsWith('/schemas/')) {
      // Remove /schemas/ prefix
      relativePath = relativePath.substring('/schemas/'.length);
      // Remove version segment (either v1 or X.Y.Z format)
      const segments = relativePath.split('/');
      if (segments[0].match(/^(v\d+|\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?|latest)$/)) {
        // First segment is a version, skip it
        relativePath = segments.slice(1).join('/');
      }
    }

    const schemaPath = path.join(LATEST_CACHE_DIR, relativePath);
    if (!existsSync(schemaPath)) {
      throw new Error(`Schema not found in cache: ${schemaPath}`);
    }

    let schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

    // Apply deprecated field/enum removal based on schema name
    // Extract schema name from path: core/format.json -> Format
    const fileName = path.basename(relativePath, '.json');
    const schemaName = fileName
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

    // Check for deprecated enum values (uses kebab-case file name)
    if (DEPRECATED_ENUM_VALUES[fileName]) {
      schema = removeDeprecatedFields(schema, fileName);
    }

    // Check for deprecated object fields (uses PascalCase schema name)
    if (DEPRECATED_SCHEMA_FIELDS[schemaName]) {
      schema = removeDeprecatedFields(schema, schemaName);
    }

    // Make specified fields optional for backward compat with pre-v3 agents
    if (BACKWARD_COMPAT_OPTIONAL_FIELDS[schemaName]) {
      schema = makeFieldsOptional(schema, BACKWARD_COMPAT_OPTIONAL_FIELDS[schemaName]);
    }

    return schema;
  } catch (error) {
    console.warn(`⚠️  Failed to load cached schema ${schemaRef}:`, error.message);
    return null;
  }
}

// Get cached AdCP version
function getCachedAdCPVersion(): string {
  try {
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    return index.adcp_version || '1.0.0';
  } catch (error) {
    console.warn(`⚠️  Failed to get cached AdCP version:`, error.message);
    return '1.0.0';
  }
}

// AdCP Tool Definitions (based on official ADCP specification)
interface ToolDefinition {
  name: string;
  methodName: string;
  description: string;
  paramsSchema: any;
  responseSchema: any;
  singleAgentOnly?: boolean;
}

/**
 * Recursively remove additionalProperties: true from schema to enforce strict typing
 * This prevents [k: string]: unknown in generated TypeScript types
 *
 * EXCEPTION: Fields with descriptions containing "must echo this value back unchanged"
 * (like context fields) preserve additionalProperties: true to maintain protocol compliance.
 */
export function enforceStrictSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // Create a shallow copy
  const strictSchema = { ...schema };

  // Check if this field must preserve arbitrary properties (e.g., context fields)
  const mustPreserveProperties =
    strictSchema.description &&
    typeof strictSchema.description === 'string' &&
    strictSchema.description.toLowerCase().includes('must echo this value back unchanged');

  // Remove additionalProperties if it's true, UNLESS the field must preserve properties
  if (strictSchema.additionalProperties === true && !mustPreserveProperties) {
    delete strictSchema.additionalProperties;
  }

  // Annotation-only nodes — schemas that carry only JSON Schema metadata keywords and no
  // type, ref, combinator, validator, or structural keyword — represent "any JSON value"
  // per JSON Schema semantics. json-schema-to-typescript defaults these to
  // { [k: string]: unknown }, which downstream Zod generation narrows to z.record and
  // rejects scalar values the spec allows (e.g. `check_governance` conditions[].required_value
  // returning a number). Annotate with tsType so the emitted TS is unknown.
  const metadataOnlyKeys = new Set([
    'description',
    'title',
    '$comment',
    'examples',
    'default',
    'deprecated',
    'readOnly',
    'writeOnly',
    '$id',
    '$anchor',
    '$schema',
  ]);
  const allKeys = Object.keys(strictSchema);
  if (allKeys.length > 0 && allKeys.every(k => metadataOnlyKeys.has(k))) {
    strictSchema.tsType = 'unknown';
  }

  // Recursively process nested schemas
  if (strictSchema.properties) {
    strictSchema.properties = Object.fromEntries(
      Object.entries(strictSchema.properties).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  if (strictSchema.patternProperties) {
    strictSchema.patternProperties = Object.fromEntries(
      Object.entries(strictSchema.patternProperties).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  // additionalProperties can be boolean or a schema; only recurse when it's a schema.
  if (strictSchema.additionalProperties && typeof strictSchema.additionalProperties === 'object') {
    strictSchema.additionalProperties = enforceStrictSchema(strictSchema.additionalProperties);
  }

  for (const key of [
    'not',
    'if',
    'then',
    'else',
    'contains',
    'propertyNames',
    'unevaluatedItems',
    'unevaluatedProperties',
  ]) {
    if (strictSchema[key] && typeof strictSchema[key] === 'object') {
      strictSchema[key] = enforceStrictSchema(strictSchema[key]);
    }
  }

  // dependentSchemas maps property name → schema. (dependencies in draft-07 may be schema or
  // string[]; only recurse into schema values.)
  for (const key of ['dependentSchemas', 'dependencies']) {
    if (strictSchema[key] && typeof strictSchema[key] === 'object' && !Array.isArray(strictSchema[key])) {
      strictSchema[key] = Object.fromEntries(
        Object.entries(strictSchema[key]).map(([name, value]) => [
          name,
          value && typeof value === 'object' && !Array.isArray(value) ? enforceStrictSchema(value) : value,
        ])
      );
    }
  }

  if (strictSchema.items) {
    if (Array.isArray(strictSchema.items)) {
      strictSchema.items = strictSchema.items.map(enforceStrictSchema);
    } else {
      strictSchema.items = enforceStrictSchema(strictSchema.items);
    }
  }

  if (strictSchema.allOf) {
    // Strip allOf members that contain only validation logic TypeScript can't
    // represent. Two cases:
    //   1. `not` constraints — mutual-exclusivity validators (e.g. "not both
    //      feed_field and value"). Keeping them causes json-schema-to-typescript
    //      to emit the full property set once per member, producing duplicate
    //      intersection arms.
    //   2. `if`/`then`/`else` conditionals — JSON Schema 7 conditional
    //      validation (e.g. "if request_type='single' then creative_manifest
    //      is required"). TS can't conditionally require fields based on
    //      another field's discriminator value. Worse, jsts intersects every
    //      branch's properties with `{ [k: string]: unknown }`, producing
    //      `BaseShape & { [k: string]: unknown }` noise that forces adopters
    //      into `as any` casts. These conditionals are still enforced at
    //      runtime by Ajv, which loads the original (unstripped) JSON
    //      schemas — so removing them from the TS-emit path doesn't weaken
    //      validation.
    strictSchema.allOf = strictSchema.allOf
      .filter((member: any) => {
        const keys = Object.keys(member);
        if (keys.length === 1 && keys[0] === 'not') return false;
        // Conditional validators are exclusively `if` / `then` / `else`.
        // Drop members composed only of those keys.
        if (keys.length > 0 && keys.every(k => k === 'if' || k === 'then' || k === 'else')) {
          return false;
        }
        return true;
      })
      .map(enforceStrictSchema);
    if (strictSchema.allOf.length === 0) {
      delete strictSchema.allOf;
    }
  }

  // Top-level `if` / `then` / `else` (rare but valid JSON Schema 7) — same
  // rationale as above. Strip; Ajv enforces them at runtime against the
  // unstripped schema.
  if (strictSchema.if) delete strictSchema.if;
  if (strictSchema.then) delete strictSchema.then;
  if (strictSchema.else) delete strictSchema.else;

  if (strictSchema.anyOf) {
    strictSchema.anyOf = strictSchema.anyOf.map(enforceStrictSchema);
  }

  if (strictSchema.oneOf) {
    strictSchema.oneOf = strictSchema.oneOf.map(enforceStrictSchema);
  }

  if (strictSchema.definitions) {
    strictSchema.definitions = Object.fromEntries(
      Object.entries(strictSchema.definitions).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  if (strictSchema.$defs) {
    strictSchema.$defs = Object.fromEntries(
      Object.entries(strictSchema.$defs).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  return strictSchema;
}

// Load AdCP tool schemas from cache
function loadToolSchema(
  toolName: string,
  taskType:
    | 'media-buy'
    | 'signals'
    | 'creative'
    | 'governance'
    | 'sponsored-intelligence'
    | 'protocol'
    | 'account' = 'media-buy'
): any {
  try {
    console.log(`📥 Loading ${toolName} schema from cache (${taskType})...`);

    // Read refs from the index.json instead of hardcoding paths
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

    const kebabName = toolName.replace(/_/g, '-');
    let requestRef: string | undefined;
    let responseRef: string | undefined;

    // Look up the task in the index to get actual $refs
    if (schemaIndex.schemas?.[taskType]?.tasks?.[kebabName]) {
      const task = schemaIndex.schemas[taskType].tasks[kebabName];
      requestRef = task.request?.$ref;
      responseRef = task.response?.$ref;
    }

    // Fallback: Try media-buy namespace if creative namespace fails
    if ((!requestRef || !responseRef) && taskType === 'creative') {
      console.log(`   ↪️  Trying media-buy namespace for ${toolName}...`);
      if (schemaIndex.schemas?.['media-buy']?.tasks?.[kebabName]) {
        const task = schemaIndex.schemas['media-buy'].tasks[kebabName];
        requestRef = task.request?.$ref;
        responseRef = task.response?.$ref;
      }
    }

    if (!requestRef || !responseRef) {
      throw new Error(`Missing request or response $ref in index for ${toolName}`);
    }

    const requestSchema = loadCachedSchema(requestRef);
    const responseSchema = loadCachedSchema(responseRef);

    if (!requestSchema || !responseSchema) {
      throw new Error(`Failed to load schemas for ${toolName}`);
    }

    // Combine into the expected format
    return {
      description: `Official AdCP ${toolName} tool schema`,
      type: 'object',
      properties: {
        request: requestSchema,
        response: responseSchema,
      },
    };
  } catch (error) {
    console.warn(`⚠️  Could not load schema for ${toolName}:`, error.message);
    return null;
  }
}

// All domains with tasks
const TASK_DOMAINS = [
  'media-buy',
  'creative',
  'signals',
  'governance',
  'sponsored-intelligence',
  'protocol',
  'account',
  'compliance',
] as const;
type TaskDomain = (typeof TASK_DOMAINS)[number];

// Deprecated tools that should be excluded from type generation
// These tools are maintained in upstream for backward compatibility but should not be exposed in the public API
const DEPRECATED_TOOLS = new Set([
  'list_authorized_properties', // Replaced by get_adcp_capabilities
  'list_property_features', // Never released
]);

// Deprecated fields to remove from schema during type generation
// Format: { schemaName: ['field1', 'field2'] }
const DEPRECATED_SCHEMA_FIELDS: Record<string, string[]> = {
  Format: ['assets_required', 'preview_image'],
};

// Fields to make optional for backward compatibility with older agent implementations.
// These fields are required in the v3 spec but were absent in v2.5/v2.6 schemas.
// Applies a recursive removal from all 'required' arrays in the named schema.
// Format: { schemaName (PascalCase from filename): ['field1', 'field2'] }
//
// How to identify fields needing this treatment:
//   1. Field is in a `required` array in a v3 JSON schema
//   2. Field did not exist in the corresponding v2 TypeScript type
//   3. Real agents running v2 implementations will not send the field
const BACKWARD_COMPAT_OPTIONAL_FIELDS: Record<string, string[]> = {
  // get_media_buy_delivery: by_package items
  // v2 by_package only had {package_id, buyer_ref?, pacing_index?} + DeliveryMetrics.
  // pricing_model, rate, currency, and all breakdown ID fields are v3 additions.
  GetMediaBuyDeliveryResponse: [
    // by_package top-level fields new in v3
    'pricing_model',
    'rate',
    'currency',
    // breakdown array item IDs new in v3 (arrays themselves are optional but if provided,
    // v2 agents may omit the ID fields)
    'content_id', // by_catalog_item items
    'keyword', // by_keyword items
    'match_type', // by_keyword items
    'geo_level', // by_geo items
    'geo_code', // by_geo items
    'device_type', // by_device_type items
    'device_platform', // by_device_platform items
    'audience_id', // by_audience items
    'audience_source', // by_audience items
    'placement_id', // by_placement items
  ],
  // get_media_buys: media_buy items
  // total_budget and approval_status are new required fields in v3.
  GetMediaBuysResponse: [
    'total_budget', // media_buys[].total_budget - new in v3
    'approval_status', // media_buys[].packages[].creative_approvals[].approval_status - new in v3
  ],
};

// Deprecated schemas that should be excluded entirely
const DEPRECATED_SCHEMAS = new Set([
  'adcp-extension', // Use get_adcp_capabilities tool instead
]);

// Deprecated enum values to filter from specific enum schemas
// Format: { schemaFileName: ['value1', 'value2'] }
const DEPRECATED_ENUM_VALUES: Record<string, string[]> = {
  'task-type': ['list_property_features', 'list_authorized_properties'],
};

/**
 * Remove deprecated fields from a schema based on DEPRECATED_SCHEMA_FIELDS config
 * Also handles deprecated enum values
 */
function removeDeprecatedFields(schema: any, schemaName: string): any {
  // Handle deprecated enum values
  if (schema.enum && Array.isArray(schema.enum)) {
    const enumValuesToRemove = DEPRECATED_ENUM_VALUES[schemaName];
    if (enumValuesToRemove) {
      const cleaned = { ...schema };
      cleaned.enum = schema.enum.filter((v: string) => !enumValuesToRemove.includes(v));
      // Also clean enumDescriptions if present
      if (cleaned.enumDescriptions) {
        cleaned.enumDescriptions = { ...cleaned.enumDescriptions };
        for (const value of enumValuesToRemove) {
          delete cleaned.enumDescriptions[value];
        }
      }
      return cleaned;
    }
  }

  const fieldsToRemove = DEPRECATED_SCHEMA_FIELDS[schemaName];
  if (!fieldsToRemove || !schema || typeof schema !== 'object') {
    return schema;
  }

  const cleaned = { ...schema };

  // Remove deprecated fields from properties
  if (cleaned.properties) {
    cleaned.properties = { ...cleaned.properties };
    for (const field of fieldsToRemove) {
      delete cleaned.properties[field];
    }
  }

  // Remove from required array if present
  if (cleaned.required && Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((r: string) => !fieldsToRemove.includes(r));
  }

  return cleaned;
}

/**
 * Recursively remove specific field names from all 'required' arrays in a schema.
 * Used for backward compatibility: makes v3-required fields optional so older agents pass validation.
 */
function makeFieldsOptional(schema: any, fieldsToMakeOptional: string[]): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(item => makeFieldsOptional(item, fieldsToMakeOptional));

  const cleaned = { ...schema };

  if (cleaned.required && Array.isArray(cleaned.required)) {
    cleaned.required = cleaned.required.filter((r: string) => !fieldsToMakeOptional.includes(r));
  }

  for (const key of Object.keys(cleaned)) {
    if (typeof cleaned[key] === 'object') {
      cleaned[key] = makeFieldsOptional(cleaned[key], fieldsToMakeOptional);
    }
  }

  return cleaned;
}

// Load official AdCP tools from cached schema index
function loadOfficialAdCPToolsWithTypes(): {
  mediaBuyTools: string[];
  creativeTools: string[];
  signalsTools: string[];
  governanceTools: string[];
  sponsoredIntelligenceTools: string[];
  protocolTools: string[];
  accountTools: string[];
} {
  try {
    console.log('📥 Loading official AdCP tools from cached schema index...');
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');

    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }

    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    const mediaBuyTools: string[] = [];
    const creativeTools: string[] = [];
    const signalsTools: string[] = [];
    const governanceTools: string[] = [];
    const sponsoredIntelligenceTools: string[] = [];
    const protocolTools: string[] = [];
    const accountTools: string[] = [];
    const complianceTools: string[] = [];

    // Extract tools from each domain's tasks (skipping deprecated tools)
    const extractToolsFromDomain = (domain: string, targetArray: string[]) => {
      const tasks = schemaIndex.schemas?.[domain]?.tasks;
      if (tasks) {
        for (const taskName of Object.keys(tasks)) {
          // Convert kebab-case to snake_case (e.g., "get-products" -> "get_products")
          const toolName = taskName.replace(/-/g, '_');

          // Skip deprecated tools
          if (DEPRECATED_TOOLS.has(toolName)) {
            console.log(`   ⏭️  Skipping deprecated tool: ${toolName}`);
            continue;
          }

          // Also skip if the task is explicitly marked deprecated in the schema
          const task = tasks[taskName];
          if (task.deprecated) {
            console.log(`   ⏭️  Skipping deprecated tool: ${toolName} (marked in schema)`);
            continue;
          }

          targetArray.push(toolName);
        }
      }
    };

    extractToolsFromDomain('media-buy', mediaBuyTools);
    extractToolsFromDomain('creative', creativeTools);
    extractToolsFromDomain('signals', signalsTools);
    extractToolsFromDomain('governance', governanceTools);
    extractToolsFromDomain('sponsored-intelligence', sponsoredIntelligenceTools);
    extractToolsFromDomain('protocol', protocolTools);
    extractToolsFromDomain('account', accountTools);
    extractToolsFromDomain('compliance', complianceTools);

    const totalTools =
      mediaBuyTools.length +
      creativeTools.length +
      signalsTools.length +
      governanceTools.length +
      sponsoredIntelligenceTools.length +
      protocolTools.length +
      accountTools.length +
      complianceTools.length;

    console.log(`✅ Discovered ${totalTools} official AdCP tools:`);
    console.log(`   📈 Media-buy tools: ${mediaBuyTools.join(', ')}`);
    console.log(`   🎨 Creative tools: ${creativeTools.join(', ')}`);
    console.log(`   🎯 Signals tools: ${signalsTools.join(', ')}`);
    console.log(`   🏛️  Governance tools: ${governanceTools.join(', ')}`);
    console.log(`   💬 Sponsored Intelligence tools: ${sponsoredIntelligenceTools.join(', ')}`);
    console.log(`   🔧 Protocol tools: ${protocolTools.join(', ')}`);
    console.log(`   💳 Account tools: ${accountTools.join(', ')}`);
    console.log(`   🧪 Compliance tools: ${complianceTools.join(', ')}`);

    return {
      mediaBuyTools,
      creativeTools,
      signalsTools,
      governanceTools,
      sponsoredIntelligenceTools,
      protocolTools,
      accountTools,
      complianceTools,
    };
  } catch (error) {
    console.warn(`⚠️  Failed to load cached tools, falling back to known tools:`, error.message);
    // Fallback to known tools if the cache fails
    return {
      mediaBuyTools: ['get_products', 'list_creative_formats', 'create_media_buy', 'sync_creatives', 'list_creatives'],
      creativeTools: [],
      signalsTools: [],
      governanceTools: [],
      sponsoredIntelligenceTools: [],
      protocolTools: [],
      accountTools: [],
      complianceTools: [],
    };
  }
}

// Load tool definitions from cached schemas
function loadAdCPTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const processedTools = new Set<string>();

  // Get the official tools list from cached schema index
  const {
    mediaBuyTools,
    creativeTools,
    signalsTools,
    governanceTools,
    sponsoredIntelligenceTools,
    protocolTools,
    accountTools,
    complianceTools,
  } = loadOfficialAdCPToolsWithTypes();

  // Helper to process tools from a domain
  const processToolsFromDomain = (
    toolNames: string[],
    domain:
      | 'media-buy'
      | 'creative'
      | 'signals'
      | 'governance'
      | 'sponsored-intelligence'
      | 'protocol'
      | 'account'
      | 'compliance',
    domainLabel: string,
    singleAgentOnlyTools: string[] = []
  ) => {
    for (const toolName of toolNames) {
      if (processedTools.has(toolName)) {
        console.log(`⏭️  Skipping ${toolName} - already processed`);
        continue;
      }

      const schema = loadToolSchema(toolName, domain as any);
      if (schema) {
        // Convert snake_case to camelCase for method names
        const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

        // Determine single-agent-only tools (transactional operations)
        const singleAgentOnly = singleAgentOnlyTools.includes(toolName);

        tools.push({
          name: toolName,
          methodName,
          description: schema.description || `Execute ${toolName} operation`,
          paramsSchema: schema.properties?.request || {},
          responseSchema: schema.properties?.response || {},
          singleAgentOnly,
        });

        processedTools.add(toolName);
        console.log(`✅ Loaded ${toolName} from cached ${domainLabel} schema`);
      } else {
        console.warn(`⚠️  Skipping ${toolName} - no schema available`);
      }
    }
  };

  // Process all domains
  processToolsFromDomain(mediaBuyTools, 'media-buy', 'media-buy', ['create_media_buy', 'update_media_buy']);
  processToolsFromDomain(creativeTools, 'creative', 'creative');
  processToolsFromDomain(signalsTools, 'signals', 'signals');
  processToolsFromDomain(governanceTools, 'governance', 'governance', [
    'create_property_list',
    'update_property_list',
    'delete_property_list',
    'create_content_standards',
    'update_content_standards',
  ]);
  processToolsFromDomain(sponsoredIntelligenceTools, 'sponsored-intelligence', 'sponsored-intelligence', [
    'si_initiate_session',
    'si_terminate_session',
  ]);
  processToolsFromDomain(protocolTools, 'protocol', 'protocol');
  processToolsFromDomain(accountTools, 'account', 'account');
  processToolsFromDomain(complianceTools, 'compliance', 'compliance');

  return tools;
}

// Load tool schema from any domain
function loadToolSchemaFromDomain(
  toolName: string,
  domain: string,
  schemaIndex: any
): { paramsSchema: any; responseSchema: any } | null {
  const kebabName = toolName.replace(/_/g, '-');

  const task = schemaIndex.schemas?.[domain]?.tasks?.[kebabName];
  if (!task) return null;

  const requestRef = task.request?.$ref;
  const responseRef = task.response?.$ref;

  if (!requestRef || !responseRef) {
    console.warn(`⚠️  Missing refs for ${toolName} in ${domain}`);
    return null;
  }

  const requestSchema = loadCachedSchema(requestRef);
  const responseSchema = loadCachedSchema(responseRef);

  if (!requestSchema || !responseSchema) {
    return null;
  }

  return { paramsSchema: requestSchema, responseSchema };
}

// Load schema from cache by name
function loadCoreSchema(schemaName: string): any {
  try {
    // Read refs from the index.json instead of hardcoding paths
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

    // Look up the schema in the index to get actual $ref
    const schemaRef = schemaIndex.schemas?.core?.schemas?.[schemaName]?.$ref;
    if (!schemaRef) {
      throw new Error(`Schema ${schemaName} not found in index`);
    }

    return loadCachedSchema(schemaRef);
  } catch (error) {
    console.warn(`⚠️  Failed to load core schema ${schemaName}:`, error.message);
    return null;
  }
}

async function generateToolTypes(tools: ToolDefinition[]) {
  console.log('🔧 Generating tool parameter and response types...');

  let toolTypes = '// Tool Parameter and Response Types\n';
  toolTypes += '// Generated from official AdCP schemas\n\n';

  // Create custom $ref resolver for cached schemas
  const refResolver = {
    canRead: true,
    read: (file: { url: string }) => {
      const url = file.url;
      // Handle any /schemas/ path (versioned or v1)
      if (url.startsWith('/schemas/')) {
        const schema = loadCachedSchema(url);
        if (schema) {
          return Promise.resolve(enforceStrictSchema(removeArrayLengthConstraints(schema)));
        }
      }
      return Promise.reject(new Error(`Cannot resolve $ref: ${url}`));
    },
  };

  // Track generated types to avoid duplicates
  const generatedTypes = new Set<string>();
  const allGeneratedCode: string[] = [];

  for (const tool of tools) {
    try {
      // Generate parameter types
      if (tool.paramsSchema) {
        const paramTypeName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Request`;
        // Process schema: remove additionalProperties and minItems constraints
        const strictParamsSchema = enforceStrictSchema(removeArrayLengthConstraints(tool.paramsSchema));
        const paramTypes = await compile(strictParamsSchema, paramTypeName, {
          bannerComment: '',
          style: { semi: true, singleQuote: true },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        const filteredParamTypes = filterDuplicateTypeDefinitions(paramTypes, generatedTypes);
        if (filteredParamTypes.trim()) {
          allGeneratedCode.push(`// ${tool.name} parameters\n${filteredParamTypes}`);
        }
      }

      // Generate response types
      if (tool.responseSchema) {
        const responseTypeName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Response`;
        // Process schema: remove additionalProperties and minItems constraints
        const strictResponseSchema = enforceStrictSchema(removeArrayLengthConstraints(tool.responseSchema));
        const responseTypes = await compile(strictResponseSchema, responseTypeName, {
          bannerComment: '',
          style: { semi: true, singleQuote: true },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        const filteredResponseTypes = filterDuplicateTypeDefinitions(responseTypes, generatedTypes);
        if (filteredResponseTypes.trim()) {
          allGeneratedCode.push(`// ${tool.name} response\n${filteredResponseTypes}`);
        }
      }

      console.log(`✅ Generated types for ${tool.name}`);
    } catch (error) {
      console.error(`❌ Failed to generate types for ${tool.name}:`, error.message);
    }
  }

  toolTypes += allGeneratedCode.join('\n\n') + '\n';

  return toolTypes;
}

/**
 * Remove index signature types generated from oneOf schemas.
 *
 * json-schema-to-typescript generates types like:
 *   export type Foo = Foo1 & Foo2;
 *   export type Foo2 = { [k: string]: unknown };
 *
 * When the JSON Schema has additionalProperties: false but uses oneOf with only
 * required constraints, the library incorrectly creates an index signature type.
 *
 * This function:
 * 1. Identifies types that are pure index signatures: { [k: string]: unknown }
 * 2. Removes those type definitions
 * 3. Removes references to them from intersection types (Foo1 & Foo2 becomes Foo1)
 * 4. Cleans up inline index signature objects in intersection types
 */
function removeIndexSignatureTypes(typeDefinitions: string): string {
  // Find all types that are pure index signatures
  // Pattern: export type TypeName = { [k: string]: unknown };
  // or: export type TypeName = {\n  [k: string]: unknown;\n};
  const indexSigTypePattern = /export type (\w+) = \{\s*\[k: string\]: unknown;?\s*\};?/g;
  const indexSigTypes = new Set<string>();

  let match;
  while ((match = indexSigTypePattern.exec(typeDefinitions)) !== null) {
    indexSigTypes.add(match[1]);
  }

  let result = typeDefinitions;

  if (indexSigTypes.size > 0) {
    console.log(`🧹 Removing ${indexSigTypes.size} index signature types: ${Array.from(indexSigTypes).join(', ')}`);

    // Remove the index signature type definitions
    for (const typeName of indexSigTypes) {
      // Remove single-line pattern
      result = result.replace(
        new RegExp(`export type ${typeName} = \\{\\s*\\[k: string\\]: unknown;?\\s*\\};?\\n?`, 'g'),
        ''
      );
      // Remove multi-line pattern
      result = result.replace(
        new RegExp(`export type ${typeName} = \\{\\n\\s*\\[k: string\\]: unknown;\\n\\};?\\n?`, 'g'),
        ''
      );
    }

    // Remove references to these types from intersection types
    // Pattern: Type1 & IndexSigType becomes Type1
    // Pattern: IndexSigType & Type1 becomes Type1
    for (const typeName of indexSigTypes) {
      // Remove " & TypeName" (when it comes after)
      result = result.replace(new RegExp(` & ${typeName}(?=[;\\s])`, 'g'), '');
      // Remove "TypeName & " (when it comes before)
      result = result.replace(new RegExp(`${typeName} & `, 'g'), '');
    }
  }

  // Also remove inline index signature objects from intersections
  // Pattern: & {\n  [k: string]: unknown;\n}
  result = result.replace(/\s*&\s*\{\s*\[k:\s*string\]:\s*unknown;?\s*\}/gm, '');

  // Clean up malformed type aliases that end with semicolon followed by & (from incomplete removal)
  // Pattern: export type Foo = Bar;\n & {...} -> export type Foo = Bar;
  result = result.replace(/;\s*\n\s*&\s*\{[^}]*\}/gm, ';');

  // Clean up any remaining orphaned & at the start of lines
  result = result.replace(/;\s*\n\s*&/gm, ';');

  return result;
}

/**
 * Fix typed index signatures that are incompatible with optional properties.
 *
 * When a JSON Schema has typed additionalProperties (e.g. { $ref: "ForecastRange" })
 * alongside optional named properties, json-schema-to-typescript generates:
 *   grps?: ForecastRange;
 *   [k: string]: ForecastRange;
 *
 * TypeScript requires the index signature to be compatible with ALL named properties.
 * Optional properties are `Type | undefined`, so the index signature must also include
 * `| undefined`. This function detects such cases and adds `| undefined`.
 */
function fixTypedIndexSignatures(typeDefinitions: string): string {
  // Match typed index signatures (not `unknown`) that lack `| undefined`
  // Pattern: `[k: string]: SomeType;` where SomeType is NOT `unknown` and NOT already `| undefined`
  // NOTE: This regex only handles single-line type annotations. Multi-line unions,
  // array types (SomeType[]), and object types ({}) are not matched. Currently those
  // cases get | undefined from json-schema-to-typescript natively.
  return typeDefinitions.replace(
    /(\[k: string\]: )(\w[\w\s|&<>,]*?)(?<!\| undefined)(;\s*\n\s*\})/g,
    (match, prefix, type, suffix) => {
      // Only add | undefined if the type is not already `unknown`
      if (type.trim() === 'unknown') return match;
      return `${prefix}${type} | undefined${suffix}`;
    }
  );
}

/**
 * Align optional TypeScript properties with Zod .nullish() behavior.
 *
 * json-schema-to-typescript generates `property?: Type` (accepts undefined).
 * But the Zod schemas use .nullish() (accepts null | undefined) because real-world
 * JSON APIs send explicit null for absent optional fields.
 *
 * Without this alignment, server handlers that echo Zod-parsed input back
 * (e.g., params.context → response.context) hit type errors:
 *   Type 'X | null | undefined' is not assignable to type 'X | undefined'
 *
 * This converts `property?: Type` to `property?: Type | null` for consistency.
 */
function alignOptionalWithNullish(typeDefinitions: string): string {
  let result = typeDefinitions;

  // 1. Convert optional properties: `name?: Type` → `name?: Type | null`
  result = result.replace(/^(\s+\w+\?:\s*)(.+?)(;\s*)$/gm, (match, prefix, type, suffix) => {
    if (type.includes('| null')) return match;
    if (type.trim() === 'undefined') return match;
    return `${prefix}${type} | null${suffix}`;
  });

  // 2. Align index signatures with optional properties:
  //    `[k: string]: Type | undefined` → `[k: string]: Type | null | undefined`
  result = result.replace(/(\[k: string\]: )(.+?)( \| undefined)(;\s*)$/gm, (match, prefix, type, undef, suffix) => {
    if (type.includes('| null')) return match;
    return `${prefix}${type} | null${undef}${suffix}`;
  });

  return result;
}

// Remove numbered type duplicates like EventType1, Catalog1 that are identical to EventType, Catalog.
// The json-schema-to-typescript compiler appends numbers when it encounters the same $ref multiple
// times within a single compilation unit. We replace all references to the numbered variant with
// the canonical name and remove the duplicate definition.
function removeNumberedTypeDuplicatesOnce(
  typeDefinitions: string,
  skipWarnings: Set<string>
): { result: string; collapsed: Array<{ numbered: string; base: string }>; mismatched: string[] } {
  const typeBodyMap = new Map<string, string>();
  const numberedTypes: Array<{ numbered: string; base: string }> = [];
  const mismatched: string[] = [];

  // Match all export type/interface blocks.
  // Note: {[^}]*} stops at the first } so interfaces with nested objects (e.g. assets: {...})
  // get a truncated body. This means those interfaces will never match as duplicates — they are
  // silently skipped. In practice this is acceptable because the generated numbered duplicates
  // (SignalID1, EventType1, etc.) are all union types that use the =[^;]+; branch, which works
  // correctly. Interface duplicates with nested objects (e.g. CreativeManifest1) pre-exist in
  // the upstream generator output and are not regressed by this function.
  const typePattern = /^(export (?:type|interface) (\w+)(?:[^{=]*?)(?:\{[^}]*\}|=[^;]+;))/gm;
  let match;
  while ((match = typePattern.exec(typeDefinitions)) !== null) {
    const [, fullDef, name] = match;
    typeBodyMap.set(name, fullDef.replace(/\s+/g, ' ').trim());
  }

  for (const [name] of typeBodyMap) {
    const numberedMatch = name.match(/^(.+?)(\d+)$/);
    if (numberedMatch) {
      const [, base] = numberedMatch;
      if (typeBodyMap.has(base)) {
        const numberedBody = (typeBodyMap.get(name) ?? '').replace(new RegExp(`\\b${name}\\b`, 'g'), base);
        const baseBody = typeBodyMap.get(base) ?? '';
        if (numberedBody === baseBody) {
          numberedTypes.push({ numbered: name, base });
        } else {
          mismatched.push(name);
          if (!skipWarnings.has(name)) {
            console.warn(`⚠️  Skipping ${name}→${base}: body mismatch (may have nested object types)`);
            skipWarnings.add(name);
          }
        }
      }
    }
  }

  let result = typeDefinitions;
  for (const { numbered, base } of numberedTypes) {
    result = result.replace(new RegExp(`\\b${numbered}\\b`, 'g'), base);
  }

  return { result, collapsed: numberedTypes, mismatched };
}

export function removeNumberedTypeDuplicates(typeDefinitions: string): string {
  // Iterate: a first-pass mismatch is often caused by nested numbered references
  // (e.g. CatalogFieldMapping2 references ExtensionObject32; once ExtensionObject32
  // is collapsed to ExtensionObject, CatalogFieldMapping2's body matches the base).
  const skipWarnings = new Set<string>();
  let current = typeDefinitions;
  const allCollapsed: Array<{ numbered: string; base: string }> = [];
  for (let pass = 0; pass < 10; pass++) {
    const { result, collapsed } = removeNumberedTypeDuplicatesOnce(current, skipWarnings);
    if (collapsed.length === 0) break;
    allCollapsed.push(...collapsed);
    current = result;
  }

  if (allCollapsed.length === 0) return typeDefinitions;

  console.log(
    `🔢 Deduplicating ${allCollapsed.length} numbered type(s): ${allCollapsed.map(t => `${t.numbered}→${t.base}`).join(', ')}`
  );

  return filterDuplicateTypeDefinitions(current, new Set<string>());
}

// Helper function to filter duplicate type definitions properly
export function filterDuplicateTypeDefinitions(typeDefinitions: string, generatedTypes: Set<string>): string {
  const lines = typeDefinitions.split('\n');
  const outputLines: string[] = [];
  let currentTypeDefinition: string[] = [];
  let currentTypeName: string | null = null;
  let insideTypeDefinition = false;
  // Track brace depth so we can detect when a non-indented `/**` is the start
  // of the next type's JSDoc rather than a comment inside the current type body.
  let braceDepth = 0;
  // Buffer JSDoc comment lines that precede a type definition so they can be
  // dropped together if the type turns out to be a duplicate.
  let pendingJsdoc: string[] = [];
  let insideJsdoc = false;

  function endCurrentType(): void {
    if (currentTypeName && !generatedTypes.has(currentTypeName)) {
      generatedTypes.add(currentTypeName);
      outputLines.push(...currentTypeDefinition);
    }
    currentTypeDefinition = [];
    currentTypeName = null;
    insideTypeDefinition = false;
    braceDepth = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts a type/interface definition
    const typeMatch = line.match(/^export (?:type|interface) (\w+)/);

    if (typeMatch) {
      // If we were tracking a previous type, process it first
      if (currentTypeName && currentTypeDefinition.length > 0) {
        endCurrentType();
      }

      // Start tracking this new type, prepending any buffered JSDoc
      currentTypeName = typeMatch[1];
      insideTypeDefinition = true;
      insideJsdoc = false;
      braceDepth = 0;
      currentTypeDefinition = [...pendingJsdoc, line];
      pendingJsdoc = [];

      // Count braces on the opening line (e.g. `export interface Foo {`)
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }
    } else if (insideTypeDefinition) {
      // Count brace depth so we know when we've left the type body
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
      }

      // A non-indented `/**` at brace depth 0 unambiguously starts the next
      // type's JSDoc — end the current type here rather than swallowing it.
      if (braceDepth === 0 && line === line.trimStart() && line.startsWith('/**')) {
        endCurrentType();
        // Begin buffering this JSDoc for the upcoming type
        pendingJsdoc = [line];
        insideJsdoc = true;
      } else {
        currentTypeDefinition.push(line);

        // Also end when the next line starts a new export or we hit a double blank
        const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
        if (nextLine.match(/^export /) || (line.trim() === '' && nextLine.trim() === '')) {
          endCurrentType();
        }
      }
    } else {
      // Outside a type definition — buffer JSDoc comment blocks so they travel
      // with the type that follows them rather than being emitted immediately.
      if (line.trimStart().startsWith('/**')) {
        // Start of a new JSDoc block; discard any previous orphaned pending block
        pendingJsdoc = [line];
        insideJsdoc = true;
      } else if (insideJsdoc) {
        pendingJsdoc.push(line);
        if (line.trimStart().startsWith('*/')) {
          insideJsdoc = false;
        }
      } else {
        // Flush any accumulated JSDoc that wasn't immediately followed by a type
        if (pendingJsdoc.length > 0) {
          outputLines.push(...pendingJsdoc);
          pendingJsdoc = [];
        }
        outputLines.push(line);
      }
    }
  }

  // Handle the last type definition if we were tracking one
  if (currentTypeName && currentTypeDefinition.length > 0) {
    if (!generatedTypes.has(currentTypeName)) {
      generatedTypes.add(currentTypeName);
      outputLines.push(...currentTypeDefinition);
    }
  }

  // Flush any trailing pending JSDoc
  if (pendingJsdoc.length > 0) {
    outputLines.push(...pendingJsdoc);
  }

  return outputLines.join('\n');
}

/**
 * Some `Foo1` artifacts survive `removeNumberedTypeDuplicates` because their bodies
 * are not byte-identical to `Foo` — `json-schema-to-typescript` under-resolves the
 * second compile pass on certain shapes, dropping properties or wrappers the first
 * pass preserved. Examples (AdCP 3.0.4):
 *
 *   VASTAsset      = { asset_type: 'vast'; …metadata… } & ({delivery_type:'url',url} | {delivery_type:'inline',content})
 *   VASTAsset1     = ({delivery_type:'url',url} | {delivery_type:'inline',content})           ← lost asset_type wrapper
 *
 *   BriefAsset     = CreativeBrief & { asset_type: 'brief' }
 *   BriefAsset1    = CreativeBrief                                                            ← lost asset_type discriminator
 *
 *   AssetVariant   = ImageAsset | … | VASTAsset | … | BriefAsset | CatalogAsset
 *   AssetVariant1  = ImageAsset | … | VASTAsset1 | … | BriefAsset1 | CatalogAsset1            ← references the under-resolved variants
 *
 * The spec converged these via `core/assets/asset-union.json` (adcp#3462) — both
 * `creative-asset.json` and `creative-manifest.json` `$ref` the same union. The
 * bundler inlines both occurrences though, so jsts sees two anonymous-but-identically-
 * titled shapes and emits Foo / Foo1.
 *
 * Rewriting each `Foo1` as `type Foo1 = Foo` is type-level safe: the bundled
 * response carries `asset_type` correctly at runtime; the under-resolved TS type
 * was strictly weaker than the wire format. The alias gives consumers the
 * correctly-discriminated shape; `@deprecated` JSDoc surfaces the canonical name.
 *
 * Tracked: adcp-client#1264.
 */
const JSTS_UNDER_RESOLUTION_ALIASES: Array<{ numbered: string; base: string }> = [
  { numbered: 'VASTAsset1', base: 'VASTAsset' },
  { numbered: 'DAASTAsset1', base: 'DAASTAsset' },
  { numbered: 'BriefAsset1', base: 'BriefAsset' },
  { numbered: 'CatalogAsset1', base: 'CatalogAsset' },
  { numbered: 'AssetVariant1', base: 'AssetVariant' },
  { numbered: 'CreativeAsset1', base: 'CreativeAsset' },
];

export function applyKnownJstsAliases(typeDefinitions: string): string {
  const lines = typeDefinitions.split('\n');
  const targetNames = new Set(JSTS_UNDER_RESOLUTION_ALIASES.map(a => a.numbered));
  const baseByNumbered = new Map(JSTS_UNDER_RESOLUTION_ALIASES.map(a => [a.numbered, a.base]));
  const aliasedNames = new Set<string>();

  const outputLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const typeMatch = line.match(/^export (?:type|interface) (\w+)\b/);

    if (!typeMatch || !targetNames.has(typeMatch[1])) {
      outputLines.push(line);
      i++;
      continue;
    }

    // Found a target — locate the end of the block (brace-balanced for
    // interfaces; first `;` at brace+paren depth 0 for unions/intersections/
    // aliases) BEFORE swallowing the leading JSDoc, so a defensive bail
    // (terminator not found) leaves the original prose intact.
    const numbered = typeMatch[1];
    const base = baseByNumbered.get(numbered)!;

    let braceDepth = 0;
    let parenDepth = 0;
    let endIdx = i;
    let foundTerminator = false;
    for (let j = i; j < lines.length; j++) {
      const cur = lines[j];
      for (const ch of cur) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        else if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
      }
      // Interface block: ends at the line that closes braceDepth back to 0.
      // Type alias block: first `;` at brace+paren depth 0 ends it. Skip lines
      // that are JSDoc continuations (`*`-prefixed) so a `;` inside a comment
      // doesn't terminate the block early.
      const trimmed = cur.trimStart();
      const isJsdocLine = trimmed.startsWith('*') || trimmed.startsWith('/*');
      if (line.startsWith('export interface')) {
        if (braceDepth === 0 && j > i) {
          endIdx = j;
          foundTerminator = true;
          break;
        }
      } else {
        if (!isJsdocLine && cur.includes(';') && braceDepth === 0 && parenDepth === 0) {
          endIdx = j;
          foundTerminator = true;
          break;
        }
      }
    }

    if (!foundTerminator) {
      // Defensive: if we can't find the end, leave the block intact
      outputLines.push(line);
      i++;
      continue;
    }

    // Now that we've confirmed we'll rewrite this block, swallow any preceding
    // JSDoc lines from outputLines so the new alias's JSDoc replaces them.
    while (
      outputLines.length > 0 &&
      (outputLines[outputLines.length - 1].trimStart().startsWith('*') ||
        outputLines[outputLines.length - 1].trimStart().startsWith('/**') ||
        outputLines[outputLines.length - 1].trim() === '')
    ) {
      outputLines.pop();
    }

    outputLines.push(
      '/**',
      ` * Re-export of \`${base}\` under the legacy codegen artifact name.`,
      ' *',
      ` * \`${numbered}\` is a json-schema-to-typescript under-resolution artifact —`,
      ` * the bundler inlined the same schema at two call sites and jsts emitted a numbered`,
      ` * sibling. The body it produced was strictly weaker than \`${base}\` (missing the`,
      ` * \`asset_type\` discriminator or its containing wrapper); aliasing to \`${base}\``,
      ' * gives consumers the correctly-discriminated shape that matches the wire format.',
      ' *',
      ` * @deprecated Use \`${base}\` from \`@adcp/sdk/types\`. Slated for removal in the next major.`,
      ' */',
      `export type ${numbered} = ${base};`
    );
    aliasedNames.add(numbered);
    i = endIdx + 1;
  }

  if (aliasedNames.size > 0) {
    console.log(
      `🔀 Aliased ${aliasedNames.size} jsts under-resolution artifact(s): ${[...aliasedNames]
        .map(n => `${n}→${baseByNumbered.get(n)}`)
        .join(', ')}`
    );
  }

  return outputLines.join('\n');
}

/**
 * Convert method name to proper type name, preserving acronyms.
 * Examples:
 *   siGetOffering -> SIGetOffering
 *   getAdcpCapabilities -> GetAdCPCapabilities
 *   createMediaBuy -> CreateMediaBuy
 */
function methodNameToTypeName(methodName: string): string {
  // Known acronyms to preserve
  const acronymReplacements: [RegExp, string][] = [
    [/^si([A-Z])/i, 'SI$1'], // siGetOffering -> SIGetOffering
    [/Adcp/g, 'AdCP'], // getAdcpCapabilities -> getAdCPCapabilities
  ];

  let typeName = methodName.charAt(0).toUpperCase() + methodName.slice(1);

  for (const [pattern, replacement] of acronymReplacements) {
    typeName = typeName.replace(pattern, replacement);
  }

  return typeName;
}

/**
 * Determine whether a tool's request requires `idempotency_key`.
 *
 * Mirrors `deriveMutatingTasks()` in src/lib/utils/idempotency.ts: a tool is
 * "mutating" when its request schema has `idempotency_key` in the top-level
 * `required` array. `si_terminate_session` is excluded by name — it's naturally
 * idempotent via session_id, so its signature stays strict.
 */
function isMutatingTool(tool: ToolDefinition): boolean {
  if (tool.name === 'si_terminate_session') return false;
  const required = tool.paramsSchema?.required;
  return Array.isArray(required) && required.includes('idempotency_key');
}

function generateAgentClasses(tools: ToolDefinition[]) {
  console.log('🔧 Generating Agent and AgentCollection classes...');

  // Generate imports for tool types
  const paramImports = tools
    .map(tool => {
      const baseName = methodNameToTypeName(tool.methodName);
      const paramType = `${baseName}Request`;
      const responseType = `${baseName}Response`;
      return [paramType, responseType];
    })
    .flat();

  let agentClass = `// Generated Agent Classes
// Auto-generated from AdCP tool definitions

import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import { validateAgentUrl } from '../validation';
import { getCircuitBreaker, unwrapProtocolResponse } from '../utils';
import type { MutatingRequestInput } from '../utils/idempotency';
import type {
  ${paramImports.join(',\n  ')}
} from '../types/tools.generated';

/**
 * Single agent operations with full type safety
 *
 * Returns raw AdCP responses matching schema exactly.
 * No SDK wrapping - responses follow AdCP discriminated union patterns.
 *
 * @deprecated Use \`SingleAgentClient\` / \`AgentClient\` / \`ADCPMultiAgentClient\`
 * from \`@adcp/sdk\` instead. The \`Agent\` class predates Stage 3's per-instance
 * \`adcpVersion\` plumbing — it always emits the SDK-pinned \`ADCP_MAJOR_VERSION\`
 * on the wire regardless of caller pin, which silently drifts from a buyer
 * who pins a non-default version. The conversation-aware clients honor the
 * per-instance pin end-to-end (validators, wire field, capability check).
 */
let _agentDeprecationWarned = false;

export class Agent {
  constructor(
    private config: AgentConfig,
    private client: any // Will be AdCPClient
  ) {
    if (!_agentDeprecationWarned) {
      // Flag is set only after a successful emitWarning so a runtime that
      // throws on the first call (monkey-patched test harness, polyfilled
      // worker) still surfaces the deprecation on a later construction.
      try {
        process.emitWarning(
          'Agent class is deprecated. Use SingleAgentClient / AgentClient / ADCPMultiAgentClient from @adcp/sdk; ' +
            'Agent does not honor per-instance adcpVersion pins (always emits the SDK default major).',
          'DeprecationWarning'
        );
        _agentDeprecationWarned = true;
      } catch {
        // emitWarning is best-effort observability; never fatal.
      }
    }
  }

  private async callTool<T>(toolName: string, params: any): Promise<T> {
    const debugLogs: any[] = [];

    try {
      validateAgentUrl(this.config.agent_uri);

      const circuitBreaker = getCircuitBreaker(this.config.id);
      const protocolResponse = await circuitBreaker.call(async () => {
        return await ProtocolClient.callTool(this.config, toolName, params, { debugLogs });
      });

      // Unwrap and validate protocol response using tool-specific Zod schema
      const adcpResponse = unwrapProtocolResponse(protocolResponse, toolName, this.config.protocol);

      return adcpResponse as T;
    } catch (error) {
      // Convert exceptions to AdCP error format
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        errors: [{
          code: 'client_error',
          message: errorMessage
        }]
      } as T;
    }
  }

`;

  // Generate typed methods for each tool
  for (const tool of tools) {
    const baseName = methodNameToTypeName(tool.methodName);
    const paramType = tool.paramsSchema ? `${baseName}Request` : 'void';
    const responseType = tool.responseSchema ? `${baseName}Response` : 'any';
    const paramTypeAnnotation =
      paramType === 'void' ? paramType : isMutatingTool(tool) ? `MutatingRequestInput<${paramType}>` : paramType;
    const paramDecl = paramType === 'void' ? '' : `params: ${paramTypeAnnotation}`;

    agentClass += `  /**
   * ${tool.description}
   */
  async ${tool.methodName}(${paramDecl}): Promise<${responseType}> {
    return this.callTool<${responseType}>('${tool.name}', ${paramType === 'void' ? '{}' : 'params'});
  }

`;
  }

  agentClass += `}

/**
 * Multi-agent operations with full type safety
 */
export class AgentCollection {
  constructor(
    private configs: AgentConfig[],
    private client: any // Will be AdCPClient
  ) {}

  private async callToolOnAll<T>(toolName: string, params: any): Promise<T[]> {
    const agents = this.configs.map(config => new Agent(config, this.client));
    const promises = agents.map(agent => (agent as any).callTool(toolName, params));
    return Promise.all(promises);
  }

`;

  // Generate typed methods for multi-agent operations (excluding single-agent-only tools)
  for (const tool of tools) {
    if (tool.singleAgentOnly) continue;

    const baseName = methodNameToTypeName(tool.methodName);
    const paramType = tool.paramsSchema ? `${baseName}Request` : 'void';
    const responseType = tool.responseSchema ? `${baseName}Response` : 'any';
    const paramTypeAnnotation =
      paramType === 'void' ? paramType : isMutatingTool(tool) ? `MutatingRequestInput<${paramType}>` : paramType;
    const paramDecl = paramType === 'void' ? '' : `params: ${paramTypeAnnotation}`;

    agentClass += `  /**
   * ${tool.description} (across multiple agents)
   */
  async ${tool.methodName}(${paramDecl}): Promise<${responseType}[]> {
    return this.callToolOnAll<${responseType}>('${tool.name}', ${paramType === 'void' ? '{}' : 'params'});
  }

`;
  }

  agentClass += '}\n';

  return agentClass;
}

/**
 * Recursively discover all JSON schema files in the cache directory.
 * Returns relative paths from LATEST_CACHE_DIR (e.g., "core/format.json", "enums/channels.json").
 */
function discoverAllSchemaFiles(dir: string, base: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      // Skip tmp directory
      if (entry === 'tmp') continue;
      results.push(...discoverAllSchemaFiles(fullPath, base));
    } else if (entry.endsWith('.json') && entry !== 'index.json') {
      results.push(path.relative(base, fullPath));
    }
  }
  return results;
}

/**
 * Convert a schema file path to a PascalCase type name.
 * e.g., "core/format.json" -> "Format"
 *       "enums/pricing-model.json" -> "PricingModel"
 *       "core/assets/html-asset.json" -> "HtmlAsset"
 *       "pricing-options/cpm-option.json" -> "CpmOption"
 *       "brand/rights-pricing-option.json" -> "RightsPricingOption"
 */
function schemaPathToTypeName(relativePath: string): string {
  const fileName = path.basename(relativePath, '.json');
  return fileName
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Compile all schemas that weren't already generated by the root schema or tool passes.
 * This fills the gap for standalone schemas in core/, enums/, pricing-options/, brand/, etc.
 *
 * Skips:
 * - Task request/response schemas (already generated as tool types)
 * - Root aggregation schemas (brand.json, adagents.json at top level)
 * - Schemas whose type names were already generated via $ref resolution
 * - Async response variant schemas (working/submitted/input-required)
 */
async function compileGapSchemas(generatedTypes: Set<string>, refResolver: any): Promise<string> {
  const allFiles = discoverAllSchemaFiles(LATEST_CACHE_DIR);
  const gapCode: string[] = [];

  // Directories that contain task request/response schemas (already covered by tool generation)
  const taskDirs = new Set([
    'account',
    'media-buy',
    'creative',
    'signals',
    'governance',
    'protocol',
    'sponsored-intelligence',
    'compliance',
    'content-standards',
    'property',
    'collection',
  ]);

  // Patterns that indicate task request/response schemas
  const taskSchemaPattern = /-(request|response)\.json$/;
  // Async response variants are always generated alongside their parent tool
  const asyncVariantPattern = /-async-response-(working|submitted|input-required)\.json$/;

  // Top-level aggregation schemas (not standalone types)
  const skipFiles = new Set(['adagents.json', 'brand.json']);

  let compiledCount = 0;

  for (const relPath of allFiles.sort()) {
    // Skip top-level aggregation files
    if (!relPath.includes('/') && skipFiles.has(relPath)) continue;

    const dir = relPath.split('/')[0];

    // Skip task request/response schemas in task directories
    if (taskDirs.has(dir) && taskSchemaPattern.test(relPath)) continue;

    // Skip async response variants
    if (asyncVariantPattern.test(relPath)) continue;

    const typeName = schemaPathToTypeName(relPath);

    // Skip if this type was already generated
    if (generatedTypes.has(typeName)) continue;

    // Skip deprecated schemas
    if (DEPRECATED_SCHEMAS.has(path.basename(relPath, '.json'))) continue;

    try {
      const schemaPath = path.join(LATEST_CACHE_DIR, relPath);
      let schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

      // Apply same preprocessing as other schema passes
      const fileName = path.basename(relPath, '.json');
      if (DEPRECATED_ENUM_VALUES[fileName]) {
        schema = removeDeprecatedFields(schema, fileName);
      }
      const pascalName = schemaPathToTypeName(relPath);
      if (DEPRECATED_SCHEMA_FIELDS[pascalName]) {
        schema = removeDeprecatedFields(schema, pascalName);
      }
      if (BACKWARD_COMPAT_OPTIONAL_FIELDS[pascalName]) {
        schema = makeFieldsOptional(schema, BACKWARD_COMPAT_OPTIONAL_FIELDS[pascalName]);
      }

      const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(schema));
      const types = await compile(strictSchema, typeName, {
        bannerComment: '',
        style: { semi: true, singleQuote: true },
        additionalProperties: false,
        strictIndexSignatures: true,
        $refOptions: {
          resolve: {
            cache: refResolver,
          },
        },
      });

      const filtered = filterDuplicateTypeDefinitions(types, generatedTypes);
      if (filtered.trim()) {
        gapCode.push(`// ${relPath}\n${filtered}`);
        compiledCount++;
      }
    } catch (error: any) {
      console.warn(`⚠️  Failed to compile gap schema ${relPath}: ${error.message}`);
    }
  }

  console.log(`📦 Compiled ${compiledCount} gap schemas`);
  return gapCode.join('\n\n');
}

async function generateTypes() {
  console.log('🔄 Generating AdCP types and fluent API...');

  // Check if schemas are cached
  if (!existsSync(LATEST_CACHE_DIR)) {
    console.error('❌ Schema cache not found. Please run "npm run sync-schemas" first.');
    process.exit(1);
  }

  const adcpVersion = getCachedAdCPVersion();
  console.log(`📋 Using AdCP schemas version: ${adcpVersion}`);

  const libOutputDir = path.join(__dirname, '../src/lib/types');
  const agentsOutputDir = path.join(__dirname, '../src/lib/agents');
  mkdirSync(libOutputDir, { recursive: true });
  mkdirSync(agentsOutputDir, { recursive: true });

  // Generate core AdCP types from cached schemas
  let coreTypes = `// Generated AdCP core types from official schemas v${adcpVersion}\n// Generated at: ${new Date().toISOString()}\n\n`;

  // Custom $ref resolver for cached schemas
  const refResolver = {
    canRead: true,
    read: (file: { url: string }) => {
      const url = file.url;
      // Handle any /schemas/ path (versioned or v1)
      if (url.startsWith('/schemas/')) {
        const schema = loadCachedSchema(url);
        if (schema) {
          return Promise.resolve(enforceStrictSchema(removeArrayLengthConstraints(schema)));
        }
      }
      return Promise.reject(new Error(`Cannot resolve $ref: ${url}`));
    },
  };

  // Track generated types across all core schemas to prevent duplicates
  const generatedCoreTypes = new Set<string>();

  for (const schemaName of ADCP_CORE_SCHEMAS) {
    try {
      console.log(`📥 Loading ${schemaName} schema from cache...`);
      const schema = loadCoreSchema(schemaName);

      if (schema) {
        console.log(`🔧 Generating TypeScript types for ${schemaName}...`);
        // Process schema: remove additionalProperties and minItems constraints
        const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(schema));
        const types = await compile(strictSchema, schemaName, {
          bannerComment: '',
          style: {
            semi: true,
            singleQuote: true,
          },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        // Filter out duplicate type definitions across core schemas
        const filteredTypes = filterDuplicateTypeDefinitions(types, generatedCoreTypes);

        coreTypes += `// ${schemaName.toUpperCase()} SCHEMA\n${filteredTypes}\n`;
        console.log(`✅ Generated core types for ${schemaName}`);
      } else {
        console.warn(`⚠️  Skipping ${schemaName} - schema not found in cache`);
      }
    } catch (error) {
      console.error(`❌ Failed to generate core types for ${schemaName}:`, error.message);
    }
  }

  // Generate types for standalone schemas (not in core/ directory)
  for (const schemaName of STANDALONE_SCHEMAS) {
    try {
      console.log(`📥 Loading ${schemaName} schema from cache...`);

      // Read refs from the index.json instead of hardcoding paths
      const indexPath = path.join(SCHEMA_CACHE_DIR, 'latest', 'index.json');
      if (!existsSync(indexPath)) {
        throw new Error('Schema index not found in cache');
      }
      const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));

      // Look up the schema in the index to get actual $ref
      const schemaRef = schemaIndex.schemas?.[schemaName]?.$ref;
      if (!schemaRef) {
        throw new Error(`Schema ${schemaName} not found in index`);
      }

      const schema = loadCachedSchema(schemaRef);

      if (schema) {
        console.log(`🔧 Generating TypeScript types for ${schemaName}...`);
        // Process schema: remove additionalProperties and minItems constraints
        const strictSchema = enforceStrictSchema(removeArrayLengthConstraints(schema));
        const types = await compile(strictSchema, schemaName, {
          bannerComment: '',
          style: {
            semi: true,
            singleQuote: true,
          },
          additionalProperties: false, // Disable [k: string]: unknown for type safety
          strictIndexSignatures: true, // Add | undefined to index signatures for optional property compatibility
          $refOptions: {
            resolve: {
              cache: refResolver,
            },
          },
        });

        // Filter out duplicate type definitions using the same tracking set
        const filteredTypes = filterDuplicateTypeDefinitions(types, generatedCoreTypes);

        coreTypes += `// ${schemaName.toUpperCase()} SCHEMA\n${filteredTypes}\n`;
        console.log(`✅ Generated standalone types for ${schemaName}`);
      } else {
        console.warn(`⚠️  Skipping ${schemaName} - schema not found in cache`);
      }
    } catch (error) {
      console.error(`❌ Failed to generate standalone types for ${schemaName}:`, error.message);
    }
  }

  // Load AdCP tools from cached schemas
  const tools = loadAdCPTools();

  // Generate tool types
  let toolTypes = await generateToolTypes(tools);

  // Remove index signature types that were incorrectly generated from oneOf schemas
  // These occur when JSON Schema has additionalProperties: false but oneOf with only required constraints
  toolTypes = removeIndexSignatureTypes(toolTypes);
  // Remove numbered type duplicates (e.g., EventType1 -> EventType) caused by multiple $ref
  // occurrences of the same schema within a single compilation unit
  toolTypes = removeNumberedTypeDuplicates(toolTypes);
  toolTypes = fixTypedIndexSignatures(toolTypes);

  // Compile gap schemas: all schemas not already generated by root schema passes.
  // Only dedup against core types (not tool types) because gap schemas go into
  // core.generated.ts which is a separate file from tools.generated.ts.
  console.log('\n🔍 Scanning for gap schemas...');
  const gapTypes = await compileGapSchemas(new Set(generatedCoreTypes), refResolver);
  if (gapTypes.trim()) {
    coreTypes += `\n// GAP SCHEMAS — types not reachable from root schemas or tool definitions\n${gapTypes}\n`;
  }

  // Generate Agent classes
  const agentClasses = generateAgentClasses(tools);

  // Write files only if content changed
  const coreTypesPath = path.join(libOutputDir, 'core.generated.ts');
  // Strip inline index-signature arms first so numbered-duplicate detection compares
  // clean bodies (without the { [k: string]: unknown } intersection arms that only appear
  // on some compile passes of the same schema). After byte-identity dedupe, alias the
  // residual jsts under-resolution artifacts (*Asset1, AssetVariant1, CreativeAsset1) —
  // see applyKnownJstsAliases for the rationale.
  const processedCoreTypes = fixTypedIndexSignatures(
    applyKnownJstsAliases(removeNumberedTypeDuplicates(removeIndexSignatureTypes(coreTypes)))
  );
  const coreChanged = writeFileIfChanged(coreTypesPath, processedCoreTypes);

  const toolTypesPath = path.join(libOutputDir, 'tools.generated.ts');
  const toolsChanged = writeFileIfChanged(toolTypesPath, toolTypes);

  const agentClassesPath = path.join(agentsOutputDir, 'index.generated.ts');
  const agentsChanged = writeFileIfChanged(agentClassesPath, agentClasses);

  const changedFiles = [
    coreChanged && 'core types',
    toolsChanged && 'tool types',
    agentsChanged && 'agent classes',
  ].filter(Boolean);

  if (changedFiles.length > 0) {
    console.log(`✅ Updated ${changedFiles.join(', ')}`);
  } else {
    console.log(`✅ All generated files are up to date`);
  }

  console.log(`✅ Generated files:`);
  console.log(`   📄 Core types: ${coreTypesPath}`);
  console.log(`   📄 Tool types: ${toolTypesPath}`);
  console.log(`   📄 Agent classes: ${agentClassesPath}`);
}

if (require.main === module) {
  (async () => {
    try {
      // Generate TypeScript types
      await generateTypes();

      // Also generate Zod schemas
      console.log('\n🔄 Generating Zod schemas...');
      const { generateZodSchemas } = await import('./generate-zod-from-ts');
      await generateZodSchemas();

      console.log('\n✅ All type generation complete!');
    } catch (error) {
      console.error('❌ Failed to generate types:', error);
      process.exit(1);
    }
  })();
}

export { generateTypes };
