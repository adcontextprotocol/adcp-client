[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / GetSignalsResponse

# Interface: GetSignalsResponse

Defined in: [src/lib/types/tools.generated.ts:1655](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1655)

Response payload for get_signals task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1659](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1659)

AdCP schema version used for this response

***

### signals

> **signals**: `object`[]

Defined in: [src/lib/types/tools.generated.ts:1663](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1663)

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

> **deployments**: `object`[]

Array of platform deployments

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

Defined in: [src/lib/types/tools.generated.ts:1734](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1734)

Task-specific errors and warnings (e.g., signal discovery or pricing issues)
