/**
 * Simple MCP Server for testing the MCP client implementation
 * This implements a basic MCP server that follows the protocol specification
 */

const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.MCP_SERVER_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MCP Server state
let serverInitialized = false;
const supportedProtocolVersion = '2024-11-05';

// Available tools
const availableTools = [
    {
        name: 'get_products',
        description: 'Get available advertising products based on brand story',
        inputSchema: {
            type: 'object',
            properties: {
                req: {
                    type: 'object',
                    properties: {
                        brief: { type: 'string', description: 'Brand story or campaign brief' },
                        promoted_offering: { type: 'string', description: 'Optional promoted offering' },
                        strategy_id: { type: ['string', 'null'], description: 'Optional strategy identifier' }
                    },
                    required: ['brief']
                }
            },
            required: ['req']
        }
    },
    {
        name: 'create_media_buy',
        description: 'Create a media buy campaign',
        inputSchema: {
            type: 'object',
            properties: {
                req: {
                    type: 'object',
                    properties: {
                        brief: { type: 'string', description: 'Brand story or campaign brief' },
                        promoted_offering: { type: 'string', description: 'Optional promoted offering' },
                        packages: { type: 'array', description: 'Media packages to include' },
                        budget: { type: 'object', description: 'Budget constraints' },
                        start_time: { type: 'string', description: 'Campaign start time' },
                        end_time: { type: 'string', description: 'Campaign end time' }
                    },
                    required: ['brief']
                }
            },
            required: ['req']
        }
    }
];

/**
 * Create a JSON-RPC response
 */
function createJsonRpcResponse(id, result = null, error = null) {
    const response = {
        jsonrpc: '2.0',
        id: id
    };
    
    if (error) {
        response.error = error;
    } else {
        response.result = result;
    }
    
    return response;
}

/**
 * Create a JSON-RPC error response
 */
function createJsonRpcError(id, code, message, data = null) {
    return createJsonRpcResponse(id, null, {
        code: code,
        message: message,
        ...(data && { data: data })
    });
}

/**
 * Handle MCP requests
 */
