// Official MCP client implementation using HTTP streaming transport with SSE fallback
import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { createMCPAuthHeaders } from '../auth';

// Re-export for convenience
export { UnauthorizedError };

/**
 * Options for MCP tool calls with OAuth support
 */
export interface MCPCallOptions {
  /** Agent URL */
  agentUrl: string;
  /** Tool name to call */
  toolName: string;
  /** Tool arguments */
  args: any;
  /** Static auth token (legacy) */
  authToken?: string;
  /** OAuth provider for dynamic auth */
  authProvider?: OAuthClientProvider;
  /** Debug logs array */
  debugLogs?: any[];
  /** Additional headers to send with every request (auth headers take precedence) */
  customHeaders?: Record<string, string>;
}

/**
 * Result of an MCP connection attempt
 */
export interface MCPConnectionResult {
  client: MCPClient;
  transport: StreamableHTTPClientTransport;
}

export async function callMCPTool(
  agentUrl: string,
  toolName: string,
  args: any,
  authToken?: string,
  debugLogs: any[] = [],
  customHeaders?: Record<string, string>
): Promise<any> {
  let mcpClient: MCPClient | undefined = undefined;
  const baseUrl = new URL(agentUrl);

  // Merge: custom < auth (auth always wins)
  const authHeaders = {
    ...customHeaders,
    ...(authToken ? createMCPAuthHeaders(authToken) : {}),
  };

  // Log auth configuration (token values redacted)
  debugLogs.push({
    type: 'info',
    message: `MCP: Auth configuration`,
    timestamp: new Date().toISOString(),
    hasAuth: !!authToken,
    headers: authToken ? { 'x-adcp-auth': '***' } : {},
    customHeaderKeys: customHeaders ? Object.keys(customHeaders) : [],
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

    // A 404 StreamableHTTPError means the server supports StreamableHTTP but the
    // session was stale/expired (the initialize POST succeeded, then the GET SSE
    // stream got a 404 for the new session ID). Retry with a fresh connection
    // instead of falling back to SSE.
    const isSessionError = error instanceof StreamableHTTPError && error.code === 404;

    if (isSessionError) {
      debugLogs.push({
        type: 'info',
        message: `MCP: Session error detected, retrying StreamableHTTP for ${toolName}`,
        timestamp: new Date().toISOString(),
      });

      mcpClient = new MCPClient({
        name: 'AdCP-Testing-Framework',
        version: '1.0.0',
      });

      const retryTransport = new StreamableHTTPClientTransport(baseUrl, {
        requestInit: {
          headers: authHeaders,
        },
      });
      await mcpClient.connect(retryTransport);

      debugLogs.push({
        type: 'success',
        message: `MCP: Connected using StreamableHTTP transport (retry) for ${toolName}`,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Non-session error — fall back to SSE transport
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

/**
 * Connect to an MCP server with OAuth support
 *
 * This function handles both static token auth and OAuth flows.
 * When using OAuth, if the server requires authorization:
 * 1. UnauthorizedError is thrown
 * 2. The OAuth provider's redirectToAuthorization is called
 * 3. Caller should wait for callback and call finishAuth on transport
 *
 * @param options Connection options
 * @returns MCP client and transport (for finishing OAuth if needed)
 * @throws UnauthorizedError if OAuth is required
 *
 * @example
 * ```typescript
 * // With OAuth provider
 * const provider = createCLIOAuthProvider(serverUrl);
 *
 * try {
 *   const { client, transport } = await connectMCP({
 *     agentUrl: serverUrl,
 *     authProvider: provider
 *   });
 *   // Connected! Use client...
 * } catch (error) {
 *   if (error instanceof UnauthorizedError) {
 *     // OAuth flow started, wait for callback
 *     const code = await provider.waitForCallback();
 *     await transport.finishAuth(code);
 *     // Retry connection...
 *   }
 * }
 * ```
 */
export async function connectMCP(options: {
  agentUrl: string;
  authToken?: string;
  authProvider?: OAuthClientProvider;
  debugLogs?: any[];
}): Promise<MCPConnectionResult> {
  const { agentUrl, authToken, authProvider, debugLogs = [] } = options;
  const baseUrl = new URL(agentUrl);

  debugLogs.push({
    type: 'info',
    message: `MCP: Connecting to ${baseUrl}`,
    timestamp: new Date().toISOString(),
    authMethod: authProvider ? 'oauth' : authToken ? 'token' : 'none',
  });

  const mcpClient = new MCPClient({
    name: 'AdCP-Client',
    version: '1.0.0',
  });

  // Build transport options
  const transportOptions: StreamableHTTPClientTransportOptions = {};

  if (authProvider) {
    // Use OAuth provider
    transportOptions.authProvider = authProvider;
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using OAuth provider for authentication',
      timestamp: new Date().toISOString(),
    });
  } else if (authToken) {
    // Use static token
    const authHeaders = createMCPAuthHeaders(authToken);
    transportOptions.requestInit = { headers: authHeaders };
    debugLogs.push({
      type: 'info',
      message: 'MCP: Using static token for authentication',
      timestamp: new Date().toISOString(),
    });
  }

  const transport = new StreamableHTTPClientTransport(baseUrl, transportOptions);

  try {
    await mcpClient.connect(transport);
    debugLogs.push({
      type: 'success',
      message: 'MCP: Connected successfully',
      timestamp: new Date().toISOString(),
    });
    return { client: mcpClient, transport };
  } catch (error) {
    // If it's an UnauthorizedError, the OAuth flow has started
    // Rethrow so the caller can handle the callback
    if (error instanceof UnauthorizedError) {
      debugLogs.push({
        type: 'info',
        message: 'MCP: OAuth authorization required, flow initiated',
        timestamp: new Date().toISOString(),
      });
      // Return transport so caller can call finishAuth
      throw Object.assign(error, { transport, client: mcpClient });
    }
    throw error;
  }
}

/**
 * Call an MCP tool with OAuth support
 *
 * This is an enhanced version of callMCPTool that supports OAuth.
 * For simple cases with static tokens, use the original callMCPTool.
 *
 * @param options Call options
 * @returns Tool response
 * @throws UnauthorizedError if OAuth is required (with transport attached)
 */
export async function callMCPToolWithOAuth(options: MCPCallOptions): Promise<any> {
  const { agentUrl, toolName, args, authToken, authProvider, debugLogs = [] } = options;

  // If no OAuth provider, use the legacy function
  if (!authProvider) {
    return callMCPTool(agentUrl, toolName, args, authToken, debugLogs);
  }

  let client: MCPClient | undefined;
  let transport: StreamableHTTPClientTransport | undefined;

  try {
    const result = await connectMCP({
      agentUrl,
      authProvider,
      debugLogs,
    });
    client = result.client;
    transport = result.transport;

    debugLogs.push({
      type: 'info',
      message: `MCP: Calling tool ${toolName}`,
      timestamp: new Date().toISOString(),
    });

    const response = await client.callTool({
      name: toolName,
      arguments: args,
    });

    debugLogs.push({
      type: response?.isError ? 'error' : 'success',
      message: `MCP: Tool ${toolName} response received`,
      timestamp: new Date().toISOString(),
    });

    if (response?.isError && response?.content && Array.isArray(response.content)) {
      const errorText = response.content
        .filter((item: any) => item.type === 'text' && item.text)
        .map((item: any) => item.text)
        .join('\n');
      throw new Error(errorText || `MCP tool '${toolName}' execution failed`);
    }

    return response;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}
