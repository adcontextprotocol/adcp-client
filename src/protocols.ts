// Official protocol clients - ALWAYS USE THESE, NO FALLBACKS
import { callMCPTool } from './mcp-client.js';
import { callA2ATool } from './a2a-client.js';

console.log('✅ Official protocol clients loaded');
import { 
  AgentConfig, 
  TestResult, 
  CreativeFormat, 
  CreativeLibraryItem,
  ManageCreativeAssetsRequest,
  ManageCreativeAssetsResponse,
  SyncCreativesRequest,
  SyncCreativesResponse,
  ListCreativesRequest,
  ListCreativesResponse
} from './types/adcp';

// Always use real agents - no more simulated responses
const USE_REAL_AGENTS = true;

// Configuration constants
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '30000'); // 30 seconds
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '5');

/**
 * Circuit Breaker for handling agent failures
 */
class CircuitBreaker {
  private failures = 0;
  private lastFailTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private readonly failureThreshold = 5;
  private readonly resetTimeout = 60000; // 1 minute
  
  constructor(private agentId: string) {}
  
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailTime > this.resetTimeout) {
        this.state = 'half-open';
        console.log(`🔄 Circuit breaker for ${this.agentId} attempting to close...`);
      } else {
        throw new Error(`Circuit breaker is open for agent ${this.agentId}`);
      }
    }
    
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
  
  private onSuccess(): void {
    this.failures = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
      console.log(`✅ Circuit breaker for ${this.agentId} closed successfully`);
    }
  }
  
  private onFailure(): void {
    this.failures++;
    this.lastFailTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      console.log(`🚨 Circuit breaker opened for agent ${this.agentId} after ${this.failures} failures`);
    }
  }
}

// Circuit breaker instances for each agent
const circuitBreakers = new Map<string, CircuitBreaker>();

function getCircuitBreaker(agentId: string): CircuitBreaker {
  if (!circuitBreakers.has(agentId)) {
    circuitBreakers.set(agentId, new CircuitBreaker(agentId));
  }
  return circuitBreakers.get(agentId)!;
}

// Standard creative formats (hardcoded for now)
const STANDARD_FORMATS: CreativeFormat[] = [
  {
    format_id: 'banner_728x90',
    name: 'Leaderboard',
    dimensions: { width: 728, height: 90 },
    aspect_ratio: '8:1',
    file_types: ['jpg', 'jpeg', 'png', 'gif'],
    max_file_size: 150000
  },
  {
    format_id: 'banner_300x250',
    name: 'Medium Rectangle',
    dimensions: { width: 300, height: 250 },
    aspect_ratio: '6:5',
    file_types: ['jpg', 'jpeg', 'png', 'gif'],
    max_file_size: 150000
  },
  {
    format_id: 'banner_320x50',
    name: 'Mobile Banner',
    dimensions: { width: 320, height: 50 },
    aspect_ratio: '32:5',
    file_types: ['jpg', 'jpeg', 'png', 'gif'],
    max_file_size: 40000
  },
  {
    format_id: 'video_1920x1080',
    name: 'Full HD Video',
    dimensions: { width: 1920, height: 1080 },
    aspect_ratio: '16:9',
    file_types: ['mp4', 'webm'],
    max_file_size: 10000000,
    duration_range: { min: 6, max: 30 }
  }
];


/**
 * Get configured sales agents from environment variables (.env file only)
 */
export function getConfiguredAgents(): AgentConfig[] {
  const configStr = process.env.SALES_AGENTS_CONFIG;
  
  if (!configStr) {
    // No agents configured - return empty array
    // This prevents demo agents from loading when no real configuration exists
    console.log('⚠️  No SALES_AGENTS_CONFIG found - no agents will be loaded');
    console.log('💡 To enable agents, set SALES_AGENTS_CONFIG in your .env file');
    return [];
  }

  try {
    const config = JSON.parse(configStr);
    if (config.agents && Array.isArray(config.agents)) {
      console.log(`📡 Configured agents: ${config.agents.length}`);
      config.agents.forEach((agent: any) => {
        console.log(`  - ${agent.name} (${agent.protocol.toUpperCase()}) at ${agent.agent_uri}`);
      });
      console.log('🔧 Real agents mode: ENABLED');
      
      return config.agents.map((agent: any) => ({
        id: String(agent.id),
        name: String(agent.name || agent.id),
        agent_uri: String(agent.agent_uri),
        protocol: agent.protocol as 'mcp' | 'a2a',
        auth_token_env: agent.auth_token_env,
        requiresAuth: agent.requiresAuth !== false
      }));
    }
  } catch (error) {
    console.error('Failed to parse SALES_AGENTS_CONFIG:', error);
  }

  return [];
}

