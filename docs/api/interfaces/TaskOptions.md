[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / TaskOptions

# Interface: TaskOptions

Defined in: [src/lib/core/ConversationTypes.ts:112](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L112)

Options for task execution

## Properties

### timeout?

> `optional` **timeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:114](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L114)

Timeout for entire task (ms)

***

### maxClarifications?

> `optional` **maxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:116](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L116)

Maximum clarification rounds before failing

***

### contextId?

> `optional` **contextId**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:118](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L118)

Context ID to continue existing conversation

***

### debug?

> `optional` **debug**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:120](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L120)

Enable debug logging for this task

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [src/lib/core/ConversationTypes.ts:122](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/core/ConversationTypes.ts#L122)

Additional metadata to include
