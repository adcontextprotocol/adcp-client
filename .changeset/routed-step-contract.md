---
'@adcp/sdk': patch
---

Correct applicability and execution evidence in routed storyboard runs (`runStoryboard('', storyboard, { agents })` and `adcp storyboard run --agents-map`). Re-baseline routed CI expectations: these corrections can change previously passing, failing, or skipped results.

- Each step uses its selected route's discovered tools and capabilities. Remove run-level `agentTools` or `_profile` overrides in routed mode; discovery is authoritative. Per-entry auth/transport overrides still inherit caller-supplied defaults, including shared headers and signing configuration.
- OAuth/JWKS evidence stays within its route, including entries sharing a URL with different credentials. A probe can now fail if it previously borrowed another route's metadata.
- Capability-unavailable producers and their dependent context/state consumers skip neutrally. Negative vectors no longer pass by sending missing context; successful alternate producers still restore execution.
- Missing-tool/controller and failed-route producers also block consumers of their absent declared outputs with hard prerequisite skips; intentional unrelated negative vectors and successfully restored outputs still execute.
- Unrescued missing tools and real failures take precedence over capability-only cascades. Failed required phases prevent an overall passing result without counting skipped rows as executed failures. Optional phases, branch regrading, and fixture/no-phase dispositions retain their existing rules.
- Unresolved or failed routes are hard failures. Repair the agents map, an explicit step agent, or the default agent as indicated by the routing error.
- Capability prerequisite skips display their reason in CLI output. Fixture-routing exceptions close the runner-owned webhook listener.

Storyboard-level required-tool applicability remains any-of across the discovered union. Single-agent and replica routing remain unchanged; the required-phase rollup and CLI diagnostics also correct these shared runner paths. Legacy controller seeding still requires external provisioning and `skip_controller_seeding: true`; declared fixture resolution routes each operation.
