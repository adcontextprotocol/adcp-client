[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / Product

# Interface: Product

Defined in: [src/lib/types/tools.generated.ts:323](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L323)

Represents available advertising inventory

## Properties

### product\_id

> **product\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:327](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L327)

Unique identifier for the product

***

### name

> **name**: `string`

Defined in: [src/lib/types/tools.generated.ts:331](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L331)

Human-readable product name

***

### description

> **description**: `string`

Defined in: [src/lib/types/tools.generated.ts:335](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L335)

Detailed description of the product and its inventory

***

### publisher\_properties

> **publisher\_properties**: \[\{ `publisher_domain`: `string`; `selection_type`: `"all"`; \} \| \{ `publisher_domain`: `string`; `selection_type`: `"by_id"`; `property_ids`: \[`string`, `...string[]`\]; \} \| \{ `publisher_domain`: `string`; `selection_type`: `"by_tag"`; `property_tags`: \[`string`, `...string[]`\]; \}, ...(\{ publisher\_domain: string; selection\_type: "all" \} \| \{ publisher\_domain: string; selection\_type: "by\_id"; property\_ids: \[string, ...string\[\]\] \} \| \{ publisher\_domain: string; selection\_type: "by\_tag"; property\_tags: \[string, ...string\[\]\] \})\[\]\]

Defined in: [src/lib/types/tools.generated.ts:341](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L341)

Publisher properties covered by this product. Buyers fetch actual property definitions from each publisher's adagents.json and validate agent authorization. Selection patterns mirror the authorization patterns in adagents.json for consistency.

#### Min Items

1

***

### format\_ids

> **format\_ids**: `FormatID`[]

Defined in: [src/lib/types/tools.generated.ts:434](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L434)

Array of supported creative format IDs - structured format_id objects with agent_url and id

***

### placements?

> `optional` **placements**: \[`Placement`, `...Placement[]`\]

Defined in: [src/lib/types/tools.generated.ts:440](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L440)

Optional array of specific placements within this product. When provided, buyers can target specific placements when assigning creatives.

#### Min Items

1

***

### delivery\_type

> **delivery\_type**: `DeliveryType`

Defined in: [src/lib/types/tools.generated.ts:441](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L441)

***

### pricing\_options

> **pricing\_options**: \[`PricingOption`, `...PricingOption[]`\]

Defined in: [src/lib/types/tools.generated.ts:447](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L447)

Available pricing models for this product

#### Min Items

1

***

### estimated\_exposures?

> `optional` **estimated\_exposures**: `number`

Defined in: [src/lib/types/tools.generated.ts:451](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L451)

Estimated exposures/impressions for guaranteed products

***

### measurement?

> `optional` **measurement**: `Measurement`

Defined in: [src/lib/types/tools.generated.ts:452](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L452)

***

### delivery\_measurement

> **delivery\_measurement**: `object`

Defined in: [src/lib/types/tools.generated.ts:456](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L456)

Measurement provider and methodology for delivery metrics. The buyer accepts the declared provider as the source of truth for the buy. REQUIRED for all products.

#### provider

> **provider**: `string`

Measurement provider(s) used for this product (e.g., 'Google Ad Manager with IAS viewability', 'Nielsen DAR', 'Geopath for DOOH impressions')

#### notes?

> `optional` **notes**: `string`

Additional details about measurement methodology in plain language (e.g., 'MRC-accredited viewability. 50% in-view for 1s display / 2s video', 'Panel-based demographic measurement updated monthly')

***

### reporting\_capabilities?

> `optional` **reporting\_capabilities**: `ReportingCapabilities`

Defined in: [src/lib/types/tools.generated.ts:466](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L466)

***

### creative\_policy?

> `optional` **creative\_policy**: [`CreativePolicy`](CreativePolicy.md)

Defined in: [src/lib/types/tools.generated.ts:467](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L467)

***

### is\_custom?

> `optional` **is\_custom**: `boolean`

Defined in: [src/lib/types/tools.generated.ts:471](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L471)

Whether this is a custom product

***

### brief\_relevance?

> `optional` **brief\_relevance**: `string`

Defined in: [src/lib/types/tools.generated.ts:475](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L475)

Explanation of why this product matches the brief (only included when brief is provided)

***

### expires\_at?

> `optional` **expires\_at**: `string`

Defined in: [src/lib/types/tools.generated.ts:479](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L479)

Expiration timestamp for custom products

***

### product\_card?

> `optional` **product\_card**: `object`

Defined in: [src/lib/types/tools.generated.ts:483](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L483)

Optional standard visual card (300x400px) for displaying this product in user interfaces. Can be rendered via preview_creative or pre-generated.

#### format\_id

> **format\_id**: `FormatID1`

#### manifest

> **manifest**: `object`

Asset manifest for rendering the card, structure defined by the format

##### Index Signature

\[`k`: `string`\]: `unknown`

***

### product\_card\_detailed?

> `optional` **product\_card\_detailed**: `object`

Defined in: [src/lib/types/tools.generated.ts:495](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/types/tools.generated.ts#L495)

Optional detailed card with carousel and full specifications. Provides rich product presentation similar to media kit pages.

#### format\_id

> **format\_id**: `FormatID2`

#### manifest

> **manifest**: `object`

Asset manifest for rendering the detailed card, structure defined by the format

##### Index Signature

\[`k`: `string`\]: `unknown`