app.post('/mcp', (req, res) => {
    const { jsonrpc, id, method, params } = req.body;
    
    // Validate JSON-RPC format
    if (jsonrpc !== '2.0') {
        return res.json(createJsonRpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0"'));
    }
    
    if (typeof id === 'undefined') {
        return res.json(createJsonRpcError(null, -32600, 'Invalid Request: id is required'));
    }
    
    console.log(`[MCP Server] Received request: ${method}`, params);
    
    try {
        switch (method) {
            case 'initialize':
                return handleInitialize(req, res, id, params);
                
            case 'tools/list':
                if (!serverInitialized) {
                    return res.json(createJsonRpcError(id, -32002, 'Server not initialized'));
                }
                return handleToolsList(req, res, id, params);
                
            case 'tools/call':
                if (!serverInitialized) {
                    return res.json(createJsonRpcError(id, -32002, 'Server not initialized'));
                }
                return handleToolsCall(req, res, id, params);
                
            case 'notifications/initialized':
                // This is a notification (no response expected)
                console.log('[MCP Server] Client sent initialized notification');
                return res.status(204).send(); // No content for notifications
                
            default:
                return res.json(createJsonRpcError(id, -32601, `Method not found: ${method}`));
        }
    } catch (error) {
        console.error('[MCP Server] Error handling request:', error);
        return res.json(createJsonRpcError(id, -32603, 'Internal error', error.message));
    }
});

/**
 * Handle initialize request
 */
function handleInitialize(req, res, id, params) {
    if (!params || !params.protocolVersion || !params.clientInfo) {
        return res.json(createJsonRpcError(id, -32602, 'Invalid params: protocolVersion and clientInfo required'));
    }
    
    if (params.protocolVersion !== supportedProtocolVersion) {
        return res.json(createJsonRpcError(id, -32602, `Unsupported protocol version: ${params.protocolVersion}`));
    }
    
    serverInitialized = true;
    
    const result = {
        protocolVersion: supportedProtocolVersion,
        capabilities: {
            tools: {},
            logging: {},
            prompts: {},
            resources: {}
        },
        serverInfo: {
            name: 'test-mcp-server',
            version: '1.0.0'
        }
    };
    
    console.log(`[MCP Server] Initialized by client: ${params.clientInfo.name} v${params.clientInfo.version}`);
    
    res.json(createJsonRpcResponse(id, result));
}

/**
 * Handle tools/list request
 */
function handleToolsList(req, res, id, params) {
    console.log('[MCP Server] Listing available tools');
    
    const result = {
        tools: availableTools
    };
    
    res.json(createJsonRpcResponse(id, result));
}

/**
 * Handle tools/call request
 */
function handleToolsCall(req, res, id, params) {
    if (!params || !params.name) {
        return res.json(createJsonRpcError(id, -32602, 'Invalid params: name is required'));
    }
    
    const { name, arguments: toolArgs } = params;
    
    console.log(`[MCP Server] Calling tool: ${name}`, toolArgs);
    
    // Find the tool
    const tool = availableTools.find(t => t.name === name);
    if (!tool) {
        return res.json(createJsonRpcError(id, -32602, `Tool not found: ${name}`));
    }
    
    // Validate arguments structure
    if (!toolArgs || !toolArgs.req) {
        return res.json(createJsonRpcError(id, -32602, 'Invalid arguments: req object is required'));
    }
    
    const { req: toolRequest } = toolArgs;
    
    if (!toolRequest.brief) {
        return res.json(createJsonRpcError(id, -32602, 'Invalid arguments: brief is required'));
    }
    
    try {
        let result;
        
        switch (name) {
            case 'get_products':
                result = {
                    content: [{
                        type: 'text',
                        text: `Found advertising products for: "${toolRequest.brief}"`
                    }],
                    products: [
                        {
                            id: 'mcp_product_1',
                            name: 'Premium Display Campaign',
                            type: 'display',
                            pricing_model: 'cpm',
                            base_price: 4.50,
                            description: 'High-visibility display advertising across premium publishers',
                            targeting_options: ['demographic', 'behavioral', 'contextual'],
                            creative_formats: ['300x250', '728x90', '320x50']
                        },
                        {
                            id: 'mcp_product_2',
                            name: 'Native Content Placement',
                            type: 'native',
                            pricing_model: 'cpc',
                            base_price: 1.25,
                            description: 'Native advertising that blends with editorial content',
                            targeting_options: ['contextual', 'interest-based'],
                            creative_formats: ['native_article', 'native_feed']
                        }
                    ],
                    campaign_recommendations: {
                        budget_range: { min: 5000, max: 50000 },
                        duration_days: 30,
                        target_impressions: 1000000,
                        estimated_reach: 250000
                    }
                };
                break;
                
            case 'create_media_buy':
                result = {
                    content: [{
                        type: 'text',
                        text: `Created media buy campaign for: "${toolRequest.brief}"`
                    }],
                    campaign: {
                        id: 'campaign_' + Date.now(),
                        name: 'Generated Campaign',
                        status: 'draft',
                        brief: toolRequest.brief,
                        promoted_offering: toolRequest.promoted_offering || null,
                        estimated_cost: 15000,
                        estimated_impressions: 500000,
                        start_time: toolRequest.start_time,
                        end_time: toolRequest.end_time
                    }
                };
                break;
                
            default:
                return res.json(createJsonRpcError(id, -32601, `Tool not implemented: ${name}`));
        }
        
        console.log(`[MCP Server] Tool ${name} executed successfully`);
        res.json(createJsonRpcResponse(id, result));
        
    } catch (error) {
        console.error(`[MCP Server] Error executing tool ${name}:`, error);
        res.json(createJsonRpcError(id, -32603, 'Tool execution error', error.message));
    }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        server_type: 'mcp',
        protocol_version: supportedProtocolVersion,
        initialized: serverInitialized,
        available_tools: availableTools.length,
        timestamp: new Date().toISOString()
    });
});

/**
 * Get server info (for debugging)
 */
app.get('/info', (req, res) => {
    res.json({
        name: 'test-mcp-server',
        version: '1.0.0',
        protocol: 'mcp',
        protocol_version: supportedProtocolVersion,
        initialized: serverInitialized,
        capabilities: ['tools'],
        available_tools: availableTools.map(tool => ({
            name: tool.name,
            description: tool.description
        })),
        endpoint: `/mcp`,
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(port, '127.0.0.1', () => {
    console.log(`🔧 Test MCP Server running on http://127.0.0.1:${port}`);
    console.log(`📋 MCP endpoint: http://127.0.0.1:${port}/mcp`);
    console.log(`❤️ Health check: http://127.0.0.1:${port}/health`);
    console.log(`ℹ️ Server info: http://127.0.0.1:${port}/info`);
    console.log(`🛠️ Available tools: ${availableTools.map(t => t.name).join(', ')}`);
});

module.exports = app;