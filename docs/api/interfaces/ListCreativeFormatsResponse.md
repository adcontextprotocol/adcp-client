[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ListCreativeFormatsResponse

# Interface: ListCreativeFormatsResponse

Defined in: [src/lib/types/tools.generated.ts:350](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L350)

Response payload for list_creative_formats task

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:354](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L354)

AdCP schema version used for this response

***

### status?

> `optional` **status**: `TaskStatus`

Defined in: [src/lib/types/tools.generated.ts:355](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L355)

***

### formats

> **formats**: `Format`[]

Defined in: [src/lib/types/tools.generated.ts:359](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L359)

Array of available creative formats

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:363](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L363)

Task-specific errors and warnings (e.g., format availability issues)
