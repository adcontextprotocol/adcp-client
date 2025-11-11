// Official MCP client implementation using HTTP streaming transport with SSE fallback
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createMCPAuthHeaders } from '../auth';

export async function callMCPTool(
  agentUrl: string,
  toolName: string,
  args: any,
  authToken?: string,
  debugLogs: any[] = []
): Promise<any> {
  let mcpClient: MCPClient | undefined = undefined;
  const baseUrl = new URL(agentUrl);

  // Create a custom fetch function that adds auth headers to every request
  // Always provide a custom fetch to ensure consistent header handling across all MCP requests
  const authHeaders = authToken ? createMCPAuthHeaders(authToken) : {};

  if (authToken) {
    // Add to debug logs only when auth is configured
    debugLogs.push({
      type: 'info',
      message: `MCP: Auth token provided (${authToken.substring(0, 10)}...) for tool ${toolName}`,
      timestamp: new Date().toISOString(),
      headers: authHeaders,
    });

    debugLogs.push({
      type: 'info',
      message: `MCP: Setting auth headers: ${JSON.stringify(authHeaders)}`,
      timestamp: new Date().toISOString(),
    });
  }

  // Log auth configuration
  debugLogs.push({
    type: 'info',
    message: `MCP: Auth configuration`,
    timestamp: new Date().toISOString(),
    hasAuth: !!authToken,
    headers: authToken ? { 'x-adcp-auth': '***' } : {},
  });

  try {
    // First, try to connect using StreamableHTTPClientTransport
    debugLogs.push({
      type: 'info',
      message: `MCP: Attempting StreamableHTTP connection to ${baseUrl} for ${toolName}`,
      timestamp: new Date().toISOString(),
    });

    mcpClient = new MCPClient({
      name: 'AdCP-Testing-Framework',
      version: '1.0.0',
    });

    // Use the SDK with requestInit headers for authentication
    // The SDK's StreamableHTTPClientTransport will use these headers for ALL requests
    // Note: authHeaders already includes 'Accept: application/json, text/event-stream' from createMCPAuthHeaders
    const transport = new StreamableHTTPClientTransport(baseUrl, {
      requestInit: {
        headers: authHeaders,
      },
    });
    await mcpClient.connect(transport);

    debugLogs.push({
      type: 'success',
      message: `MCP: Connected using StreamableHTTP transport for ${toolName}`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    // Capture the connection error
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLogs.push({
      type: 'error',
      message: `MCP: StreamableHTTP connection failed for ${toolName}: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error: error,
    });

    // If StreamableHTTP fails, fall back to SSE transport
    debugLogs.push({
      type: 'info',
      message: `MCP: Falling back to SSE transport for ${toolName}`,
      timestamp: new Date().toISOString(),
    });

    mcpClient = new MCPClient({
      name: 'AdCP-Testing-Framework',
      version: '1.0.0',
    });

    // For SSE fallback, add auth to URL (if SSE transport supports it)
    if (authToken) {
      baseUrl.searchParams.set('auth', authToken);
    }

    const sseTransport = new SSEClientTransport(baseUrl);
    await mcpClient.connect(sseTransport);

    debugLogs.push({
      type: 'success',
      message: `MCP: Connected using SSE transport for ${toolName}`,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    // Call the tool using official MCP client
    debugLogs.push({
      type: 'info',
      message: `MCP: Calling tool ${toolName} with args: ${JSON.stringify(args)}`,
      timestamp: new Date().toISOString(),
    });

    // For debugging: log the transport headers being used
    if (authToken) {
      debugLogs.push({
        type: 'info',
        message: `MCP: Transport configured with x-adcp-auth header for ${toolName}`,
        timestamp: new Date().toISOString(),
      });
    }

    const response = await mcpClient.callTool({
      name: toolName,
      arguments: args,
    });

    debugLogs.push({
      type: response?.isError ? 'error' : 'success',
      message: `MCP: Tool ${toolName} response received (${response?.isError ? 'error' : 'success'})`,
      timestamp: new Date().toISOString(),
      response: response,
    });

    // If MCP returns an error response, throw an error with the extracted message
    // This ensures the error is properly caught and handled by the executor
    if (response?.isError && response?.content && Array.isArray(response.content)) {
      const errorText = response.content
        .filter((item: any) => item.type === 'text' && item.text)
        .map((item: any) => item.text)
        .join('\n');

      throw new Error(errorText || `MCP tool '${toolName}' execution failed (no error details provided)`);
    }

    return response;
  } catch (error) {
    // Capture tool call errors (including timeouts)
    const errorMessage = error instanceof Error ? error.message : String(error);
    debugLogs.push({
      type: 'error',
      message: `MCP: Tool ${toolName} call failed: ${errorMessage}`,
      timestamp: new Date().toISOString(),
      error: error,
    });

    // If this is an auth error, log additional debugging info
    if (errorMessage.toLowerCase().includes('auth') || errorMessage.toLowerCase().includes('unauthorized')) {
      debugLogs.push({
        type: 'warning',
        message: `MCP: Authentication issue detected for ${toolName} - headers may not be reaching server`,
        timestamp: new Date().toISOString(),
      });
    }

    throw error; // Re-throw to maintain error handling
  } finally {
    // Always close the client properly
    if (mcpClient) {
      try {
        await mcpClient.close();
        debugLogs.push({
          type: 'info',
          message: `MCP: Client connection closed for ${toolName}`,
          timestamp: new Date().toISOString(),
        });
      } catch (closeError) {
        debugLogs.push({
          type: 'warning',
          message: `MCP: Error closing client for ${toolName}: ${closeError}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}
