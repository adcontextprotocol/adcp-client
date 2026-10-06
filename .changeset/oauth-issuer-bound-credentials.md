---
'@adcp/sdk': patch
---

Security behavior change: require the patched MCP 2.2.0 clients and legacy peer SDK 1.31.0 or later, and preserve authorization-server issuer bindings through provider, storage, web and diagnostic flows. Refuse unstamped or mismatched prior credentials before spending them. Directly constructed providers now require `allowInteractiveAuthorization: true` for a fresh interactive sign-in; CLI factories opt in. Owners of legacy grants without an independently trusted issuer must explicitly clear credentials and sign in again. See `docs/guides/OAUTH-ISSUER-BINDING.md` for migration and CLI recovery. Distributed refresh coordination remains separate.

Restart older pending web flows that lack the frozen issuer, and retain the same client-bearing storage view through callback. Authorization servers must publish matching issuer metadata, including for fresh sign-in. File storage preserves omitted OAuth fields in partial saves; an own property set to `undefined` explicitly clears it, as the owner-clear and completed PKCE paths now do.
