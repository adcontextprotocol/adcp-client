/**
 * Simple Node.js migration of the working Cloudflare Worker
 * Serves the original sales-agents.html and implements the working backend
 */

require('dotenv/config');
const express = require('express');
const path = require('path');
const cors = require('cors');

// Import the working sales agents handlers (adapted for Node.js)
const { SalesAgentsHandlers } = require('./src/sales-agents-handlers-node');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'development' ? true : ['https://testing.adcontextprotocol.org'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files (now index.html is your original HTML)
app.use(express.static(path.join(__dirname, 'src', 'public')));

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        node_env: process.env.NODE_ENV || 'development'
    });
});

// API Routes - using your original working handlers

// List available agents (original endpoint)
app.get('/api/agents', async (req, res) => {
    try {
        const handler = new SalesAgentsHandlers(process.env);
        const result = await handler.getSalesAgents();
        
        res.json({
            success: true,
            data: {
                agents: result.agents,
                total: result.agents.length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error getting agents:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Test multiple agents (your original working endpoint)
app.post('/api/test', async (req, res) => {
    try {
        const { agents, brief, promoted_offering, tool_name } = req.body;
        
        if (!agents || !Array.isArray(agents) || agents.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Agents array is required'
            });
        }
        
        if (!brief || typeof brief !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Brief is required and must be a string'
            });
        }
        
        const handler = new SalesAgentsHandlers(process.env);
        
        // Query each agent individually and collect results
        const results = [];
        let successful = 0;
        let failed = 0;
        let totalResponseTime = 0;
        
        for (const agent of agents) {
            const startTime = Date.now();
            try {
                let result;
                if (agent.protocol === 'a2a') {
                    result = await handler.queryA2AAgent(agent, brief, promoted_offering, tool_name || 'get_products');
                } else if (agent.protocol === 'mcp') {
                    result = await handler.queryMCPAgent(agent, brief, promoted_offering, tool_name || 'get_products');
                } else {
                    throw new Error(`Unsupported protocol: ${agent.protocol}`);
                }
                
                const responseTime = Date.now() - startTime;
                totalResponseTime += responseTime;
                
                results.push({
                    agent_id: agent.id,
                    agent_name: agent.name,
                    success: true,
                    response_time_ms: responseTime,
                    data: result.response,
                    debug_logs: result.debugLogs || [],
                    validation: result.validation || null,
                    timestamp: new Date().toISOString()
                });
                successful++;
                
            } catch (error) {
                const responseTime = Date.now() - startTime;
                totalResponseTime += responseTime;
                
                results.push({
                    agent_id: agent.id,
                    agent_name: agent.name,
                    success: false,
                    response_time_ms: responseTime,
                    error: error.message,
                    debug_logs: [],
                    timestamp: new Date().toISOString()
                });
                failed++;
            }
        }
        
        const averageResponseTime = Math.round(totalResponseTime / agents.length);
        
        res.json({
            success: true,
            data: {
                test_id: `test_${Date.now()}`,
                results,
                summary: {
                    total_agents: agents.length,
                    successful,
                    failed,
                    average_response_time_ms: averageResponseTime
                },
                timestamp: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error in test endpoint:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Discover agent capabilities
app.get('/api/agents/:agentId/discover', async (req, res) => {
    try {
        const { agentId } = req.params;
        const handler = new SalesAgentsHandlers(process.env);
        const capabilities = await handler.discoverAgentCapabilities(agentId);
        
        res.json(capabilities);
    } catch (error) {
        console.error('Error discovering agent capabilities:', error);
        res.status(500).json({
            error: error.message
        });
    }
});

// Test single agent
app.post('/api/agents/:agentId/test', async (req, res) => {
    try {
        const { agentId } = req.params;
        const { brandStory, offering, agentConfig, toolName } = req.body;
        
        if (!brandStory || typeof brandStory !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Brand story is required and must be a string'
            });
        }
        
        const handler = new SalesAgentsHandlers(process.env);
        const result = await handler.querySalesAgent(agentId, brandStory, offering, agentConfig, toolName);
        
        res.json(result);
    } catch (error) {
        console.error('Error testing single agent:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get standard creative formats
app.get('/api/formats/standard', async (req, res) => {
    try {
        const handler = new SalesAgentsHandlers(process.env);
        const formats = await handler.fetchStandardFormats();
        
        res.json({
            formats,
            total_count: formats.length,
            source: 'adcp_repository',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error getting standard formats:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            formats: []
        });
    }
});

// === Original UI API Endpoints ===

// Get sales agents (original UI endpoint)
app.get('/api/sales/agents', async (req, res) => {
    try {
        const handler = new SalesAgentsHandlers(process.env);
        const result = await handler.getSalesAgents();
        
        res.json({
            success: true,
            agents: result.agents
        });
    } catch (error) {
        console.error('Error getting sales agents:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Query single agent (original UI endpoint)
app.post('/api/sales/agents/:agentId/query', async (req, res) => {
    try {
        const { agentId } = req.params;
        const { brandStory, offering, agentConfig, toolName } = req.body;
        
        if (!brandStory || typeof brandStory !== 'string') {
            return res.status(400).json({
                success: false,
                error: 'Brand story is required'
            });
        }
        
        const handler = new SalesAgentsHandlers(process.env);
        const result = await handler.querySalesAgent(agentId, brandStory, offering, agentConfig, toolName);
        
        res.json(result);
    } catch (error) {
        console.error('Error querying sales agent:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get standard creative formats (original UI endpoint)
app.get('/api/sales/formats/standard', async (req, res) => {
    try {
        const handler = new SalesAgentsHandlers(process.env);
        const formats = await handler.fetchStandardFormats();
        
        res.json({
            success: true,
            formats
        });
    } catch (error) {
        console.error('Error getting standard formats:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            formats: []
        });
    }
});

// No auth endpoints needed for public deployment

// Start server
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';

app.listen(port, host, () => {
    console.log(`🚀 AdCP Testing Framework running on http://${host}:${port}`);
    console.log(`📋 API available at http://${host}:${port}/api`);
    console.log(`🌐 UI available at http://${host}:${port}`);
    
    // Log environment info
    const agents = process.env.SALES_AGENTS_CONFIG ? JSON.parse(process.env.SALES_AGENTS_CONFIG) : null;
    if (agents && agents.agents) {
        console.log(`📡 Configured agents: ${agents.agents.length}`);
        agents.agents.forEach(agent => {
            console.log(`  - ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
        });
    }
    
    console.log(`🔧 Real agents mode: ${process.env.USE_REAL_AGENTS === 'true' ? 'ENABLED' : 'DISABLED'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});