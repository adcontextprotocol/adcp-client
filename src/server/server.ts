import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { 
  ADCPMultiAgentClient, 
  ConfigurationManager, 
  getStandardFormats,
  type TaskResult,
  type InputHandler,
  ADCP_STATUS,
  InputRequiredError
} from '../lib';
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

// Initialize ADCP client with configured agents  
const configuredAgents = ConfigurationManager.loadAgentsFromEnv();
const adcpClient = new ADCPMultiAgentClient(configuredAgents);

// Storage for active tasks and conversations
const activeTasks = new Map<string, { 
  taskId: string; 
  agentId: string; 
  toolName: string; 
  continuation?: any; // Will store deferred/submitted continuation data 
  status: string;
  startTime: Date;
}>();
const conversations = new Map<string, any[]>();

// Helper function to build tool-appropriate parameters
function buildToolArgs(toolName: string, brief?: string, promotedOffering?: string, additionalParams: any = {}): any {
  const args: any = {};
  
  // Tools that accept brief parameter
  const briefAcceptingTools = [
    'get_products', 
    'create_media_buy', 
    'update_media_buy',
    'sync_creatives',
    'get_media_buy_delivery',
    'provide_performance_feedback',
    'get_signals',
    'activate_signal'
  ];
  
  // Tools that accept promoted_offering parameter  
  const offeringAcceptingTools = [
    'get_products',
    'create_media_buy'
  ];
  
  // Only add parameters that the tool accepts
  if (briefAcceptingTools.includes(toolName) && brief) {
    args.brief = brief;
  }
  
  if (offeringAcceptingTools.includes(toolName) && promotedOffering) {
    args.promoted_offering = promotedOffering;
  }
  
  // Always merge in any explicitly provided tool params
  Object.assign(args, additionalParams);
  
  return args;
}

// Helper function to convert TaskResult to legacy TestResult format for backward compatibility
function adaptTaskResultToLegacyFormat(taskResult: TaskResult<any>, agentId: string): TestResult & { 
  status?: string; 
  inputRequest?: any; 
  continuation?: any; 
  taskId?: string; 
  webhookUrl?: string;
} {
  const agent = adcpClient.getAgentConfigs().find(a => a.id === agentId);
  return {
    agent_id: agentId,
    agent_name: agent?.name || agentId,
    success: taskResult.success,
    response_time_ms: taskResult.metadata.responseTimeMs || 0,
    data: taskResult.success ? taskResult.data : undefined,
    error: taskResult.success ? undefined : taskResult.error,
    timestamp: new Date().toISOString(),
    debug_logs: taskResult.debug_logs || [],
    // New async fields
    status: taskResult.status,
    inputRequest: taskResult.status === 'deferred' ? taskResult.deferred : undefined,
    continuation: taskResult.deferred || taskResult.submitted,
    taskId: taskResult.submitted?.taskId,
    webhookUrl: taskResult.submitted?.webhookUrl
  };
}

// Default input handler for testing - allows manual interaction via UI
function createDefaultInputHandler(): InputHandler {
  return async (request) => {
    // For testing UI, we'll defer all input requests to be handled via the UI
    return { defer: true };
  };
}

