/**
 * Node.js adaptation of your working Cloudflare Workers sales-agents-handlers.js
 * This preserves your original working logic but adapts it for Node.js environment
 */

// Use native fetch (available in Node.js 18+)

// Import A2A client with proper error handling
let A2AClient = null;
try {
    // Try to import the A2A client from the client module
    const clientModule = require('@a2a-js/sdk/client');
    A2AClient = clientModule.A2AClient;
    if (A2AClient) {
        console.log('✅ A2A SDK client imported successfully in handlers');
    } else {
        throw new Error('A2AClient not found in client module');
    }
} catch (error) {
    console.warn('⚠️ A2A SDK import failed in handlers:', error.message);
    console.log('📄 Using HTTP fallback approach for A2A protocol');
    A2AClient = null;
}

/**
 * Tracks multi-step protocol operations as a single logical unit
 */
class OperationLogger {
    constructor(operationName, protocol, agentName) {
        this.operationName = operationName;
        this.protocol = protocol;
        this.agentName = agentName;
        this.startTime = Date.now();
        this.lastStepTime = this.startTime;
        this.steps = [];
        this.rawLogs = [];
        this.metadata = {};
        
        // Size limits to prevent memory bloat
        this.MAX_STEPS = 50; // Maximum steps per operation
        this.MAX_RAW_LOGS = 100; // Maximum raw logs per operation
        this.MAX_LOG_SIZE = 10000; // Maximum size in characters per log entry
    }
    
    addStep(stepName, status, details = {}) {
        const now = Date.now();
        
        // Truncate details if too large
        const truncatedDetails = this._truncateObject(details);
        
        this.steps.push({
            step: stepName,
            status,
            duration_ms: now - this.lastStepTime,
            timestamp: new Date(now).toISOString(),
            details: truncatedDetails
        });
        
        // Rotate steps if we exceed max count
        if (this.steps.length > this.MAX_STEPS) {
            this.steps.shift(); // Remove oldest step
        }
        
        this.lastStepTime = now;
    }
    
    addRawLog(log) {
        // Sanitize sensitive data before logging
        const sanitizedLog = SecurityUtils.sanitizeLogEntry(log);
        
        // Truncate log if too large
        const truncatedLog = this._truncateObject(sanitizedLog);
        
        this.rawLogs.push(truncatedLog);
        
        // Rotate raw logs if we exceed max count
        if (this.rawLogs.length > this.MAX_RAW_LOGS) {
            this.rawLogs.shift(); // Remove oldest log
        }
    }
    
    /**
     * Truncate object to prevent memory bloat
     */
    _truncateObject(obj) {
        if (!obj) return obj;
        
        try {
            const jsonStr = JSON.stringify(obj);
            if (jsonStr.length <= this.MAX_LOG_SIZE) {
                return obj; // No truncation needed
            }
            
            // Truncate string and add indicator
            const truncated = jsonStr.substring(0, this.MAX_LOG_SIZE - 50);
            const truncatedObj = JSON.parse(truncated + '"}');
            truncatedObj._truncated = `Original size: ${jsonStr.length} chars, truncated to: ${this.MAX_LOG_SIZE} chars`;
            
            return truncatedObj;
        } catch (error) {
            // If truncation fails, return a safe minimal object
            return {
                _error: 'Failed to serialize/truncate log object',
                _originalType: typeof obj,
                _size: 'unknown'
            };
        }
    }
    
    setMetadata(key, value) {
        this.metadata[key] = value;
    }
    
    complete(success, summary, result = {}) {
        const totalDuration = Date.now() - this.startTime;
        return {
            type: 'operation',
            operation: this.operationName,
            protocol: this.protocol,
            agent_name: this.agentName,
            timestamp: new Date(this.startTime).toISOString(),
            duration_ms: totalDuration,
            status: success ? 'success' : 'failed',
            summary,
            steps: this.steps,
            metadata: this.metadata,
            result,
            rawLogs: this.rawLogs, // Available for detailed debugging
            step_count: this.steps.length
        };
    }
}

/**
 * Security utilities for token sanitization in logging
 */
class SecurityUtils {
    /**
     * Sanitize sensitive data from headers for logging
     */
    static sanitizeHeaders(headers = {}) {
        const sanitized = { ...headers };
        
        // List of sensitive header keys
        const sensitiveHeaders = [
            'authorization',
            'x-adcp-auth',
            'x-api-key',
            'cookie',
            'set-cookie',
            'proxy-authorization',
            'www-authenticate'
        ];
        
        for (const [key, value] of Object.entries(sanitized)) {
            if (sensitiveHeaders.includes(key.toLowerCase())) {
                if (typeof value === 'string' && value.length > 0) {
                    // Show only first 4 and last 4 characters for debugging context
                    sanitized[key] = value.length > 8 
                        ? `${value.substring(0, 4)}****${value.substring(value.length - 4)}`
                        : '****';
                } else {
                    sanitized[key] = '****';
                }
            }
        }
        
        return sanitized;
    }
    
