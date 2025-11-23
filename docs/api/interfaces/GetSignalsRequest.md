[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetSignalsRequest

# Interface: GetSignalsRequest

Defined in: [src/lib/types/tools.generated.ts:3806](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3806)

Request parameters for discovering signals based on description

## Properties

### signal\_spec

> **signal\_spec**: `string`

Defined in: [src/lib/types/tools.generated.ts:3810](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3810)

Natural language description of the desired signals

***

### deliver\_to

> **deliver\_to**: `object`

Defined in: [src/lib/types/tools.generated.ts:3814](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3814)

Destination platforms where signals need to be activated

#### destinations

> **destinations**: \[`Destination`, `...Destination[]`\]

List of destination platforms (DSPs, sales agents, etc.). If the authenticated caller matches one of these destinations, activation keys will be included in the response.

##### Min Items

1

#### countries

> **countries**: `string`[]

Countries where signals will be used (ISO codes)

***

### filters?

> `optional` **filters**: `object`

Defined in: [src/lib/types/tools.generated.ts:3829](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3829)

Filters to refine results

#### catalog\_types?

> `optional` **catalog\_types**: (`"custom"` \| `"marketplace"` \| `"owned"`)[]

Filter by catalog type

#### data\_providers?

> `optional` **data\_providers**: `string`[]

Filter by specific data providers

#### max\_cpm?

> `optional` **max\_cpm**: `number`

Maximum CPM price filter

#### min\_coverage\_percentage?

> `optional` **min\_coverage\_percentage**: `number`

Minimum coverage requirement

***

### max\_results?

> `optional` **max\_results**: `number`

Defined in: [src/lib/types/tools.generated.ts:3850](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3850)

Maximum number of results to return

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:3854](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3854)

Initiator-provided context included in the request payload. Agents must echo this value back unchanged in responses and webhooks. Use for UI/session hints, correlation tokens, or tracking metadata.
