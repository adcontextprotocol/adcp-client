[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / InputRequest

# Interface: InputRequest

Defined in: [src/lib/core/ConversationTypes.ts:30](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L30)

Request for input from the agent - sent when clarification is needed

## Properties

### question

> **question**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:32](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L32)

Human-readable question or prompt

***

### field?

> `optional` **field**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:34](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L34)

Specific field being requested (if applicable)

***

### expectedType?

> `optional` **expectedType**: `"string"` \| `"number"` \| `"boolean"` \| `"object"` \| `"array"`

Defined in: [src/lib/core/ConversationTypes.ts:36](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L36)

Expected type of response

***

### suggestions?

> `optional` **suggestions**: `any`[]

Defined in: [src/lib/core/ConversationTypes.ts:38](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L38)

Suggested values or options

***

### required?

> `optional` **required**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:40](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L40)

Whether this input is required

***

### validation?

> `optional` **validation**: `object`

Defined in: [src/lib/core/ConversationTypes.ts:42](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L42)

Validation rules for the input

#### min?

> `optional` **min**: `number`

#### max?

> `optional` **max**: `number`

#### pattern?

> `optional` **pattern**: `string`

#### enum?

> `optional` **enum**: `any`[]

***

### context?

> `optional` **context**: `string`

Defined in: [src/lib/core/ConversationTypes.ts:49](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/ConversationTypes.ts#L49)

Additional context about why this input is needed
