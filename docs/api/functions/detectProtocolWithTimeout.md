[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / detectProtocolWithTimeout

# Function: detectProtocolWithTimeout()

> **detectProtocolWithTimeout**(`url`, `timeoutMs`): `Promise`\<`"mcp"` \| `"a2a"`\>

Defined in: [src/lib/utils/protocol-detection.ts:58](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/utils/protocol-detection.ts#L58)

Detect protocol with custom timeout

## Parameters

### url

`string`

Agent URL to check

### timeoutMs

`number` = `5000`

Timeout in milliseconds (default: 5000)

## Returns

`Promise`\<`"mcp"` \| `"a2a"`\>

Promise resolving to 'a2a' or 'mcp'
