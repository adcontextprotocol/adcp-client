import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { AdCPClient, ConfigurationManager, getStandardFormats } from '../lib';
import type { TestRequest, ApiResponse, TestResponse, AgentListResponse, ValidateAdAgentsRequest, ValidateAdAgentsResponse, CreateAdAgentsRequest, CreateAdAgentsResponse, AgentConfig, TestResult } from '../lib/types';
import { AdAgentsManager } from './adagents-manager';

// __dirname is available in CommonJS mode

const app: FastifyInstance = Fastify({ 
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development' 
      ? { target: 'pino-pretty' } 
      : undefined
  }
});

// Initialize AdCP client with configured agents
const configuredAgents = ConfigurationManager.loadAgentsFromEnv();
const adcpClient = new AdCPClient(configuredAgents);

// Helper function to call tools dynamically using the new fluent API
// Convert new fluent API response to legacy format for server compatibility
function adaptResponseToLegacyFormat(fluentResponse: any): TestResult {
  return {
    agent_id: fluentResponse.agent.id,
    agent_name: fluentResponse.agent.name,
    success: fluentResponse.success,
    response_time_ms: fluentResponse.responseTimeMs,
    data: fluentResponse.success ? fluentResponse.data : undefined,
    error: fluentResponse.success ? undefined : fluentResponse.error,
    timestamp: fluentResponse.timestamp,
    debug_logs: fluentResponse.debugLogs
  };
}

