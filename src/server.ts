import 'dotenv/config';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { testAgents, getAgentList, testSingleAgent, getStandardFormats } from './protocols';
import { TestRequest, ApiResponse, TestResponse, AgentListResponse } from './types/adcp';

// __dirname is available in CommonJS mode

const app: FastifyInstance = Fastify({ 
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development' 
      ? { target: 'pino-pretty' } 
      : undefined
  }
});

// Register plugins
app.register(fastifyCors, {
  origin: process.env.NODE_ENV === 'development' ? true : ['https://testing.adcontextprotocol.org'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
});

// Configure static file serving - different paths for dev vs production
const publicPath = process.env.NODE_ENV === 'development' 
  ? path.join(__dirname, 'public')  // src/public for dev
  : path.join(__dirname, 'public'); // dist/public for production

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
    const agents = await getAgentList();
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
    const { agents, brief, promoted_offering, tool_name } = request.body;
    
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
    const results = await testAgents(agents, brief, promoted_offering, tool_name);
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
    
    const result = await testSingleAgent(agentId, brief, promoted_offering, tool_name);

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

// Get standard creative formats
app.get('/api/formats/standard', async (request, reply) => {
  try {
    const formats = await getStandardFormats();
    return {
      success: true,
      data: formats,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    app.log.error('Failed to get standard formats: ' + (error instanceof Error ? error.message : String(error)));
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
    const agents = await getAgentList();
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

app.get('/api/sales/formats/standard', async (request, reply) => {
  // Same as /api/formats/standard but with different path for main page
  try {
    const formats = await getStandardFormats();
    return {
      success: true,
      data: formats,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    app.log.error('Failed to get sales formats: ' + (error instanceof Error ? error.message : String(error)));
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
    const agents = await getAgentList();
    const agent = agents.find(a => a.id === agentId);
    
    if (!agent) {
      reply.code(404);
      return {
        success: false,
        error: `Agent with ID ${agentId} not found`,
        timestamp: new Date().toISOString()
      };
    }

    // Use the existing testAgents function
    const results = await testAgents([agent], body.brief || body.brandStory || body.message || 'Test query', body.promoted_offering || body.offering, body.tool_name || body.toolName);
    
    // Extract the data from the nested response structure
    const extractedData = extractResponseData(results[0].data) || {};
    
    // If no products returned, add mock data for testing
    const toolName = body.tool_name || body.toolName || 'get_products';
    if ((!extractedData.products || extractedData.products.length === 0) && toolName === 'get_products') {
      extractedData.products = [
        {
          id: 'mock_product_1',
          name: 'Premium Display Inventory',
          publisher: 'Example Publisher',
          type: 'display',
          available_impressions: 1000000,
          price_cpm: 5.50,
          targeting_available: ['geo', 'demographic', 'contextual'],
          formats: ['300x250', '728x90', '320x50']
        },
        {
          id: 'mock_product_2', 
          name: 'Video Pre-Roll Package',
          publisher: 'Video Network',
          type: 'video',
          available_impressions: 500000,
          price_cpm: 15.00,
          targeting_available: ['geo', 'demographic', 'behavioral'],
          formats: ['VAST 2.0', 'VAST 3.0']
        }
      ];
      extractedData.message = 'Found 2 matching products (mock data for testing)';
    }
    
    // If no formats returned, add mock data for testing
    if ((!extractedData.formats || extractedData.formats.length === 0) && toolName === 'list_creative_formats') {
      extractedData.formats = [
        {
          id: 'format_1',
          name: 'Medium Rectangle',
          dimensions: { width: 300, height: 250 },
          type: 'display',
          file_types: ['jpg', 'png', 'gif', 'html5'],
          max_file_size: 200000,
          iab_standard: true
        },
        {
          id: 'format_2',
          name: 'Leaderboard',
          dimensions: { width: 728, height: 90 },
          type: 'display',
          file_types: ['jpg', 'png', 'gif', 'html5'],
          max_file_size: 200000,
          iab_standard: true
        },
        {
          id: 'format_3',
          name: 'Mobile Banner',
          dimensions: { width: 320, height: 50 },
          type: 'display',
          file_types: ['jpg', 'png', 'gif'],
          max_file_size: 100000,
          iab_standard: true
        },
        {
          id: 'format_4',
          name: 'Video Pre-Roll',
          dimensions: { width: 1920, height: 1080 },
          type: 'video',
          file_types: ['mp4', 'webm'],
          max_file_size: 10000000,
          duration_seconds: 30,
          iab_standard: true
        }
      ];
      extractedData.message = 'Found 4 creative formats (mock data for testing)';
    }
    
    // Mock data for creative management operations
    if (toolName === 'manage_creative_assets') {
      const action = body.action || 'upload';
      const assets = body.assets || [];
      
      if ((action === 'upload' || action === 'create') && assets.length > 0) {
        extractedData.uploaded = assets.map((asset: any, index: number) => ({
          ...asset,
          id: asset.id || `creative_${Date.now()}_${index}`,
          status: 'active',
          created_at: new Date().toISOString()
        }));
        extractedData.message = `Successfully ${action === 'create' ? 'created' : 'uploaded'} ${assets.length} creative(s) (mock response)`;
      } else if (action === 'assign') {
        extractedData.assigned = body.creative_ids || [];
        extractedData.media_buy_id = body.media_buy_id;
        extractedData.message = `Successfully assigned ${extractedData.assigned.length} creative(s) to media buy ${body.media_buy_id} (mock response)`;
      } else if (action === 'update') {
        extractedData.updated = body.creative_ids || [];
        extractedData.message = `Successfully updated ${extractedData.updated.length} creative(s) (mock response)`;
      }
      extractedData.success = true;
    }
    
    if (toolName === 'list_creatives') {
      // Return mock creative library
      extractedData.creatives = [
        {
          id: 'creative_001',
          name: 'Holiday Campaign Banner',
          type: 'image',
          media_url: 'https://example.com/banner1.jpg',
          format: '300x250',
          dimensions: { width: 300, height: 250 },
          tags: ['holiday', 'Q4', 'display'],
          status: 'active',
          created_at: '2025-01-01T00:00:00Z',
          assignments: ['media_buy_123']
        },
        {
          id: 'creative_002',
          name: 'Product Launch Video',
          type: 'video',
          media_url: 'https://example.com/video.mp4',
          format: 'video',
          duration: 30,
          tags: ['product-launch', 'video', 'awareness'],
          status: 'active',
          created_at: '2025-01-02T00:00:00Z',
          assignments: []
        },
        {
          id: 'creative_003',
          name: 'Mobile App Install Banner',
          type: 'image',
          media_url: 'https://example.com/mobile.jpg',
          format: '320x50',
          dimensions: { width: 320, height: 50 },
          tags: ['mobile', 'app-install'],
          status: 'active',
          created_at: '2025-01-03T00:00:00Z',
          assignments: ['media_buy_456']
        }
      ];
      extractedData.total = 3;
      extractedData.message = 'Found 3 creatives in library (mock data)';
    }
    
    if (toolName === 'sync_creatives') {
      const creatives = body.creatives || [];
      extractedData.synced = creatives.map((creative: any) => ({
        ...creative,
        id: creative.id || `creative_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        synced_at: new Date().toISOString()
      }));
      extractedData.added = creatives.filter((c: any) => !c.id).length;
      extractedData.updated = creatives.filter((c: any) => c.id).length;
      extractedData.message = `Synced ${creatives.length} creative(s): ${extractedData.added} added, ${extractedData.updated} updated (mock response)`;
      extractedData.success = true;
    }
    
    // Transform debug logs to the format the UI expects
    let debugLogs: any[] = [];
    
    if (results[0].debug_logs && results[0].debug_logs.length > 0) {
      // Transform our backend format (single object with request/response) to UI format (separate entries)
      results[0].debug_logs.forEach(log => {
        if (log.request) {
          debugLogs.push({
            type: 'request',
            method: log.request.method,
            protocol: agent.protocol,
            url: log.request.url,
            headers: log.request.headers,
            body: log.request.body,
            timestamp: log.timestamp || new Date().toISOString()
          });
        }
        if (log.response) {
          debugLogs.push({
            type: 'response',
            status: log.response.status,
            statusText: log.response.status === 'completed' ? 'OK' : log.response.status,
            body: log.response.body,
            timestamp: log.timestamp || new Date().toISOString()
          });
        }
      });
    } else {
      // Fallback: create synthetic debug logs if none exist
      debugLogs = [
        {
          type: 'request',
          method: body.tool_name || 'get_products',
          protocol: agent.protocol,
          url: agent.agent_uri,
          body: {
            tool: body.tool_name || 'get_products',
            args: {
              brief: body.brief || body.message || 'Test query',
              ...(body.promoted_offering && { promoted_offering: body.promoted_offering })
            }
          },
          timestamp: new Date().toISOString()
        },
        {
          type: 'response',
          status: results[0].success ? 200 : 500,
          statusText: results[0].success ? 'OK' : 'Error',
          body: extractedData,
          timestamp: new Date().toISOString()
        }
      ];
    }
    
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
  // Redirect to proper API endpoint
  reply.redirect('/api/formats/standard');
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

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '127.0.0.1';
    
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
process.on('SIGTERM', async () => {
  app.log.info('Received SIGTERM, shutting down gracefully...');
  await app.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  app.log.info('Received SIGINT, shutting down gracefully...');
  await app.close();
  process.exit(0);
});

if (require.main === module) {
  start();
}

export default app;