[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createADCPMultiAgentClient

# Function: createADCPMultiAgentClient()

> **createADCPMultiAgentClient**(`agents`, `config?`): [`ADCPMultiAgentClient`](../classes/ADCPMultiAgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:643](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ADCPMultiAgentClient.ts#L643)

Factory function to create a multi-agent ADCP client

## Parameters

### agents

[`AgentConfig`](../interfaces/AgentConfig.md)[]

Array of agent configurations

### config?

[`ADCPClientConfig`](../interfaces/ADCPClientConfig.md)

Client configuration

## Returns

[`ADCPMultiAgentClient`](../classes/ADCPMultiAgentClient.md)

Configured ADCPMultiAgentClient instance