    /**
     * Sanitize tokens from request/response body for logging
     */
    static sanitizeBody(body) {
        if (!body) return body;
        
        try {
            if (typeof body === 'string') {
                // Try to parse as JSON to sanitize tokens
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    // Not JSON, sanitize as string
                    return this.sanitizeStringTokens(body);
                }
                
                return JSON.stringify(this.sanitizeObjectTokens(parsed));
            } else if (typeof body === 'object') {
                return this.sanitizeObjectTokens(body);
            }
            
            return body;
        } catch {
            return '[SANITIZATION_ERROR]';
        }
    }
    
    /**
     * Recursively sanitize tokens from object properties
     */
    static sanitizeObjectTokens(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        
        const sensitiveKeys = [
            'token', 'auth_token', 'access_token', 'refresh_token',
            'api_key', 'secret', 'password', 'authorization',
            'x-adcp-auth', 'bearer'
        ];
        
        const sanitized = Array.isArray(obj) ? [] : {};
        
        for (const [key, value] of Object.entries(obj)) {
            const keyLower = key.toLowerCase();
            
            if (sensitiveKeys.some(sensitive => keyLower.includes(sensitive))) {
                // Sanitize sensitive values
                if (typeof value === 'string' && value.length > 0) {
                    sanitized[key] = value.length > 8 
                        ? `${value.substring(0, 4)}****${value.substring(value.length - 4)}`
                        : '****';
                } else {
                    sanitized[key] = '****';
                }
            } else if (typeof value === 'object') {
                // Recursively sanitize nested objects
                sanitized[key] = this.sanitizeObjectTokens(value);
            } else {
                sanitized[key] = value;
            }
        }
        
        return sanitized;
    }
    
    /**
     * Sanitize tokens from string content (URLs, raw text)
     */
    static sanitizeStringTokens(str) {
        if (typeof str !== 'string') return str;
        
        // Common token patterns in URLs and strings
        const tokenPatterns = [
            /([?&](?:token|auth|key|secret)=)[^&\s]+/gi,
            /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/gi,
            /Basic\s+[A-Za-z0-9+/]+=*/gi,
            /(?:token|key|secret)[:=]\s*["']?[A-Za-z0-9\-_]{16,}["']?/gi
        ];
        
        let sanitized = str;
        tokenPatterns.forEach(pattern => {
            sanitized = sanitized.replace(pattern, (match, prefix) => {
                if (prefix) {
                    return `${prefix}****`;
                }
                return match.substring(0, Math.min(8, match.length)) + '****';
            });
        });
        
        return sanitized;
    }
    
    /**
     * Sanitize complete log entry before adding to debug logs
     */
    static sanitizeLogEntry(logEntry) {
        if (!logEntry || typeof logEntry !== 'object') return logEntry;
        
        const sanitized = { ...logEntry };
        
        // Sanitize headers
        if (sanitized.headers) {
            sanitized.headers = this.sanitizeHeaders(sanitized.headers);
        }
        
        // Sanitize request/response bodies
        if (sanitized.body) {
            sanitized.body = this.sanitizeBody(sanitized.body);
        }
        if (sanitized.response) {
            sanitized.response = this.sanitizeBody(sanitized.response);
        }
        
        // Sanitize URL
        if (sanitized.url) {
            sanitized.url = this.sanitizeStringTokens(sanitized.url);
        }
        
        // Sanitize any other string properties
        for (const [key, value] of Object.entries(sanitized)) {
            if (typeof value === 'string' && key !== 'body' && key !== 'response') {
                sanitized[key] = this.sanitizeStringTokens(value);
            }
        }
        
        return sanitized;
    }
    
    /**
     * Validate authentication token format and basic security properties
     */
    static validateAuthToken(token) {
        if (!token || typeof token !== 'string') {
            return { valid: false, reason: 'Token must be a non-empty string' };
        }
        
        // Trim whitespace
        token = token.trim();
        
        if (token.length === 0) {
            return { valid: false, reason: 'Token cannot be empty or whitespace only' };
        }
        
        // Check minimum length for security
        if (token.length < 16) {
            return { valid: false, reason: 'Token too short (minimum 16 characters)' };
        }
        
        // Check for common insecure patterns
        const insecurePatterns = [
            /^(test|demo|example|sample|default|admin|password|secret)$/i,
            /^(123|abc|aaa|xxx)+$/i,
            /^\d{1,10}$/,  // Just numbers
            /^[a]{16,}$/i, // All A's
            /^.{1,3}$/     // Too short
        ];
        
        for (const pattern of insecurePatterns) {
            if (pattern.test(token)) {
                return { valid: false, reason: 'Token appears to be a placeholder or test value' };
            }
        }
        
        // Check for environment variable patterns that weren't resolved
        if (token.includes('${') || token.includes('$')) {
            return { valid: false, reason: 'Token appears to contain unresolved environment variables' };
        }
        
        return { valid: true, token: token };
    }
    
    /**
     * Standardized error handling for agent protocols
     */
    static createStandardError(type, error, context = {}) {
        const baseError = {
            timestamp: new Date().toISOString(),
            success: false,
            protocol: context.protocol || 'unknown',
            agent_name: context.agentName || context.agent_name || 'unknown',
            agent_id: context.agentId || context.agent_id || context.id || 'unknown'
        };
        
        // Standard error types with consistent messaging
        switch (type) {
            case 'network':
                return {
                    ...baseError,
                    error_type: 'network_error',
                    error: `Network request failed: ${error.message}`,
                    message: error.message,
                    recommendation: "Check agent connectivity and network configuration",
                    retry_possible: true,
                    ...context.additionalData
                };
                
            case 'authentication':
                return {
                    ...baseError,
                    error_type: 'authentication_error',
                    error: `Authentication failed: ${error.message}`,
                    message: error.message,
                    recommendation: "Verify authentication token and permissions",
                    retry_possible: false,
                    ...context.additionalData
                };
                
            case 'protocol':
                return {
                    ...baseError,
                    error_type: 'protocol_error',
                    error: `Protocol error: ${error.message}`,
                    message: error.message,
                    recommendation: "Check protocol implementation and message format",
                    retry_possible: false,
                    ...context.additionalData
                };
                
            case 'timeout':
                return {
                    ...baseError,
                    error_type: 'timeout_error',
                    error: `Request timed out: ${error.message}`,
                    message: error.message,
                    recommendation: "Try again or increase timeout value",
                    retry_possible: true,
                    ...context.additionalData
                };
                
            case 'validation':
                return {
                    ...baseError,
                    error_type: 'validation_error',
                    error: `Input validation failed: ${error.message}`,
                    message: error.message,
                    recommendation: "Check request format and required parameters",
                    retry_possible: false,
                    ...context.additionalData
                };
                
            case 'rate_limit':
                return {
                    ...baseError,
                    error_type: 'rate_limit_error',
                    error: `Rate limit exceeded: ${error.message}`,
                    message: error.message,
                    recommendation: "Wait before retrying or reduce request frequency",
                    retry_possible: true,
                    retry_after: context.retryAfter || 60,
                    ...context.additionalData
                };
                
            case 'server':
                return {
                    ...baseError,
                    error_type: 'server_error',
                    error: `Server error: ${error.message}`,
                    message: error.message,
                    recommendation: "Check agent server status and configuration",
                    retry_possible: true,
                    ...context.additionalData
                };
                
            default:
                return {
                    ...baseError,
                    error_type: 'general_error',
                    error: error.message || 'Unknown error occurred',
                    message: error.message || 'Unknown error occurred',
                    recommendation: "Check logs for more details",
                    retry_possible: true,
                    ...context.additionalData
                };
        }
    }
    
    /**
     * Classify error type based on error characteristics
     */
    static classifyError(error, response = null) {
        if (!error) return 'general';
        
        const message = error.message?.toLowerCase() || '';
        const status = response?.status || error.status || 0;
        
        // Network-related errors
        if (message.includes('network') || message.includes('connection') || 
            message.includes('fetch') || message.includes('econnrefused') ||
            message.includes('enotfound') || message.includes('timeout')) {
            return status >= 500 ? 'server' : 'network';
        }
        
        // Authentication errors
        if (status === 401 || status === 403 || 
            message.includes('unauthorized') || message.includes('auth') ||
            message.includes('token') || message.includes('permission')) {
            return 'authentication';
        }
        
        // Protocol errors
        if (message.includes('protocol') || message.includes('json-rpc') ||
            message.includes('invalid format') || message.includes('parse')) {
            return 'protocol';
        }
        
        // Validation errors
        if (status === 400 || message.includes('validation') || 
            message.includes('invalid') || message.includes('required')) {
            return 'validation';
        }
        
        // Rate limiting
        if (status === 429 || message.includes('rate limit') || 
            message.includes('too many requests')) {
            return 'rate_limit';
        }
        
        // Timeout errors
        if (message.includes('timeout') || message.includes('timed out')) {
            return 'timeout';
        }
        
        // Server errors
        if (status >= 500) {
            return 'server';
        }
        
        return 'general';
    }
    
    /**
     * Manage debug log arrays with size limits and rotation
     */
    static manageDebugLogs(debugLogsArray, newEntry, maxSize = 100, maxEntrySize = 5000) {
        if (!Array.isArray(debugLogsArray)) {
            console.warn('manageDebugLogs called with non-array, creating new array');
            debugLogsArray = [];
        }
        
        // Truncate the new entry if it's too large
        let processedEntry = newEntry;
        if (newEntry && typeof newEntry === 'object') {
            try {
                const jsonStr = JSON.stringify(newEntry);
                if (jsonStr.length > maxEntrySize) {
                    const truncated = jsonStr.substring(0, maxEntrySize - 100);
                    processedEntry = JSON.parse(truncated + '"}');
                    processedEntry._truncated = `Original: ${jsonStr.length} chars, truncated to: ${maxEntrySize} chars`;
                }
            } catch (error) {
                processedEntry = {
                    _error: 'Failed to process log entry',
                    _originalType: typeof newEntry,
                    _timestamp: new Date().toISOString()
                };
            }
        }
        
        // Add the entry
        debugLogsArray.push(processedEntry);
        
        // Rotate if too many entries
        while (debugLogsArray.length > maxSize) {
            debugLogsArray.shift(); // Remove oldest entry
        }
        
        return debugLogsArray;
    }
    
    /**
     * Get memory usage statistics for debug logs
     */
    static getDebugLogStats(debugLogsArray) {
        if (!Array.isArray(debugLogsArray)) return { error: 'Not an array' };
        
        try {
            const jsonStr = JSON.stringify(debugLogsArray);
            const sizeInBytes = new TextEncoder().encode(jsonStr).length;
            const sizeInKB = Math.round(sizeInBytes / 1024 * 100) / 100;
            
            return {
                entryCount: debugLogsArray.length,
                sizeInBytes,
                sizeInKB,
                averageEntrySize: Math.round(sizeInBytes / (debugLogsArray.length || 1)),
                truncatedEntries: debugLogsArray.filter(entry => 
                    entry && typeof entry === 'object' && entry._truncated
                ).length
            };
        } catch (error) {
            return {
                error: 'Failed to calculate stats',
                entryCount: debugLogsArray.length,
                errorMessage: error.message
            };
        }
    }
}

