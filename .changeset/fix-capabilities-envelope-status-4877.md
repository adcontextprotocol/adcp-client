---
'@adcp/sdk': patch
---

fix(server): emit envelope `status: "completed"` on `get_adcp_capabilities` responses

`capabilitiesResponse` (and the framework's auto-registered `get_adcp_capabilities` handler that uses it) now stamps the v3 protocol envelope's required `status: "completed"` field at the top level of `structuredContent`. Synchronous task responses MUST carry `status` per `protocol-envelope.json` (AdCP #4876); the helper previously built `structuredContent` from the typed `GetAdCPCapabilitiesResponse` payload alone, never threading the envelope-level status. Adopters who didn't override the helper hit `v3_envelope_integrity/no_legacy_status_fields` conformance failure.

The auto-registered handler in `createAdcpServer` inherits the fix because it calls `capabilitiesResponse` for its wire output. v5 raw-handler adopters still calling `capabilitiesResponse` directly also get the fix for free. Adopters who hand-rolled their own `get_adcp_capabilities` MCP tool (not using the helper) must add `status: "completed"` to their structuredContent themselves.

Fixes adcontextprotocol/adcp#4877. Reported by @kapoost (`@adcp/sdk@7.7.0`, 117/121 storyboards passing; this was the remaining `v3_envelope_integrity` failure surfaced in adcontextprotocol/adcp#4832).