async function callToolOnAgent(agentId: string, toolName: string, args: any): Promise<TestResult> {
  const agent = adcpClient.agent(agentId);
  
  let fluentResponse;
  switch (toolName) {
    case 'get_products':
      fluentResponse = await agent.getProducts({
        brief: args.brief,
        promoted_offering: args.promoted_offering
      });
      break;
    case 'list_creative_formats':
      fluentResponse = await agent.listCreativeFormats({
        type: args.type,
        category: args.category,
        format_ids: args.format_ids
      });
      break;
    case 'create_media_buy':
      fluentResponse = await agent.createMediaBuy({
        buyer_ref: args.buyer_ref || 'test-buyer-ref',
        packages: args.packages || [],
        promoted_offering: args.promoted_offering || 'Test offering',
        start_time: args.start_time || new Date().toISOString(),
        end_time: args.end_time || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        budget: args.budget || { total: 1000, currency: 'USD' }
      });
      break;
    case 'sync_creatives':
      fluentResponse = await agent.syncCreatives({
        creatives: args.creatives,
        patch: args.patch,
        dry_run: args.dry_run
      });
      break;
    case 'list_creatives':
      fluentResponse = await agent.listCreatives({
        filters: args.filters,
        sort: args.sort,
        pagination: args.pagination
      });
      break;
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
  
  return adaptResponseToLegacyFormat(fluentResponse);
}

async function callToolOnAgents(agentIds: string[], toolName: string, args: any): Promise<TestResult[]> {
  const agents = adcpClient.agents(agentIds);
  
  let fluentResponses;
  switch (toolName) {
    case 'get_products':
      fluentResponses = await agents.getProducts({
        ...(args.brief && { brief: args.brief }),
        promoted_offering: args.promoted_offering || 'Test offering for AdCP testing'
      });
      break;
    case 'list_creative_formats':
      fluentResponses = await agents.listCreativeFormats({
        ...(args.type && { type: args.type }),
        ...(args.category && { category: args.category }),
        ...(args.format_ids && { format_ids: args.format_ids })
      });
      break;
    case 'sync_creatives':
      fluentResponses = await agents.syncCreatives({
        creatives: args.creatives,
        patch: args.patch,
        dry_run: args.dry_run
      });
      break;
    case 'list_creatives':
      fluentResponses = await agents.listCreatives({
        filters: args.filters,
        sort: args.sort,
        pagination: args.pagination
      });
      break;
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
  
  return fluentResponses.map(adaptResponseToLegacyFormat);
}

// Register plugins
app.register(fastifyCors, {
  origin: process.env.NODE_ENV === 'development' ? true : ['https://testing.adcontextprotocol.org', 'https://adcp-testing.fly.dev'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
});

// Configure static file serving - different paths for dev vs production
const publicPath = process.env.NODE_ENV === 'development' 
  ? path.join(__dirname, '../../src/public')  // from src/server/ to src/public/ 
  : path.join(__dirname, '../public'); // dist/public for production (go up from dist/server to dist/public)

console.log(`📁 Static files path: ${publicPath}`);

app.register(fastifyStatic, {
  root: publicPath,
  prefix: '/'
});

// Health check endpoint
app.get('/health', async () => {
  return { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    node_env: process.env.NODE_ENV || 'development'
  };
});

// API Routes

// Get list of available agents
app.get<{ Reply: ApiResponse<AgentListResponse> }>('/api/agents', async (request, reply) => {
  try {
    const agents = adcpClient.getAgents();
    return {
      success: true,
      data: {
        agents,
        total: agents.length
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    app.log.error('Failed to get agent list: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Test multiple agents in parallel
app.post<{ 
  Body: TestRequest;
  Reply: ApiResponse<TestResponse>;
}>('/api/test', async (request, reply) => {
  try {
    const { agents, brief, promoted_offering, tool_name } = request.body as TestRequest;
    
    if (!agents || agents.length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'At least one agent must be provided',
        timestamp: new Date().toISOString()
      };
    }

    if (!brief || brief.trim().length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'Brief is required',
        timestamp: new Date().toISOString()
      };
    }

    app.log.info(`Testing ${agents.length} agents with brief: "${brief.substring(0, 100)}..."`);
    
    const startTime = Date.now();
    const agentIds = agents.map((a: AgentConfig) => a.id);
    const args = {
      brief,
      ...(promoted_offering && { promoted_offering }),
      ...(tool_name && { tool_name })
    };
    const results = await callToolOnAgents(agentIds, tool_name || 'get_products', args);
    const totalTime = Date.now() - startTime;

    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;
    const avgResponseTime = results.length > 0 
      ? results.reduce((sum, r) => sum + r.response_time_ms, 0) / results.length 
      : 0;

    return {
      success: true,
      data: {
        test_id: `test_${Date.now()}`,
        results,
        summary: {
          total_agents: results.length,
          successful,
          failed,
          average_response_time_ms: Math.round(avgResponseTime)
        }
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    app.log.error('Failed to test agents: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Test a single agent
app.post<{
  Params: { agentId: string };
  Body: { brief: string; promoted_offering?: string; tool_name?: string };
  Reply: ApiResponse<TestResponse>;
}>('/api/agent/:agentId/test', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const { brief, promoted_offering, tool_name } = request.body;

    if (!brief || brief.trim().length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'Brief is required',
        timestamp: new Date().toISOString()
      };
    }

    app.log.info(`Testing single agent ${agentId} with brief: "${brief.substring(0, 100)}..."`);
    
    const args = {
      brief,
      ...(promoted_offering && { promoted_offering })
    };
    const result = await callToolOnAgent(agentId, tool_name || 'get_products', args);

    return {
      success: true,
      data: {
        test_id: `test_${Date.now()}`,
        results: [result],
        summary: {
          total_agents: 1,
          successful: result.success ? 1 : 0,
          failed: result.success ? 0 : 1,
          average_response_time_ms: result.response_time_ms
        }
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    app.log.error('Failed to test single agent: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});


// Additional endpoints for main page (index.html)
app.get('/api/sales/agents', async (request, reply) => {
  // Same as /api/agents but with different path for main page
  try {
    const agents = adcpClient.getAgents();
    return {
      success: true,
      data: {
        agents,
        total: agents.length
      },
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    app.log.error('Failed to get sales agents: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});


// Helper function to extract data from nested A2A/MCP responses
function extractResponseData(result: any): any {
  // Check multiple possible nested structures
  
  // 1. Check if this is an A2A response with result.artifacts
  if (result?.artifacts && Array.isArray(result.artifacts)) {
    const artifacts = result.artifacts;
    if (artifacts.length > 0 && artifacts[0].parts && artifacts[0].parts.length > 0) {
      const data = artifacts[0].parts[0].data;
      return {
        ...result,
        products: data?.products || [],
        formats: data?.formats || [],
        message: data?.message || 'Response processed'
      };
    }
  }
  
  // 2. Check if this is nested under result.result.artifacts (double nesting)
  if (result?.result?.artifacts && Array.isArray(result.result.artifacts)) {
    const artifacts = result.result.artifacts;
    if (artifacts.length > 0 && artifacts[0].parts && artifacts[0].parts.length > 0) {
      const data = artifacts[0].parts[0].data;
      return {
        ...result,
        products: data?.products || [],
        formats: data?.formats || [],
        message: data?.message || 'Response processed'
      };
    }
  }
  
  // 3. Check if this is nested under result.data.result.artifacts
  if (result?.data?.result?.artifacts && Array.isArray(result.data.result.artifacts)) {
    const artifacts = result.data.result.artifacts;
    if (artifacts.length > 0 && artifacts[0].parts && artifacts[0].parts.length > 0) {
      const data = artifacts[0].parts[0].data;
      return {
        ...result,
        products: data?.products || [],
        formats: data?.formats || [],
        message: data?.message || 'Response processed'
      };
    }
  }
  
  // 4. Check if data is directly available
  if (result?.products || result?.formats) {
    return result;
  }
  
  // 5. Check if data is under result.data
  if (result?.data?.products || result?.data?.formats) {
    return {
      ...result,
      products: result.data.products || [],
      formats: result.data.formats || [],
      message: result.data.message || 'Response processed'
    };
  }
  
  // 6. Check for MCP toolResponse structure
  if (result?.toolResponse) {
    // MCP responses may have the data directly in toolResponse
    if (result.toolResponse?.products || result.toolResponse?.formats) {
      return {
        ...result.toolResponse,
        message: result.toolResponse.message || 'MCP response processed'
      };
    }
    // Or nested under toolResponse.result
    if (result.toolResponse?.result) {
      return {
        ...result.toolResponse.result,
        products: result.toolResponse.result.products || [],
        formats: result.toolResponse.result.formats || [],
        message: result.toolResponse.result.message || 'MCP response processed'
      };
    }
    // Or the toolResponse itself might be the data
    return result.toolResponse;
  }
  
  // 7. Check for note/error structure (MCP error response)
  if (result?.note || result?.error) {
    return {
      products: [],
      formats: [],
      message: result.note || result.error || 'MCP response received',
      error: result.error
    };
  }
  
  // Return the original result if we can't extract anything
  return result || {};
}

app.post('/api/sales/agents/:agentId/query', async (request, reply) => {
  // Individual agent query endpoint for main page
  try {
    const { agentId } = request.params as { agentId: string };
    const body = request.body as any;
    
    // Convert single agent query to the standard test format
    const agents = adcpClient.getAgents();
    const agent = agents.find(a => a.id === agentId);
    
    if (!agent) {
      reply.code(404);
      return {
        success: false,
        error: `Agent with ID ${agentId} not found`,
        timestamp: new Date().toISOString()
      };
    }

    // Use the existing testAgents function with tool-specific parameters
    app.log.info(`Query endpoint received body:`, body);
    
    const toolName = body.tool;
    if (!toolName) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required parameter: tool'
      });
    }
    app.log.info(`Tool name: ${toolName}`);
    
    const brief = body.brief || body.brandStory || body.message || 'Test query';
    const promotedOffering = body.promoted_offering || body.offering;
    
    // Pass tool-specific params if provided
    const toolParams = body.params || {};
    const args = {
      brief,
      ...(promotedOffering && { promoted_offering: promotedOffering }),
      ...toolParams
    };
    const results = await callToolOnAgents([agent.id], toolName, args);
    
    // Extract the data from the nested response structure
    const extractedData = extractResponseData(results[0].data) || {};
    
    // Debug: Log the results structure
    app.log.info('Results structure: ' + JSON.stringify({
      success: results[0].success,
      error: results[0].error,
      debug_logs_length: results[0].debug_logs ? results[0].debug_logs.length : 'undefined',
      debug_logs_sample: results[0].debug_logs ? results[0].debug_logs.slice(0, 2) : 'undefined'
    }));
    
    // Pass through authentic debug logs only - NO SYNTHETIC FALLBACKS
    let debugLogs: any[] = [];
    
    if (results[0].debug_logs && results[0].debug_logs.length > 0) {
      // Pass through the authentic debug logs directly
      debugLogs = results[0].debug_logs;
    }
    // If no debug logs exist, that's fine - we don't create fake ones
    
    // Format the response to match what the UI expects
    const response = {
      success: true,
      // The UI expects inventory_response with products directly inside
      inventory_response: {
        products: extractedData.products || [],
        formats: extractedData.formats || [],
        message: extractedData.message || 'Response processed',
        // Include the original result structure for backward compatibility
        result: results[0].data
      },
      // Also include at the top level for simpler access
      products: extractedData.products || [],
      formats: extractedData.formats || [],
      // Include debug info - always have something to show
      debug_logs: debugLogs,
      validation: results[0].validation,
      timestamp: new Date().toISOString()
    };
    
    return response;
  } catch (error) {
    app.log.error('Failed to query agent: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Serve the main UI at root
app.get('/', async (request, reply) => {
  return reply.sendFile('index.html');
});


// Add some fallback routes for missing endpoints that might be expected
app.get('/agents', async (request, reply) => {
  // Redirect to proper API endpoint
  reply.redirect('/api/agents');
});

app.get('/standard', async (request, reply) => {
  // Formats are now retrieved from agents, not a separate endpoint
  reply.redirect('/');
});

// Removed unused /query endpoint that was causing 404 errors

// Error handler
app.setErrorHandler((error, request, reply) => {
  app.log.error('Unhandled error: ' + error.message);
  reply.code(500).send({
    success: false,
    error: 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// AdAgents.json Management Endpoints
const adagentsManager = new AdAgentsManager();

// Validate domain's adagents.json
app.post<{
  Body: ValidateAdAgentsRequest;
  Reply: ApiResponse<ValidateAdAgentsResponse>;
}>('/api/adagents/validate', async (request, reply) => {
  try {
    const { domain } = request.body as ValidateAdAgentsRequest;
    
    if (!domain || domain.trim().length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'Domain is required',
        timestamp: new Date().toISOString()
      };
    }

    app.log.info(`Validating adagents.json for domain: ${domain}`);
    
    // Validate the domain's adagents.json
    const validation = await adagentsManager.validateDomain(domain);
    
    let agentCards = undefined;
    
    // If adagents.json is found and has agents, validate their cards
    if (validation.valid && validation.raw_data?.authorized_agents?.length > 0) {
      app.log.info(`Validating ${validation.raw_data.authorized_agents.length} agent cards`);
      agentCards = await adagentsManager.validateAgentCards(validation.raw_data.authorized_agents);
    }

    return {
      success: true,
      data: {
        domain: validation.domain,
        found: validation.status_code === 200,
        validation,
        agent_cards: agentCards
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    app.log.error('Failed to validate domain: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Create adagents.json file
app.post<{
  Body: CreateAdAgentsRequest;
  Reply: ApiResponse<CreateAdAgentsResponse>;
}>('/api/adagents/create', async (request, reply) => {
  try {
    const { authorized_agents, include_schema = true, include_timestamp = true } = request.body as CreateAdAgentsRequest;
    
    if (!authorized_agents || !Array.isArray(authorized_agents)) {
      reply.code(400);
      return {
        success: false,
        error: 'authorized_agents array is required',
        timestamp: new Date().toISOString()
      };
    }

    if (authorized_agents.length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'At least one authorized agent is required',
        timestamp: new Date().toISOString()
      };
    }

    app.log.info(`Creating adagents.json with ${authorized_agents.length} agents`);
    
    // Validate the proposed structure
    const validation = adagentsManager.validateProposed(authorized_agents);
    
    if (!validation.valid) {
      reply.code(400);
      return {
        success: false,
        error: `Validation failed: ${validation.errors.map((e: any) => e.message).join(', ')}`,
        timestamp: new Date().toISOString()
      };
    }

    // Create the adagents.json content
    const adagentsJson = adagentsManager.createAdAgentsJson(
      authorized_agents, 
      include_schema, 
      include_timestamp
    );

    return {
      success: true,
      data: {
        success: true,
        adagents_json: adagentsJson,
        validation
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    app.log.error('Failed to create adagents.json: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});

// Validate agent cards only (utility endpoint)
app.post<{
  Body: { agent_urls: string[] };
  Reply: ApiResponse<{ agent_cards: any[] }>;
}>('/api/adagents/validate-cards', async (request, reply) => {
  try {
    const { agent_urls } = request.body;
    
    if (!agent_urls || !Array.isArray(agent_urls) || agent_urls.length === 0) {
      reply.code(400);
      return {
        success: false,
        error: 'agent_urls array with at least one URL is required',
        timestamp: new Date().toISOString()
      };
    }

    app.log.info(`Validating ${agent_urls.length} agent cards`);
    
    const agents = agent_urls.map(url => ({ url, authorized_for: 'validation' }));
    const agentCards = await adagentsManager.validateAgentCards(agents);

    return {
      success: true,
      data: {
        agent_cards: agentCards
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    app.log.error('Failed to validate agent cards: ' + (error instanceof Error ? error.message : String(error)));
    reply.code(500);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    };
  }
});


// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '8080');
    const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
    
    await app.listen({ 
      port, 
      host 
    });
    
    app.log.info(`🚀 AdCP Testing Framework running on http://${host}:${port}`);
    app.log.info(`📋 API available at http://${host}:${port}/api`);
    app.log.info(`🌐 UI available at http://${host}:${port}`);
  } catch (err) {
    app.log.error('Failed to start server: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
};

// Handle graceful shutdown
let shutdownInProgress = false;

async function gracefulShutdown(signal: string) {
  if (shutdownInProgress) {
    app.log.warn(`Received ${signal} but shutdown already in progress, forcing exit...`);
    process.exit(1);
  }
  
  shutdownInProgress = true;
  app.log.info(`Received ${signal}, shutting down gracefully...`);
  
  try {
    // Set a timeout for forceful shutdown
    const forceShutdownTimer = setTimeout(() => {
      app.log.error('Graceful shutdown timed out, forcing exit...');
      process.exit(1);
    }, 10000); // 10 second timeout
    
    await app.close();
    clearTimeout(forceShutdownTimer);
    app.log.info('Server closed successfully');
    process.exit(0);
  } catch (error) {
    app.log.error(`Error during graceful shutdown: ${error}`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
  start();
}

export default app;