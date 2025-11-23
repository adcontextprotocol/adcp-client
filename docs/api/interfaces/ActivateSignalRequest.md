[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ActivateSignalRequest

# Interface: ActivateSignalRequest

Defined in: [src/lib/types/tools.generated.ts:4041](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4041)

A destination platform where signals can be activated (DSP, sales agent, etc.)

## Properties

### signal\_agent\_segment\_id

> **signal\_agent\_segment\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:4045](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4045)

The universal identifier for the signal to activate

***

### destinations

> **destinations**: \[`Destination`, `...Destination[]`\]

Defined in: [src/lib/types/tools.generated.ts:4051](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4051)

Target destination(s) for activation. If the authenticated caller matches one of these destinations, activation keys will be included in the response.

#### Min Items

1

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:4055](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4055)

Initiator-provided context included in the request payload. Agents must echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
