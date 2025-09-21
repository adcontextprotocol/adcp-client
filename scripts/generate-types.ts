#!/usr/bin/env tsx

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { compile } from 'json-schema-to-typescript';
import path from 'path';

// Schema cache configuration
const SCHEMA_CACHE_DIR = path.join(__dirname, '../schemas/cache');
const LATEST_CACHE_DIR = path.join(SCHEMA_CACHE_DIR, 'latest');

// Core AdCP schemas to generate
const ADCP_CORE_SCHEMAS = ['media-buy', 'creative-asset', 'product', 'targeting'];

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

// AdCP Tool Definitions (based on official ADCP specification)
interface ToolDefinition {
  name: string;
  methodName: string;
  description: string;
  paramsSchema: any;
  responseSchema: any;
  singleAgentOnly?: boolean;
}

// Load AdCP tool schemas from cache
function loadToolSchema(toolName: string, taskType: 'media-buy' | 'signals' = 'media-buy'): any {
  try {
    const kebabName = toolName.replace(/_/g, '-');
    const requestRef = `/schemas/v1/${taskType}/${kebabName}-request.json`;
    const responseRef = `/schemas/v1/${taskType}/${kebabName}-response.json`;
    
    console.log(`📥 Loading ${toolName} schema from cache...`);
    
    const requestSchema = loadCachedSchema(requestRef);
    const responseSchema = loadCachedSchema(responseRef);
    
    if (!requestSchema || !responseSchema) {
      throw new Error(`Missing request or response schema for ${toolName}`);
    }
    
    // Combine into the expected format
    return {
      description: `Official AdCP ${toolName} tool schema`,
      type: 'object',
      properties: {
        request: requestSchema,
        response: responseSchema
      }
    };
  } catch (error) {
    console.warn(`⚠️  Could not load schema for ${toolName}:`, error.message);
    return null;
  }
}

// Load official AdCP tools from cached schema index
function loadOfficialAdCPToolsWithTypes(): {mediaBuyTools: string[], signalsTools: string[]} {
  try {
    console.log('📥 Loading official AdCP tools from cached schema index...');
    const indexPath = path.join(LATEST_CACHE_DIR, 'index.json');
    
    if (!existsSync(indexPath)) {
      throw new Error('Schema index not found in cache');
    }
    
    const schemaIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    const mediaBuyTools: string[] = [];
    const signalsTools: string[] = [];
    
    // Extract tools from media-buy tasks
    if (schemaIndex.schemas?.['media-buy']?.tasks) {
      const mediaBuyTasks = schemaIndex.schemas['media-buy'].tasks;
      for (const taskName of Object.keys(mediaBuyTasks)) {
        // Convert kebab-case to snake_case (e.g., "get-products" -> "get_products")
        const toolName = taskName.replace(/-/g, '_');
        mediaBuyTools.push(toolName);
      }
    }
    
    // Extract tools from signals tasks
    if (schemaIndex.schemas?.signals?.tasks) {
      const signalsTasks = schemaIndex.schemas.signals.tasks;
      for (const taskName of Object.keys(signalsTasks)) {
        // Convert kebab-case to snake_case (e.g., "get-signals" -> "get_signals")
        const toolName = taskName.replace(/-/g, '_');
        signalsTools.push(toolName);
      }
    }
    
    console.log(`✅ Discovered ${mediaBuyTools.length + signalsTools.length} official AdCP tools:`);
    console.log(`   📈 Media-buy tools: ${mediaBuyTools.join(', ')}`);
    console.log(`   🎯 Signals tools: ${signalsTools.join(', ')}`);
    
    return { mediaBuyTools, signalsTools };
  } catch (error) {
    console.warn(`⚠️  Failed to load cached tools, falling back to known tools:`, error.message);
    // Fallback to known tools if the cache fails
    return {
      mediaBuyTools: [
        'get_products',
        'list_creative_formats', 
        'create_media_buy',
        'sync_creatives',
        'list_creatives'
      ],
      signalsTools: []
    };
  }
}

