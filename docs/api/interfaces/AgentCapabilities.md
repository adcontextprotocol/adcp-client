[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / AgentCapabilities

# Interface: AgentCapabilities

Defined in: [src/lib/storage/interfaces.ts:57](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L57)

Agent capabilities for caching

## Properties

### agentId

> **agentId**: `string`

Defined in: [src/lib/storage/interfaces.ts:59](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L59)

Agent ID

***

### supportedTasks

> **supportedTasks**: `string`[]

Defined in: [src/lib/storage/interfaces.ts:61](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L61)

Supported task names

***

### taskSchemas?

> `optional` **taskSchemas**: `Record`\<`string`, `any`\>

Defined in: [src/lib/storage/interfaces.ts:63](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L63)

Task schemas/definitions

***

### metadata?

> `optional` **metadata**: `object`

Defined in: [src/lib/storage/interfaces.ts:65](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L65)

Agent metadata

#### Index Signature

\[`key`: `string`\]: `any`

#### version?

> `optional` **version**: `string`

#### description?

> `optional` **description**: `string`

#### lastUpdated?

> `optional` **lastUpdated**: `string`

***

### cachedAt

> **cachedAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:72](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L72)

When capabilities were cached

***

### expiresAt?

> `optional` **expiresAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:74](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L74)

Cache expiration time
