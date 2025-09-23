[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / GetSignalsRequest

# Interface: GetSignalsRequest

Defined in: [src/lib/types/tools.generated.ts:1588](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1588)

Request parameters for discovering signals based on description

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1592](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1592)

AdCP schema version for this request

***

### signal\_spec

> **signal\_spec**: `string`

Defined in: [src/lib/types/tools.generated.ts:1596](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1596)

Natural language description of the desired signals

***

### deliver\_to

> **deliver\_to**: `object`

Defined in: [src/lib/types/tools.generated.ts:1600](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1600)

Where the signals need to be delivered

#### platforms

> **platforms**: `string`[] \| `"all"`

Target platforms for signal deployment

#### accounts?

> `optional` **accounts**: `object`[]

Specific platform-account combinations

#### countries

> **countries**: `string`[]

Countries where signals will be used (ISO codes)

***

### filters?

> `optional` **filters**: `object`

Defined in: [src/lib/types/tools.generated.ts:1626](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1626)

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

Defined in: [src/lib/types/tools.generated.ts:1647](https://github.com/adcontextprotocol/adcp-client/blob/9ed0be764adbd110916d257101c95a577b3f15c8/src/lib/types/tools.generated.ts#L1647)

Maximum number of results to return
