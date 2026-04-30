---
'@adcp/sdk': patch
'@adcp/client': patch
---

fix(protocols): caller-supplied `adcp_major_version` / `adcp_version` no longer overridden by SDK pin (#1072)

**Behavior change for 5.24/5.25 users.** Restores the pre-5.24 caller-wins contract for the wire version envelope. If you pinned `@adcp/sdk` to 5.24 or 5.25 and were relying on the SDK to override stale `adcp_major_version` / `adcp_version` values in your `args` payload, those values now reach the seller verbatim. The 5.25 server-side field-disagreement check in `createAdcpServer` (per spec PR `adcontextprotocol/adcp#3493`) is the correct enforcement boundary for stale-config drift — a 3.1+ buyer carrying both fields with mismatched majors still gets `VERSION_UNSUPPORTED` from a compliant seller.

**Why.** The 5.24 SDK-overrides-caller behavior made it impossible for conformance harnesses using `ProtocolClient` as buyer transport to probe seller version negotiation. The bundled `compliance/cache/3.0.1/universal/error-compliance.yaml` `unsupported_major_version` step (which sends `adcp_major_version: 99` to elicit `VERSION_UNSUPPORTED`) could not pass — the 99 was rewritten to the SDK pin before leaving the buyer.

**Changes:**

- All four wire-injection sites (in-process MCP, HTTP MCP, A2A, `createMCPClient`, `createA2AClient`) now route through a new `applyVersionEnvelope(args, envelope)` helper. Single chokepoint, single test surface, no future-refactor drift between branches. Helper is exported.
- `adcp_version` added to `ADCP_ENVELOPE_FIELDS` so a caller-supplied 3.1+ release-precision string survives `SingleAgentClient`'s per-tool schema-strip path. Mirrors the existing `adcp_major_version` carve-out — and 3.1 sellers MUST accept `adcp_version` at the envelope layer per spec PR #3493, so strict-schema rejections were a seller bug regardless.

No schema or wire changes — purely a buyer-side fix.
