---
'@adcp/sdk': patch
---

Upgrade the official MCP client and server to 2.2.0 and require the patched legacy MCP SDK peer (`^1.31.0`) for GHSA-6qxp-vccf-f47h. Preserve OAuth `issuer` bindings through agent configuration and credential storage. Verify the authorization-server issuer before direct web-flow exchanges or diagnostic refreshes, and refuse to reuse saved refresh tokens or client secrets without a valid binding.

Clear legacy saved refresh tokens and confidential client registrations and sign in again, or assign their issuer from independently trusted configuration. Do not infer it from the current MCP server's discovery metadata. Custom OAuth providers must round-trip `issuer`; upstream bundled machine-auth providers must configure `expectedIssuer`. See the [OAuth issuer migration guide](https://github.com/adcontextprotocol/adcp-client/blob/main/docs/migration-oauth-issuer-bindings.md) for the upgrade steps.
