[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / StorageConfig

# Interface: StorageConfig

Defined in: [src/lib/storage/interfaces.ts:149](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L149)

Storage configuration for different data types

## Properties

### capabilities?

> `optional` **capabilities**: [`Storage`](Storage.md)\<[`AgentCapabilities`](AgentCapabilities.md)\>

Defined in: [src/lib/storage/interfaces.ts:151](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L151)

Storage for agent capabilities caching

***

### conversations?

> `optional` **conversations**: [`Storage`](Storage.md)\<[`ConversationState`](ConversationState.md)\>

Defined in: [src/lib/storage/interfaces.ts:154](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L154)

Storage for conversation state persistence

***

### tokens?

> `optional` **tokens**: [`Storage`](Storage.md)\<[`DeferredTaskState`](DeferredTaskState.md)\>

Defined in: [src/lib/storage/interfaces.ts:157](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L157)

Storage for deferred task tokens

***

### debugLogs?

> `optional` **debugLogs**: [`Storage`](Storage.md)\<`any`\>

Defined in: [src/lib/storage/interfaces.ts:160](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L160)

Storage for debug logs (optional)

***

### custom?

> `optional` **custom**: `Record`\<`string`, [`Storage`](Storage.md)\<`any`\>\>

Defined in: [src/lib/storage/interfaces.ts:163](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L163)

Custom storage instances
