// Official MCP client implementation using HTTP streaming transport with SSE fallback
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export async function callMCPTool(
  agentUrl: string,
  toolName: string,
  args: any,
  authToken?: string
): Promise<any> {
  let mcpClient: MCPClient | undefined = undefined;
  const baseUrl = new URL(agentUrl);
  
  // Prepare auth headers for StreamableHTTP transport
  const requestInit: RequestInit = {};
  if (authToken) {
    requestInit.headers = {
      'x-adcp-auth': authToken,
      'Accept': 'application/json, text/event-stream' // Required by MCP server
    };
    console.log('Auth token provided:', authToken.substring(0, 10) + '...');
  }
  
  try {
    // First, try to connect using StreamableHTTPClientTransport
    mcpClient = new MCPClient({
      name: 'AdCP-Testing-Framework',
      version: '1.0.0'
    });
    
    // Use the SDK with proper header authentication
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit
    });
    await mcpClient.connect(transport);
    console.log('Connected to MCP using StreamableHTTP transport');
  } catch (error) {
    // If StreamableHTTP fails, fall back to SSE transport
    console.log('StreamableHTTP connection failed, falling back to SSE transport:', error);
    
    mcpClient = new MCPClient({
      name: 'AdCP-Testing-Framework',
      version: '1.0.0'
    });
    
    // For SSE fallback, add auth to URL (if SSE transport supports it)
    if (authToken) {
      baseUrl.searchParams.set('auth', authToken);
    }
    
    const sseTransport = new SSEClientTransport(baseUrl);
    await mcpClient.connect(sseTransport);
    console.log('Connected to MCP using SSE transport');
  }
  
  try {
    // Call the tool using official MCP client
    console.log(`Calling tool: ${toolName} with args:`, JSON.stringify(args));
    const response = await mcpClient.callTool({
      name: toolName,
      arguments: args
    });
    console.log('Tool response received:', response?.isError ? 'error' : 'success');
    
    return response;
  } finally {
    // Always close the client properly
    if (mcpClient) {
      await mcpClient.close();
    }
  }
}