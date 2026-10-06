---
'@adcp/sdk': minor
---

Export `AgentOAuthClientCredentialsSchema` from `@adcp/sdk`, `@adcp/sdk/auth`, and `@adcp/sdk/schemas` so hosted platforms can validate OAuth client credentials settings without duplicating the SDK type. The schema covers the required token endpoint, client ID and secret, plus optional scope, resource, audience, and authentication method, preserving environment-variable secret references.