/**
 * Client lifecycle management and resource cleanup utilities
 */
class ClientManager {
    constructor() {
        this.clients = new Map(); // clientKey -> client metadata
        this.MAX_CLIENTS_PER_AGENT = 3;
        this.CLIENT_IDLE_TIMEOUT = 300000; // 5 minutes
        this.CLIENT_MAX_AGE = 1800000; // 30 minutes
        
        // Start cleanup timer
        this.cleanupTimer = setInterval(() => {
            this.cleanupIdleClients();
        }, 60000); // Check every minute
    }
    
    /**
     * Generate unique key for client caching
     */
    getClientKey(agent, protocol) {
        return `${protocol}:${agent.agent_uri}:${agent.agent_name || 'unnamed'}`;
    }
    
    /**
     * Get cached client if available and still valid
     */
    getCachedClient(agent, protocol) {
        const key = this.getClientKey(agent, protocol);
        const clientMeta = this.clients.get(key);
        
        if (!clientMeta) return null;
        
        const now = Date.now();
        
        // Check if client is too old
        if (now - clientMeta.created > this.CLIENT_MAX_AGE) {
            this.disposeClient(key);
            return null;
        }
        
        // Update last used time
        clientMeta.lastUsed = now;
        return clientMeta.client;
    }
    
    /**
     * Store client in cache with metadata
     */
    cacheClient(agent, protocol, client) {
        const key = this.getClientKey(agent, protocol);
        const now = Date.now();
        
        // Clean up any existing client for this key
        this.disposeClient(key);
        
        // Check if we have too many clients for this agent already
        const agentClients = Array.from(this.clients.keys()).filter(k => 
            k.startsWith(`${protocol}:${agent.agent_uri}:`)
        );
        
        if (agentClients.length >= this.MAX_CLIENTS_PER_AGENT) {
            // Remove the oldest client for this agent
            const oldestKey = agentClients
                .map(k => ({ key: k, meta: this.clients.get(k) }))
                .sort((a, b) => a.meta.lastUsed - b.meta.lastUsed)[0].key;
            
            this.disposeClient(oldestKey);
        }
        
        this.clients.set(key, {
            client,
            created: now,
            lastUsed: now,
            protocol,
            agentUri: agent.agent_uri,
            agentName: agent.agent_name || 'unnamed'
        });
    }
    
