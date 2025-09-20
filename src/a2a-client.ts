// Official A2A client implementation - NO FALLBACKS
const clientModule = require('@a2a-js/sdk/client');
const A2AClient = clientModule.A2AClient;

if (!A2AClient) {
  throw new Error('A2A SDK client is required. Please install @a2a-js/sdk');
}

export async function callA2ATool(
  agentUrl: string,
  toolName: string,
  brief: string,
  promotedOffering?: string,
  authToken?: string
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
  
  // Create A2A client with agent URL
  const a2aClient = new A2AClient(agentUrl, {
    fetchImpl
  });
  
  // Build request payload
  const requestPayload = {
    message: {
      kind: "message",
      messageId: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      role: "user",
      parts: [{
        kind: "data",
        data: {
          skill: toolName,
          parameters: {
            brief,
            ...(promotedOffering && { promoted_offering: promotedOffering })
          }
        }
      }]
    },
    configuration: {
      blocking: true, // Wait for response
      acceptedOutputModes: ['application/json', 'text/plain']
    }
  };
  
  // Send message using A2A protocol
  const messageResponse = await a2aClient.sendMessage(requestPayload);
  
  // Check for JSON-RPC error in response
  if (messageResponse?.error || messageResponse?.result?.error) {
    const errorObj = messageResponse.error || messageResponse.result?.error;
    const errorMessage = errorObj.message || JSON.stringify(errorObj);
    throw new Error(`A2A agent returned error: ${errorMessage}`);
  }
  
  return messageResponse;
}