async function executeTaskOnAgent(
  agentId: string,
  toolName: string,
  args: any,
  inputHandler?: InputHandler
): Promise<TestResult & { status?: string; inputRequest?: any; continuation?: any; taskId?: string; webhookUrl?: string; }> {
  try {
    const client = adcpClient.agent(agentId);
    const handler = inputHandler || createDefaultInputHandler();

    // Use typed methods instead of generic executeTask
    let result: TaskResult<any>;

    switch (toolName) {
      case 'get_products':
        result = await client.getProducts(args, handler);
        break;
      case 'list_creative_formats':
        result = await client.listCreativeFormats(args, handler);
        break;
      case 'create_media_buy':
        result = await client.createMediaBuy(args, handler);
        break;
      case 'update_media_buy':
        result = await client.updateMediaBuy(args, handler);
        break;
      case 'sync_creatives':
        result = await client.syncCreatives(args, handler);
        break;
      case 'list_creatives':
        result = await client.listCreatives(args, handler);
        break;
      case 'get_media_buy_delivery':
        result = await client.getMediaBuyDelivery(args, handler);
        break;
      case 'list_authorized_properties':
        result = await client.listAuthorizedProperties(args, handler);
        break;
      case 'provide_performance_feedback':
        result = await client.providePerformanceFeedback(args, handler);
        break;
      case 'get_signals':
        result = await client.getSignals(args, handler);
        break;
      case 'activate_signal':
        result = await client.activateSignal(args, handler);
        break;
      default:
        throw new Error(`Unknown or unsupported tool: ${toolName}`);
    }

    // Store active task if it's deferred or submitted
    if (result.status === 'deferred' || result.status === 'submitted') {
      const taskId = result.submitted?.taskId || `deferred-${Date.now()}`;
      activeTasks.set(taskId, {
        taskId,
        agentId,
        toolName,
        continuation: result.deferred || result.submitted,
        status: result.status,
        startTime: new Date()
      });
    }

    return adaptTaskResultToLegacyFormat(result as TaskResult<any>, agentId);
  } catch (error) {
    app.log.error({ error }, 'Error executing task');

    // Handle InputRequiredError specifically
    if (error instanceof InputRequiredError) {
      return adaptTaskResultToLegacyFormat({
        success: false,
        status: 'input-required',
        error: 'Input required but no handler provided',
        metadata: { responseTimeMs: 0, taskId: '', taskName: '', agent: { id: agentId, name: '', protocol: 'mcp' as const }, timestamp: '', clarificationRounds: 0 },
        debugLogs: []
      } as any as TaskResult<any>, agentId);
    }

    return {
      agent_id: agentId,
      agent_name: adcpClient.getAgentConfigs().find(a => a.id === agentId)?.name || agentId,
      success: false,
      response_time_ms: 0,
      data: undefined,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
      debug_logs: []
    };
  }
}

