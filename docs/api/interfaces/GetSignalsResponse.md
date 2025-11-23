[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / GetSignalsResponse

# Interface: GetSignalsResponse

Defined in: [src/lib/types/tools.generated.ts:3977](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3977)

Response payload for get_signals task

## Properties

### signals

> **signals**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:3981](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L3981)

Array of matching signals

#### signal\_agent\_segment\_id

> **signal\_agent\_segment\_id**: `string`

Unique identifier for the signal

#### name

> **name**: `string`

Human-readable signal name

#### description

> **description**: `string`

Detailed signal description

#### signal\_type

> **signal\_type**: `"custom"` \| `"marketplace"` \| `"owned"`

Type of signal

#### data\_provider

> **data\_provider**: `string`

Name of the data provider

#### coverage\_percentage

> **coverage\_percentage**: `number`

Percentage of audience coverage

#### deployments

> **deployments**: `Deployment`[]

Array of destination deployments

#### pricing

> **pricing**: `object`

Pricing information

##### pricing.cpm

> **cpm**: `number`

Cost per thousand impressions

##### pricing.currency

> **currency**: `string`

Currency code

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:4027](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4027)

Task-specific errors and warnings (e.g., signal discovery or pricing issues)

***

### context?

> `optional` **context**: `object`

Defined in: [src/lib/types/tools.generated.ts:4031](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L4031)

Initiator-provided context echoed inside the task payload. Opaque metadata such as UI/session hints, correlation tokens, or tracking identifiers.
