---
'@adcp/sdk': patch
---

fix(client): don't downgrade obvious v3 agents to v2 on a single capabilities-validation failure

`SingleAgentClient.getCapabilities()` had a coarse v2-fallback heuristic: if `get_adcp_capabilities` was advertised but the call returned `success: false` for any reason, fall back to v2 synthetic capabilities. That's wrong when the agent is clearly a v3 agent that just has a wire-shape bug (e.g., a single missing required field that fails strict schema validation but otherwise returns a fully v3-shaped response).

When the fallback fired, the SDK marked the agent as v2.5, downstream tooling asked for v2.5 schemas (not shipped — only 3.0.x is bundled), and every subsequent step errored with `"AdCP schema data for version v2.5 not found"`. One missing field cascaded into total storyboard failure with errors that had nothing to do with the original problem.

Fix: tighten the fallback heuristic. When `result.success === false` but `result.data` is **structurally v3-shaped**, parse it anyway, surface the validation failure loudly, and continue with v3 capabilities. The agent has a wire-shape bug to fix; downgrading to v2 hides that.

The new `looksLikeV3Capabilities()` helper (exported from `@adcp/sdk` via `src/lib/utils/capabilities.ts`) checks for affirmative v3 signals:

- Presence of the `adcp` envelope block
- Presence of `supported_protocols` (v3-only top-level field)
- Presence of any v3 protocol-level capability block (`account`, `media_buy`, `signals`, `creative`, `brand`, `governance`, `sponsored_intelligence`, `compliance_testing`)

Empty / null / non-object responses still fall back to v2 (the existing heuristic — preserved). v2 agents that genuinely don't have any v3 surface in their response continue to be detected correctly.

Surfaced empirically by the matrix v2 mock-server run on adcontextprotocol/adcp-client#1185, where Claude built a v3 signals agent with a single missing field (`account.supported_billing`) that the runner's old fallback turned into a cascade of confusing v2.5 errors. Closes adcontextprotocol/adcp-client#1189.

Pairs with the related v6 framework default fix (#1198 / #1186 — default `supported_billing: ['agent']`). With both fixes, the most common cause of the cascade is gone (#1198), and the runner stops compounding any remaining cause into a confusing v2.5 failure (#1189). Each change stands alone; together they remove one of the gnarliest brittleness patterns in the matrix harness.
