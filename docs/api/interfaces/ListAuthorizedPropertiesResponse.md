[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ListAuthorizedPropertiesResponse

# Interface: ListAuthorizedPropertiesResponse

Defined in: [src/lib/types/tools.generated.ts:1468](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1468)

Type of identifier for this property

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1472](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1472)

AdCP schema version used for this response

***

### properties

> **properties**: `Property`[]

Defined in: [src/lib/types/tools.generated.ts:1476](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1476)

Array of all properties this agent is authorized to represent

***

### tags?

> `optional` **tags**: `object`

Defined in: [src/lib/types/tools.generated.ts:1480](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1480)

Metadata for each tag referenced by properties

#### Index Signature

\[`k`: `string`\]: `object`

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:1495](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1495)

Task-specific errors and warnings (e.g., property availability issues)