    /**
     * Dispose of a specific client and clean up resources
     */
    disposeClient(clientKey) {
        const clientMeta = this.clients.get(clientKey);
        if (!clientMeta) return;
        
        try {
            // Attempt to close/cleanup the client if it has cleanup methods
            if (clientMeta.client && typeof clientMeta.client.close === 'function') {
                clientMeta.client.close();
            }
            if (clientMeta.client && typeof clientMeta.client.disconnect === 'function') {
                clientMeta.client.disconnect();
            }
            if (clientMeta.client && typeof clientMeta.client.destroy === 'function') {
                clientMeta.client.destroy();
            }
        } catch (error) {
            console.warn(`Error disposing client ${clientKey}:`, error.message);
        }
        
        this.clients.delete(clientKey);
    }
    
    /**
     * Clean up idle clients that haven't been used recently
     */
    cleanupIdleClients() {
        const now = Date.now();
        const keysToRemove = [];
        
        for (const [key, clientMeta] of this.clients) {
            const idleTime = now - clientMeta.lastUsed;
            const age = now - clientMeta.created;
            
            if (idleTime > this.CLIENT_IDLE_TIMEOUT || age > this.CLIENT_MAX_AGE) {
                keysToRemove.push(key);
            }
        }
        
        keysToRemove.forEach(key => {
            this.disposeClient(key);
        });
        
        if (keysToRemove.length > 0) {
            console.log(`Cleaned up ${keysToRemove.length} idle/expired clients`);
        }
    }
    
