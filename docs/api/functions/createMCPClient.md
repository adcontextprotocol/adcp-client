[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createMCPClient

# Function: createMCPClient()

> **createMCPClient**(`agentUrl`, `authToken?`): `object`

Defined in: [src/lib/protocols/index.ts:53](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/protocols/index.ts#L53)

Simple factory functions for protocol-specific clients

## Parameters

### agentUrl

`string`

### authToken?

`string`

## Returns

`object`

### callTool()

> **callTool**: (`toolName`, `args`, `debugLogs?`) => `Promise`\<`any`\>

#### Parameters

##### toolName

`string`

##### args

`Record`\<`string`, `any`\>

##### debugLogs?

`any`[]

#### Returns

`Promise`\<`any`\>