/**
 * Get list of available agents
 */
export async function getAgentList(): Promise<AgentConfig[]> {
  return getConfiguredAgents();
}

/**
 * Get standard creative formats
 */
export async function getStandardFormats(): Promise<CreativeFormat[]> {
  return STANDARD_FORMATS;
}


/**
 * Get expected response schema type for a given tool
 */
function getExpectedSchema(toolName: string): string {
  switch (toolName) {
    case 'get_products':
      return 'products';
    case 'list_creative_formats':
      return 'formats';
    case 'manage_creative_assets':
      return 'creative_management';
    case 'sync_creatives':
      return 'sync_response';
    case 'list_creatives':
      return 'creative_list';
    case 'add_creative_assets':
      return 'creative_upload';
    default:
      return 'generic';
  }
}

/**
 * Get authentication token for an agent
 */
function getAuthToken(agent: AgentConfig): string | undefined {
  if (!agent.requiresAuth || !agent.auth_token_env) {
    return undefined;
  }
  
  // If auth_token_env looks like a direct token (not an env var name), use it directly
  // Base64-like tokens are typically 40+ chars and contain mixed case/symbols
  if (agent.auth_token_env.length > 20 && !agent.auth_token_env.match(/^[A-Z_][A-Z0-9_]*$/)) {
    return agent.auth_token_env;
  }
  
  // Otherwise, look up the environment variable
  return process.env[agent.auth_token_env];
}

/**
 * Generate UUID for request tracking
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/**
 * Create AdCP-compliant headers
 */
function createAdCPHeaders(authToken?: string, isMCP: boolean = false): Record<string, string> {
  return {
    'Content-Type': isMCP ? 'application/json' : 'application/vnd.adcp+json',
    'AdCP-Version': '1.0',
    'AdCP-Request-ID': generateUUID(),
    'User-Agent': 'AdCP-Testing-Framework/1.0.0',
    'Accept': isMCP ? 'application/json, text/event-stream' : 'application/vnd.adcp+json, application/json',
    ...(authToken && { 'Authorization': `Bearer ${authToken}` })
  };
}

/**
 * Create an authenticated fetch function for A2A client
 */
function createAuthenticatedFetch(authToken: string) {
  return async (url: string | URL | Request, options?: RequestInit) => {
    const headers = createAdCPHeaders(authToken);
    
    return fetch(url, {
      ...options,
      headers: {
        ...headers,
        ...(options?.headers || {})
      }
    });
  };
}

/**
 * Validate agent URL to prevent SSRF attacks
 */
function validateAgentUrl(url: string): void {
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
      
      // Block metadata endpoints
      if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
        throw new Error('Metadata endpoint access not allowed');
      }
    }
    
    // Ensure reasonable URL length
    if (url.length > 2048) {
      throw new Error('URL too long');
    }
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`Invalid agent URL: ${e.message}`);
    }
    throw new Error('Invalid agent URL');
  }
}

/**
 * Validate AdCP response format and content
 */