    /**
     * Get client statistics for monitoring
     */
    getStats() {
        const now = Date.now();
        const stats = {
            totalClients: this.clients.size,
            clientsByProtocol: {},
            clientsByAge: { fresh: 0, old: 0, expired: 0 },
            clientsByIdle: { active: 0, idle: 0, stale: 0 }
        };
        
        for (const [key, clientMeta] of this.clients) {
            // By protocol
            stats.clientsByProtocol[clientMeta.protocol] = 
                (stats.clientsByProtocol[clientMeta.protocol] || 0) + 1;
            
            // By age
            const age = now - clientMeta.created;
            if (age < 300000) stats.clientsByAge.fresh++;
            else if (age < this.CLIENT_MAX_AGE) stats.clientsByAge.old++;
            else stats.clientsByAge.expired++;
            
            // By idle time
            const idleTime = now - clientMeta.lastUsed;
            if (idleTime < 60000) stats.clientsByIdle.active++;
            else if (idleTime < this.CLIENT_IDLE_TIMEOUT) stats.clientsByIdle.idle++;
            else stats.clientsByIdle.stale++;
        }
        
        return stats;
    }
    
    /**
     * Dispose of all clients and stop cleanup timer
     */
    shutdown() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        
        const keys = Array.from(this.clients.keys());
        keys.forEach(key => this.disposeClient(key));
        
        console.log(`ClientManager shutdown: disposed of ${keys.length} clients`);
    }
}

class SalesAgentsHandlers {
    constructor(env) {
        this.env = env;
        this.clientManager = new ClientManager();
        this.MAX_CONCURRENT_REQUESTS = 5;
        this.REQUEST_TIMEOUT = 30000;
        
        // Concurrent request limiting
        this.concurrentRequests = 0;
        this.requestQueue = [];
        this.requestStats = {
            total: 0,
            completed: 0,
            failed: 0,
            queued: 0,
            rejected: 0
        };
        
        // Handle graceful shutdown
        this.setupShutdownHandlers();
    }
    
    /**
     * Setup graceful shutdown handlers for proper resource cleanup
     */
    setupShutdownHandlers() {
        const cleanup = () => {
            console.log('Shutting down SalesAgentsHandlers...');
            if (this.clientManager) {
                this.clientManager.shutdown();
            }
        };
        
        // Handle various shutdown signals
        process.on('SIGTERM', cleanup);
        process.on('SIGINT', cleanup);
        process.on('beforeExit', cleanup);
        
        // Handle uncaught exceptions to ensure cleanup
        process.on('uncaughtException', (error) => {
            console.error('Uncaught exception:', error);
            cleanup();
            process.exit(1);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled rejection at:', promise, 'reason:', reason);
            cleanup();
            process.exit(1);
        });
    }
    
    /**
     * Acquire a concurrent request slot
     */
    async acquireRequestSlot() {
        return new Promise((resolve, reject) => {
            this.requestStats.total++;
            
            if (this.concurrentRequests < this.MAX_CONCURRENT_REQUESTS) {
                // Slot available immediately
                this.concurrentRequests++;
                resolve();
            } else {
                // Queue the request
                this.requestStats.queued++;
                const queueEntry = {
                    resolve,
                    reject,
                    timestamp: Date.now(),
                    timeout: setTimeout(() => {
                        // Request timed out in queue
                        this.removeFromQueue(queueEntry);
                        this.requestStats.queued--;
                        this.requestStats.rejected++;
                        reject(new Error('Request timed out in queue'));
                    }, this.REQUEST_TIMEOUT)
                };
                
                this.requestQueue.push(queueEntry);
                
                // Limit queue size to prevent memory issues
                const maxQueueSize = this.MAX_CONCURRENT_REQUESTS * 10; // 10x the concurrent limit
                if (this.requestQueue.length > maxQueueSize) {
                    // Remove oldest queued request
                    const oldest = this.requestQueue.shift();
                    clearTimeout(oldest.timeout);
                    this.requestStats.queued--;
                    this.requestStats.rejected++;
                    oldest.reject(new Error('Request queue full, oldest request dropped'));
                }
            }
        });
    }
    
    /**
     * Release a concurrent request slot
     */
    releaseRequestSlot() {
        this.concurrentRequests = Math.max(0, this.concurrentRequests - 1);
        
        // Process next item in queue if available
        if (this.requestQueue.length > 0 && this.concurrentRequests < this.MAX_CONCURRENT_REQUESTS) {
            const nextRequest = this.requestQueue.shift();
            clearTimeout(nextRequest.timeout);
            this.concurrentRequests++;
            this.requestStats.queued--;
            nextRequest.resolve();
        }
    }
    
    /**
     * Remove a specific entry from the queue
     */
    removeFromQueue(targetEntry) {
        const index = this.requestQueue.indexOf(targetEntry);
        if (index !== -1) {
            this.requestQueue.splice(index, 1);
            clearTimeout(targetEntry.timeout);
        }
    }
    
