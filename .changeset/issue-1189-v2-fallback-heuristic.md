---
"@adcp/sdk": patch
---

fix(client): tighten v2-fallback heuristic — don't downgrade v3 agents when get_adcp_capabilities fails

When a v3 agent's `get_adcp_capabilities` call fails (schema validation error, wire-shape bug, etc.), the SDK previously fell back to v2 synthetic capabilities, triggering v2.5 schema lookups that had nothing to do with the original failure. The fix requires affirmative v2 evidence: only build v2 synthetic capabilities when the agent has no `get_adcp_capabilities` tool at all (the strongest v2 signal). When the tool is present but the call fails, the SDK now builds synthetic v3 capabilities and surfaces the real error.
