[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createADCPMultiAgentClient

# Function: createADCPMultiAgentClient()

> **createADCPMultiAgentClient**(`agents`, `config?`): [`ADCPMultiAgentClient`](../classes/ADCPMultiAgentClient.md)

Defined in: [src/lib/core/ADCPMultiAgentClient.ts:1095](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ADCPMultiAgentClient.ts#L1095)

Factory function to create a multi-agent ADCP client

## Parameters

### agents

[`AgentConfig`](../interfaces/AgentConfig.md)[]

Array of agent configurations

### config?

[`SingleAgentClientConfig`](../interfaces/SingleAgentClientConfig.md)

Client configuration

## Returns

[`ADCPMultiAgentClient`](../classes/ADCPMultiAgentClient.md)

Configured ADCPMultiAgentClient instance
