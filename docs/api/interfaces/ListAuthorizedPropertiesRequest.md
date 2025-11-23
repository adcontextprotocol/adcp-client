[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListAuthorizedPropertiesRequest

# Interface: ListAuthorizedPropertiesRequest

Defined in: [src/lib/types/tools.generated.ts:3039](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3039)

Request parameters for discovering which publishers this agent is authorized to represent

## Properties

### publisher\_domains?

> `optional` **publisher\_domains**: \[`string`, `...string[]`\]

Defined in: [src/lib/types/tools.generated.ts:3045](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3045)

Filter to specific publisher domains (optional). If omitted, returns all publishers this agent represents.

#### Min Items

1

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:3049](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3049)

Initiator-provided context included in the request payload. Agentsmust echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
