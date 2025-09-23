[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / ActivateSignalRequest

# Interface: ActivateSignalRequest

Defined in: [src/lib/types/tools.generated.ts:1744](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1744)

Request parameters for activating a signal on a specific platform/account

## Properties

### adcp\_version?

> `optional` **adcp\_version**: `string`

Defined in: [src/lib/types/tools.generated.ts:1748](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1748)

AdCP schema version for this request

***

### signal\_agent\_segment\_id

> **signal\_agent\_segment\_id**: `string`

Defined in: [src/lib/types/tools.generated.ts:1752](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1752)

The universal identifier for the signal to activate

***

### platform

> **platform**: `string`

Defined in: [src/lib/types/tools.generated.ts:1756](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1756)

The target platform for activation

***

### account?

> `optional` **account**: `string`

Defined in: [src/lib/types/tools.generated.ts:1760](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/types/tools.generated.ts#L1760)

Account identifier (required for account-specific activation)
