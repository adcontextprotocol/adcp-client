[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / unwrapProtocolResponse

# Function: unwrapProtocolResponse()

> **unwrapProtocolResponse**(`protocolResponse`, `toolName?`, `protocol?`): `AdCPResponse` & `object`

Defined in: [src/lib/utils/response-unwrapper.ts:120](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/utils/response-unwrapper.ts#L120)

Extract raw AdCP response from protocol wrapper

## Parameters

### protocolResponse

`any`

Raw response from MCP or A2A protocol

### toolName?

`string`

Optional AdCP tool name for validation

### protocol?

Protocol type ('mcp' or 'a2a'), if known. If not provided, will auto-detect.

`"mcp"` | `"a2a"`

## Returns

`AdCPResponse` & `object`

Raw AdCP response data matching schema exactly

## Throws

If response doesn't match expected schema for the tool