    /**
     * Execute a function with concurrent request limiting
     */
    async withConcurrencyLimit(asyncFunction) {
        await this.acquireRequestSlot();
        
        try {
            const result = await asyncFunction();
            this.requestStats.completed++;
            return result;
        } catch (error) {
            this.requestStats.failed++;
            throw error;
        } finally {
            this.releaseRequestSlot();
        }
    }
    
    /**
     * Get concurrent request statistics
     */
    getConcurrencyStats() {
        return {
            currentConcurrent: this.concurrentRequests,
            maxConcurrent: this.MAX_CONCURRENT_REQUESTS,
            queueLength: this.requestQueue.length,
            queueOldestWaitTime: this.requestQueue.length > 0 
                ? Date.now() - this.requestQueue[0].timestamp 
                : 0,
            stats: { ...this.requestStats }
        };
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
            
            // Block private IP ranges and localhost (security: always enforce, regardless of environment)
            const hostname = parsedUrl.hostname.toLowerCase();
            
            // Check for development allowlist first
            const devAllowedHosts = (process.env.ADCP_DEV_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase());
            const isDevAllowed = process.env.NODE_ENV !== 'production' && devAllowedHosts.includes(hostname);
            
            if (!isDevAllowed) {
                // Block localhost variants
                if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::]'].includes(hostname)) {
                    throw new Error('Localhost access not allowed for security reasons');
                }
                
                // Block private IPv4 ranges (RFC 1918)
                if (hostname.match(/^192\.168\.\d+\.\d+$/) ||
                    hostname.match(/^10\.\d+\.\d+\.\d+$/) ||
                    hostname.match(/^172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+$/)) {
                    throw new Error('Private IP range access not allowed for security reasons');
                }
                
                // Block link-local addresses
                if (hostname.match(/^169\.254\.\d+\.\d+$/) ||
                    hostname.match(/^fe80::/i)) {
                    throw new Error('Link-local address access not allowed for security reasons');
                }
                
