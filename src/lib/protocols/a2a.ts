// Official A2A client implementation - NO FALLBACKS
const clientModule = require('@a2a-js/sdk/client');
const A2AClient = clientModule.A2AClient;

if (!A2AClient) {
  throw new Error('A2A SDK client is required. Please install @a2a-js/sdk');
}

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  parameters: Record<string, any>,
  authToken?: string,
  debugLogs: any[] = []
): Promise<any> {
  // Create authenticated fetch if needed
  const fetchImpl = authToken ? 
    async (url: string | URL | Request, options?: RequestInit) => {
      return fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${authToken}`,
          ...(options?.headers || {})
        }
      });
    } : undefined;
  
  // Create A2A client using the recommended fromCardUrl method
  // Ensure the URL points to the agent card endpoint
  const cardUrl = agentUrl.endsWith('/.well-known/agent-card.json') 
    ? agentUrl 
    : agentUrl.replace(/\/$/, '') + '/.well-known/agent-card.json';
    
  const a2aClient = await A2AClient.fromCardUrl(cardUrl, {
    fetchImpl
  });
  
  // Build request payload following AdCP A2A spec
  const requestPayload = {
    message: {
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: "user", 
      parts: [{
        kind: "data",  // A2A spec uses "kind", not "type"
        data: {
          skill: toolName,
          parameters
        }
      }]
    }
  };
  
  // Add debug log for A2A call
  const payloadSize = JSON.stringify(requestPayload).length;
  debugLogs.push({
    type: 'info',
    message: `A2A: Calling skill ${toolName} with parameters: ${JSON.stringify(parameters)}. Payload size: ${payloadSize} bytes`,
    timestamp: new Date().toISOString(),
    payloadSize,
    actualPayload: requestPayload
  });
  
  // Send message using A2A protocol
  const messageResponse = await a2aClient.sendMessage(requestPayload);
  
  // Add debug log for A2A response
  debugLogs.push({
    type: messageResponse?.error ? 'error' : 'success',
    message: `A2A: Response received (${messageResponse?.error ? 'error' : 'success'})`,
    timestamp: new Date().toISOString(),
    response: messageResponse
  });
  
  // Check for JSON-RPC error in response
  if (messageResponse?.error || messageResponse?.result?.error) {
    const errorObj = messageResponse.error || messageResponse.result?.error;
    const errorMessage = errorObj.message || JSON.stringify(errorObj);
    throw new Error(`A2A agent returned error: ${errorMessage}`);
  }
  
  return messageResponse;
}