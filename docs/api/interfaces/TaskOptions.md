[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / TaskOptions

# Interface: TaskOptions

Defined in: [src/lib/core/ConversationTypes.ts:120](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L120)

Options for task execution

## Properties

### timeout?

> `optional` **timeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:122](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L122)

Timeout for entire task (ms)

***

### maxClarifications?

> `optional` **maxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:124](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L124)

Maximum clarification rounds before failing

***

### contextId?

> `optional` **contextId**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:126](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L126)

Context ID to continue existing conversation

***

### debug?

> `optional` **debug**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:128](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L128)

Enable debug logging for this task

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [src/lib/core/ConversationTypes.ts:130](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L130)

Additional metadata to include
