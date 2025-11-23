[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / TaskEventCallbacks

# Interface: TaskEventCallbacks

Defined in: [src/lib/core/TaskEventTypes.ts:158](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L158)

Event listener callback signatures
For OBSERVABILITY only - not for control flow!
Use these to log, record, or update UI - NOT to handle responses

## Properties

### onProtocolRequest()?

> `optional` **onProtocolRequest**: (`event`) => `void`

Defined in: [src/lib/core/TaskEventTypes.ts:163](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L163)

Called for protocol requests (when request is sent to agent)
Use for: logging, UI updates, recording to database

#### Parameters

##### event

[`ProtocolRequestEvent`](ProtocolRequestEvent.md)

#### Returns

`void`

***

### onProtocolResponse()?

> `optional` **onProtocolResponse**: (`event`) => `void`

Defined in: [src/lib/core/TaskEventTypes.ts:169](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L169)

Called for protocol responses (when response received from agent)
Use for: logging, UI updates, recording to database

#### Parameters

##### event

[`ProtocolResponseEvent`](ProtocolResponseEvent.md)

#### Returns

`void`

***

### onStatusChange()?

> `optional` **onStatusChange**: (`event`) => `void`

Defined in: [src/lib/core/TaskEventTypes.ts:176](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L176)

Called for ALL status changes (submitted, working, completed, etc)
Use for: progress tracking, UI updates, event recording
NOTE: This fires during synchronous execution - don't block!

#### Parameters

##### event

`TaskStatusUpdateEvent`

#### Returns

`void`

***

### onObjectEvent()?

> `optional` **onObjectEvent**: (`event`) => `void`

Defined in: [src/lib/core/TaskEventTypes.ts:182](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/TaskEventTypes.ts#L182)

Called for object events (products received, creatives synced, etc)
Use for: tracking granular object status

#### Parameters

##### event

[`ObjectEvent`](ObjectEvent.md)

#### Returns

`void`
