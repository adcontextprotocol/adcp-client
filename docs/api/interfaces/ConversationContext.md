[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ConversationContext

# Interface: ConversationContext

Defined in: [src/lib/core/ConversationTypes.ts:70](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L70)

Complete conversation context provided to input handlers

## Properties

### messages

> **messages**: [`Message`](Message.md)[]

Defined in: [src/lib/core/ConversationTypes.ts:72](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L72)

Full conversation history for this task

***

### inputRequest

> **inputRequest**: [`InputRequest`](InputRequest.md)

Defined in: [src/lib/core/ConversationTypes.ts:74](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L74)

Current input request from the agent

***

### taskId

> **taskId**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:76](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L76)

Unique task identifier

***

### agent

> **agent**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:78](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L78)

Agent configuration

#### id

> **id**: `string`

#### name

> **name**: `string`

#### protocol

> **protocol**: `"mcp"` \| `"a2a"`

***

### attempt

> **attempt**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:84](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L84)

Current clarification attempt number (1-based)

***

### maxAttempts

> **maxAttempts**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:86](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L86)

Maximum allowed clarification attempts

## Methods

### deferToHuman()

> **deferToHuman**(): `Promise`\<\{ `defer`: `true`; `token`: `string`; \}\>

Defined in: [src/lib/core/ConversationTypes.ts:89](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L89)

Helper method to defer task to human

#### Returns

`Promise`\<\{ `defer`: `true`; `token`: `string`; \}\>

***

### abort()

> **abort**(`reason?`): `never`

Defined in: [src/lib/core/ConversationTypes.ts:92](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L92)

Helper method to abort the task

#### Parameters

##### reason?

`string`

#### Returns

`never`

***

### getSummary()

> **getSummary**(): `string`

Defined in: [src/lib/core/ConversationTypes.ts:95](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L95)

Get conversation summary for context

#### Returns

`string`

***

### wasFieldDiscussed()

> **wasFieldDiscussed**(`field`): `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:98](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L98)

Check if a field was previously discussed

#### Parameters

##### field

`string`

#### Returns

`boolean`

***

### getPreviousResponse()

> **getPreviousResponse**(`field`): `any`

Defined in: [src/lib/core/ConversationTypes.ts:101](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L101)

Get previous response for a field

#### Parameters

##### field

`string`

#### Returns

`any`
