[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / AgentCapabilities

# Interface: AgentCapabilities

Defined in: [src/lib/storage/interfaces.ts:57](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L57)

Agent capabilities for caching

## Properties

### agentId

> **agentId**: `string`

Defined in: [src/lib/storage/interfaces.ts:59](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L59)

Agent ID

***

### supportedTasks

> **supportedTasks**: `string`[]

Defined in: [src/lib/storage/interfaces.ts:61](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L61)

Supported task names

***

### taskSchemas?

> `optional` **taskSchemas**: `Record`\<`string`, `any`\>

Defined in: [src/lib/storage/interfaces.ts:63](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L63)

Task schemas/definitions

***

### metadata?

> `optional` **metadata**: `object`

Defined in: [src/lib/storage/interfaces.ts:65](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L65)

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

Defined in: [src/lib/storage/interfaces.ts:72](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L72)

When capabilities were cached

***

### expiresAt?

> `optional` **expiresAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:74](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/storage/interfaces.ts#L74)

Cache expiration time