function validateAdCPResponse(response: any, expectedSchema: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Basic response structure validation
  if (!response || typeof response !== 'object') {
    errors.push('Response is not a valid object');
    return { valid: false, errors };
  }
  
  // Check for AdCP-specific fields based on expected schema
  if (expectedSchema === 'products') {
    if (!Array.isArray(response.products)) {
      errors.push('Missing or invalid products array');
    } else {
      response.products.forEach((product: any, index: number) => {
        if (!product.id) errors.push(`Product ${index}: Missing id field`);
        if (!product.name) errors.push(`Product ${index}: Missing name field`);
        if (!product.pricing_model) errors.push(`Product ${index}: Missing pricing_model field`);
      });
    }
  }
  
  if (expectedSchema === 'formats') {
    if (!Array.isArray(response.formats) && !Array.isArray(response.creative_formats)) {
      errors.push('Missing formats/creative_formats array');
    }
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Handle AdCP response with comprehensive error checking
 */
async function handleAdCPResponse(
  response: Response, 
  expectedSchema: string,
  agentName: string
): Promise<{ success: boolean; data?: any; error?: string; warnings?: string[] }> {
  const warnings: string[] = [];
  
  // Check AdCP-specific response headers
  const adcpVersion = response.headers.get('AdCP-Version');
  if (!adcpVersion) {
    warnings.push('Missing AdCP-Version header in response');
  } else if (adcpVersion !== '1.0') {
    warnings.push(`Unexpected AdCP version: ${adcpVersion} (expected 1.0)`);
  }
  
  const responseId = response.headers.get('AdCP-Response-ID');
  if (!responseId) {
    warnings.push('Missing AdCP-Response-ID header in response');
  }
  
  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('application/vnd.adcp+json') && !contentType?.includes('application/json')) {
    warnings.push(`Unexpected content type: ${contentType} (expected application/vnd.adcp+json)`);
  }
  
  // Parse response body
  let responseData: any;
  try {
    const textResponse = await response.text();
    if (!textResponse.trim()) {
      return {
        success: false,
        error: `Empty response from ${agentName}`,
        warnings
      };
    }
    
    responseData = JSON.parse(textResponse);
  } catch (parseError) {
    return {
      success: false,
      error: `Invalid JSON response from ${agentName}: ${parseError instanceof Error ? parseError.message : 'Parse error'}`,
      warnings
    };
  }
  
  // Check for JSON-RPC error response
  if (responseData?.error || (responseData?.jsonrpc && responseData?.id !== undefined && !responseData?.result)) {
    const errorObj = responseData.error;
    return {
      success: false,
      error: `Agent returned JSON-RPC error: ${errorObj?.message || JSON.stringify(errorObj)}`,
      warnings,
      data: responseData // Include raw data for debugging
    };
  }
  
  // Validate response schema
  const validation = validateAdCPResponse(responseData, expectedSchema);
  if (!validation.valid) {
    return {
      success: false,
      error: `Schema validation failed for ${agentName}: ${validation.errors.join(', ')}`,
      warnings,
      data: responseData // Include raw data for debugging
    };
  }
  
  return {
    success: true,
    data: responseData,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

/**
 * Test MCP agent using official client with HTTP streaming
 */
async function testMCPAgent(
  agent: AgentConfig, 
  brief: string, 
  promotedOffering?: string,
  toolName: string = 'get_products'
): Promise<TestResult> {
  const startTime = Date.now();
  const circuitBreaker = getCircuitBreaker(agent.id);
  const debugLogs: any[] = [];
  
  try {
    validateAgentUrl(agent.agent_uri);
    
    // Prepare tool arguments - spec-compliant format (no wrapper)
    // AdCP spec requires promoted_offering to always be present for get_products
    const args: any = {
      brief,
      promoted_offering: promotedOffering || 'gourmet robot food' // Default to something fun
    };

    const result = await circuitBreaker.call(async () => {
      console.log(`🔗 Calling MCP agent using official client: ${agent.name} at ${agent.agent_uri}`);
      
      const authToken = getAuthToken(agent);
      
      // Log request (MCP uses x-adcp-auth header)
      debugLogs.push({
        request: {
          method: `${toolName} (MCP Tool)`,
          url: agent.agent_uri,
          headers: authToken ? { 'x-adcp-auth': authToken } : {},
          body: JSON.stringify({
            tool: toolName,
            arguments: args
          })
        },
        response: null,
        timestamp: new Date().toISOString()
      });
      
      // Call MCP tool using official client
      const response = await callMCPTool(
        agent.agent_uri,
        toolName,
        args,
        authToken
      );
      
      // Log response
      if (debugLogs.length > 0) {
        debugLogs[debugLogs.length - 1].response = {
          status: 'completed',
          body: response
        };
      }
      
      return response;
    });
    
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      success: true,
      response_time_ms: Date.now() - startTime,
      data: result,
      timestamp: new Date().toISOString(),
      debug_logs: debugLogs
    };
  } catch (error) {
    // Log error in debug logs if we have a pending request
    if (debugLogs.length > 0 && !debugLogs[debugLogs.length - 1].response) {
      debugLogs[debugLogs.length - 1].response = {
        status: 'error',
        body: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
    
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      success: false,
      response_time_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
      debug_logs: debugLogs
    };
  }
}

/**
 * Test A2A agent using official client only - NO FALLBACKS
 */
async function testA2AAgent(
  agent: AgentConfig,
  brief: string,
  promotedOffering?: string,
  toolName: string = 'get_products'
): Promise<TestResult> {
  const startTime = Date.now();
  const circuitBreaker = getCircuitBreaker(agent.id);
  const debugLogs: any[] = [];
  
  try {
    validateAgentUrl(agent.agent_uri);
    
    const result = await circuitBreaker.call(async () => {
      console.log(`🔗 Calling A2A agent using official client: ${agent.name} at ${agent.agent_uri}`);
      
      const authToken = getAuthToken(agent);
      
      // Log request
      debugLogs.push({
        request: {
          method: `${toolName} (A2A Tool)`,
          url: agent.agent_uri,
          headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
          body: JSON.stringify({
            tool: toolName,
            brief,
            ...(promotedOffering && { promoted_offering: promotedOffering })
          })
        },
        response: null,
        timestamp: new Date().toISOString()
      });
      
      // Call A2A tool using official client
      const response = await callA2ATool(
        agent.agent_uri,
        toolName,
        brief,
        promotedOffering,
        authToken
      );
      
      // Log response
      if (debugLogs.length > 0) {
        debugLogs[debugLogs.length - 1].response = {
          status: 'completed',
          body: response
        };
      }
      
      return response;
    });

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      success: true,
      response_time_ms: Date.now() - startTime,
      data: result,
      timestamp: new Date().toISOString(),
      debug_logs: debugLogs
    };
  } catch (error) {
    // Log error in debug logs if we have a pending request
    if (debugLogs.length > 0 && !debugLogs[debugLogs.length - 1].response) {
      debugLogs[debugLogs.length - 1].response = {
        status: 'error',
        body: { error: error instanceof Error ? error.message : 'Unknown error' }
      };
    }
    
    return {
      agent_id: agent.id,
      agent_name: agent.name,
      success: false,
      response_time_ms: Date.now() - startTime,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
      debug_logs: debugLogs
    };
  }
}

/**
 * Test a single agent
 */
export async function testSingleAgent(
  agentId: string,
  brief: string,
  promotedOffering?: string,
  toolName?: string
): Promise<TestResult> {
  const agents = getConfiguredAgents();
  const agent = agents.find(a => a.id === agentId);
  
  if (!agent) {
    return {
      agent_id: agentId,
      agent_name: 'Unknown',
      success: false,
      response_time_ms: 0,
      error: `Agent with ID '${agentId}' not found`,
      timestamp: new Date().toISOString()
    };
  }

  if (agent.protocol === 'mcp') {
    return testMCPAgent(agent, brief, promotedOffering, toolName);
  } else if (agent.protocol === 'a2a') {
    return testA2AAgent(agent, brief, promotedOffering, toolName);
  } else {
    return {
      agent_id: agentId,
      agent_name: agent.name,
      success: false,
      response_time_ms: 0,
      error: `Unsupported protocol: ${(agent as any).protocol}`,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Test multiple agents in parallel with concurrency control
 */
export async function testAgents(
  agentConfigs: AgentConfig[],
  brief: string,
  promotedOffering?: string,
  toolName?: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  
  // Process agents in batches to control concurrency
  for (let i = 0; i < agentConfigs.length; i += MAX_CONCURRENT) {
    const batch = agentConfigs.slice(i, i + MAX_CONCURRENT);
    
    const batchPromises = batch.map(agent => {
      if (agent.protocol === 'mcp') {
        return testMCPAgent(agent, brief, promotedOffering, toolName);
      } else if (agent.protocol === 'a2a') {
        return testA2AAgent(agent, brief, promotedOffering, toolName);
      } else {
        return Promise.resolve({
          agent_id: agent.id,
          agent_name: agent.name,
          success: false,
          response_time_ms: 0,
          error: `Unsupported protocol: ${(agent as any).protocol}`,
          timestamp: new Date().toISOString()
        });
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    
    // Convert settled results to TestResult format
    const batchTestResults = batchResults.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          agent_id: batch[index].id,
          agent_name: batch[index].name,
          success: false,
          response_time_ms: REQUEST_TIMEOUT,
          error: result.reason instanceof Error ? result.reason.message : 'Promise rejected',
          timestamp: new Date().toISOString()
        };
      }
    });

    results.push(...batchTestResults);
  }

  return results;
}
