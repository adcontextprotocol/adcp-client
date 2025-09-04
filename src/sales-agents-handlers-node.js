/**
 * Node.js adaptation of your working Cloudflare Workers sales-agents-handlers.js
 * This preserves your original working logic but adapts it for Node.js environment
 */

// Use native fetch (available in Node.js 18+)

// Mock A2A client for now since the SDK has import issues
// We'll use your working HTTP fallback approach
let A2AClient = null;
try {
    // SDK imports commented out due to ES module compatibility issues
    // We'll use the HTTP fallback approach which works reliably
    A2AClient = null;
} catch (error) {
    console.log('A2A SDK not available, using HTTP fallback');
    A2AClient = null;
}

class SalesAgentsHandlers {
    constructor(env) {
        this.env = env;
        this.mcpClients = new Map();
        this.a2aClients = new Map();
        this.MAX_CONCURRENT_REQUESTS = 5;
        this.REQUEST_TIMEOUT = 30000;
    }

    /**
     * Validate agent URL to prevent SSRF attacks
     */
    validateAgentUrl(url) {
        try {
            const parsedUrl = new URL(url);
            
            // Only allow HTTP/HTTPS protocols
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                throw new Error('Only HTTP/HTTPS protocols allowed');
            }
            
            // Block private IP ranges and localhost in production
            if (process.env.NODE_ENV === 'production') {
                const hostname = parsedUrl.hostname.toLowerCase();
                if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(hostname) ||
                    hostname.startsWith('192.168.') ||
                    hostname.startsWith('10.') ||
                    hostname.match(/^172\.(1[6-9]|2[0-9]|3[01])\./)) {
                    throw new Error('Private network access not allowed in production');
                }
            }
            
