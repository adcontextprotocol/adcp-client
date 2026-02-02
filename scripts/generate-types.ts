#!/usr/bin/env tsx

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { compile } from 'json-schema-to-typescript';
import path from 'path';
import { removeMinItemsConstraints } from './schema-utils';

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
function enforceStrictSchema(schema: any): any {
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

  // Recursively process nested schemas
  if (strictSchema.properties) {
    strictSchema.properties = Object.fromEntries(
      Object.entries(strictSchema.properties).map(([key, value]) => [key, enforceStrictSchema(value)])
    );
  }

  if (strictSchema.items) {
    if (Array.isArray(strictSchema.items)) {
      strictSchema.items = strictSchema.items.map(enforceStrictSchema);
    } else {
      strictSchema.items = enforceStrictSchema(strictSchema.items);
    }
  }

  if (strictSchema.allOf) {
    strictSchema.allOf = strictSchema.allOf.map(enforceStrictSchema);
  }

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
  taskType: 'media-buy' | 'signals' | 'creative' | 'governance' | 'sponsored-intelligence' | 'protocol' | 'account' = 'media-buy'
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
const TASK_DOMAINS = ['media-buy', 'creative', 'signals', 'governance', 'sponsored-intelligence', 'protocol', 'account'] as const;
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

    const totalTools =
      mediaBuyTools.length +
      creativeTools.length +
      signalsTools.length +
      governanceTools.length +
      sponsoredIntelligenceTools.length +
      protocolTools.length +
      accountTools.length;

    console.log(`✅ Discovered ${totalTools} official AdCP tools:`);
    console.log(`   📈 Media-buy tools: ${mediaBuyTools.join(', ')}`);
    console.log(`   🎨 Creative tools: ${creativeTools.join(', ')}`);
    console.log(`   🎯 Signals tools: ${signalsTools.join(', ')}`);
    console.log(`   🏛️  Governance tools: ${governanceTools.join(', ')}`);
    console.log(`   💬 Sponsored Intelligence tools: ${sponsoredIntelligenceTools.join(', ')}`);
    console.log(`   🔧 Protocol tools: ${protocolTools.join(', ')}`);
    console.log(`   💳 Account tools: ${accountTools.join(', ')}`);

    return { mediaBuyTools, creativeTools, signalsTools, governanceTools, sponsoredIntelligenceTools, protocolTools, accountTools };
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
    };
  }
}

// Load tool definitions from cached schemas
function loadAdCPTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const processedTools = new Set<string>();

  // Get the official tools list from cached schema index
  const { mediaBuyTools, creativeTools, signalsTools, governanceTools, sponsoredIntelligenceTools, protocolTools, accountTools } =
    loadOfficialAdCPToolsWithTypes();

  // Helper to process tools from a domain
  const processToolsFromDomain = (
    toolNames: string[],
    domain: 'media-buy' | 'creative' | 'signals' | 'governance' | 'sponsored-intelligence' | 'protocol' | 'account',
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
          return Promise.resolve(schema);
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
        const strictParamsSchema = enforceStrictSchema(removeMinItemsConstraints(tool.paramsSchema));
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
        const strictResponseSchema = enforceStrictSchema(removeMinItemsConstraints(tool.responseSchema));
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

// Helper function to filter duplicate type definitions properly
function filterDuplicateTypeDefinitions(typeDefinitions: string, generatedTypes: Set<string>): string {
  const lines = typeDefinitions.split('\n');
  const outputLines: string[] = [];
  let currentTypeDefinition: string[] = [];
  let currentTypeName: string | null = null;
  let insideTypeDefinition = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this line starts a type/interface definition
    const typeMatch = line.match(/^export (?:type|interface) (\w+)/);

    if (typeMatch) {
      // If we were tracking a previous type, process it first
      if (currentTypeName && currentTypeDefinition.length > 0) {
        if (!generatedTypes.has(currentTypeName)) {
          generatedTypes.add(currentTypeName);
          outputLines.push(...currentTypeDefinition);
        }
        currentTypeDefinition = [];
      }

      // Start tracking this new type
      currentTypeName = typeMatch[1];
      insideTypeDefinition = true;
      currentTypeDefinition = [line];
    } else if (insideTypeDefinition) {
      currentTypeDefinition.push(line);

      // Check if we've reached the end of the type definition
      // Type definitions end when we hit a line that starts a new export or is completely empty
      const nextLine = i + 1 < lines.length ? lines[i + 1] : '';
      if (nextLine.match(/^export /) || (line.trim() === '' && nextLine.trim() === '')) {
        // End of current type definition
        if (currentTypeName && !generatedTypes.has(currentTypeName)) {
          generatedTypes.add(currentTypeName);
          outputLines.push(...currentTypeDefinition);
        }
        currentTypeDefinition = [];
        currentTypeName = null;
        insideTypeDefinition = false;
      }
    } else {
      // Regular line outside of type definitions
      outputLines.push(line);
    }
  }

  // Handle the last type definition if we were tracking one
  if (currentTypeName && currentTypeDefinition.length > 0) {
    if (!generatedTypes.has(currentTypeName)) {
      generatedTypes.add(currentTypeName);
      outputLines.push(...currentTypeDefinition);
    }
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
import type {
  ${paramImports.join(',\n  ')}
} from '../types/tools.generated';

/**
 * Single agent operations with full type safety
 *
 * Returns raw AdCP responses matching schema exactly.
 * No SDK wrapping - responses follow AdCP discriminated union patterns.
 */
export class Agent {
  constructor(
    private config: AgentConfig,
    private client: any // Will be AdCPClient
  ) {}

  private async callTool<T>(toolName: string, params: any): Promise<T> {
    const debugLogs: any[] = [];

    try {
      validateAgentUrl(this.config.agent_uri);

      const circuitBreaker = getCircuitBreaker(this.config.id);
      const protocolResponse = await circuitBreaker.call(async () => {
        return await ProtocolClient.callTool(this.config, toolName, params, debugLogs);
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
    const paramDecl = paramType === 'void' ? '' : `params: ${paramType}`;

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
    const paramDecl = paramType === 'void' ? '' : `params: ${paramType}`;

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
          return Promise.resolve(schema);
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
        const strictSchema = enforceStrictSchema(removeMinItemsConstraints(schema));
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
        const strictSchema = enforceStrictSchema(removeMinItemsConstraints(schema));
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

  // Generate Agent classes
  const agentClasses = generateAgentClasses(tools);

  // Write files only if content changed
  const coreTypesPath = path.join(libOutputDir, 'core.generated.ts');
  // Remove index signature types that were incorrectly generated from oneOf schemas
  const processedCoreTypes = removeIndexSignatureTypes(coreTypes);
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
