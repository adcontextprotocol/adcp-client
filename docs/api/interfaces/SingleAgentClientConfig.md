[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / SingleAgentClientConfig

# Interface: SingleAgentClientConfig

Defined in: [src/lib/core/SingleAgentClient.ts:43](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L43)

Configuration for SingleAgentClient (and multi-agent client)

## Extends

- [`ConversationConfig`](ConversationConfig.md)

## Extended by

- [`CreativeAgentClientConfig`](CreativeAgentClientConfig.md)

## Properties

### maxHistorySize?

> `optional` **maxHistorySize**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:258](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L258)

Maximum messages to keep in history

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`maxHistorySize`](ConversationConfig.md#maxhistorysize)

***

### persistConversations?

> `optional` **persistConversations**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:260](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L260)

Whether to persist conversations

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`persistConversations`](ConversationConfig.md#persistconversations)

***

### workingTimeout?

> `optional` **workingTimeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:262](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L262)

Timeout for 'working' status (max 120s per PR #78)

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`workingTimeout`](ConversationConfig.md#workingtimeout)

***

### defaultMaxClarifications?

> `optional` **defaultMaxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:264](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L264)

Default max clarifications

#### Inherited from

[`ConversationConfig`](ConversationConfig.md).[`defaultMaxClarifications`](ConversationConfig.md#defaultmaxclarifications)

***

### debug?

> `optional` **debug**: `boolean`

Defined in: [src/lib/core/SingleAgentClient.ts:45](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L45)

Enable debug logging

***

### userAgent?

> `optional` **userAgent**: `string`

Defined in: [src/lib/core/SingleAgentClient.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L47)

Custom user agent string

***

### headers?

> `optional` **headers**: `Record`\<`string`, `string`\>

Defined in: [src/lib/core/SingleAgentClient.ts:49](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L49)

Additional headers to include in requests

***

### onActivity()?

> `optional` **onActivity**: (`activity`) => `void` \| `Promise`\<`void`\>

Defined in: [src/lib/core/SingleAgentClient.ts:51](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L51)

Activity callback for observability (logging, UI updates, etc)

#### Parameters

##### activity

[`Activity`](Activity.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### handlers?

> `optional` **handlers**: [`AsyncHandlerConfig`](AsyncHandlerConfig.md)

Defined in: [src/lib/core/SingleAgentClient.ts:53](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L53)

Task completion handlers - called for both sync responses and webhook completions

***

### webhookSecret?

> `optional` **webhookSecret**: `string`

Defined in: [src/lib/core/SingleAgentClient.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L55)

Webhook secret for signature verification (recommended for production)

***

### webhookUrlTemplate?

> `optional` **webhookUrlTemplate**: `string`

Defined in: [src/lib/core/SingleAgentClient.ts:69](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L69)

Webhook URL template with macro substitution

Available macros:
- {agent_id} - Agent ID
- {task_type} - Task type (e.g., sync_creatives, media_buy_delivery)
- {operation_id} - Operation ID

#### Example

```ts
Path-based: "https://myapp.com/webhook/{task_type}/{agent_id}/{operation_id}"
Query string: "https://myapp.com/webhook?agent={agent_id}&op={operation_id}&type={task_type}"
Custom: "https://myapp.com/api/v1/adcp/{agent_id}?operation={operation_id}"
```

***

### reportingWebhookFrequency?

> `optional` **reportingWebhookFrequency**: `"hourly"` \| `"daily"` \| `"monthly"`

Defined in: [src/lib/core/SingleAgentClient.ts:75](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L75)

Reporting webhook frequency

#### Default

```ts
'daily'
```

***

### validation?

> `optional` **validation**: `object`

Defined in: [src/lib/core/SingleAgentClient.ts:79](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L79)

Runtime schema validation options

#### strictSchemaValidation?

> `optional` **strictSchemaValidation**: `boolean`

Fail tasks when response schema validation fails (default: true)

When true: Invalid responses cause task to fail with error
When false: Schema violations are logged but task continues

##### Default

```ts
true
```

#### logSchemaViolations?

> `optional` **logSchemaViolations**: `boolean`

Log all schema validation violations to debug logs (default: true)

##### Default

```ts
true
```
