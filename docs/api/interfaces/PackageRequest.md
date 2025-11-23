[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / PackageRequest

# Interface: PackageRequest

Defined in: [src/lib/types/tools.generated.ts:1635](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1635)

Package configuration for media buy creation

## Properties

### buyer\_ref

> **buyer\_ref**: `string`

Defined in: [src/lib/types/tools.generated.ts:1639](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1639)

Buyer's reference identifier for this package

***

### product\_id

> **product\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1643](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1643)

Product ID for this package

***

### format\_ids?

> `optional` **format\_ids**: \[`FormatID`, `...FormatID[]`\]

Defined in: [src/lib/types/tools.generated.ts:1649](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1649)

Array of format IDs that will be used for this package - must be supported by the product. If omitted, defaults to all formats supported by the product.

#### Min Items

1

***

### budget

> **budget**: `number`

Defined in: [src/lib/types/tools.generated.ts:1653](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1653)

Budget allocation for this package in the media buy's currency

***

### pacing?

> `optional` **pacing**: `Pacing`

Defined in: [src/lib/types/tools.generated.ts:1654](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1654)

***

### pricing\_option\_id

> **pricing\_option\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1658](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1658)

ID of the selected pricing option from the product's pricing_options array

***

### bid\_price?

> `optional` **bid\_price**: `number`

Defined in: [src/lib/types/tools.generated.ts:1662](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1662)

Bid price for auction-based CPM pricing (required if using cpm-auction-option)

***

### targeting\_overlay?

> `optional` **targeting\_overlay**: `TargetingOverlay`

Defined in: [src/lib/types/tools.generated.ts:1663](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1663)

***

### creative\_ids?

> `optional` **creative\_ids**: `string`[]

Defined in: [src/lib/types/tools.generated.ts:1667](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1667)

Creative IDs to assign to this package at creation time (references existing library creatives)

***

### creatives?

> `optional` **creatives**: [`CreativeAsset`](CreativeAsset.md)[]

Defined in: [src/lib/types/tools.generated.ts:1673](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L1673)

Full creative objects to upload and assign to this package at creation time (alternative to creative_ids - creatives will be added to library). Supports both static and generative creatives.

#### Max Items

100
