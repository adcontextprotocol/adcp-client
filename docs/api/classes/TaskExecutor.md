[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / TaskExecutor

# Class: TaskExecutor

Defined in: [src/lib/core/TaskExecutor.ts:79](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L79)

Core task execution engine that handles the conversation loop with agents

## Constructors

### Constructor

> **new TaskExecutor**(`config`): `TaskExecutor`

Defined in: [src/lib/core/TaskExecutor.ts:84](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L84)

#### Parameters

##### config

###### workingTimeout?

`number`

Default timeout for 'working' status (max 120s per PR #78)

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

#### Returns

`TaskExecutor`

## Methods

### executeTask()

> **executeTask**\<`T`\>(`agent`, `taskName`, `params`, `inputHandler?`, `options?`): `Promise`\<[`TaskResult`](../interfaces/TaskResult.md)\<`T`\>\>

Defined in: [src/lib/core/TaskExecutor.ts:108](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L108)

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

Defined in: [src/lib/core/TaskExecutor.ts:464](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L464)

Task tracking methods (PR #78)

#### Parameters

##### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

#### Returns

`Promise`\<`TaskInfo`[]\>

***

### getTaskStatus()

> **getTaskStatus**(`agent`, `taskId`): `Promise`\<`TaskInfo`\>

Defined in: [src/lib/core/TaskExecutor.ts:474](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L474)

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

Defined in: [src/lib/core/TaskExecutor.ts:479](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L479)

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

Defined in: [src/lib/core/TaskExecutor.ts:515](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L515)

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

Defined in: [src/lib/core/TaskExecutor.ts:614](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L614)

Legacy methods for backward compatibility

#### Parameters

##### taskId

`string`

#### Returns

`undefined` \| [`Message`](../interfaces/Message.md)[]

***

### clearConversationHistory()

> **clearConversationHistory**(`taskId`): `void`

Defined in: [src/lib/core/TaskExecutor.ts:618](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L618)

#### Parameters

##### taskId

`string`

#### Returns

`void`

***

### getActiveTasks()

> **getActiveTasks**(): [`TaskState`](../interfaces/TaskState.md)[]

Defined in: [src/lib/core/TaskExecutor.ts:622](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/core/TaskExecutor.ts#L622)

#### Returns

[`TaskState`](../interfaces/TaskState.md)[]
