[**@adcp/client API Reference v2.0.0**](../README.md)

***

[@adcp/client API Reference](../README.md) / createAuthenticatedFetch

# Function: createAuthenticatedFetch()

> **createAuthenticatedFetch**(`authToken`): (`url`, `options?`) => `Promise`\<`Response`\>

Defined in: [src/lib/auth/index.ts:49](https://github.com/adcontextprotocol/adcp-client/blob/add23254eadaef025ae9fbe49b40948f459b98ff/src/lib/auth/index.ts#L49)

Create an authenticated fetch function for A2A client

## Parameters

### authToken

`string`

## Returns

> (`url`, `options?`): `Promise`\<`Response`\>

### Parameters

#### url

`string` | `URL` | `Request`

#### options?

`RequestInit`

### Returns

`Promise`\<`Response`\>
