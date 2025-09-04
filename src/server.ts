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

// Serve the main UI at root
app.get('/', async (request, reply) => {
  return reply.sendFile('index.html');
});

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