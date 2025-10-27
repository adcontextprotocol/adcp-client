// Official A2A client implementation - NO FALLBACKS
import { logger } from '../utils/logger';

const clientModule = require('@a2a-js/sdk/client');
const A2AClient = clientModule.A2AClient;

if (!A2AClient) {
  throw new Error('A2A SDK client is required. Please install @a2a-js/sdk');
}

const a2aLogger = logger.child('A2A');

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, any>,
  authToken?: string,
  debugLogs: any[] = []
): Promise<any> {
  // Create authenticated fetch that wraps native fetch
  // This ensures ALL requests (including agent card fetching) include auth headers
  const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
    // Build headers - always start with existing headers, then add auth if available
    const existingHeaders: Record<string, string> = {};
    if (options?.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(options.headers)) {
        for (const [key, value] of options.headers) {
          existingHeaders[key] = value;
        }
      } else {
        Object.assign(existingHeaders, options.headers);
      }
    }

    // Add auth headers if token is provided - these override any existing auth headers
    const headers: Record<string, string> = {
      ...existingHeaders,
      ...(authToken && {
        'Authorization': `Bearer ${authToken}`,
        'x-adcp-auth': authToken
      })
    };

    const logMeta = {
      hasAuth: !!authToken,
      headers: authToken
        ? { ...headers, 'Authorization': 'Bearer ***', 'x-adcp-auth': '***' }
        : headers
    };

    debugLogs.push({
      type: 'info',
      message: `A2A: Fetch to ${typeof url === 'string' ? url : url.toString()}`,
      timestamp: new Date().toISOString(),
      ...logMeta
    });

    a2aLogger.debug(`Fetch to ${typeof url === 'string' ? url : url.toString()}`, logMeta);

    return fetch(url, {
      ...options,
      headers
    });
  };

  // Create A2A client using the recommended fromCardUrl method
  // Ensure the URL points to the agent card endpoint
  const cardUrl = agentUrl.endsWith('/.well-known/agent-card.json')
    ? agentUrl
    : agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';

  debugLogs.push({
    type: 'info',
    message: `A2A: Creating client for ${cardUrl}`,
    timestamp: new Date().toISOString()
  });

  a2aLogger.debug(`Creating client for ${cardUrl}`);

  const a2aClient = await A2AClient.fromCardUrl(cardUrl, {
    fetchImpl
  });
  
  // Build request payload following AdCP A2A spec
  const requestPayload = {
    message: {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: "user",
      kind: "message",  // Required by A2A spec
      parts: [{
        kind: "data",  // A2A spec uses "kind", not "type"
        data: {
          skill: toolName,
          input: parameters  // A2A spec uses "input", not "parameters"
        }
      }]
    }
  };
  
  // Add debug log for A2A call
  const payloadSize = JSON.stringify(requestPayload).length;
  const callMeta = { payloadSize, skill: toolName, parameters };

  debugLogs.push({
    type: 'info',
    message: `A2A: Calling skill ${toolName} with input: ${JSON.stringify(parameters)}. Payload size: ${payloadSize} bytes`,
    timestamp: new Date().toISOString(),
    payloadSize,
    actualPayload: requestPayload
  });

  a2aLogger.debug(`Calling skill ${toolName}`, callMeta);

  // Send message using A2A protocol
  debugLogs.push({
    type: 'info',
    message: `A2A: Sending message via sendMessage()`,
    timestamp: new Date().toISOString(),
    skill: toolName
  });

  a2aLogger.debug('Sending message via sendMessage()', { skill: toolName });

  const messageResponse = await a2aClient.sendMessage(requestPayload);

  // Add debug log for A2A response
  const isError = messageResponse?.error || messageResponse?.result?.error;
  const responseMeta = { skill: toolName, hasError: !!isError };

  debugLogs.push({
    type: isError ? 'error' : 'success',
    message: `A2A: Response received (${isError ? 'error' : 'success'})`,
    timestamp: new Date().toISOString(),
    response: messageResponse,
    skill: toolName
  });

  if (isError) {
    a2aLogger.error('Response received with error', responseMeta);
  } else {
    a2aLogger.debug('Response received successfully', responseMeta);
  }

  // Check for JSON-RPC error in response
  if (isError) {
    const errorObj = messageResponse.error || messageResponse.result?.error;
    const errorMessage = errorObj.message || JSON.stringify(errorObj);
    throw new Error(`A2A agent returned error: ${errorMessage}`);
  }
  
  return messageResponse;
}