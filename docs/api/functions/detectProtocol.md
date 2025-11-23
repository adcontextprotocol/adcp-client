[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / detectProtocol

# Function: detectProtocol()

> **detectProtocol**(`url`): `Promise`\<`"mcp"` \| `"a2a"`\>

Defined in: [src/lib/utils/protocol-detection.ts:18](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/utils/protocol-detection.ts#L18)

Detect protocol for a given agent URL

Uses a hybrid approach:
1. Check URL patterns (fast heuristic)
2. Try A2A discovery endpoint (authoritative)
3. Default to MCP if A2A discovery fails

## Parameters

### url

`string`

Agent URL to check

## Returns

`Promise`\<`"mcp"` \| `"a2a"`\>

Promise resolving to 'a2a' or 'mcp'