// Load tool definitions from cached schemas
function loadAdCPTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  
  // Get the official tools list from cached schema index
  const { mediaBuyTools, signalsTools } = loadOfficialAdCPToolsWithTypes();
  
  // Process media-buy tools
  for (const toolName of mediaBuyTools) {
    const schema = loadToolSchema(toolName, 'media-buy');
    if (schema) {
      // Convert snake_case to camelCase for method names
      const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      
      // Determine single-agent-only tools (transactional operations)
      const singleAgentOnly = ['create_media_buy', 'update_media_buy'].includes(toolName);
      
      tools.push({
        name: toolName,
        methodName,
        description: schema.description || `Execute ${toolName} operation`,
        paramsSchema: schema.properties?.request || {},
        responseSchema: schema.properties?.response || {},
        singleAgentOnly
      });
      
      console.log(`✅ Loaded ${toolName} from cached media-buy schema`);
    } else {
      console.warn(`⚠️  Skipping ${toolName} - no schema available`);
    }
  }
  
  // Process signals tools
  for (const toolName of signalsTools) {
    const schema = loadToolSchema(toolName, 'signals');
    if (schema) {
      // Convert snake_case to camelCase for method names
      const methodName = toolName.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      
      // Signals tools are typically multi-agent friendly
      const singleAgentOnly = false;
      
      tools.push({
        name: toolName,
        methodName,
        description: schema.description || `Execute ${toolName} operation`,
        paramsSchema: schema.properties?.request || {},
        responseSchema: schema.properties?.response || {},
        singleAgentOnly
      });
      
      console.log(`✅ Loaded ${toolName} from cached signals schema`);
    } else {
      console.warn(`⚠️  Skipping ${toolName} - no schema available`);
    }
  }
  
  return tools;
}

