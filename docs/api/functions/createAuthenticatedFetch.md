[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / createAuthenticatedFetch

# Function: createAuthenticatedFetch()

> **createAuthenticatedFetch**(`authToken`): (`url`, `options?`) => `Promise`\<`Response`\>

Defined in: [src/lib/auth/index.ts:75](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/auth/index.ts#L75)

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
