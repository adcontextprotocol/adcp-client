# OAuth issuer bindings

SDK 14.4 upgrades MCP client/server/core to 2.2.0 and requires the legacy
`@modelcontextprotocol/sdk` peer at `^1.31.0` to address
[GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
The transport rejects vulnerable legacy peers even if installation checks were bypassed.
Node requirements remain `^20.19.0 || >=22.12.0`.

The next major changes direct providers to background by default (explicit
interactive opt-in). Adapters built for 14.4's authoritative-absence contract
must switch tokens, client, verifier and discovery to omission-preserves /
own-undefined-clears.

See [OAuth authorization-server binding](guides/OAUTH-ISSUER-BINDING.md) for
required owner recovery, interactive opt-in, partial-storage semantics and
web-flow migration. Rotate any credentials exposed to an untrusted server
according to the advisory.