// Load schema from cache by name
function loadCoreSchema(schemaName: string): any {
  const schemaRef = `/schemas/v1/core/${schemaName}.json`;
  return loadCachedSchema(schemaRef);
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
      if (url.startsWith('/schemas/v1/')) {
        const schema = loadCachedSchema(url);
        if (schema) {
          return Promise.resolve(schema);
        }
      }
      return Promise.reject(new Error(`Cannot resolve $ref: ${url}`));
    }
  };


  // Track generated types to avoid duplicates
  const generatedTypes = new Set<string>();
  const allGeneratedCode: string[] = [];

  for (const tool of tools) {
    try {
      // Generate parameter types
      if (tool.paramsSchema) {
        const paramTypeName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Request`;
        const paramTypes = await compile(tool.paramsSchema, paramTypeName, {
          bannerComment: '',
          style: { semi: true, singleQuote: true },
          $refOptions: {
            resolve: {
              cache: refResolver
            }
          }
        });
        
        const filteredParamTypes = filterDuplicateTypeDefinitions(paramTypes, generatedTypes);
        if (filteredParamTypes.trim()) {
          allGeneratedCode.push(`// ${tool.name} parameters\n${filteredParamTypes}`);
        }
      }

      // Generate response types  
      if (tool.responseSchema) {
        const responseTypeName = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Response`;
        const responseTypes = await compile(tool.responseSchema, responseTypeName, {
          bannerComment: '',
          style: { semi: true, singleQuote: true },
          $refOptions: {
            resolve: {
              cache: refResolver
            }
          }
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


function generateAgentClasses(tools: ToolDefinition[]) {
  console.log('🔧 Generating Agent and AgentCollection classes...');

  // Generate imports for tool types
  const paramImports = tools.map(tool => {
    const paramType = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Request`;
    const responseType = `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Response`;
    return [paramType, responseType];
  }).flat();

  let agentClass = `// Generated Agent Classes
// Auto-generated from AdCP tool definitions

import type { AgentConfig } from '../types';
import { ProtocolClient } from '../protocols';
import { validateAgentUrl } from '../validation';
import { getCircuitBreaker } from '../utils';
import type {
  ${paramImports.join(',\n  ')}
} from '../types/tools.generated';

// Common response wrapper
interface ToolResponse<T> {
  success: true;
  data: T;
  agent: {
    id: string;
    name: string;
    protocol: 'mcp' | 'a2a';
  };
  responseTimeMs: number;
  timestamp: string;
  debugLogs?: any[];
}

interface ToolError {
  success: false;
  error: string;
  agent: {
    id: string;
    name: string;
    protocol: 'mcp' | 'a2a';
  };
  responseTimeMs: number;
  timestamp: string;
  debugLogs?: any[];
}

type ToolResult<T> = ToolResponse<T> | ToolError;

/**
 * Single agent operations with full type safety
 */
export class Agent {
  constructor(
    private config: AgentConfig,
    private client: any // Will be AdCPClient
  ) {}

  private async callTool<T>(toolName: string, params: any): Promise<ToolResult<T>> {
    const startTime = Date.now();
    const debugLogs: any[] = [];

    try {
      validateAgentUrl(this.config.agent_uri);
      
      const circuitBreaker = getCircuitBreaker(this.config.id);
      const result = await circuitBreaker.call(async () => {
        return await ProtocolClient.callTool(this.config, toolName, params, debugLogs);
      });

      return {
        success: true,
        data: result,
        agent: {
          id: this.config.id,
          name: this.config.name,
          protocol: this.config.protocol
        },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        debugLogs
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: errorMessage,
        agent: {
          id: this.config.id,
          name: this.config.name,
          protocol: this.config.protocol
        },
        responseTimeMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        debugLogs
      };
    }
  }

`;

  // Generate typed methods for each tool
  for (const tool of tools) {
    const paramType = tool.paramsSchema ? 
      `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Request` : 
      'void';
    
    const responseType = tool.responseSchema ? 
      `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Response` : 
      'any';

    const paramDecl = paramType === 'void' ? '' : `params: ${paramType}`;

    agentClass += `  /**
   * ${tool.description}
   * Official AdCP ${tool.name} tool schema
   */
  async ${tool.methodName}(${paramDecl}): Promise<ToolResult<${responseType}>> {
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

  private async callToolOnAll<T>(toolName: string, params: any): Promise<ToolResult<T>[]> {
    const agents = this.configs.map(config => new Agent(config, this.client));
    const promises = agents.map(agent => (agent as any).callTool(toolName, params));
    return Promise.all(promises);
  }

`;

  // Generate typed methods for multi-agent operations (excluding single-agent-only tools)
  for (const tool of tools) {
    if (tool.singleAgentOnly) continue;

    const paramType = tool.paramsSchema ? 
      `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Request` : 
      'void';
    
    const responseType = tool.responseSchema ? 
      `${tool.methodName.charAt(0).toUpperCase() + tool.methodName.slice(1)}Response` : 
      'any';

    const paramDecl = paramType === 'void' ? '' : `params: ${paramType}`;

    agentClass += `  /**
   * ${tool.description} (across multiple agents)
   * Official AdCP ${tool.name} tool schema
   */
  async ${tool.methodName}(${paramDecl}): Promise<ToolResult<${responseType}>[]> {
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
      if (url.startsWith('/schemas/v1/')) {
        const schema = loadCachedSchema(url);
        if (schema) {
          return Promise.resolve(schema);
        }
      }
      return Promise.reject(new Error(`Cannot resolve $ref: ${url}`));
    }
  };

  for (const schemaName of ADCP_CORE_SCHEMAS) {
    try {
      console.log(`📥 Loading ${schemaName} schema from cache...`);
      const schema = loadCoreSchema(schemaName);
      
      if (schema) {
        console.log(`🔧 Generating TypeScript types for ${schemaName}...`);
        const types = await compile(schema, schemaName, {
          bannerComment: '',
          style: {
            semi: true,
            singleQuote: true
          },
          $refOptions: {
            resolve: {
              cache: refResolver
            }
          }
        });
        
        coreTypes += `// ${schemaName.toUpperCase()} SCHEMA\n${types}\n`;
        console.log(`✅ Generated core types for ${schemaName}`);
      } else {
        console.warn(`⚠️  Skipping ${schemaName} - schema not found in cache`);
      }
    } catch (error) {
      console.error(`❌ Failed to generate core types for ${schemaName}:`, error.message);
    }
  }

  // Load AdCP tools from cached schemas
  const tools = loadAdCPTools();

  // Generate tool types
  const toolTypes = await generateToolTypes(tools);

  // Generate Agent classes
  const agentClasses = generateAgentClasses(tools);

  // Write files
  const coreTypesPath = path.join(libOutputDir, 'core.generated.ts');
  writeFileSync(coreTypesPath, coreTypes);
  
  const toolTypesPath = path.join(libOutputDir, 'tools.generated.ts');
  writeFileSync(toolTypesPath, toolTypes);

  const agentClassesPath = path.join(agentsOutputDir, 'index.generated.ts');
  writeFileSync(agentClassesPath, agentClasses);
  
  console.log(`✅ Generated files:`);
  console.log(`   📄 Core types: ${coreTypesPath}`);
  console.log(`   📄 Tool types: ${toolTypesPath}`);
  console.log(`   📄 Agent classes: ${agentClassesPath}`);
}

if (require.main === module) {
  generateTypes().catch(error => {
    console.error('❌ Failed to generate types:', error);
    process.exit(1);
  });
}

export { generateTypes };