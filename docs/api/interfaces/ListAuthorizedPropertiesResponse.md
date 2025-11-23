[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / ListAuthorizedPropertiesResponse

# Interface: ListAuthorizedPropertiesResponse

Defined in: [src/lib/types/tools.generated.ts:3071](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3071)

Response payload for list_authorized_properties task. Lists publisher domains and authorization scope (property_ids or property_tags). Buyers fetch actual property definitions from each publisher's canonical adagents.json file.

## Properties

### publisher\_domains

> **publisher\_domains**: \[`string`, `...string[]`\]

Defined in: [src/lib/types/tools.generated.ts:3077](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3077)

Publisher domains this agent is authorized to represent. Buyers should fetch each publisher's adagents.json to see property definitions and verify this agent is in their authorized_agents list with authorization scope.

#### Min Items

1

***

### primary\_channels?

> `optional` **primary\_channels**: \[`AdvertisingChannels`, `...AdvertisingChannels[]`\]

Defined in: [src/lib/types/tools.generated.ts:3083](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3083)

Primary advertising channels represented in this property portfolio. Helps buying agents quickly filter relevance.

#### Min Items

1

***

### primary\_countries?

> `optional` **primary\_countries**: \[`string`, `...string[]`\]

Defined in: [src/lib/types/tools.generated.ts:3089](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3089)

Primary countries (ISO 3166-1 alpha-2 codes) where properties are concentrated. Helps buying agents quickly filter relevance.

#### Min Items

1

***

### portfolio\_description?

> `optional` **portfolio\_description**: `string`

Defined in: [src/lib/types/tools.generated.ts:3093](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3093)

Markdown-formatted description of the property portfolio, including inventory types, audience characteristics, and special features.

***

### advertising\_policies?

> `optional` **advertising\_policies**: `string`

Defined in: [src/lib/types/tools.generated.ts:3097](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3097)

Publisher's advertising content policies, restrictions, and guidelines in natural language. May include prohibited categories, blocked advertisers, restricted tactics, brand safety requirements, or links to full policy documentation.

***

### last\_updated?

> `optional` **last\_updated**: `string`

Defined in: [src/lib/types/tools.generated.ts:3101](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3101)

ISO 8601 timestamp of when the agent's publisher authorization list was last updated. Buyers can use this to determine if their cached publisher adagents.json files might be stale.

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:3105](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3105)

Task-specific errors and warnings (e.g., property availability issues)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:3109](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3109)

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
