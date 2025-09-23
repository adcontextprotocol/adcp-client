[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ProtocolClient

# Class: ProtocolClient

Defined in: [src/lib/protocols/index.ts:14](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/protocols/index.ts#L14)

Universal protocol client - automatically routes to the correct protocol implementation

## Constructors

### Constructor

> **new ProtocolClient**(): `ProtocolClient`

#### Returns

`ProtocolClient`

## Methods

### callTool()

> `static` **callTool**(`agent`, `toolName`, `args`, `debugLogs`): `Promise`\<`any`\>

Defined in: [src/lib/protocols/index.ts:18](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/protocols/index.ts#L18)

Call a tool on an agent using the appropriate protocol

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### toolName

`string`

##### args

`Record`\<`string`, `any`\>

##### debugLogs

`any`[] = `[]`

#### Returns

`Promise`\<`any`\>
