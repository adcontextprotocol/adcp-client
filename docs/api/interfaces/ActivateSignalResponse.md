[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ActivateSignalResponse

# Interface: ActivateSignalResponse

Defined in: [src/lib/types/tools.generated.ts:1768](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1768)

Current activation state: 'submitted' (pending), 'working' (processing), 'completed' (deployed), 'failed', 'input-required' (needs auth), etc.

## Properties

### adcp\_version

> **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1772](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1772)

AdCP schema version used for this response

***

### task\_id

> **task\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1776](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1776)

Unique identifier for tracking the activation

***

### status

> **status**: `TaskStatus`

Defined in: [src/lib/types/tools.generated.ts:1777](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1777)

***

### decisioning\_platform\_segment\_id?

> `optional` **decisioning\_platform\_segment\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1781](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1781)

The platform-specific ID to use once activated

***

### estimated\_activation\_duration\_minutes?

> `optional` **estimated\_activation\_duration\_minutes**: `number`

Defined in: [src/lib/types/tools.generated.ts:1785](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1785)

Estimated time to complete (optional)

***

### deployed\_at?

> `optional` **deployed\_at**: `string`

Defined in: [src/lib/types/tools.generated.ts:1789](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1789)

Timestamp when activation completed (optional)

***

### errors?

> `optional` **errors**: `Error`[]

Defined in: [src/lib/types/tools.generated.ts:1793](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1793)

Task-specific errors and warnings (e.g., activation failures, platform issues)
