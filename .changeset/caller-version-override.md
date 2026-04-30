---
'@adcp/sdk': patch
'@adcp/client': patch
---

fix(protocols): caller-supplied `adcp_major_version` / `adcp_version` no longer overridden by SDK pin (#1072)

`ProtocolClient.callTool` previously spread the wire version envelope after caller `args`, silently rewriting any `adcp_major_version` (or `adcp_version`) the caller put in `args` with the SDK's own pin. This made it impossible for a conformance harness using the SDK as the buyer-side transport to probe seller-side version validation — the bundled `error-compliance.yaml` `version_negotiation/unsupported_major_version` step (which sends `adcp_major_version: 99` to elicit `VERSION_UNSUPPORTED`) could not pass.

Spread order is now reversed at all four wire-injection sites (in-process MCP, HTTP MCP, A2A, both factory functions): caller args win, SDK envelope fills only when absent. Stale dual-field drift (e.g. buyer pinned to 3.1 but with stale integer in args) is still detected at the server boundary by `createAdcpServer`'s field-disagreement check, which returns `VERSION_UNSUPPORTED` per spec PR `adcontextprotocol/adcp#3493`.

`adcp_version` is now also part of `ADCP_ENVELOPE_FIELDS`, so a caller-supplied 3.1+ release-precision string survives the per-tool schema-strip path in `SingleAgentClient` (the same protection `adcp_major_version` already had).

This restores the pre-5.24 caller-wins behavior. No schema or wire changes — purely a buyer-side fix.
