/**
 * Simple Node.js migration of the working Cloudflare Worker
 * Serves the original sales-agents.html and implements the working backend
 */

require('dotenv/config');
const express = require('express');
const path = require('path');
const cors = require('cors');

// Import the library-based sales agents handlers
const { SalesAgentsHandlers } = require('./dist/server/sales-agents-handlers');

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors({
    origin: process.env.NODE_ENV === 'development' ? true : ['https://testing.adcontextprotocol.org'],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Security headers middleware
app.use((req, res, next) => {
    // Content Security Policy
    const cspDirectives = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://unpkg.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: https:",
        "connect-src 'self' https: wss:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'"
    ];
    res.setHeader('Content-Security-Policy', cspDirectives.join('; '));
    
    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    
    // Prevent caching of sensitive endpoints
    if (req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }
    
    // Remove server signature
    res.removeHeader('X-Powered-By');
    
    // HSTS for production (only over HTTPS)
    if (process.env.NODE_ENV === 'production' && req.secure) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    }
    
    next();
});

// Rate limiting middleware
const rateLimiter = (() => {
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxRequests = 100; // requests per window per IP
    const maxAPIRequests = 50; // API requests per window per IP
    const clients = new Map(); // IP -> { count, windowStart, apiCount }
    
    // Cleanup old entries every 5 minutes
    setInterval(() => {
        const now = Date.now();
        for (const [ip, data] of clients.entries()) {
            if (now - data.windowStart > windowMs * 2) { // Keep data for 2 windows
                clients.delete(ip);
            }
        }
    }, 5 * 60 * 1000);
    
    return (req, res, next) => {
        const ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const isAPIRequest = req.path.startsWith('/api/');
        
        // Skip rate limiting for health check
        if (req.path === '/health') {
            return next();
        }
        
        let clientData = clients.get(ip);
        
        // Initialize or reset window if expired
        if (!clientData || now - clientData.windowStart > windowMs) {
            clientData = {
                count: 0,
                apiCount: 0,
                windowStart: now
            };
            clients.set(ip, clientData);
        }
        
        // Increment counters
        clientData.count++;
        if (isAPIRequest) {
            clientData.apiCount++;
        }
        
        // Check limits
        const totalLimit = maxRequests;
        const apiLimit = maxAPIRequests;
        
        if (clientData.count > totalLimit) {
            res.setHeader('X-RateLimit-Limit', totalLimit);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', new Date(clientData.windowStart + windowMs).toISOString());
            
            return res.status(429).json({
                success: false,
                error: 'Too many requests, please try again later',
                retryAfter: Math.ceil((clientData.windowStart + windowMs - now) / 1000),
                timestamp: new Date().toISOString()
            });
        }
        
        if (isAPIRequest && clientData.apiCount > apiLimit) {
            res.setHeader('X-RateLimit-Limit', apiLimit);
            res.setHeader('X-RateLimit-Remaining', 0);
            res.setHeader('X-RateLimit-Reset', new Date(clientData.windowStart + windowMs).toISOString());
            
            return res.status(429).json({
                success: false,
                error: 'Too many API requests, please try again later',
                retryAfter: Math.ceil((clientData.windowStart + windowMs - now) / 1000),
                timestamp: new Date().toISOString()
            });
        }
        
        // Set rate limit headers
        const remainingTotal = Math.max(0, totalLimit - clientData.count);
        const remainingAPI = isAPIRequest ? Math.max(0, apiLimit - clientData.apiCount) : apiLimit;
        
        res.setHeader('X-RateLimit-Limit', isAPIRequest ? apiLimit : totalLimit);
        res.setHeader('X-RateLimit-Remaining', isAPIRequest ? remainingAPI : remainingTotal);
        res.setHeader('X-RateLimit-Reset', new Date(clientData.windowStart + windowMs).toISOString());
        
        next();
    };
})();

app.use(rateLimiter);

// Request size and validation middleware
app.use((req, res, next) => {
    // Add basic request validation
    const maxHeaderSize = 8192; // 8KB
    const headerSize = JSON.stringify(req.headers).length;
    
    if (headerSize > maxHeaderSize) {
        return res.status(413).json({
            success: false,
            error: 'Request headers too large',
            timestamp: new Date().toISOString()
        });
    }
    
    // Add request ID for tracing
    req.requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    res.setHeader('X-Request-ID', req.requestId);
    
    next();
});

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