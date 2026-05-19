---
'@adcp/sdk': minor
---

feat(testing): opt-in `discovery_resilient` for multi-agent storyboard runs (#1367)

Hello-cluster CI and exploratory multi-agent runs no longer fail the whole storyboard when one tenant's `get_adcp_capabilities` probe hangs or rejects. Opt in with `StoryboardRunOptions.discovery_resilient: true`; the runner then:

- Logs discovery failures but does not throw.
- Excludes failed agents from the protocol-claim index.
- Surfaces a per-step `RoutingError` only when a step's protocol resolves to a failed agent — unrelated storyboards complete normally.
- Echoes the failed agents on `StoryboardResult.discovery_failures[]` so operators see the topology breakage without correlating across log lines.

**Default behavior is unchanged.** Production multi-tenant flows where every tenant in the map is load-bearing keep their hard-failure contract; flipping the flag is the explicit "I accept partial topology" signal.

**Surfaces:**
- `StoryboardRunOptions.discovery_resilient?: boolean` — new opt-in flag.
- `StoryboardResult.discovery_failures?: Array<{ agent_key, url, error }>` — new optional field. Present only when resilient mode is on AND ≥1 agent failed; absent otherwise.
- `AgentRoutingContext.discoveryFailures: DiscoveryFailure[]` — internal field on the routing context; framework consumers should read `StoryboardResult.discovery_failures` instead.
- `resolveAgentForStep` `RoutingError` message now mentions which agents failed discovery when their absence caused the protocol to be unclaimed — so the operator sees the connection between the probe failure and the per-step error without correlating.

**Security:**
- The `discovery_failures[].error` string is upstream-agent-derived and may carry attacker-influenced content. Runner bounds it at ~512 chars and runs the existing auth-secret scrub; JSDoc carries the "untrusted; validate before LLM templating" warning at the read site.
- The `discovery_failures[].url` is scrubbed of userinfo (`//user:pass@host` → `//[REDACTED]@host`) so operator-encoded credentials don't leak to dashboards.

**Step-override safety:** `resolveAgentForStep` now checks whether a `step.agent` override targets an agent whose discovery failed under resilient mode. Before this guard, the override returned verbatim and the dispatcher handed back a transport client to a broken tenant, failing at the wire layer with a misleading transport error. The override-time check makes the failure attributable to topology.

**Default-mode discoverability:** When `discovery_resilient` is unset (default), the `DiscoveryFailure` thrown by the runner now appends a one-line signposted suggestion to set the flag for hello-cluster / exploratory CI — with the explicit "NOT for production" warning attached. Adopters discover the escape hatch at the throw site, not by grep'ing JSDoc.

**Tests:** 5 new regression tests in `test/lib/agent-routing-discovery-resilient.test.js` covering default-mode hard-failure preservation, resilient-mode failure collection on `discoveryFailures`, the improved `RoutingError` message naming failed agents, the `step.agent` override safety check, and `default_agent` fallback under resilient mode.

**Adopter usage:**

```ts
import { runStoryboard } from '@adcp/sdk/testing/storyboard';

const result = await runStoryboard(storyboard, [], {
  agents: {
    sales: { url: 'http://localhost:3001/mcp' },
    signals: { url: 'http://localhost:3002/mcp' },
    creative: { url: 'http://localhost:3003/mcp' }, // bind-flaky in CI
    // ...
  },
  discovery_resilient: true, // accept partial topology for hello-cluster
});

if (result.discovery_failures?.length) {
  console.warn(`Discovery missed: ${result.discovery_failures.map(f => f.agent_key).join(', ')}`);
}
```
