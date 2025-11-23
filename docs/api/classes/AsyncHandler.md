[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / AsyncHandler

# Class: AsyncHandler

Defined in: [src/lib/core/AsyncHandler.ts:164](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L164)

Async handler class

## Constructors

### Constructor

> **new AsyncHandler**(`config`): `AsyncHandler`

Defined in: [src/lib/core/AsyncHandler.ts:165](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L165)

#### Parameters

##### config

[`AsyncHandlerConfig`](../interfaces/AsyncHandlerConfig.md)

#### Returns

`AsyncHandler`

## Methods

### handleWebhook()

> **handleWebhook**(`payload`, `agentId?`): `Promise`\<`void`\>

Defined in: [src/lib/core/AsyncHandler.ts:170](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L170)

Handle incoming webhook payload (both task completions and notifications)

#### Parameters

##### payload

[`WebhookPayload`](../interfaces/WebhookPayload.md)

##### agentId?

`string`

#### Returns

`Promise`\<`void`\>
