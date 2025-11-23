[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / MediaBuyDeliveryNotification

# Interface: MediaBuyDeliveryNotification

Defined in: [src/lib/core/AsyncHandler.ts:60](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L60)

Media buy delivery notification payload (PR #81)
Agent-initiated periodic reporting, not tied to any client operation

## Properties

### notification\_type

> **notification\_type**: `"scheduled"` \| `"final"` \| `"delayed"`

Defined in: [src/lib/core/AsyncHandler.ts:62](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L62)

Type of notification

***

### sequence\_number?

> `optional` **sequence\_number**: `number`

Defined in: [src/lib/core/AsyncHandler.ts:64](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L64)

Sequential notification number (starts at 1)

***

### next\_expected\_at?

> `optional` **next\_expected\_at**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:66](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L66)

When next notification is expected (omitted for 'final')

***

### reporting\_period?

> `optional` **reporting\_period**: `object`

Defined in: [src/lib/core/AsyncHandler.ts:68](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L68)

Reporting period for this notification

#### start

> **start**: `string`

#### end

> **end**: `string`

***

### currency?

> `optional` **currency**: `string`

Defined in: [src/lib/core/AsyncHandler.ts:73](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L73)

Currency used for financial metrics

***

### media\_buy\_deliveries?

> `optional` **media\_buy\_deliveries**: `object`[]

Defined in: [src/lib/core/AsyncHandler.ts:75](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/core/AsyncHandler.ts#L75)

Array of media buy deliveries being reported

#### Index Signature

\[`key`: `string`\]: `any`

#### media\_buy\_id

> **media\_buy\_id**: `string`

#### impressions?

> `optional` **impressions**: `number`

#### clicks?

> `optional` **clicks**: `number`

#### spend?

> `optional` **spend**: `number`

#### conversions?

> `optional` **conversions**: `number`
