[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / CreateMediaBuyRequest

# Interface: CreateMediaBuyRequest

Defined in: [src/lib/types/tools.generated.ts:492](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L492)

Request parameters for creating a media buy

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:496](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L496)

AdCP schema version for this request

***

### buyer\_ref

> **buyer\_ref**: `string`

Defined in: [src/lib/types/tools.generated.ts:500](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L500)

Buyer's reference identifier for this media buy

***

### packages

> **packages**: (\{\[`k`: `string`\]: `unknown`; \} \| \{\[`k`: `string`\]: `unknown`; \})[]

Defined in: [src/lib/types/tools.generated.ts:504](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L504)

Array of package configurations

***

### promoted\_offering

> **promoted\_offering**: `string`

Defined in: [src/lib/types/tools.generated.ts:515](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L515)

Description of advertiser and what is being promoted

***

### po\_number?

> `optional` **po\_number**: `string`

Defined in: [src/lib/types/tools.generated.ts:519](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L519)

Purchase order number for tracking

***

### start\_time

> **start\_time**: `string`

Defined in: [src/lib/types/tools.generated.ts:523](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L523)

Campaign start date/time in ISO 8601 format

***

### end\_time

> **end\_time**: `string`

Defined in: [src/lib/types/tools.generated.ts:527](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L527)

Campaign end date/time in ISO 8601 format

***

### budget

> **budget**: `Budget`

Defined in: [src/lib/types/tools.generated.ts:528](https://github.com/adcontextprotocol/adcp-client/blob/e8953d756e5ce5fafa76c5e8fa2f0316f0da0998/src/lib/types/tools.generated.ts#L528)
