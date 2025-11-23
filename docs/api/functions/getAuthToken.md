[**@adcp/client API Reference v3.1.0**](../README.md)

***

[@adcp/client API Reference](../globals.md) / getAuthToken

# Function: getAuthToken()

> **getAuthToken**(`agent`): `undefined` \| `string`

Defined in: [src/lib/auth/index.ts:26](https://github.com/adcontextprotocol/adcp-client/blob/8b051702996bea03f2cc34f765f78723a45db572/src/lib/auth/index.ts#L26)

Get authentication token for an agent

Supports two explicit authentication methods:
1. auth_token: Direct token value, used as-is
2. auth_token_env: Environment variable name, looked up in process.env

Priority: auth_token takes precedence if both are provided

## Parameters

### agent

[`AgentConfig`](../interfaces/AgentConfig.md)

Agent configuration

## Returns

`undefined` \| `string`

Authentication token string or undefined if not configured/required
