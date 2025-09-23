[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / DeferredTaskState

# Interface: DeferredTaskState

Defined in: [src/lib/storage/interfaces.ts:111](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L111)

Deferred task state for resumption

## Properties

### token

> **token**: `string`

Defined in: [src/lib/storage/interfaces.ts:113](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L113)

Unique token for this deferred task

***

### taskId

> **taskId**: `string`

Defined in: [src/lib/storage/interfaces.ts:115](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L115)

Task ID

***

### taskName

> **taskName**: `string`

Defined in: [src/lib/storage/interfaces.ts:117](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L117)

Task name

***

### agentId

> **agentId**: `string`

Defined in: [src/lib/storage/interfaces.ts:119](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L119)

Agent ID

***

### params

> **params**: `any`

Defined in: [src/lib/storage/interfaces.ts:121](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L121)

Task parameters

***

### messages

> **messages**: `object`[]

Defined in: [src/lib/storage/interfaces.ts:123](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L123)

Message history up to deferral point

#### id

> **id**: `string`

#### role

> **role**: `"user"` \| `"agent"` \| `"system"`

#### content

> **content**: `any`

#### timestamp

> **timestamp**: `string`

#### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

***

### pendingInput?

> `optional` **pendingInput**: `object`

Defined in: [src/lib/storage/interfaces.ts:131](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L131)

Pending input request that caused deferral

#### question

> **question**: `string`

#### field?

> `optional` **field**: `string`

#### expectedType?

> `optional` **expectedType**: `string`

#### suggestions?

> `optional` **suggestions**: `any`[]

#### validation?

> `optional` **validation**: `Record`\<`string`, `any`\>

***

### deferredAt

> **deferredAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:139](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L139)

When task was deferred

***

### expiresAt

> **expiresAt**: `string`

Defined in: [src/lib/storage/interfaces.ts:141](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L141)

When token expires

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [src/lib/storage/interfaces.ts:143](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/storage/interfaces.ts#L143)

Additional metadata
