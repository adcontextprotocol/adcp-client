#!/usr/bin/env tsx

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import path from 'path';

// Schema cache configuration
const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const LATEST_CACHE_DIR = path.join(SCHEMA_CACHE_DIR, 'latest');

// Core AdCP schemas to generate
const ADCP_CORE_SCHEMAS = ['media-buy', 'creative-asset', 'product', 'targeting'];

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

// Load schema from cache
function loadCachedSchema(schemaRef: string): any {
  try {
    const schemaPath = path.join(LATEST_CACHE_DIR, schemaRef.replace('/schemas/v1/', ''));
    if (!existsSync(schemaPath)) {
      throw new Error(`Schema not found in cache: ${schemaPath}`);
    }
    return JSON.parse(readFileSync(schemaPath, 'utf8'));
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

// Load schema from cache by name
function loadCoreSchema(schemaName: string): any {
  const schemaRef = `/schemas/v1/core/${schemaName}.json`;
  return loadCachedSchema(schemaRef);
}

// Load tool definitions from cached schemas
interface ToolDefinition {
  name: string;
  methodName: string;
  requestSchema: any;
  responseSchema: any;
}

function loadToolSchema(toolName: string, taskType: 'media-buy' | 'signals' | 'creative' = 'media-buy'): any {
  try {
    const kebabName = toolName.replace(/_/g, '-');
    let requestRef = `/schemas/v1/${taskType}/${kebabName}-request.json`;
    let responseRef = `/schemas/v1/${taskType}/${kebabName}-response.json`;

    let requestSchema = loadCachedSchema(requestRef);
    let responseSchema = loadCachedSchema(responseRef);

    // Fallback: Try media-buy namespace if creative namespace fails
    if ((!requestSchema || !responseSchema) && taskType === 'creative') {
      requestRef = `/schemas/v1/media-buy/${kebabName}-request.json`;
      responseRef = `/schemas/v1/media-buy/${kebabName}-response.json`;
      requestSchema = loadCachedSchema(requestRef);
      responseSchema = loadCachedSchema(responseRef);
    }

    if (!requestSchema || !responseSchema) {
      return null;
    }

    return { requestSchema, responseSchema };
  } catch (error) {
    console.warn(`⚠️  Could not load schema for ${toolName}:`, error.message);
    return null;
  }
}

// Load official AdCP tools from cached schema index
function loadOfficialAdCPTools(): ToolDefinition[] {
  try {
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');

    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }

    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    const tools: ToolDefinition[] = [];

    // Extract tools from media-buy tasks
    if (schemaIndex.schemas?.['media-buy']?.tasks) {
      const mediaBuyTasks = schemaIndex.schemas['media-buy'].tasks;
      for (const taskName of Object.keys(mediaBuyTasks)) {
        const toolName = taskName.replace(/-/g, '_');
        const schemas = loadToolSchema(toolName, 'media-buy');
        if (schemas) {
          const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
          tools.push({
            name: toolName,
            methodName,
            requestSchema: schemas.requestSchema,
            responseSchema: schemas.responseSchema
          });
        }
      }
    }

    // Extract tools from signals tasks
    if (schemaIndex.schemas?.signals?.tasks) {
      const signalsTasks = schemaIndex.schemas.signals.tasks;
      for (const taskName of Object.keys(signalsTasks)) {
        const toolName = taskName.replace(/-/g, '_');
        const schemas = loadToolSchema(toolName, 'signals');
        if (schemas) {
          const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
          tools.push({
            name: toolName,
            methodName,
            requestSchema: schemas.requestSchema,
            responseSchema: schemas.responseSchema
          });
        }
      }
    }

    return tools;
  } catch (error) {
    console.warn(`⚠️  Failed to load tools:`, error.message);
    return [];
  }
}

// Convert JSON Schema to Zod with proper naming
function convertSchemaToZod(schema: any, schemaName: string): string {
  try {
    // Use json-schema-to-zod to convert
    const zodCode = jsonSchemaToZod(schema, {
      name: schemaName,
      module: 'esm'
    });

    // Remove the import statement since we have one at the top of the file
    const codeWithoutImport = zodCode.replace(/^import \{ z \} from ["']zod["']\n*/m, '');

    return codeWithoutImport;
  } catch (error) {
    console.error(`Failed to convert ${schemaName} to Zod:`, error.message);
    return '';
  }
}

async function generateZodSchemas() {
  console.log('🔄 Generating Zod schemas from AdCP JSON schemas...');

  // Check if schemas are cached
  if (!existsSync(LATEST_CACHE_DIR)) {
    console.error('❌ Schema cache not found. Please run "npm run sync-schemas" first.');
    process.exit(1);
  }

  const adcpVersion = getCachedAdCPVersion();
  console.log(`📋 Using AdCP schemas version: ${adcpVersion}`);

  const outputDir = path.join(__dirname, '../src/lib/types');
  mkdirSync(outputDir, { recursive: true });

  let zodSchemas = `// Generated Zod schemas from official AdCP schemas v${adcpVersion}
// Generated at: ${new Date().toISOString()}
// These schemas provide runtime validation for AdCP data structures

import { z } from 'zod';

`;

  // Track generated schemas to avoid duplicates
  const generatedSchemas = new Set<string>();

  // Generate core AdCP schemas
  console.log('📦 Generating core Zod schemas...');
  for (const schemaName of ADCP_CORE_SCHEMAS) {
    try {
      console.log(`  📥 Loading ${schemaName} schema...`);
      const schema = loadCoreSchema(schemaName);

      if (schema) {
        const pascalName = schemaName
          .split('-')
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join('');

        const schemaVarName = `${pascalName}Schema`;

        if (!generatedSchemas.has(schemaVarName)) {
          console.log(`  🔧 Converting ${schemaName} to Zod...`);
          const zodCode = convertSchemaToZod(schema, schemaVarName);

          if (zodCode.trim()) {
            zodSchemas += `// ${schemaName.toUpperCase()} SCHEMA\n${zodCode}\n\n`;
            generatedSchemas.add(schemaVarName);
            console.log(`  ✅ Generated ${schemaVarName}`);
          }
        }
      } else {
        console.warn(`  ⚠️  Skipping ${schemaName} - schema not found in cache`);
      }
    } catch (error) {
      console.error(`  ❌ Failed to generate Zod schema for ${schemaName}:`, error.message);
    }
  }

  // Generate tool schemas
  console.log('📦 Generating tool Zod schemas...');
  const tools = loadOfficialAdCPTools();

  for (const tool of tools) {
    try {
      const requestSchemaName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}RequestSchema`;
      const responseSchemaName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}ResponseSchema`;

      // Generate request schema
      if (tool.requestSchema && !generatedSchemas.has(requestSchemaName)) {
        console.log(`  🔧 Converting ${tool.name} request to Zod...`);
        const zodCode = convertSchemaToZod(tool.requestSchema, requestSchemaName);

        if (zodCode.trim()) {
          zodSchemas += `// ${tool.name} request\n${zodCode}\n\n`;
          generatedSchemas.add(requestSchemaName);
          console.log(`  ✅ Generated ${requestSchemaName}`);
        }
      }

      // Generate response schema
      if (tool.responseSchema && !generatedSchemas.has(responseSchemaName)) {
        console.log(`  🔧 Converting ${tool.name} response to Zod...`);
        const zodCode = convertSchemaToZod(tool.responseSchema, responseSchemaName);

        if (zodCode.trim()) {
          zodSchemas += `// ${tool.name} response\n${zodCode}\n\n`;
          generatedSchemas.add(responseSchemaName);
          console.log(`  ✅ Generated ${responseSchemaName}`);
        }
      }
    } catch (error) {
      console.error(`  ❌ Failed to generate Zod schemas for ${tool.name}:`, error.message);
    }
  }

  // Write the generated schemas
  const outputPath = path.join(outputDir, 'schemas.generated.ts');
  const changed = writeFileIfChanged(outputPath, zodSchemas);

  if (changed) {
    console.log(`✅ Generated Zod schemas: ${outputPath}`);
  } else {
    console.log(`✅ Zod schemas are up to date: ${outputPath}`);
  }

  console.log(`📊 Generated ${generatedSchemas.size} Zod schemas`);
}

if (require.main === module) {
  generateZodSchemas().catch(error => {
    console.error('❌ Failed to generate Zod schemas:', error);
    process.exit(1);
  });
}

export { generateZodSchemas };
