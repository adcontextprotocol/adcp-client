// Official A2A client implementation - NO FALLBACKS
const clientModule = require('@a2a-js/sdk/client');
const A2AClient = clientModule.A2AClient;

if (!A2AClient) {
  throw new Error('A2A SDK client is required. Please install @a2a-js/sdk');
}

import { logger } from '../utils/logger';

export interface ProtocolLoggingConfig {
  enabled?: boolean;
  logRequests?: boolean;
  logResponses?: boolean;
  logRequestBodies?: boolean;
  logResponseBodies?: boolean;
  maxBodySize?: number;
  redactAuthHeaders?: boolean;
}

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, any>,
  authToken?: string,
  debugLogs: any[] = [],
  loggingConfig?: ProtocolLoggingConfig
): Promise<any> {
  // Create authenticated fetch that wraps native fetch
  // This ensures ALL requests (including agent card fetching) include auth headers
  const fetchImpl = async (url: string | URL | Request, options?: RequestInit) => {
    const startTime = Date.now();

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

    // Log request details if protocol logging is enabled
    const shouldLog = loggingConfig?.enabled === true;
    const shouldLogRequest = shouldLog && (loggingConfig?.logRequests !== false);
    const shouldLogRequestBody = shouldLog && (loggingConfig?.logRequestBodies !== false);
    const shouldRedact = loggingConfig?.redactAuthHeaders !== false;
    const maxBodySize = loggingConfig?.maxBodySize || 50000;

    if (shouldLogRequest) {
      const urlString = typeof url === 'string' ? url : url.toString();
      const method = options?.method || 'POST';

      // Prepare headers for logging (redact sensitive ones)
      const headersForLog = { ...headers };
      if (shouldRedact) {
        if (headersForLog['Authorization']) headersForLog['Authorization'] = '***REDACTED***';
        if (headersForLog['x-adcp-auth']) headersForLog['x-adcp-auth'] = '***REDACTED***';
      }

      let requestBody: any = null;
      if (shouldLogRequestBody && options?.body) {
        const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        if (bodyStr.length > maxBodySize) {
          requestBody = bodyStr.substring(0, maxBodySize) + `... [TRUNCATED: ${bodyStr.length - maxBodySize} bytes]`;
        } else {
          try {
            requestBody = JSON.parse(bodyStr);
          } catch {
            requestBody = bodyStr;
          }
        }
      }

      logger.debug('[A2A Request]', {
        protocol: 'a2a',
        method,
        url: urlString,
        headers: headersForLog,
        body: requestBody,
        timestamp: new Date().toISOString()
      });
    }

    debugLogs.push({
      type: 'info',
      message: `A2A: Fetch to ${typeof url === 'string' ? url : url.toString()}`,
      timestamp: new Date().toISOString(),
      hasAuth: !!authToken,
      headers: authToken
        ? { ...headers, 'Authorization': 'Bearer ***', 'x-adcp-auth': '***' }
        : headers
    });

    const response = await fetch(url, {
      ...options,
      headers
    });

    const latency = Date.now() - startTime;

    // Log response details if protocol logging is enabled
    const shouldLogResponse = shouldLog && (loggingConfig?.logResponses !== false);
    const shouldLogResponseBody = shouldLog && (loggingConfig?.logResponseBodies !== false);

    if (shouldLogResponse) {
      const responseHeadersObj: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeadersObj[key] = value;
      });

      let responseBody: any = null;
      if (shouldLogResponseBody && response.body) {
        // Clone response to read body without consuming it
        const clonedResponse = response.clone();
        try {
          const bodyText = await clonedResponse.text();
          if (bodyText.length > maxBodySize) {
            responseBody = bodyText.substring(0, maxBodySize) + `... [TRUNCATED: ${bodyText.length - maxBodySize} bytes]`;
          } else {
            try {
              responseBody = JSON.parse(bodyText);
            } catch {
              responseBody = bodyText;
            }
          }
        } catch (err) {
          responseBody = '[Could not read response body]';
        }
      }

      logger.debug('[A2A Response]', {
        protocol: 'a2a',
        status: response.status,
        statusText: response.statusText,
        headers: responseHeadersObj,
        body: responseBody,
        latency: `${latency}ms`,
        timestamp: new Date().toISOString()
      });
    }

    return response;
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
  debugLogs.push({
    type: 'info',
    message: `A2A: Calling skill ${toolName} with input: ${JSON.stringify(parameters)}. Payload size: ${payloadSize} bytes`,
    timestamp: new Date().toISOString(),
    payloadSize,
    actualPayload: requestPayload
  });
  
  // Send message using A2A protocol
  debugLogs.push({
    type: 'info',
    message: `A2A: Sending message via sendMessage()`,
    timestamp: new Date().toISOString(),
    skill: toolName
  });

  const messageResponse = await a2aClient.sendMessage(requestPayload);

  // Add debug log for A2A response
  debugLogs.push({
    type: messageResponse?.error ? 'error' : 'success',
    message: `A2A: Response received (${messageResponse?.error ? 'error' : 'success'})`,
    timestamp: new Date().toISOString(),
    response: messageResponse,
    skill: toolName
  });
  
  // Check for JSON-RPC error in response
  if (messageResponse?.error || messageResponse?.result?.error) {
    const errorObj = messageResponse.error || messageResponse.result?.error;
    const errorMessage = errorObj.message || JSON.stringify(errorObj);
    throw new Error(`A2A agent returned error: ${errorMessage}`);
  }
  
  return messageResponse;
}