[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / TaskExecutor

# Class: TaskExecutor

Defined in: [src/lib/core/TaskExecutor.ts:82](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L82)

Core task execution engine that handles the conversation loop with agents

## Constructors

### Constructor

> **new TaskExecutor**(`config`): `TaskExecutor`

Defined in: [src/lib/core/TaskExecutor.ts:87](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L87)

#### Parameters

##### config

###### workingTimeout?

`number`

Default timeout for 'working' status (max 120s per PR #78)

###### pollingInterval?

`number`

Polling interval for 'working' status in milliseconds (default: 2000ms)

###### defaultMaxClarifications?

`number`

Default max clarification attempts

###### enableConversationStorage?

`boolean`

Enable conversation storage

###### webhookManager?

`WebhookManager`

Webhook manager for submitted tasks

###### deferredStorage?

[`Storage`](../interfaces/Storage.md)\<`DeferredTaskState`\>

Storage for deferred task state

###### webhookUrlTemplate?

`string`

Webhook URL template for protocol-level webhook support

###### agentId?

`string`

Agent ID for webhook URL generation

###### webhookSecret?

`string`

Webhook secret for HMAC authentication (min 32 chars)

###### strictSchemaValidation?

`boolean`

Fail tasks when response schema validation fails (default: true)

###### logSchemaViolations?

`boolean`

Log all schema validation violations to debug logs (default: true)

###### onActivity?

(`activity`) => `void` \| `Promise`\<`void`\>

Global activity callback for observability

#### Returns

`TaskExecutor`

## Methods

### executeTask()

> **executeTask**\<`T`\>(`agent`, `taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/TaskExecutor.ts:139](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L139)

Execute a task with an agent using PR #78 async patterns
Handles: working (keep SSE open), submitted (webhook), input-required (handler), completed

#### Type Parameters

##### T

`T` = `any`

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### taskName

`string`

##### params

`any`

##### inputHandler?

[`InputHandler`](../type-aliases/InputHandler.md)

##### options?

[`TaskOptions`](../interfaces/TaskOptions.md) = `{}`

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

***

### listTasks()

> **listTasks**(`agent`): `Promise`\<`TaskInfo`[]\>

Defined in: [src/lib/core/TaskExecutor.ts:720](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L720)

Task tracking methods (PR #78)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

#### Returns

`Promise`\<`TaskInfo`[]\>

***

### getTaskStatus()

> **getTaskStatus**(`agent`, `taskId`): `Promise`\<`TaskInfo`\>

Defined in: [src/lib/core/TaskExecutor.ts:730](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L730)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### taskId

`string`

#### Returns

`Promise`\<`TaskInfo`\>

***

### pollTaskCompletion()

> **pollTaskCompletion**\<`T`\>(`agent`, `taskId`, `pollInterval`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/TaskExecutor.ts:735](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L735)

#### Type Parameters

##### T

`T`

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### taskId

`string`

##### pollInterval

`number` = `60000`

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

***

### resumeDeferredTask()

> **resumeDeferredTask**\<`T`\>(`token`, `input`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/TaskExecutor.ts:771](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L771)

Resume a deferred task (client deferral)

#### Type Parameters

##### T

`T`

#### Parameters

##### token

`string`

##### input

`any`

#### Returns

`Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

***

### getConversationHistory()

> **getConversationHistory**(`taskId`): `undefined` \| [`Message`](../interfaces/Message.md)[]

Defined in: [src/lib/core/TaskExecutor.ts:888](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L888)

Legacy methods for backward compatibility

#### Parameters

##### taskId

`string`

#### Returns

`undefined` \| [`Message`](../interfaces/Message.md)[]

***

### clearConversationHistory()

> **clearConversationHistory**(`taskId`): `void`

Defined in: [src/lib/core/TaskExecutor.ts:892](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L892)

#### Parameters

##### taskId

`string`

#### Returns

`void`

***

### getActiveTasks()

> **getActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/TaskExecutor.ts:896](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L896)

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]

***

### getTaskList()

> **getTaskList**(`agentId`): `Promise`\<`TaskInfo`[]\>

Defined in: [src/lib/core/TaskExecutor.ts:922](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L922)

Get task list for a specific agent

#### Parameters

##### agentId

`string`

#### Returns

`Promise`\<`TaskInfo`[]\>

***

### getTaskInfo()

> **getTaskInfo**(`taskId`): `Promise`\<`null` \| `TaskInfo`\>

Defined in: [src/lib/core/TaskExecutor.ts:949](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L949)

Get detailed information about a specific task

#### Parameters

##### taskId

`string`

#### Returns

`Promise`\<`null` \| `TaskInfo`\>

***

### onTaskUpdate()

> **onTaskUpdate**(`agentId`, `callback`): () => `void`

Defined in: [src/lib/core/TaskExecutor.ts:969](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L969)

Subscribe to task updates for a specific agent

#### Parameters

##### agentId

`string`

##### callback

(`task`) => `void`

#### Returns

> (): `void`

##### Returns

`void`

***

### onTaskEvents()

> **onTaskEvents**(`agentId`, `callbacks`): () => `void`

Defined in: [src/lib/core/TaskExecutor.ts:983](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L983)

Subscribe to task events with detailed callbacks

#### Parameters

##### agentId

`string`

##### callbacks

###### onTaskCreated?

(`task`) => `void`

###### onTaskUpdated?

(`task`) => `void`

###### onTaskCompleted?

(`task`) => `void`

###### onTaskFailed?

(`task`, `error`) => `void`

#### Returns

> (): `void`

##### Returns

`void`

***

### registerWebhook()

> **registerWebhook**(`agent`, `webhookUrl`, `taskTypes?`): `Promise`\<`void`\>

Defined in: [src/lib/core/TaskExecutor.ts:1026](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L1026)

Register webhook for task notifications

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

##### webhookUrl

`string`

##### taskTypes?

`string`[]

#### Returns

`Promise`\<`void`\>

***

### unregisterWebhook()

> **unregisterWebhook**(`agent`): `Promise`\<`void`\>

Defined in: [src/lib/core/TaskExecutor.ts:1040](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskExecutor.ts#L1040)

Unregister webhook notifications

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

#### Returns

`Promise`\<`void`\>
