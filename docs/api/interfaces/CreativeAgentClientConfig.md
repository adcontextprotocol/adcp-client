[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / CreativeAgentClientConfig

# Interface: CreativeAgentClientConfig

Defined in: [src/lib/core/CreativeAgentClient.ts:12](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L12)

Configuration for CreativeAgentClient

## Extends

- [`SingleAgentClientConfig`](SingleAgentClientConfig.md)

## Properties

### maxHistorySize?

> `optional` **maxHistorySize**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:258](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L258)

Maximum messages to keep in history

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`maxHistorySize`](SingleAgentClientConfig.md#maxhistorysize)

***

### persistConversations?

> `optional` **persistConversations**: `boolean`

Defined in: [src/lib/core/ConversationTypes.ts:260](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L260)

Whether to persist conversations

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`persistConversations`](SingleAgentClientConfig.md#persistconversations)

***

### workingTimeout?

> `optional` **workingTimeout**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:262](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L262)

Timeout for 'working' status (max 120s per PR #78)

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`workingTimeout`](SingleAgentClientConfig.md#workingtimeout)

***

### defaultMaxClarifications?

> `optional` **defaultMaxClarifications**: `number`

Defined in: [src/lib/core/ConversationTypes.ts:264](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/ConversationTypes.ts#L264)

Default max clarifications

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`defaultMaxClarifications`](SingleAgentClientConfig.md#defaultmaxclarifications)

***

### agentUrl

> **agentUrl**: `string`

Defined in: [src/lib/core/CreativeAgentClient.ts:14](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L14)

Creative agent URL

***

### protocol?

> `optional` **protocol**: `"mcp"` \| `"a2a"`

Defined in: [src/lib/core/CreativeAgentClient.ts:16](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L16)

Protocol to use (defaults to 'mcp')

***

### authToken?

> `optional` **authToken**: `string`

Defined in: [src/lib/core/CreativeAgentClient.ts:18](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/CreativeAgentClient.ts#L18)

Authentication token if required

***

### debug?

> `optional` **debug**: `boolean`

Defined in: [src/lib/core/SingleAgentClient.ts:45](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L45)

Enable debug logging

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`debug`](SingleAgentClientConfig.md#debug)

***

### userAgent?

> `optional` **userAgent**: `string`

Defined in: [src/lib/core/SingleAgentClient.ts:47](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L47)

Custom user agent string

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`userAgent`](SingleAgentClientConfig.md#useragent)

***

### headers?

> `optional` **headers**: `Record`\<`string`, `string`\>

Defined in: [src/lib/core/SingleAgentClient.ts:49](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L49)

Additional headers to include in requests

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`headers`](SingleAgentClientConfig.md#headers)

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

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`onActivity`](SingleAgentClientConfig.md#onactivity)

***

### handlers?

> `optional` **handlers**: [`AsyncHandlerConfig`](AsyncHandlerConfig.md)

Defined in: [src/lib/core/SingleAgentClient.ts:53](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L53)

Task completion handlers - called for both sync responses and webhook completions

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`handlers`](SingleAgentClientConfig.md#handlers)

***

### webhookSecret?

> `optional` **webhookSecret**: `string`

Defined in: [src/lib/core/SingleAgentClient.ts:55](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L55)

Webhook secret for signature verification (recommended for production)

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`webhookSecret`](SingleAgentClientConfig.md#webhooksecret)

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

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`webhookUrlTemplate`](SingleAgentClientConfig.md#webhookurltemplate)

***

### reportingWebhookFrequency?

> `optional` **reportingWebhookFrequency**: `"hourly"` \| `"daily"` \| `"monthly"`

Defined in: [src/lib/core/SingleAgentClient.ts:75](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/SingleAgentClient.ts#L75)

Reporting webhook frequency

#### Default

```ts
'daily'
```

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`reportingWebhookFrequency`](SingleAgentClientConfig.md#reportingwebhookfrequency)

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

#### Inherited from

[`SingleAgentClientConfig`](SingleAgentClientConfig.md).[`validation`](SingleAgentClientConfig.md#validation)