                // Block IPv6 localhost and private ranges
                if (hostname.match(/^::1$/) ||
                    hostname.match(/^fc00::/i) ||
                    hostname.match(/^fd00::/i)) {
                    throw new Error('Private IPv6 address access not allowed for security reasons');
                }
            }
            
            // Block metadata endpoints (use already declared hostname variable)
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
    async getMCPClient(agent, debugLogs = [], operationLogger = null) {
        const url = agent.agent_uri;
        
        // Validate URL before creating client
        this.validateAgentUrl(url);
        
        // Try to get cached client first, but only for agents that don't require fresh sessions
        let cachedClient = null;
        if (!agent.requiresFreshSession) {
            cachedClient = this.clientManager.getCachedClient(agent, 'mcp');
            if (cachedClient) {
                return cachedClient;
            }
        }
        
        // Get auth token if required
        let authToken = null;
        if (agent.requiresAuth !== false && agent.auth_token_env) {
            // Validate the auth token before using it
            const tokenValidation = SecurityUtils.validateAuthToken(agent.auth_token_env);
            if (tokenValidation.valid) {
                authToken = tokenValidation.token;
            } else {
                console.warn(`Invalid MCP auth token for agent ${agent.agent_name}: ${tokenValidation.reason}`);
                // Continue without token - let the agent handle authentication failure
            }
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
            
            // Only add MCP auth headers when agent explicitly requires authentication
            // This prevents leaking authentication attempts to public endpoints
            if (agent.requiresAuth !== false && authToken) {
                if (!headers['x-adcp-auth']) {
                    headers['x-adcp-auth'] = authToken;
                }
                if (!headers['Authorization']) {
                    headers['Authorization'] = `Bearer ${authToken}`;
                }
            } else if (agent.requiresAuth !== false && !authToken) {
                // Agent requires auth but no token provided - this will likely fail
                // but we should let the agent respond with proper error
                if (!headers['x-adcp-auth']) {
                    headers['x-adcp-auth'] = 'unauthenticated';
                }
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
                SecurityUtils.manageDebugLogs(logs, SecurityUtils.sanitizeLogEntry(debugEntry));
            }
            
            // Also log to OperationLogger if provided
            if (operationLogger) {
                operationLogger.addRawLog(debugEntry);
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
                    SecurityUtils.manageDebugLogs(logs, SecurityUtils.sanitizeLogEntry(errorEntry));
                }
                
                // Also log to OperationLogger if provided
                if (operationLogger) {
                    operationLogger.addRawLog(errorEntry);
                    operationLogger.addStep(mcpMethod, 'error', { error: error.message });
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
                SecurityUtils.manageDebugLogs(logs, SecurityUtils.sanitizeLogEntry(responseEntry));
            }
            
            // Also log to OperationLogger if provided
            if (operationLogger) {
                operationLogger.addRawLog(responseEntry);
                operationLogger.addStep(mcpMethod, response.status, { 
                    response_type: mcpResponseType,
                    session_id: mcpSessionId,
                    has_error: !!mcpError,
                    duration_ms: requestEnd - requestStart
                });
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
        
        // Cache the client if it doesn't require fresh sessions
        if (!agent.requiresFreshSession) {
            this.clientManager.cacheClient(agent, 'mcp', mockMcpClient);
        }
        
        return mockMcpClient;
    }

    /**
     * Get or create A2A client for agent (HTTP fallback)
     */
    async getA2AClient(agent, debugLogs = []) {
        const url = agent.agent_uri;
        
        // Try to get cached client first
        const cachedClient = this.clientManager.getCachedClient(agent, 'a2a');
        if (cachedClient) {
            return cachedClient;
        }
        
        // Get auth token if required
        let authToken = null;
        if (agent.requiresAuth !== false && agent.auth_token_env) {
            // Validate the auth token before using it
            const tokenValidation = SecurityUtils.validateAuthToken(agent.auth_token_env);
            if (tokenValidation.valid) {
                authToken = tokenValidation.token;
            } else {
                console.warn(`Invalid A2A auth token for agent ${agent.agent_name}: ${tokenValidation.reason}`);
                // Continue without token - let the agent handle authentication failure
            }
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
                SecurityUtils.manageDebugLogs(logs, SecurityUtils.sanitizeLogEntry(debugEntry));
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
                SecurityUtils.manageDebugLogs(logs, SecurityUtils.sanitizeLogEntry(responseEntry));
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
        
        // Cache the client for reuse
        this.clientManager.cacheClient(agent, 'a2a', mockClient);
        
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
    createA2AMessage(messageId, requestText, toolName, brandStory, userProvidedOffering, additionalParams = {}) {
        // Build comprehensive text request with AdCP-compliant parameters
        let paramText = `TOOL REQUEST: ${toolName}\nBRIEF: ${brandStory}${userProvidedOffering ? `\nPROMOTED OFFERING: ${userProvidedOffering}` : ''}`;

        // Add AdCP version
        paramText += `\nADCP VERSION: ${additionalParams.adcp_version || '1.6.0'}`;

        // Add filters if present
        if (toolName === 'get_products' && (additionalParams.filters || additionalParams.delivery_type || additionalParams.format_types || additionalParams.is_fixed_price)) {
            paramText += '\n\nFILTERS:';

            const filters = additionalParams.filters || {};
            const deliveryType = additionalParams.delivery_type || filters.delivery_type;
            const formatTypes = additionalParams.format_types || filters.format_types;
            const isFixedPrice = additionalParams.is_fixed_price !== undefined ? additionalParams.is_fixed_price : filters.is_fixed_price;

            if (deliveryType) {
                paramText += `\n- Delivery Type: ${deliveryType}`;
            }
            if (formatTypes && formatTypes.length > 0) {
                paramText += `\n- Format Types: ${formatTypes.join(', ')}`;
            }
            if (isFixedPrice !== undefined) {
                paramText += `\n- Fixed Price Only: ${isFixedPrice ? 'Yes' : 'No'}`;
            }
        }

        const fullRequestText = `${requestText}\n\n${paramText}`;

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
                parts: baseParts
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
    async queryA2AAgent(agent, brandStory, userProvidedOffering = null, toolName = 'get_products', additionalParams = {}) {
        // Apply concurrent request limiting
        return await this.withConcurrencyLimit(async () => {
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
                additionalParams
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
                    userProvidedOffering,
                    additionalParams
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
                                // Handle different part kinds according to A2A spec
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
        }); // End of concurrency limiter
    }

    /**
     * Query MCP protocol agent for inventory using proper tool discovery
     */
    async queryMCPAgent(agent, brandStory, userProvidedOffering = null, toolName = 'get_products', additionalParams = {}) {
        // Apply concurrent request limiting
        return await this.withConcurrencyLimit(async () => {
            // Create operation logger to track the entire MCP operation
        const operationLogger = new OperationLogger(
            `mcp_${toolName}`,
            'MCP',
            agent.name
        );
        
        // Legacy debug logs array for compatibility
        const debugLogs = [];
        
        const client = await this.getMCPClient(agent, debugLogs, operationLogger);
        
        operationLogger.setMetadata('agent_uri', agent.agent_uri);
        operationLogger.setMetadata('tool_name', toolName);
        operationLogger.setMetadata('requires_auth', agent.requiresAuth !== false);
        
        try {
            // Initialize the MCP session first
            const initResult = await client.initialize();
            operationLogger.setMetadata('protocol_version', initResult?.protocolVersion);
            operationLogger.setMetadata('server_info', initResult?.serverInfo);
            
            // First discover available tools
            const toolsResponse = await client.listTools();
            const tools = toolsResponse.tools;
            operationLogger.setMetadata('available_tools', tools.map(t => ({ name: t.name, description: t.description })));
            
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
                // Build AdCP-compliant get_products request
                const req = {
                    promoted_offering: userProvidedOffering || 'Testing product for advertising campaign discovery'
                };

                // Add optional AdCP parameters
                if (brandStory) {
                    req.brief = brandStory;
                }

                // Add adcp_version if provided, otherwise use package version
                req.adcp_version = additionalParams.adcp_version || '1.6.0';

                // Add filters if provided
                if (additionalParams.filters || additionalParams.delivery_type || additionalParams.format_types || additionalParams.is_fixed_price) {
                    req.filters = {};

                    // Handle nested filters object
                    if (additionalParams.filters) {
                        Object.assign(req.filters, additionalParams.filters);
                    }

                    // Handle top-level filter parameters (for backward compatibility)
                    if (additionalParams.delivery_type) {
                        req.filters.delivery_type = additionalParams.delivery_type;
                    }
                    if (additionalParams.format_types) {
                        req.filters.format_types = additionalParams.format_types;
                    }
                    if (additionalParams.is_fixed_price !== undefined) {
                        req.filters.is_fixed_price = additionalParams.is_fixed_price;
                    }
                    if (additionalParams.format_ids) {
                        req.filters.format_ids = additionalParams.format_ids;
                    }
                    if (additionalParams.standard_formats_only !== undefined) {
                        req.filters.standard_formats_only = additionalParams.standard_formats_only;
                    }
                }

                // Include any other additional params that might be relevant
                Object.keys(additionalParams).forEach(key => {
                    if (!['delivery_type', 'format_types', 'is_fixed_price', 'format_ids', 'standard_formats_only', 'filters', 'adcp_version'].includes(key)) {
                        req[key] = additionalParams[key];
                    }
                });

                toolArguments = { req };
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
                // For all other tools (list_creative_formats, list_creatives, etc.)
                // Build request with AdCP version and merge in all additionalParams
                const req = {
                    adcp_version: additionalParams.adcp_version || '1.6.0'
                };

                // Add brief and offering if provided
                if (brandStory) {
                    req.brief = brandStory;
                }
                if (userProvidedOffering) {
                    req.promoted_offering = userProvidedOffering;
                }

                // Merge in all additional parameters
                Object.keys(additionalParams).forEach(key => {
                    if (key !== 'adcp_version') {
                        req[key] = additionalParams[key];
                    }
                });

                toolArguments = { req };
            }
            
            const toolCall = {
                name: targetTool.name,
                arguments: toolArguments
            };
            
            const response = await client.callTool(toolCall);
            
            // Tool call completed - metadata tracked by operationLogger automatically

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
                const errorMessage = responseMessage || "MCP agent returned an error";
                const operationLog = operationLogger.complete(false, errorMessage, {
                    error: true,
                    message: errorMessage,
                    agent_name: agent.name
                });
                
                return {
                    response: {
                        error: true,
                        message: errorMessage,
                        agent_name: agent.name,
                        raw_response: response
                    },
                    debugLogs: [operationLog] // Return the grouped operation log
                };
            }

            const successMessage = `${responseMessage} - Found ${extractedData.length} products${files.length > 0 ? ` and ${files.length} files` : ''}`;
            operationLogger.setMetadata('products_found', extractedData.length);
            operationLogger.setMetadata('files_found', files.length);
            
            const operationLog = operationLogger.complete(true, successMessage, {
                task_created: true,
                task_id: `mcp_${Date.now()}`,
                task_status: "completed",
                products: extractedData,
                total_products_found: extractedData.length,
                files: files,
                total_files: files.length,
                additional_data: additionalData,
                message: `${responseMessage}. Found ${extractedData.length} products${files.length > 0 ? ` and ${files.length} files` : ''}.`
            });

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
                debugLogs: [operationLog] // Return the grouped operation log
            };
            
        } catch (error) {
            console.error(`MCP agent error for ${agent.name}:`, error);
            
            const errorMessage = `MCP agent error: ${error.message}`;
            const operationLog = operationLogger.complete(false, errorMessage, {
                error: true,
                message: error.message,
                agent_name: agent.name,
                error_stack: error.stack,
                recommendation: "Check that the MCP agent is properly configured and implements the expected tools"
            });
            
            return {
                response: {
                    error: true,
                    message: error.message,
                    agent_name: agent.name,
                    recommendation: "Check that the MCP agent is properly configured and implements the expected tools"
                },
                debugLogs: [operationLog] // Return the grouped operation log
            };
        }
        }); // End of concurrency limiter
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
                    // Validate the auth token before using it
                    const tokenValidation = SecurityUtils.validateAuthToken(agent.auth_token_env);
                    if (tokenValidation.valid) {
                        authHeaders['Authorization'] = `Bearer ${tokenValidation.token}`;
                    } else {
                        console.warn(`Invalid auth token for tool discovery on agent ${agent.agent_name}: ${tokenValidation.reason}`);
                        // Continue without token - let the agent handle authentication failure
                    }
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
    async querySalesAgent(agentId, brandStory, userProvidedOffering = null, customAgentConfig = null, toolName = 'get_products', additionalParams = {}) {
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
                const result = await this.queryA2AAgent(agent, brandStory, userProvidedOffering, toolName, additionalParams);
                response = result.response;
                debugLogs = result.debugLogs || [];
                validation = result.validation || null;

                if (result.response && result.response.error) {
                    throw new Error(result.response.message || 'A2A agent returned an error');
                }
            } else if (agent.protocol === 'mcp') {
                const result = await this.queryMCPAgent(agent, brandStory, userProvidedOffering, toolName, additionalParams);
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