            // Block metadata endpoints
            const hostname = parsedUrl.hostname.toLowerCase();
            if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
                throw new Error('Metadata endpoint access not allowed');
            }
            
            // Ensure reasonable URL length
            if (url.length > 2048) {
                throw new Error('URL too long');
            }
            
            return true;
        } catch (e) {
            throw new Error(`Invalid agent URL: ${e.message}`);
        }
    }

    /**
     * Get configured sales agents from environment variable
     */
    getConfiguredAgents() {
        // Check if custom agents are configured in environment variable (as JSON string)
        if (this.env.SALES_AGENTS_CONFIG) {
            try {
                // Validate config size to prevent DoS
                const configStr = this.env.SALES_AGENTS_CONFIG;
                if (configStr.length > 10000) { // 10KB limit
                    throw new Error('SALES_AGENTS_CONFIG too large');
                }
                
                const customAgents = JSON.parse(configStr);
                if (customAgents.agents && Array.isArray(customAgents.agents)) {
                    // Validate each agent configuration
                    const validatedAgents = customAgents.agents.map(agent => {
                        if (!agent.id || !agent.agent_uri || !agent.protocol) {
                            throw new Error('Invalid agent configuration: missing required fields');
                        }
                        
                        // Validate agent URL
                        this.validateAgentUrl(agent.agent_uri);
                        
                        // Validate protocol
                        if (!['mcp', 'a2a'].includes(agent.protocol)) {
                            throw new Error(`Invalid protocol: ${agent.protocol}`);
                        }
                        
                        return {
                            id: String(agent.id).substring(0, 100), // Limit ID length
                            name: String(agent.name || agent.id).substring(0, 200), // Limit name length
                            agent_uri: agent.agent_uri,
                            protocol: agent.protocol,
                            auth_token_env: agent.auth_token_env,
                            requiresAuth: agent.requiresAuth !== false
                        };
                    });
                    
                    return validatedAgents;
                }
            } catch (e) {
                console.error('Failed to parse SALES_AGENTS_CONFIG:', e.message);
            }
        }
        
        // Default agents configuration (empty for now - agents must be configured via env)
        return [];
    }

    /**
     * Get or create MCP client for an agent
     */
    async getMCPClient(agent, debugLogs = []) {
        const url = agent.agent_uri;
        
        // Validate URL before creating client
        this.validateAgentUrl(url);
        
        // Always create a fresh client for MCP to avoid session issues
        // Get auth token if required
        let authToken = null;
        if (agent.requiresAuth !== false && agent.auth_token_env) {
            // Use the auth_token_env value directly as the token
            authToken = agent.auth_token_env;
        }

        // Store MCP session state and ensure debugLogs is captured
        let mcpSessionId = null;
        let mcpProtocolVersion = null;
        const logs = debugLogs || [];

        // Create custom fetch function with detailed logging and session handling
        const customFetch = async (fetchUrl, options = {}) => {
            const requestStart = Date.now();
            
            // Convert Headers object to plain object if needed
            const originalHeaders = options.headers instanceof Headers 
                ? Object.fromEntries(options.headers.entries())
                : (options.headers || {});
            
            // Preserve all SDK headers (especially Accept header for MCP)
            const headers = { 
                ...originalHeaders
            };
            
            // Only set Content-Type if not already set by SDK
            if (!headers['Content-Type'] && !headers['content-type']) {
                headers['Content-Type'] = 'application/json';
            }
            
            // Always add MCP auth headers for MCP protocol agents
            // Many MCP agents require x-adcp-auth header even for public endpoints
            if (!headers['x-adcp-auth']) {
                headers['x-adcp-auth'] = authToken || 'public-access';
            }
            if (authToken && !headers['Authorization']) {
                headers['Authorization'] = `Bearer ${authToken}`;
            }

            // Add MCP session headers if we have them
            if (mcpSessionId && !headers['mcp-session-id']) {
                headers['mcp-session-id'] = mcpSessionId;
            }
            if (mcpProtocolVersion && !headers['mcp-protocol-version']) {
                headers['mcp-protocol-version'] = mcpProtocolVersion;
            }
            
            // Parse request body to extract MCP method for better debugging
            let mcpMethod = 'unknown';
            let requestId = null;
            if (options.body) {
                try {
                    const requestData = JSON.parse(options.body);
                    mcpMethod = requestData.method || 'unknown';
                    requestId = requestData.id || null;
                } catch (e) {
                    // Not JSON, ignore
                }
            }

            // Capture debug info for UI with enhanced MCP context
            const debugEntry = {
                timestamp: new Date().toISOString(),
                type: 'request',
                protocol: 'MCP',
                mcp_method: mcpMethod,
                request_id: requestId,
                http_method: options.method || 'POST',
                url: fetchUrl,
                headers: { ...headers }, // Clone to avoid mutation
                body: options.body || null,
                session_id: mcpSessionId || null,
                request_start: requestStart
            };
            if (logs && Array.isArray(logs)) {
                logs.push(debugEntry);
            }
            
            let response;
            let requestError = null;
            
            try {
                response = await fetch(fetchUrl, {
                    ...options,
                    headers,
                    redirect: 'follow' // Follow redirects
                });
            } catch (error) {
                requestError = error;
                // Log the error
                const errorEntry = {
                    timestamp: new Date().toISOString(),
                    type: 'error',
                    protocol: 'MCP',
                    mcp_method: mcpMethod,
                    request_id: requestId,
                    error: error.message,
                    duration_ms: Date.now() - requestStart
                };
                if (logs && Array.isArray(logs)) {
                    logs.push(errorEntry);
                }
                throw error;
            }
            
            const requestEnd = Date.now();
            
            // Clone response to read body for logging without consuming it
            const responseClone = response.clone();
            let responseText = null;
            let parsedResponse = null;
            
            try {
                responseText = await responseClone.text();
                if (responseText && responseText.trim()) {
                    // Try to parse as JSON to extract MCP response details
                    if (responseText.includes('jsonrpc')) {
                        try {
                            parsedResponse = JSON.parse(responseText);
                        } catch (e) {
                            // Could be SSE format, try parsing
                            if (responseText.includes('data:')) {
                                const lines = responseText.split('\n');
                                for (const line of lines) {
                                    if (line.startsWith('data: ')) {
                                        try {
                                            parsedResponse = JSON.parse(line.substring(6));
                                            break;
                                        } catch (parseErr) {
                                            // Continue trying other lines
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                responseText = `[ERROR: Could not read response body: ${e.message}]`;
            }

            // Capture MCP session information from response headers
            const responseHeaders = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });
            
            if (responseHeaders['mcp-session-id']) {
                mcpSessionId = responseHeaders['mcp-session-id'];
            }
            if (responseHeaders['mcp-protocol-version']) {
                mcpProtocolVersion = responseHeaders['mcp-protocol-version'];
            }

            // Extract MCP response details for better debugging
            let mcpResponseType = 'unknown';
            let mcpError = null;
            let mcpResult = null;
            let responseId = requestId;
            
            if (parsedResponse) {
                responseId = parsedResponse.id || requestId;
                if (parsedResponse.error) {
                    mcpResponseType = 'error';
                    mcpError = parsedResponse.error;
                } else if (parsedResponse.result !== undefined) {
                    mcpResponseType = 'success';
                    mcpResult = parsedResponse.result;
                } else if (parsedResponse.method) {
                    mcpResponseType = 'notification';
                }
            }

            // Capture response debug info for UI with enhanced MCP context
            const responseEntry = {
                timestamp: new Date().toISOString(),
                type: 'response',
                protocol: 'MCP',
                mcp_method: mcpMethod,
                mcp_response_type: mcpResponseType,
                mcp_error: mcpError,
                request_id: requestId,
                response_id: responseId,
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
                body: parsedResponse ? JSON.stringify(parsedResponse, null, 2) : responseText,
                parsed_response: parsedResponse,
                session_id: mcpSessionId || null,
                duration_ms: requestEnd - requestStart,
                success: response.ok && !mcpError
            };
            if (logs && Array.isArray(logs)) {
                logs.push(responseEntry);
            }
            
            return response;
        };

        // Create a mock MCP client that uses HTTP directly since transport is not available
        console.log(`Creating HTTP-based MCP client for URL: ${url}`);
        
        const mockMcpClient = {
            url: url,
            authToken: authToken,
            customFetch: customFetch,
            
            async initialize() {
                const initRequest = {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            roots: {
                                listChanged: false
                            },
                            sampling: {}
                        },
                        clientInfo: {
                            name: 'adcp-testing-framework',
                            version: '1.0.0'
                        }
                    }
                };
                
                const response = await this.customFetch(this.url, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(initRequest)
                });
                
                if (!response.ok) {
                    throw new Error(`MCP initialize failed: ${response.status} ${response.statusText}`);
                }
                
                // Parse response (handle both SSE and JSON formats)
                const responseText = await response.text();
                let initResult;
                
                if (responseText.includes('event:') || responseText.includes('data:')) {
                    // Parse SSE format - extract JSON from "data: " lines
                    initResult = this.parseSSEResponse(responseText);
                } else {
                    initResult = JSON.parse(responseText);
                }
                
                if (initResult.error) {
                    throw new Error(`MCP initialize error: ${initResult.error.message} (code: ${initResult.error.code})`);
                }
                
                // Send initialized notification (required by MCP protocol)
                if (initResult.result) {
                    const initializedNotification = {
                        jsonrpc: '2.0',
                        method: 'notifications/initialized',
                        params: {}
                    };
                    
                    await this.customFetch(this.url, {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'Accept': 'application/json, text/event-stream'
                        },
                        body: JSON.stringify(initializedNotification)
                    });
                }
                
                return initResult;
            },
            
            parseSSEResponse(responseText) {
                const lines = responseText.split('\n');
                let eventType = null;
                let dataLines = [];
                
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('event: ')) {
                        eventType = trimmedLine.substring(7);
                    } else if (trimmedLine.startsWith('data: ')) {
                        const dataContent = trimmedLine.substring(6);
                        if (dataContent) {
                            dataLines.push(dataContent);
                        }
                    } else if (trimmedLine === '' && dataLines.length > 0) {
                        // End of SSE message, parse accumulated data
                        const jsonData = dataLines.join('\n');
                        try {
                            return JSON.parse(jsonData);
                        } catch (e) {
                            console.warn('Failed to parse SSE JSON data:', jsonData);
                        }
                        dataLines = [];
                    }
                }
                
                // Handle case where there's data but no blank line terminator
                if (dataLines.length > 0) {
                    const jsonData = dataLines.join('\n');
                    return JSON.parse(jsonData);
                }
                
                throw new Error('No valid data found in SSE response');
            },
            
            async listTools() {
                const listToolsRequest = {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list'
                    // Note: MCP tools/list should not include params for most servers
                };
                
                const response = await this.customFetch(this.url, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(listToolsRequest)
                });
                
                if (!response.ok) {
                    throw new Error(`MCP tools/list failed: ${response.status} ${response.statusText}`);
                }
                
                // Parse response (handle both SSE and JSON formats)
                const responseText = await response.text();
                let jsonRpcResponse;
                
                if (responseText.includes('event:') || responseText.includes('data:')) {
                    jsonRpcResponse = this.parseSSEResponse(responseText);
                } else {
                    jsonRpcResponse = JSON.parse(responseText);
                }
                
                if (jsonRpcResponse.error) {
                    // Provide more helpful error information for MCP issues
                    const errorMsg = `MCP tools/list error: ${jsonRpcResponse.error.message} (code: ${jsonRpcResponse.error.code})`;
                    if (jsonRpcResponse.error.code === -32602) {
                        throw new Error(`${errorMsg}. This typically means the server expects different parameters or the MCP session wasn't properly initialized.`);
                    } else if (jsonRpcResponse.error.code === -32601) {
                        throw new Error(`${errorMsg}. The tools/list method is not implemented by this MCP server.`);
                    } else if (jsonRpcResponse.error.code === -32600) {
                        throw new Error(`${errorMsg}. Invalid JSON-RPC request format.`);
                    }
                    throw new Error(errorMsg);
                }
                
                // Ensure we return a valid tools list structure
                const result = jsonRpcResponse.result || { tools: [] };
                if (Array.isArray(result)) {
                    return { tools: result };
                }
                return result;
            },
            
            async callTool(toolCall) {
                const callToolRequest = {
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'tools/call',
                    params: {
                        name: toolCall.name,
                        arguments: toolCall.arguments || {}
                    }
                };
                
                const response = await this.customFetch(this.url, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'
                    },
                    body: JSON.stringify(callToolRequest)
                });
                
                if (!response.ok) {
                    throw new Error(`MCP tools/call failed: ${response.status} ${response.statusText}`);
                }
                
                // Parse response (handle both SSE and JSON formats)
                const responseText = await response.text();
                let jsonRpcResponse;
                
                if (responseText.includes('event:') || responseText.includes('data:')) {
                    jsonRpcResponse = this.parseSSEResponse(responseText);
                } else {
                    jsonRpcResponse = JSON.parse(responseText);
                }
                
                if (jsonRpcResponse.error) {
                    throw new Error(`MCP tools/call error: ${jsonRpcResponse.error.message} (code: ${jsonRpcResponse.error.code})`);
                }
                
                return jsonRpcResponse.result;
            }
        };
        
        console.log(`HTTP-based MCP client created successfully`);
        return mockMcpClient;
    }

    /**
     * Get or create A2A client for agent (HTTP fallback)
     */
    async getA2AClient(agent, debugLogs = []) {
        const url = agent.agent_uri;
        
        // Get auth token if required
        let authToken = null;
        if (agent.requiresAuth !== false && agent.auth_token_env) {
            // Use the auth_token_env value directly as the token
            authToken = agent.auth_token_env;
        }
        
        // Capture debugLogs in closure scope
        const logs = debugLogs || [];
        
        // Create custom fetch for auth and logging
        const customFetch = async (url, options = {}) => {
            const headers = { 
                'Content-Type': 'application/json',
                ...options.headers 
            };
            
            if (authToken) {
                headers['Authorization'] = `Bearer ${authToken}`;
            }
            

            // Capture debug info for UI
            const debugEntry = {
                timestamp: new Date().toISOString(),
                type: 'request',
                protocol: 'A2A',
                method: options.method || 'GET',
                url: url,
                headers: headers,
                body: options.body || null,
                adcp_version: 'PR#48' // Indicate ADCP spec compliance
            };
            if (logs && Array.isArray(logs)) {
                logs.push(debugEntry);
            }
            
            const response = await fetch(url, {
                ...options,
                headers
            });
            
            
            // Clone response to read body for logging without consuming it
            const responseClone = response.clone();
            let responseText = null;
            try {
                responseText = await responseClone.text();
            } catch (e) {
                responseText = `[ERROR: Could not read response body: ${e.message}]`;
            }

            // Capture response debug info for UI
            const responseHeaders = {};
            response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
            });
            
            const responseEntry = {
                timestamp: new Date().toISOString(),
                type: 'response',
                protocol: 'A2A',
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
                body: responseText
            };
            if (logs && Array.isArray(logs)) {
                logs.push(responseEntry);
            }
            
            return response;
        };

        // Use HTTP fallback approach since A2A SDK is problematic
        // Create a mock client that implements the sendMessage method
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const cardUrl = baseUrl + '/.well-known/agent-card.json';
        
        // Fetch agent card first
        const cardResponse = await customFetch(cardUrl, { method: 'GET' });
        if (!cardResponse.ok) {
            throw new Error(`Failed to fetch agent card: ${cardResponse.status} ${cardResponse.statusText}`);
        }
        
        const agentCard = await cardResponse.json();
        
        // Create mock client with sendMessage method
        const mockClient = {
            agentCard,
            sendMessage: async (request) => {
                // Extract service URL from agent card
                const serviceUrl = agentCard.url || baseUrl;
                
                // Make JSON-RPC call to the service URL
                const jsonRpcRequest = {
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'message/send',
                    params: request
                };
                
                const response = await customFetch(serviceUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(jsonRpcRequest)
                });
                
                if (!response.ok) {
                    throw new Error(`A2A request failed: ${response.status} ${response.statusText}`);
                }
                
                const jsonRpcResponse = await response.json();
                
                if (jsonRpcResponse.error) {
                    return { error: jsonRpcResponse.error };
                }
                
                return { result: jsonRpcResponse.result };
            }
        };
        
        return mockClient;
    }

    /**
     * Sanitize user input to prevent prompt injection
     */
    sanitizeInput(input, maxLength = 10000) {
        if (!input || typeof input !== 'string') {
            return '';
        }
        
        // Limit length
        let sanitized = input.substring(0, maxLength);
        
        // Remove potential prompt injection patterns
        sanitized = sanitized
            .replace(/\n\s*system\s*:/gi, '\n[REMOVED]:')
            .replace(/\n\s*assistant\s*:/gi, '\n[REMOVED]:')
            .replace(/\n\s*user\s*:/gi, '\n[REMOVED]:')
            .replace(/```/g, '[CODE_BLOCK]')
            .replace(/\[INST\]/gi, '[INSTRUCTION]')
            .replace(/\[\/INST\]/gi, '[/INSTRUCTION]');
        
        return sanitized.trim();
    }

    /**
     * Create A2A message following current ADCP specification
     * Uses only text parts as skill parts are not supported by current agents
     */
    createA2AMessage(messageId, requestText, toolName, brandStory, userProvidedOffering) {
        // Create comprehensive text request that includes all necessary information
        const fullRequestText = `${requestText}\n\nTOOL REQUEST: ${toolName}\nBRIEF: ${brandStory}${userProvidedOffering ? `\nPROMOTED OFFERING: ${userProvidedOffering}` : ''}`;
        
        const baseParts = [
            {
                kind: 'text',
                text: fullRequestText
            }
        ];

        return {
            message: {
                messageId: messageId,
                role: 'user',
                parts: baseParts,
                kind: 'message'
            },
            configuration: {
                blocking: true,
                acceptedOutputModes: ['application/json', 'text/plain']
            }
        };
    }

    /**
     * Query A2A protocol agent for inventory with structured brief
     */
    async queryA2AAgent(agent, brandStory, userProvidedOffering = null, toolName = 'get_products') {
        // Validate URL before making requests
        this.validateAgentUrl(agent.agent_uri);
        
        // Array to collect debug logs
        const debugLogs = [];
        
        // Get A2A client with debug logging
        const client = await this.getA2AClient(agent, debugLogs);
        
        try {
            // Create inventory discovery message using proper A2A format
            const messageId = String(Date.now());
            
            let requestText;
            if (toolName === 'get_products') {
                requestText = `INVENTORY DISCOVERY REQUEST

I need to find available advertising inventory for the following campaign:

BRAND STORY: ${brandStory}

SPECIFIC INVENTORY REQUIREMENTS:
- Ad formats: Display, Video, Native, Search  
- Target audience: US-based consumers
- Budget range: Flexible
- Campaign duration: 30-60 days

REQUESTED INVENTORY DATA:
1. Available ad placement inventory (specific slots/positions)
2. Audience reach estimates and demographics
3. CPM/CPC pricing for different ad formats
4. Minimum spend requirements
5. Creative specifications and requirements
6. Available targeting options
7. Performance benchmarks for similar campaigns

Please provide actual inventory listings and availability, not just your capabilities.`;
            } else {
                requestText = `${toolName.toUpperCase().replace('_', ' ')} REQUEST

BRAND STORY: ${brandStory}

Please process this ${toolName} request according to AdCP specifications.`;
            }
            
            // Create message using ADCP PR #48 specification with explicit skill invocation
            const inventoryRequest = this.createA2AMessage(
                messageId, 
                requestText, 
                toolName, 
                brandStory, 
                userProvidedOffering, 
                true // Use explicit skill invocation
            );
            
            // Try explicit skill invocation first
            let response = await client.sendMessage(inventoryRequest);
            
            // If payload validation fails, try with simplified text approach
            if (response.error && (response.error.code === -32600 || (response.error.message && response.error.message.includes('validation')))) {
                console.log('A2A request failed with validation error, trying simplified approach...');
                const simplifiedText = `Please help with ${toolName} for: ${brandStory}`;
                const fallbackRequest = this.createA2AMessage(
                    messageId + '_fallback', 
                    simplifiedText, 
                    toolName, 
                    brandStory, 
                    userProvidedOffering
                );
                
                response = await client.sendMessage(fallbackRequest);
            }
            
            if (response.error) {
                throw new Error(`A2A agent error: ${response.error.message || JSON.stringify(response.error)}`);
            }

            // Handle successful response
            const result = response.result;
            
            if (result && result.kind === 'task') {
                // Agent created a task - extract data from artifacts using ADCP parts format
                let extractedData = [];
                let additionalData = {};
                let files = [];
                
                if (result.artifacts && Array.isArray(result.artifacts)) {
                    result.artifacts.forEach((artifact) => {
                        if (artifact.parts && Array.isArray(artifact.parts)) {
                            artifact.parts.forEach((part) => {
                                // Handle different part kinds according to ADCP spec
                                switch (part.kind) {
                                    case 'data':
                                        if (part.data && part.data.products && Array.isArray(part.data.products)) {
                                            extractedData = extractedData.concat(part.data.products);
                                            
                                            // Extract additional campaign context data
                                            if (part.data.campaign_context) {
                                                additionalData.campaign_context = part.data.campaign_context;
                                            }
                                            if (part.data.targeting_options) {
                                                additionalData.targeting_options = part.data.targeting_options;
                                            }
                                            if (part.data.campaign_recommendations) {
                                                additionalData.campaign_recommendations = part.data.campaign_recommendations;
                                            }
                                        }
                                        break;
                                    case 'file':
                                        files.push({
                                            name: part.name,
                                            mimeType: part.mimeType,
                                            uri: part.uri,
                                            size: part.size
                                        });
                                        break;
                                    case 'text':
                                        // Store text responses for context
                                        if (!additionalData.text_responses) {
                                            additionalData.text_responses = [];
                                        }
                                        additionalData.text_responses.push(part.text);
                                        break;
                                }
                            });
                        }
                    });
                }
                
                return {
                    response: {
                        task_created: true,
                        task_id: result.id,
                        task_status: result.status.state,
                        products: extractedData,
                        total_products_found: extractedData.length,
                        files: files,
                        total_files: files.length,
                        additional_data: additionalData,
                        message: `Agent created task ${result.id} with status: ${result.status.state}. Found ${extractedData.length} products${files.length > 0 ? ` and ${files.length} files` : ''}.`
                    },
                    debugLogs
                };
            } else {
                // Direct response or unexpected format
                return {
                    response: {
                        direct_response: true,
                        message: 'Agent responded directly',
                        full_response: result
                    },
                    debugLogs
                };
            }
        } catch (error) {
            console.error(`A2A agent error for ${agent.id}:`, error);
            return {
                response: {
                    error: true,
                    message: error.message,
                    agent_id: agent.id,
                    agent_name: agent.name,
                    recommendation: "Check that the A2A agent is properly configured and responding correctly"
                },
                debugLogs
            };
        }
    }

    /**
     * Query MCP protocol agent for inventory using proper tool discovery
     */
    async queryMCPAgent(agent, brandStory, userProvidedOffering = null, toolName = 'get_products') {
        // Array to collect debug logs
        const debugLogs = [];
        
        const client = await this.getMCPClient(agent, debugLogs);
        
        try {
            // Initialize the MCP session first
            const initResult = await client.initialize();
            
            // Log successful initialization
            debugLogs.push({
                timestamp: new Date().toISOString(),
                type: 'info',
                protocol: 'MCP',
                message: 'MCP session initialized successfully',
                init_result: initResult
            });
            
            // First discover available tools
            const toolsResponse = await client.listTools();
            const tools = toolsResponse.tools;
            
            // Log tools discovery
            debugLogs.push({
                timestamp: new Date().toISOString(),
                type: 'info',
                protocol: 'MCP',
                message: `Discovered ${tools.length} tools`,
                tools: tools.map(t => ({ name: t.name, description: t.description }))
            });
            
            // Look for the specified tool
            let targetTool = tools.find(t => t.name === toolName);
            
            // Fallback to other product/inventory related tools
            if (!targetTool) {
                if (toolName === 'get_products') {
                    targetTool = tools.find(t => 
                        t.name.includes('product') || 
                        t.name.includes('inventory') ||
                        t.name.includes('discover')
                    );
                } else if (toolName === 'create_media_buy') {
                    targetTool = tools.find(t => 
                        t.name.includes('media') ||
                        t.name.includes('buy') ||
                        t.name.includes('create') ||
                        t.name.includes('campaign')
                    );
                }
            }
            
            if (!targetTool) {
                return {
                    response: {
                        error: true,
                        message: `No ${toolName} tool found. Available tools: ${tools.map(t => t.name).join(', ')}`,
                        available_tools: tools.map(t => ({ 
                            name: t.name, 
                            description: t.description 
                        }))
                    },
                    debugLogs
                };
            }
            
            // Build tool arguments
            let toolArguments;
            
            if (toolName === 'get_products') {
                toolArguments = {
                    req: {
                        brief: brandStory,
                        promoted_offering: userProvidedOffering || 'Testing product for advertising campaign discovery',
                        strategy_id: null
                    }
                };
            } else if (toolName === 'create_media_buy') {
                toolArguments = {
                    req: {
                        brief: brandStory,
                        promoted_offering: userProvidedOffering || 'Testing product for advertising campaign discovery',
                        packages: [],
                        budget: {},
                        start_time: new Date().toISOString(),
                        end_time: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
                    }
                };
            } else {
                toolArguments = {
                    req: {
                        brief: brandStory,
                        promoted_offering: userProvidedOffering || 'Testing product for advertising campaign discovery'
                    }
                };
            }
            
            const toolCall = {
                name: targetTool.name,
                arguments: toolArguments
            };
            
            const response = await client.callTool(toolCall);
            
            // Log successful tool call
            debugLogs.push({
                timestamp: new Date().toISOString(),
                type: 'info',
                protocol: 'MCP',
                message: `Successfully called tool: ${targetTool.name}`,
                tool_call: toolCall,
                response_summary: {
                    has_data: !!response,
                    response_type: typeof response
                }
            });

            // Parse MCP response to extract products and format consistently
            let extractedData = [];
            let files = [];
            let additionalData = {};
            let responseMessage = "MCP agent response received";

            if (response.content && Array.isArray(response.content)) {
                // Parse content array for text responses containing JSON
                response.content.forEach(contentItem => {
                    if (contentItem.type === 'text' && contentItem.text) {
                        try {
                            // Try to parse the text as JSON (common pattern for MCP agents)
                            const parsedText = JSON.parse(contentItem.text);
                            if (parsedText.products && Array.isArray(parsedText.products)) {
                                extractedData = extractedData.concat(parsedText.products);
                            }
                            if (parsedText.message) {
                                responseMessage = parsedText.message;
                            }
                        } catch (e) {
                            // Not JSON, treat as plain text response
                            if (!additionalData.text_responses) {
                                additionalData.text_responses = [];
                            }
                            additionalData.text_responses.push(contentItem.text);
                        }
                    }
                });
            }
            
            // Also check for structuredContent (some agents provide this) - but avoid duplicates
            if (extractedData.length === 0 && response.structuredContent && response.structuredContent.products) {
                if (Array.isArray(response.structuredContent.products)) {
                    extractedData = extractedData.concat(response.structuredContent.products);
                }
                if (response.structuredContent.message) {
                    responseMessage = response.structuredContent.message;
                }
            }
            
            // Check for error state
            if (response.isError === true) {
                return {
                    response: {
                        error: true,
                        message: responseMessage || "MCP agent returned an error",
                        agent_name: agent.name,
                        raw_response: response
                    },
                    debugLogs
                };
            }

            return { 
                response: {
                    task_created: true,
                    task_id: `mcp_${Date.now()}`,
                    task_status: "completed",
                    products: extractedData,
                    total_products_found: extractedData.length,
                    files: files,
                    total_files: files.length,
                    additional_data: additionalData,
                    message: `${responseMessage}. Found ${extractedData.length} products${files.length > 0 ? ` and ${files.length} files` : ''}.`,
                    raw_mcp_response: response
                }, 
                debugLogs
            };
            
        } catch (error) {
            console.error(`MCP agent error for ${agent.name}:`, error);
            
            // Log the error for debugging
            debugLogs.push({
                timestamp: new Date().toISOString(),
                type: 'error',
                protocol: 'MCP',
                message: `MCP agent error: ${error.message}`,
                error: error.message,
                error_stack: error.stack,
                agent_name: agent.name
            });
            
            return {
                response: {
                    error: true,
                    message: error.message,
                    agent_name: agent.name,
                    recommendation: "Check that the MCP agent is properly configured and implements the expected tools"
                },
                debugLogs
            };
        }
    }

    /**
     * Get available sales agents
     */
    async getSalesAgents() {
        return {
            success: true,
            agents: this.getConfiguredAgents()
        };
    }

    /**
     * Discover capabilities of a specific agent
     */
    async discoverAgentCapabilities(agentId) {
        const agents = this.getConfiguredAgents();
        const agent = agents.find(a => a.id === agentId);
        
        if (!agent) {
            throw new Error(`Agent ${agentId} not found`);
        }

        const capabilities = {
            agent_id: agentId,
            agent_name: agent.name,
            protocol: agent.protocol,
            agent_uri: agent.agent_uri,
            requires_auth: agent.requiresAuth !== false
        };

        try {
            if (agent.protocol === 'mcp') {
                // Discover MCP tools
                const client = await this.getMCPClient(agent);
                const toolsResponse = await client.listTools();
                const tools = toolsResponse.tools;
                
                capabilities.mcp_capabilities = {
                    available_tools: tools.map(t => ({
                        name: t.name,
                        description: t.description,
                        input_schema: t.inputSchema
                    })),
                    total_tools: tools.length,
                    has_product_tools: tools.some(t => 
                        t.name === 'get_products' || 
                        t.name.includes('product') || 
                        t.name.includes('inventory')
                    )
                };
            } else if (agent.protocol === 'a2a') {
                // Check A2A agent card
                const authHeaders = {};
                if (agent.requiresAuth !== false && agent.auth_token_env) {
                    const authToken = agent.auth_token_env;
                    authHeaders['Authorization'] = `Bearer ${authToken}`;
                }

                const response = await fetch(agent.agent_uri, {
                    method: 'GET',
                    headers: authHeaders
                });

                if (response.ok) {
                    const agentCard = await response.json();
                    capabilities.a2a_capabilities = {
                        agent_card: agentCard,
                        has_messaging_url: !!agentCard.url,
                        has_skills: !!agentCard.skills && agentCard.skills.length > 0,
                        protocol_version: agentCard.protocolVersion || agentCard.protocol_version,
                        supports_parts_array: agentCard.capabilities?.parts_array_format || true, // ADCP PR #48 standard
                        supports_streaming: agentCard.capabilities?.streaming,
                        supports_explicit_skills: agentCard.capabilities?.explicit_skill_invocation !== false,
                        supports_natural_language: agentCard.capabilities?.natural_language_invocation !== false,
                        available_skills: agentCard.skills?.map(skill => ({
                            name: skill.name,
                            description: skill.description,
                            parameters: skill.parameters
                        })) || []
                    };
                } else {
                    capabilities.a2a_capabilities = {
                        error: `Could not fetch agent card: ${response.status} ${response.statusText}`
                    };
                }
            }

            return capabilities;
        } catch (error) {
            capabilities.error = error.message;
            return capabilities;
        }
    }

    /**
     * Query a single sales agent for inventory
     */
    async querySalesAgent(agentId, brandStory, userProvidedOffering = null, customAgentConfig = null, toolName = 'get_products') {
        try {
            let agent;
            
            // If custom agent config is provided, use it
            if (customAgentConfig && customAgentConfig.id === agentId) {
                agent = {
                    id: customAgentConfig.id,
                    name: customAgentConfig.name || customAgentConfig.id,
                    agent_uri: customAgentConfig.server_url || customAgentConfig.agent_uri,
                    protocol: customAgentConfig.protocol || 'mcp',
                    auth_token_env: customAgentConfig.auth_token_env,
                    requiresAuth: customAgentConfig.requiresAuth !== false
                };
            } else {
                // Fall back to environment-configured agents
                const agents = this.getConfiguredAgents();
                agent = agents.find(a => a.id === agentId);
                if (!agent) {
                    throw new Error(`Sales agent ${agentId} not found`);
                }
            }

            const startTime = Date.now();
            let response, debugLogs = [], validation = null;

            // Query based on protocol
            if (agent.protocol === 'a2a') {
                const result = await this.queryA2AAgent(agent, brandStory, userProvidedOffering, toolName);
                response = result.response;
                debugLogs = result.debugLogs || [];
                validation = result.validation || null;
                
                if (result.response && result.response.error) {
                    throw new Error(result.response.message || 'A2A agent returned an error');
                }
            } else if (agent.protocol === 'mcp') {
                const result = await this.queryMCPAgent(agent, brandStory, userProvidedOffering, toolName);
                response = result.response;
                debugLogs = result.debugLogs || [];
                validation = result.validation || null;
                
                if (result.response && result.response.error) {
                    throw new Error(result.response.message || 'MCP agent returned an error');
                }
            } else {
                throw new Error(`Unsupported protocol: ${agent.protocol}`);
            }

            return {
                success: true,
                agent_id: agentId,
                agent_name: agent.name,
                protocol: agent.protocol,
                inventory_response: response,
                debug_logs: debugLogs,
                validation: validation,
                metadata: {
                    timestamp: new Date().toISOString(),
                    response_time_ms: Date.now() - startTime,
                    agent_uri: agent.agent_uri
                }
            };

        } catch (error) {
            console.error(`Error querying sales agent ${agentId}:`, error);
            
            return {
                success: false,
                agent_id: agentId,
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * Get standard creative formats
     */
    async fetchStandardFormats() {
        // Return basic standard formats
        const iabStandardFormats = [
            {
                format_id: 'display_300x250',
                name: 'Medium Rectangle',
                type: 'display',
                is_standard: true,
                iab_specification: 'IAB Standard Ad Unit',
                requirements: 'Standard display banner',
                assets_required: [{
                    asset_id: 'image',
                    asset_type: 'image',
                    width: 300,
                    height: 250,
                    required: true
                }]
            },
            {
                format_id: 'display_728x90',
                name: 'Leaderboard',
                type: 'display',
                is_standard: true,
                iab_specification: 'IAB Standard Ad Unit',
                requirements: 'Standard display banner',
                assets_required: [{
                    asset_id: 'image',
                    asset_type: 'image',
                    width: 728,
                    height: 90,
                    required: true
                }]
            }
        ];
        
        return iabStandardFormats.map(format => ({
            ...format,
            source: 'adcp_standard'
        }));
    }
}

module.exports = { SalesAgentsHandlers };