async function executeTaskOnMultipleAgents(
  agentIds: string[], 
  toolName: string, 
  args: any,
  inputHandler?: InputHandler
): Promise<TestResult[]> {
  // Execute on each agent individually to get proper async support
  const promises = agentIds.map(agentId => 
    executeTaskOnAgent(agentId, toolName, args, inputHandler)
  );
  
  return Promise.all(promises);
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
    const agents = adcpClient.getAgentConfigs();
    return reply.send({
      success: true,
      data: {
        agents,
        total: agents.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error('Failed to get agent list: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
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
      return reply.code(400).send({
        success: false,
        error: 'At least one agent must be provided',
        timestamp: new Date().toISOString()
      });
    }

    if (!brief || brief.trim().length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'Brief is required',
        timestamp: new Date().toISOString()
      });
    }

    app.log.info(`Testing ${agents.length} agents with brief: "${brief.substring(0, 100)}..."`);
    
    const startTime = Date.now();
    const agentIds = agents.map((a: AgentConfig) => a.id);
    const args = buildToolArgs(tool_name || 'get_products', brief, promoted_offering, tool_name ? { tool_name } : {});
    const results = await Promise.all(
      agentIds.map((agentId: string) => executeTaskOnAgent(agentId, tool_name || 'get_products', args))
    );
    const totalTime = Date.now() - startTime;

    const successful = results.filter(r => r.success).length;
    const failed = results.length - successful;
    const avgResponseTime = results.length > 0 
      ? results.reduce((sum: number, r: any) => sum + r.response_time_ms, 0) / results.length 
      : 0;

    return reply.send({
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
    });
  } catch (error) {
    app.log.error('Failed to test agents: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
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
      return reply.code(400).send({
        success: false,
        error: 'Brief is required',
        timestamp: new Date().toISOString()
      });
    }

    app.log.info(`Testing single agent ${agentId} with brief: "${brief.substring(0, 100)}..."`);
    
    const args = buildToolArgs(tool_name || 'get_products', brief, promoted_offering);
    const result = await executeTaskOnAgent(agentId, tool_name || 'get_products', args);

    return reply.send({
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
    });
  } catch (error) {
    app.log.error('Failed to test single agent: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});


// Additional endpoints for main page (index.html)
app.get('/api/sales/agents', async (request, reply) => {
  // Same as /api/agents but with different path for main page
  try {
    const agents = adcpClient.getAgentConfigs();
    return reply.send({
      success: true,
      data: {
        agents,
        total: agents.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error('Failed to get sales agents: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
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
      return Object.assign({}, result, {
        products: data?.products || [],
        formats: data?.formats || [],
        message: data?.message || 'Response processed'
      });
    }
  }
  
  // 2. Check if this is nested under result.result.artifacts (double nesting)
  if (result?.result?.artifacts && Array.isArray(result.result.artifacts)) {
    const artifacts = result.result.artifacts;
    if (artifacts.length > 0 && artifacts[0].parts && artifacts[0].parts.length > 0) {
      const data = artifacts[0].parts[0].data;
      return Object.assign({}, result, {
        products: data?.products || [],
        formats: data?.formats || [],
        message: data?.message || 'Response processed'
      });
    }
  }
  
  // 3. Check if this is nested under result.data.result.artifacts
  if (result?.data?.result?.artifacts && Array.isArray(result.data.result.artifacts)) {
    const artifacts = result.data.result.artifacts;
    if (artifacts.length > 0 && artifacts[0].parts && artifacts[0].parts.length > 0) {
      const data = artifacts[0].parts[0].data;
      return Object.assign({}, result, {
        products: data?.products || [],
        formats: data?.formats || [],
        message: data?.message || 'Response processed'
      });
    }
  }
  
  // 4. Check if data is directly available
  if (result?.products || result?.formats) {
    return result;
  }
  
  // 5. Check if data is under result.data
  if (result?.data?.products || result?.data?.formats) {
    return Object.assign({}, result, {
      products: result.data.products || [],
      formats: result.data.formats || [],
      message: result.data.message || 'Response processed'
    });
  }
  
  // 6. Check for MCP toolResponse structure
  if (result?.toolResponse) {
    // MCP responses may have the data directly in toolResponse
    if (result.toolResponse?.products || result.toolResponse?.formats) {
      return Object.assign({}, result.toolResponse, {
        message: result.toolResponse.message || 'MCP response processed'
      });
    }
    // Or nested under toolResponse.result
    if (result.toolResponse?.result) {
      return Object.assign({}, result.toolResponse.result, {
        products: result.toolResponse.result.products || [],
        formats: result.toolResponse.result.formats || [],
        message: result.toolResponse.result.message || 'MCP response processed'
      });
    }
    // Or the toolResponse itself might be the data
    return result.toolResponse;
  }
  
  // 7. Check for MCP structuredContent (only source for data)
  if (result?.structuredContent) {
    if (result.structuredContent.products || result.structuredContent.formats) {
      // Extract text content as informational message for user
      let textMessage = `Found ${result.structuredContent.formats?.length || result.structuredContent.products?.length || 0} items from agent`;
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content.find((item: any) => item.type === 'text');
        if (textContent?.text) {
          // Use text as message only if it's not a JSON dump
          try {
            JSON.parse(textContent.text);
            // It's JSON, keep the count message
          } catch (e) {
            // Not JSON, use as user message
            textMessage = textContent.text.length > 200 ? 
              textContent.text.substring(0, 200) + '...' : 
              textContent.text;
          }
        }
      }
      
      return {
        products: result.structuredContent.products || [],
        formats: result.structuredContent.formats || [],
        message: textMessage
      };
    }
  }
  
  // 9. Check for note/error structure (MCP error response)
  if (result?.note || result?.error) {
    const response = {
      products: [],
      formats: [],
      message: result.note || result.error || 'MCP response received',
      error: result.error
    };
    return response;
  }
  
  // Return the original result if we can't extract anything
  return result || {};
}

// ==== SPECIFIC TOOL ENDPOINTS ====
// Clean, typed REST endpoints that directly call client library methods

// Get Products
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/get-products', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.getProducts(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'Get products error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// List Creative Formats
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/list-creative-formats', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.listCreativeFormats(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'List creative formats error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Create Media Buy
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/create-media-buy', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.createMediaBuy(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'Create media buy error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Update Media Buy
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/update-media-buy', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.updateMediaBuy(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'Update media buy error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Sync Creatives
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/sync-creatives', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.syncCreatives(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'Sync creatives error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// List Creatives
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/list-creatives', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.listCreatives(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'List creatives error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get Media Buy Delivery
app.post<{
  Params: { agentId: string };
}>('/api/agents/:agentId/get-media-buy-delivery', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const params = request.body as any;

    const client = adcpClient.agent(agentId);
    const result = await client.getMediaBuyDelivery(params, createDefaultInputHandler());

    return reply.send({
      success: result.success,
      data: result.data,
      error: result.error,
      metadata: result.metadata,
      debug_logs: result.debug_logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    app.log.error({ error }, 'Get media buy delivery error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ==== NEW ASYNC API ENDPOINTS ====

// Execute task with full async support
app.post<{
  Params: { agentId: string };
  Body: { tool: string; params: any; inputHandler?: 'defer' | 'approve' | 'custom' };
}>('/api/agents/:agentId/execute', async (request, reply) => {
  try {
    const { agentId } = request.params;
    const { tool, params, inputHandler } = request.body;

    // Check if agent exists
    const agents = adcpClient.getAgentConfigs();
    const agent = agents.find(a => a.id === agentId);
    
    if (!agent) {
      return reply.code(404).send({
        success: false,
        error: `Agent with ID ${agentId} not found`
      });
    }

    if (!tool) {
      return reply.code(400).send({
        success: false,
        error: 'Missing required parameter: tool'
      });
    }

    // Create input handler based on request
    let handler: InputHandler | undefined;
    if (inputHandler === 'approve') {
      handler = async () => ({ approve: true });
    } else if (inputHandler === 'defer') {
      handler = async () => ({ defer: true });
    } // else use default defer handler

    const result = await executeTaskOnAgent(agentId, tool, params || {}, handler);
    
    return reply.send({
      success: result.success,
      status: result.status,
      data: result.data,
      error: result.error,
      taskId: result.taskId,
      webhookUrl: result.webhookUrl,
      inputRequest: result.inputRequest,
      continuation: result.continuation,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    app.log.error({ error }, 'Execute task error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get task status
app.get('/api/tasks/:taskId', async (request, reply) => {
  try {
    const { taskId } = request.params as { taskId: string };
    
    const task = activeTasks.get(taskId);
    if (!task) {
      return reply.code(404).send({
        success: false,
        error: `Task with ID ${taskId} not found`
      });
    }

    // For submitted tasks, we'd normally poll the actual task status
    // For this demo, we'll simulate some task progression
    let status = task.status;
    if (task.status === 'submitted') {
      const elapsedMs = Date.now() - task.startTime.getTime();
      if (elapsedMs > 10000) { // After 10 seconds, mark as completed
        status = 'completed';
        activeTasks.delete(taskId); // Clean up completed task
      }
    }

    return reply.send({
      success: true,
      taskId: task.taskId,
      agentId: task.agentId,
      toolName: task.toolName,
      status: status,
      startTime: task.startTime.toISOString(),
      continuation: task.continuation
    });

  } catch (error) {
    app.log.error({ error }, 'Get task status error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Continue deferred task with input
app.post('/api/tasks/:taskId/continue', async (request, reply) => {
  try {
    const { taskId } = request.params as { taskId: string };
    const { input } = request.body as { input: any };
    
    const task = activeTasks.get(taskId);
    if (!task || task.status !== 'deferred' || !task.continuation) {
      return reply.code(404).send({
        success: false,
        error: `Deferred task with ID ${taskId} not found`
      });
    }

    // Resume the deferred task - use the main client for this
    // TODO: This needs to be implemented properly with the continuation token system
    // For now, simulate resuming by re-executing the task with the input
    const result = await executeTaskOnAgent(
      task.agentId, 
      task.toolName, 
      { ...input, continued: true }
    );

    // Clean up the task
    activeTasks.delete(taskId);

    return result; // executeTaskOnAgent already returns the adapted format

  } catch (error) {
    app.log.error({ error }, 'Continue task error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get conversation history
app.get('/api/agents/:agentId/conversation', async (request, reply) => {
  try {
    const { agentId } = request.params as { agentId: string };
    
    // TODO: Implement proper conversation history retrieval
    // For now, return empty conversation as this needs to be implemented
    const history: any[] = [];
    
    return reply.send({
      success: true,
      agentId,
      conversation: history,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    app.log.error({ error }, 'Get conversation error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// List active tasks
app.get('/api/tasks', async (request, reply) => {
  try {
    const tasks = Array.from(activeTasks.values()).map(task => ({
      taskId: task.taskId,
      agentId: task.agentId,
      toolName: task.toolName,
      status: task.status,
      startTime: task.startTime.toISOString()
    }));

    return reply.send({
      success: true,
      tasks,
      total: tasks.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    app.log.error({ error }, 'List tasks error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ==== WEBHOOK & NOTIFICATION ENDPOINTS ====

// Storage for webhook registrations
const webhookRegistrations = new Map<string, {
  agentId: string;
  webhookUrl: string;
  taskTypes?: string[];
  createdAt: Date;
}>();

// Task notification listeners (for real-time updates)
const taskNotificationCallbacks = new Map<string, (task: any) => void>();

/**
 * Register webhook for task notifications
 */
app.post<{
  Body: {
    agentId: string;
    webhookUrl: string;
    taskTypes?: string[];
  };
}>('/api/webhooks/register', async (request, reply) => {
  try {
    const { agentId, webhookUrl, taskTypes } = request.body;
    
    if (!agentId || !webhookUrl) {
      return reply.code(400).send({
        success: false,
        error: 'agentId and webhookUrl are required'
      });
    }

    const registrationId = `${agentId}-${Date.now()}`;
    webhookRegistrations.set(registrationId, {
      agentId,
      webhookUrl,
      taskTypes,
      createdAt: new Date()
    });

    app.log.info(`Webhook registered for agent ${agentId}: ${webhookUrl}`);

    return reply.send({
      success: true,
      registrationId,
      message: 'Webhook registered successfully'
    });

  } catch (error) {
    app.log.error({ error }, 'Register webhook error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Receive webhook callback from agents
 */
app.post<{
  Params: { token: string };
  Body: any;
}>('/api/webhooks/callback/:token', async (request, reply) => {
  try {
    const { token } = request.params;
    const payload = request.body as any;
    
    app.log.info({ token, payload }, 'Webhook callback received');
    
    // Find the task that this webhook refers to
    const task = activeTasks.get(token) || activeTasks.get(payload.taskId);
    
    if (task) {
      // Update task status
      task.status = payload.status || 'completed';
      if (payload.result) {
        task.continuation = { result: payload.result };
      }
      if (payload.error) {
        task.status = 'failed';
        task.continuation = { error: payload.error };
      }
      
      // Notify any listeners
      taskNotificationCallbacks.forEach(callback => {
        try {
          callback({
            taskId: task.taskId,
            agentId: task.agentId,
            toolName: task.toolName,
            status: task.status,
            result: task.continuation?.result,
            error: task.continuation?.error,
            updatedAt: new Date().toISOString()
          });
        } catch (err) {
          app.log.error({ err }, 'Task notification callback error');
        }
      });
      
      app.log.info(`Task ${task.taskId} updated via webhook: ${task.status}`);
    }
    
    return reply.send({
      success: true,
      message: 'Webhook processed successfully'
    });

  } catch (error) {
    app.log.error({ error }, 'Webhook callback error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Unregister webhook
 */
app.delete<{
  Params: { registrationId: string };
}>('/api/webhooks/:registrationId', async (request, reply) => {
  try {
    const { registrationId } = request.params;
    
    const removed = webhookRegistrations.delete(registrationId);
    
    if (removed) {
      app.log.info(`Webhook unregistered: ${registrationId}`);
      return reply.send({
        success: true,
        message: 'Webhook unregistered successfully'
      });
    } else {
      return reply.code(404).send({
        success: false,
        error: 'Webhook registration not found'
      });
    }

  } catch (error) {
    app.log.error({ error }, 'Unregister webhook error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * List webhook registrations
 */
app.get('/api/webhooks', async (request, reply) => {
  try {
    const registrations = Array.from(webhookRegistrations.entries()).map(([id, reg]) => ({
      id,
      ...reg,
      createdAt: reg.createdAt.toISOString()
    }));

    return reply.send({
      success: true,
      webhooks: registrations,
      total: registrations.length
    });

  } catch (error) {
    app.log.error({ error }, 'List webhooks error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Enhanced task list endpoint with more details
 */
app.get('/api/tasks/detailed', async (request, reply) => {
  try {
    const tasks = Array.from(activeTasks.values()).map(task => ({
      taskId: task.taskId,
      agentId: task.agentId,
      toolName: task.toolName,
      status: task.status,
      startTime: task.startTime.toISOString(),
      hasWebhook: Array.from(webhookRegistrations.values())
        .some(reg => reg.agentId === task.agentId),
      result: task.continuation?.result,
      error: task.continuation?.error
    }));

    return reply.send({
      success: true,
      tasks,
      total: tasks.length,
      timestamp: new Date().toISOString(),
      summary: {
        byStatus: tasks.reduce((acc: any, task) => {
          acc[task.status] = (acc[task.status] || 0) + 1;
          return acc;
        }, {}),
        byAgent: tasks.reduce((acc: any, task) => {
          acc[task.agentId] = (acc[task.agentId] || 0) + 1;
          return acc;
        }, {})
      }
    });

  } catch (error) {
    app.log.error({ error }, 'List detailed tasks error');
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ==== END NEW ASYNC API ENDPOINTS ====

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
  reply.status(500).send({
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
      return reply.code(400).send({
        success: false,
        error: 'Domain is required',
        timestamp: new Date().toISOString()
      });
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

    return reply.send({
      success: true,
      data: {
        domain: validation.domain,
        found: validation.status_code === 200,
        validation,
        agent_cards: agentCards
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    app.log.error('Failed to validate domain: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
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
      return reply.code(400).send({
        success: false,
        error: 'authorized_agents array is required',
        timestamp: new Date().toISOString()
      });
    }

    if (authorized_agents.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'At least one authorized agent is required',
        timestamp: new Date().toISOString()
      });
    }

    app.log.info(`Creating adagents.json with ${authorized_agents.length} agents`);
    
    // Validate the proposed structure
    const validation = adagentsManager.validateProposed(authorized_agents);
    
    if (!validation.valid) {
      return reply.code(400).send({
        success: false,
        error: `Validation failed: ${validation.errors.map((e: any) => e.message).join(', ')}`,
        timestamp: new Date().toISOString()
      });
    }

    // Create the adagents.json content
    const adagentsJson = adagentsManager.createAdAgentsJson(
      authorized_agents, 
      include_schema, 
      include_timestamp
    );

    return reply.send({
      success: true,
      data: {
        success: true,
        adagents_json: adagentsJson,
        validation
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    app.log.error('Failed to create adagents.json: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
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
      return reply.code(400).send({
        success: false,
        error: 'agent_urls array with at least one URL is required',
        timestamp: new Date().toISOString()
      });
    }

    app.log.info(`Validating ${agent_urls.length} agent cards`);
    
    const agents = agent_urls.map(url => ({ url, authorized_for: 'validation' }));
    const agentCards = await adagentsManager.validateAgentCards(agents);

    return reply.send({
      success: true,
      data: {
        agent_cards: agentCards
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    app.log.error('Failed to validate agent cards: ' + (error instanceof Error ? error.message : String(error)));
    return reply.code(500).send({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
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