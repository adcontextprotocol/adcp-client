---
"@adcp/sdk": patch
---

fix(client): extend v3 fallback to cover capabilities-call throws and empty-data cases

#1201 tightened the v2-fallback heuristic in `SingleAgentClient.getCapabilities()` so that v3 agents with wire-shape bugs (returning `success: false` with v3-shaped `result.data`) are no longer mis-classified as v2. But the fix only covered one failure mode. Two residual paths still fell back to v2 synthetic capabilities, cascading into "AdCP schema data for version v2.5 not found" errors:

- `executeTask` throws (transport error, parse error, OAuth flow failure)
- `success: false` AND `result.data` is empty / not v3-shaped (so the `looksLikeV3Capabilities` heuristic doesn't catch it)

In both cases the agent still has the v3-only `get_adcp_capabilities` tool in its `tools/list` — affirmative evidence that it's v3 even though we couldn't read details. Falling back to v2 synthetic causes `parseAdcpVersion` to ask for v2.5 schemas (not bundled, by design — they're optional) and every subsequent step fails.

This patch:
- Adds `buildSyntheticV3Capabilities(tools)` to `@adcp/sdk/utils/capabilities` (mirrors `buildSyntheticCapabilities` but emits `version: 'v3'`, `majorVersions: [3]`, `_synthetic: true`).
- `SingleAgentClient.getCapabilities` returns synthetic v3 caps when `get_adcp_capabilities` is in the tool list but the call fails (any reason).
- `requireSupportedMajor` skips the version + idempotency-TTL detail checks for synthetic v3 (we know the agent is v3 but couldn't confirm specifics until the caps endpoint is fixed).

Closes #1217.
